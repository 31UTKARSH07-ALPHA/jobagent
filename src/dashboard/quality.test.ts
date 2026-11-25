import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openDb } from '../store/db.ts';
import { Profile } from '../store/schema.ts';
import { assessDraft } from './quality.ts';

const stamp = '2026-11-24T00:00:00.000Z';
const draft = {
  email: ' Recruiter@example.test ',
  subject: 'Backend Intern at Example',
  body: 'Hi Alex,\nI built a task queue backed by Redis. I measured 8ms queue latency in a local benchmark. Your platform uses Go for scheduling.\nThanks,\nTest Candidate',
};

function fixture(t: TestContext) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const dir = mkdtempSync(join(tmpdir(), 'draft-quality-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilePath = join(dir, 'profile.json');
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('quality review must remain offline'));
  const savedProfilePath = process.env['JOBAGENT_PROFILE'];
  process.env['JOBAGENT_PROFILE'] = profilePath;
  t.after(() => {
    if (savedProfilePath === undefined) delete process.env['JOBAGENT_PROFILE'];
    else process.env['JOBAGENT_PROFILE'] = savedProfilePath;
  });
  writeFileSync(profilePath, JSON.stringify(Profile.parse({
    name: 'Test Candidate', email: 'candidate@example.test', phone: '', links: [],
    education: [{ institution: 'Example College', degree: 'BSc', dates: '2024–2027', location: '', score: '95%' }],
    summary: 'Undergraduate working on backend systems.', skills: [], domains: [],
    projects: [{ name: 'Task Queue', summary: 'A task queue backed by Redis.', tech: ['Redis'], highlights: ['Measured 8ms queue latency in a local benchmark.'] }],
    experience: [], achievements: [], target_roles: ['Backend Intern'], extracted_at: stamp, model: 'test',
  })));
  db.exec(`
    INSERT INTO companies (id,name,domain,created_at,updated_at) VALUES
      (1,'Example Inc.','example.test','${stamp}','${stamp}'),
      (2,'Another Employer','another.test','${stamp}','${stamp}');
    INSERT INTO contacts (id,company_id,email,name,source,confidence,created_at) VALUES
      (1,1,'recruiter@example.test','Alex Smith','posting','high','${stamp}'),
      (2,1,'other@example.test',NULL,'posting','high','${stamp}'),
      (3,2,'recruiter@another.test',NULL,'posting','high','${stamp}');
    INSERT INTO jobs (id,company_id,dedup_key,source,url,title,description,state_changed_at,first_seen_at,last_seen_at) VALUES
      (11,1,'a','manual','https://example.test/a','Backend Intern','Our platform uses Go for scheduling.','${stamp}','${stamp}','${stamp}'),
      (12,1,'b','manual','https://example.test/b','  BACKEND — INTERN  ','','${stamp}','${stamp}','${stamp}'),
      (13,2,'c','manual','https://another.test/c','Backend Intern','','${stamp}','${stamp}','${stamp}');
  `);
  db.prepare(`INSERT INTO outreach (id,job_id,contact_id,subject,body,drafted_at) VALUES (1,11,1,?,?,?)`)
    .run(draft.subject, draft.body, stamp);
  return { db, profilePath, fetch };
}

test('uses saved profile, job posting and contact without flagging the record itself or making calls', async (t) => {
  const { db, fetch } = fixture(t);
  assert.deepEqual(await assessDraft(db, 1, draft), { warnings: [], mode: 'local' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('flags possible unsupported claims, context-shifted figures, and changes to the saved contact', async (t) => {
  const { db } = fixture(t);
  db.exec("UPDATE jobs SET description = '' WHERE id = 11");
  const result = await assessDraft(db, 1, {
    email: 'replacement@example.test', subject: '[Company] internship',
    body: 'Hi Alex,\nI worked at Made Up Corp. I am a final-year student at Example College. I cut queue latency by 95%. Your platform uses Go for scheduling. I built a distributed task queue backed by Redis and achieved a 5× gain.',
  });
  const codes = result.warnings.map(({ code }) => code);
  for (const code of ['recipient_changed', 'greeting_review', 'placeholder', 'unsupported_employment', 'unsupported_education', 'unsupported_employer', 'unsupported_metric']) {
    assert.ok(codes.includes(code), `Expected ${code}; got ${codes.join(', ')}`);
  }
  assert.match(result.warnings.find(({ code }) => code === 'unsupported_metric')!.message, /95%.*5×|95%.*5x/);
});

test('checks normalized role, effective recipient and edited content, including from sent outreach', async (t) => {
  const { db } = fixture(t);
  db.prepare(`INSERT INTO outreach (id,job_id,contact_id,subject,body,drafted_at,sent_at,recipient_override,local_subject,local_body)
    VALUES (2,12,2,'original subject','original body',?,?,?,?,?)`).run(stamp, stamp, 'recruiter@example.test', draft.subject.toUpperCase(), draft.body.replace(/\s+/g, '  '));
  const result = await assessDraft(db, 1, draft);
  assert.deepEqual(result.warnings.map(({ code }) => code), ['duplicate_role', 'duplicate_recipient', 'duplicate_content']);
  assert.equal(db.prepare('SELECT local_body FROM outreach WHERE id = 1').get()?.local_body, null);
});

test('compares both subject and body, and recognizes minor copy edits to a long body', async (t) => {
  const { db } = fixture(t);
  const longer = `${draft.body}\nCould we talk this week about where an intern could help? My main interest is learning about the challenges your engineering group faces while scheduling different kinds of tasks under load.`;
  db.prepare(`INSERT INTO outreach (id,job_id,contact_id,subject,body,drafted_at)
    VALUES (3,13,3,?,?,?)`).run(draft.subject, longer, stamp);
  const result = await assessDraft(db, 1, { ...draft, subject: `${draft.subject}!`, body: longer.replace('this week', 'next week') });
  assert.deepEqual(result.warnings.map(({ code }) => code), ['duplicate_content']);
  assert.deepEqual((await assessDraft(db, 1, { ...draft, subject: 'Another subject', body: longer })).warnings, []);
});

test('does not attribute a known retired contact or its name to the recorded override', async (t) => {
  const { db } = fixture(t);
  db.exec("UPDATE outreach SET recipient_override = 'alternate@example.test' WHERE id = 1; UPDATE contacts SET dead_at = '2026-11-24' WHERE id = 1");
  const edited = await assessDraft(db, 1, { ...draft, email: 'alternate@example.test' });
  assert.deepEqual(edited.warnings.map(({ code }) => code), ['greeting_review']);
  const original = await assessDraft(db, 1, draft);
  assert.deepEqual(original.warnings.map(({ code }) => code), ['recipient_changed', 'recipient_retired']);
});

test('a missing profile or outreach row is reported without implying the draft passed', async (t) => {
  const { db, profilePath } = fixture(t);
  rmSync(profilePath);
  assert.ok((await assessDraft(db, 1, draft)).warnings.some(({ code }) => code === 'profile_unavailable'));
  assert.deepEqual((await assessDraft(db, 9999, draft)).warnings.map(({ code }) => code), ['draft_not_found']);
});
