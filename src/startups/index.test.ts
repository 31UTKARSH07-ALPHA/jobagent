import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../store/db.ts';
import type { Profile, YcCompanyPage, YcIndexCompany } from '../store/schema.ts';
import { discover, draftBest, findContactsForShortlist, markDead, notifyNewRoles, shortlist, MAX_UNSENT_DRAFTS } from './index.ts';
import { parseCompanyPage } from './yc.ts';
import { greetingFor } from './draft.ts';

const quiet = () => {};

const company = (over: Partial<YcIndexCompany> = {}): YcIndexCompany => ({
  name: 'Ressl AI',
  slug: 'ressl-ai',
  website: 'https://fictional.example',
  all_locations: 'Bengaluru, KA, India',
  long_description: 'Agents.',
  one_liner: 'Train, eval and build autonomous agents',
  team_size: 3,
  tags: ['Artificial Intelligence'],
  industries: ['B2B'],
  regions: ['India', 'South Asia'],
  batch: 'Winter 2026',
  status: 'Active',
  stage: 'Early',
  isHiring: true,
  url: 'https://www.ycombinator.com/companies/ressl-ai',
  ...over,
});

const page: YcCompanyPage = {
  company: {
    github_url: null,
    founders: [
      { full_name: 'Asha Rao', title: 'Founder/CEO', is_active: true },
      { full_name: 'Avery Stone', title: 'Founder/CTO', is_active: true },
    ],
  },
  launches: [],
  newsItems: [],
  jobPostings: [
    {
      id: '1',
      title: 'Software Engineering Intern',
      url: '/companies/ressl-ai/jobs/1',
      location: 'Bengaluru, KA, IN',
      type: 'Internship',
      role: 'eng',
      salaryRange: '₹25K - ₹75K INR / monthly',
      minExperience: '',
      visa: null,
    },
  ],
};

const deps = {
  fetchIndex: async () => [
    company(),
    // Not early, and a big company: never fetched.
    company({ name: 'BigCo', slug: 'bigco', stage: 'Growth', team_size: 900 }),
  ],
  fetchCompanyPage: async () => page,
  fetchPeakXvJobs: async () => [],
};

test('discovery keeps early-stage startups, and running it twice changes nothing', async () => {
  const db = openDb(':memory:');
  const first = await discover(db, quiet, {}, deps);
  assert.equal(first.candidates, 1);
  await discover(db, quiet, {}, deps);

  assert.equal((db.prepare('SELECT count(*) AS n FROM startups').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT count(*) AS n FROM startup_people').get() as { n: number }).n, 2);
  assert.equal((db.prepare('SELECT count(*) AS n FROM startup_roles').get() as { n: number }).n, 1);

  const [top] = shortlist(db);
  assert.equal(top?.startup.name, 'Ressl AI');
  assert.match(top?.fit.why ?? '', /internship listed/);
});

const profile = { name: 'Example Candidate' } as Profile;
const noNetwork = {
  fetchJobPage: async () => ({
    job: { description: 'Build agent benchmarks.', interview_process: 'Take-home', hiringManager: { first_name: 'Abhishek', last_name: 'E' } },
  }),
  fetchHnStories: async () => [],
};
const fakeDrafter = {
  model: 'fake',
  compose: async (_s: unknown, _r: unknown, _p: Profile, name: string | null, _w: string, _l: unknown) => ({
    subject: 'Software intern — agents',
    body: `${greetingFor(name, 'Ressl AI')}\n\nI built something.\n\nExample Candidate`,
  }),
};

async function seeded() {
  const db = openDb(':memory:');
  await discover(db, quiet, {}, deps);
  await findContactsForShortlist(db, quiet, {}, {
    findContacts: async () => [],
    hasMx: async () => true,
  });
  return db;
}

test('contacts: the CTO is guessed when nothing is published, and marked low', async () => {
  const db = await seeded();
  const row = db.prepare('SELECT email, source, confidence, name FROM startup_contacts').get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { email: 'avery@fictional.example', source: 'guess', confidence: 'low', name: 'Avery Stone' });
});

test('drafting writes one Gmail draft per startup, ever, greeting the founder by name', async () => {
  const db = await seeded();
  const written: { to: string; body: string }[] = [];
  const writeDraft = async (d: { to: string; body: string }) => {
    written.push(d);
    return { draftId: `d${written.length}`, messageId: null, threadId: null };
  };

  await draftBest(db, quiet, {}, { drafter: fakeDrafter, writeDraft, profile, brief: noNetwork });
  await draftBest(db, quiet, {}, { drafter: fakeDrafter, writeDraft, profile, brief: noNetwork });

  assert.equal(written.length, 1);
  assert.equal(written[0]?.to, 'avery@fictional.example');
  assert.match(written[0]?.body ?? '', /^Hi Avery,/);
});

test('a dry run drafts nothing', async () => {
  const db = await seeded();
  let calls = 0;
  await draftBest(db, quiet, { dryRun: true }, {
    drafter: fakeDrafter,
    writeDraft: async () => {
      calls++;
      return { draftId: 'x', messageId: null, threadId: null };
    },
    profile,
    brief: noNetwork,
  });
  assert.equal(calls, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM startup_outreach').get() as { n: number }).n, 0);
});

test('never a second cold email to a company the job pipeline already wrote to', async () => {
  const db = await seeded();
  // The job pipeline's own tables, as the pipeline would have left them.
  const now = new Date().toISOString();
  const companyId = Number(
    db
      .prepare(`INSERT INTO companies (name, domain, ats_type, created_at, updated_at) VALUES ('Ressl', 'fictional.example', 'none', ?, ?)`)
      .run(now, now).lastInsertRowid,
  );
  const jobId = Number(
    db
      .prepare(
        `INSERT INTO jobs (company_id, dedup_key, source, url, title, state, state_changed_at, first_seen_at, last_seen_at)
         VALUES (?, ?, 'manual', 'https://fictional.example/j', 'Intern', 'DRAFTED', ?, ?, ?)`,
      )
      .run(companyId, 'k'.repeat(64), now, now, now).lastInsertRowid,
  );
  const contactId = Number(
    db
      .prepare(`INSERT INTO contacts (company_id, email, source, confidence, created_at) VALUES (?, 'hi@fictional.example', 'team_page', 'high', ?)`)
      .run(companyId, now).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO outreach (job_id, contact_id, subject, body, gmail_draft_id, drafted_at) VALUES (?, ?, 's', 'b', 'g1', ?)`,
  ).run(jobId, contactId, now);

  let calls = 0;
  await draftBest(db, quiet, {}, {
    drafter: fakeDrafter,
    writeDraft: async () => {
      calls++;
      return { draftId: 'x', messageId: null, threadId: null };
    },
    profile,
    brief: noNetwork,
  });
  assert.equal(calls, 0);
});

test('a bounced address is retired and not drafted', async () => {
  const db = await seeded();
  assert.equal(markDead(db, 'AVERY@fictional.example'), 1);
  let calls = 0;
  await draftBest(db, quiet, {}, {
    drafter: fakeDrafter,
    writeDraft: async () => {
      calls++;
      return { draftId: 'x', messageId: null, threadId: null };
    },
    profile,
    brief: noNetwork,
  });
  assert.equal(calls, 0);
});

test('drafting stops while too many are waiting unsent', async () => {
  const db = await seeded();
  const startupId = (db.prepare('SELECT id FROM startups').get() as { id: number }).id;
  const contactId = (db.prepare('SELECT id FROM startup_contacts').get() as { id: number }).id;
  // Fill the unsent queue with other startups' drafts.
  for (let i = 0; i < MAX_UNSENT_DRAFTS; i++) {
    const now = new Date().toISOString();
    const id = Number(
      db
        .prepare(
          `INSERT INTO startups (source, source_id, name, source_url, first_seen_at, last_seen_at) VALUES ('yc', ?, ?, 'https://x.y/z', ?, ?)`,
        )
        .run(`s${i}`, `S${i}`, now, now).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO startup_outreach (startup_id, contact_id, subject, body, gmail_draft_id, drafted_at) VALUES (?, ?, 's', 'b', ?, ?)`,
    ).run(id, contactId, `g${i}`, now);
  }
  assert.ok(startupId > 0);
  const result = await draftBest(db, quiet, {}, { drafter: fakeDrafter, writeDraft: async () => ({ draftId: 'x', messageId: null, threadId: null }), profile, brief: noNetwork });
  assert.equal(result.drafted, 0);
});

test('a YC company page is read from its embedded data', () => {
  const props = { company: { github_url: 'https://github.com/acme', founders: [{ full_name: 'A B', title: 'CTO', is_active: true }] }, jobPostings: [] };
  const html = `<div data-page="${JSON.stringify({ props }).replace(/"/g, '&quot;')}"></div>`;
  const parsed = parseCompanyPage(html);
  assert.equal(parsed?.company.founders[0]?.full_name, 'A B');
  assert.equal(parseCompanyPage('<html></html>'), null);
});

test('the brief is printed before the email, and the drafter gets the role description', async () => {
  const db = await seeded();
  const lines: string[] = [];
  let seenDescription = '';
  await draftBest(db, (m) => lines.push(m), { dryRun: true }, {
    drafter: {
      model: 'fake',
      compose: async (s, role, p, name, w, l) => {
        seenDescription = role?.description ?? '';
        return fakeDrafter.compose(s, role, p, name, w, l);
      },
    },
    profile,
    brief: noNetwork,
  });
  const out = lines.join('\n');
  assert.ok(out.indexOf('THE ROLE') < out.indexOf('── EMAIL'), 'brief first');
  assert.match(out, /Build agent benchmarks\./);
  assert.match(out, /Hiring manager on YC: Abhishek E/);
  assert.equal(seenDescription, 'Build agent benchmarks.');
});

test('new startup roles go to Telegram once, as plain lines with no buttons', async () => {
  const db = openDb(':memory:');
  await discover(db, quiet, {}, deps);
  const sent: string[] = [];
  const send = async (text: string) => {
    sent.push(text);
  };

  assert.equal(await notifyNewRoles(db, quiet, { send }), 1);
  assert.equal(await notifyNewRoles(db, quiet, { send }), 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? '', /<b>Ressl AI<\/b> — <a href="https:\/\/www\.ycombinator\.com\/companies\/ressl-ai\/jobs\/1">Software Engineering Intern<\/a>/);
  assert.doesNotMatch(sent[0] ?? '', /approve|reject/i);
});

test('a failed Telegram send leaves the roles to be announced next time', async () => {
  const db = openDb(':memory:');
  await discover(db, quiet, {}, deps);
  await assert.rejects(notifyNewRoles(db, quiet, { send: async () => { throw new Error('offline'); } }));
  assert.equal(await notifyNewRoles(db, quiet, { send: async () => {} }), 1);
});
