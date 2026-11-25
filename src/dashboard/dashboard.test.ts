import { createFollowup, changeFollowup, setOutcome, trackingData } from "./tracking.ts";
import { localReview } from "./local-review.ts";

import { request as httpRequest } from "node:http";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../store/db.ts';
import { approveDraft, dashboardData, dashboardServer } from './server.ts';
import type { gmail_v1 } from "@googleapis/gmail";
import { deleteDraft, readReplies } from "./mail.ts";
import { archiveDraft, regenerateDraft, saveDraft, updateApplication } from "./outreach.ts";



function seed() {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO companies (id,name,domain,created_at,updated_at) VALUES (1,'Example','example.com','2026-11-01','2026-11-01');
    INSERT INTO contacts (id,company_id,email,source,confidence,mx_valid,created_at)
      VALUES (1,1,'careers@example.com','posting','high',1,'2026-11-01');
    INSERT INTO jobs (id,company_id,dedup_key,source,url,title,state,state_changed_at,first_seen_at,last_seen_at) VALUES
      (1,1,'a','gmail-alert','https://example.com/a','AI Intern','PENDING_APPROVAL','2026-11-01','2026-11-01','2026-11-01'),
      (2,1,'b','gmail-alert','https://example.com/b','Backend Intern','PENDING_APPROVAL','2026-11-02','2026-11-02','2026-11-02'),
      (3,1,'c','gmail-alert','https://example.com/c','Frontend Intern','SENT','2026-11-03','2026-11-03','2026-11-03'),
      (4,1,'d','gmail-alert','https://example.com/d','Old Intern','REJECTED_BY_USER','2026-09-04','2026-09-01','2026-09-04');
    INSERT INTO outreach (id,job_id,contact_id,subject,body,gmail_draft_id,drafted_at,sent_at) VALUES
      (1,1,1,'One','Body','draft1','2026-11-02',NULL),
      (2,2,1,'Two','Body','draft2','2026-11-03',NULL),
      (3,3,1,'Three','Body','draft3','2026-11-04','2026-11-04'),
      (4,4,1,'Four','Body','draft4','2026-09-03',NULL);
  `);
  return db;
}

test('dashboard returns recent jobs and outreach history, newest first', () => {
  const db = seed();
  try {
    const data = dashboardData(db, new Date('2026-11-24'));
    assert.deepEqual(data.jobs.map((j) => j.id), [3, 2, 1]);
    assert.deepEqual(data.drafts.map((d) => d.id), [3, 2, 1, 4]);
    assert.equal(data.drafts[0]?.body, 'Body');
  } finally { db.close(); }
});

test('send action is disarmed by default and can only approve a live draft once', (t) => {
  const db = seed();
  t.after(() => db.close());
  const previous = process.env['JOBAGENT_SEND'];
  t.after(() => { if (previous === undefined) delete process.env['JOBAGENT_SEND']; else process.env['JOBAGENT_SEND'] = previous; });
  process.env['JOBAGENT_SEND'] = 'disarmed';
  assert.equal(approveDraft(db, 1).status, 409);
  assert.equal(db.prepare('SELECT approved_at FROM outreach WHERE id = 1').get()?.approved_at, null);
  process.env['JOBAGENT_SEND'] = 'armed';
  assert.equal(approveDraft(db, 3).status, 409);
  assert.equal(approveDraft(db, 4).status, 409);
  assert.equal(approveDraft(db, 1).status, 200);
  assert.equal(approveDraft(db, 1).status, 409);
  const row = db.prepare('SELECT approved_at, sent_at FROM outreach WHERE id = 1').get();
  assert.ok(row?.approved_at);
  assert.equal(row?.sent_at, null);
  db.exec("UPDATE contacts SET dead_at = '2026-11-23' WHERE id = 1");
  assert.equal(approveDraft(db, 2).status, 409);
});

test('delete retains outreach history and blocks sending before calling Gmail', async () => {
  const db = seed();
  let attempts = 0;
  const gmail = { users: { drafts: {
    get: async () => ({ data: { message: { labelIds: ['DRAFT'] } } }),
    delete: async () => {
      assert.equal(db.prepare('SELECT state FROM jobs WHERE id = 1').get()?.state, 'REJECTED_BY_USER');
      if (!attempts++) throw new Error('temporary Gmail failure');
    },
  } } } as unknown as gmail_v1.Gmail;
  try {
    assert.equal((await deleteDraft(db, 1, gmail)).status, 502);
    assert.ok(dashboardData(db, new Date('2026-11-24')).drafts.find((d) => d.id === 1)?.delete_requested_at);
    assert.equal((await deleteDraft(db, 1, gmail)).status, 200);
    const row = db.prepare('SELECT gmail_draft_id, sent_at FROM outreach WHERE id = 1').get();
    assert.ok(row);
    assert.equal(row.gmail_draft_id, null);
    assert.equal(row.sent_at, null);
    assert.equal((await deleteDraft(db, 1, gmail)).status, 409);
  } finally { db.close(); }
});

test('delete protects approved drafts and a draft Gmail says was manually sent', async () => {
  const db = seed();
  const gmail = { users: { drafts: {
    get: async ({ id }: { id: string }) => {
      assert.equal(id, 'draft1');
      return { data: { message: { labelIds: ['SENT'] } } };
    },
    delete: async () => assert.fail('must not delete sent or approved mail'),
  } } } as unknown as gmail_v1.Gmail;
  try {
    db.exec("UPDATE outreach SET approved_at = '2026-11-23' WHERE id = 2");
    assert.equal((await deleteDraft(db, 2, gmail)).status, 409);
    assert.equal((await deleteDraft(db, 1, gmail)).status, 409);
    assert.equal(db.prepare('SELECT state FROM jobs WHERE id = 1').get()?.state, 'PENDING_APPROVAL');
  } finally { db.close(); }
});

test('reply inbox reads only tracked outreach threads and excludes own mail and bounces', async () => {
  const db = seed();
  const at = Date.parse('2026-11-05');
  const msg = (id: string, from: string, labelIds: string[], timestamp = at) => ({
    id, internalDate: String(timestamp), labelIds,
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: 'SGVsbG8' } },
  });
  const gmail = { users: { threads: { get: async ({ id }: { id: string }) => {
    assert.equal(id, 'example-thread');
    return { data: { messages: [msg('original', 'me@example.com', []), msg('mine', 'me@example.com', ['SENT']),
      msg('bounce', 'mailer-daemon@example.com', ['INBOX']), msg('older', 'hr@example.com', [], at - 3 * 86400_000),
      msg('reply', 'hr@example.com', ['INBOX'])] } };
  } } } } as unknown as gmail_v1.Gmail;
  try {
    db.exec("UPDATE outreach SET gmail_thread_id = 'example-thread', gmail_message_id = 'original' WHERE id = 3");
    const { checked, unavailable, replies } = await readReplies(db, gmail);
    assert.deepEqual([checked, unavailable], [1, 0]);
    assert.deepEqual(replies.map((reply) => [reply.id, reply.company, reply.text]), [['reply', 'Example', 'Hello']]);
  } finally { db.close(); }
});

test('a concurrent manual send is not cleared from the ledger after Gmail returns 404 on delete', async () => {
  const db = seed();
  let lookups = 0;
  const gmail = { users: { drafts: {
    get: async () => ({ data: { message: { labelIds: [lookups++ ? 'SENT' : 'DRAFT'] } } }),
    delete: async () => { throw Object.assign(new Error('not found'), { code: 404 }); },
  } } } as unknown as gmail_v1.Gmail;
  try {
    assert.equal((await deleteDraft(db, 1, gmail)).status, 409);
    const row = db.prepare('SELECT gmail_draft_id, delete_requested_at FROM outreach WHERE id = 1').get();
    assert.equal(row?.gmail_draft_id, 'draft1');
    assert.equal(row?.delete_requested_at, null);
  } finally { db.close(); }
});

test('local revisions preserve the original message and cannot enter the send queue', () => {
  const db = seed();
  try {
    const fields = { email: 'new@example.com', subject: 'Updated', body: 'Updated body', revision: 0 };
    assert.equal(saveDraft(db, 1, fields).status, 200);
    assert.equal(saveDraft(db, 1, fields).status, 409);
    assert.equal(saveDraft(db, 3, fields).status, 409);
    const original = db.prepare('SELECT subject, body, sent_at, approved_at FROM outreach WHERE id=1').get();
    assert.deepEqual({ ...original }, { subject: 'One', body: 'Body', sent_at: null, approved_at: null });
    const draft = dashboardData(db).drafts.find((d) => d.id === 1)!;
    assert.deepEqual([draft.subject, draft.email, draft.revision, draft.local_only], ['Updated', 'new@example.com', 1, 1]);
    assert.equal(approveDraft(db, 1, 1).status, 409);
    const proposal = regenerateDraft(db, 1);
    assert.ok(proposal?.subject.includes('AI Intern'));
    assert.equal(dashboardData(db).drafts.find((d) => d.id === 1)?.subject, 'Updated');
  } finally { db.close(); }
});

test('archive, restore, and application links preserve outreach history', () => {
  const db = seed();
  try {
    assert.equal(archiveDraft(db, 1, true).status, 200);
    assert.equal(dashboardData(db).drafts.find((d) => d.id === 1)?.status, 'Archived');
    assert.equal(archiveDraft(db, 1, false).status, 200);
    assert.equal(archiveDraft(db, 3, true).status, 409);
    const followUpAt = '2026-12-01T12:00:00.000Z';
    assert.equal(updateApplication(db, 1, { create: true, followUpAt, allowUnsent: true }).status, 200);
    const data = dashboardData(db);
    assert.equal(data.applications.length, 1);
    assert.equal(data.drafts.find((d) => d.id === 1)?.follow_up_at, followUpAt);
    assert.equal(updateApplication(db, 2, { applicationId: Number(data.applications[0]!.id) }).status, 200);
    assert.equal(updateApplication(db, 1, { applicationId: 999 }).status, 404);
    assert.equal(dashboardData(db).drafts.find((d) => d.id === 2)?.application_title, 'AI Intern');
  } finally { db.close(); }
});

test('dashboard mutations require local origin, action header, and valid input', async () => {
  const db = seed();
  const server = dashboardServer(db, 0);
  // The HTTP Host guard is tied to the configured dashboard origin; use a synthetic host
  // over the test listener so the OS can choose the actual port.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const request = (origin: string, input: unknown) => new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname:'127.0.0.1', port, path:'/api/drafts/1/edit', method:'POST',
        headers:{ host:'127.0.0.1:0', origin, 'X-JobAgent-Action':'edit', 'Content-Type':'application/json' } },
      (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.once('error', reject);
      req.end(JSON.stringify(input));
    });
    const fields = { email:'new@example.com', subject:'New', body:'Body', revision:0 };
    assert.equal(await request('http://example.com', fields), 403);
    assert.equal(await request('http://127.0.0.1:0', { ...fields, subject:'bad\nheader' }), 400);
    assert.equal(await request('http://127.0.0.1:0', fields), 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('follow-ups require explicit unsent consent, track changes, and cannot reopen completed records', () => {
  const db=seed();
  try {
    const input={date:'2099-12-10',note:'Initial note',allowUnsent:false};
    assert.equal(createFollowup(db,999,input).status,404);
    assert.equal(createFollowup(db,1,input).status,409);
    assert.equal(createFollowup(db,1,{...input,allowUnsent:true}).status,200);
    const id=Number(trackingData(db).followups[0]!.id);
    assert.equal(changeFollowup(db,id,{action:'snooze',date:'2000-01-01'}).status,400);
    assert.equal(changeFollowup(db,id,{action:'snooze',date:'2099-12-11'}).status,200);
    assert.equal(changeFollowup(db,id,{action:'note',note:'Another note'}).status,200);
    assert.equal(changeFollowup(db,id,{action:'complete'}).status,200);
    assert.equal(changeFollowup(db,id,{action:'complete'}).status,409);
    assert.equal(changeFollowup(db,id,{action:'reschedule',date:'2099-12-12'}).status,409);
    const tracked=trackingData(db);
    assert.equal(tracked.analytics?.completed,1);
    const events=tracked.activity.filter((e)=>e.followup_id===id);
    assert.equal(events.length,5);
    assert.ok(events.every((e)=>e.source==='manual' && Number.isFinite(Date.parse(String(e.at)))));
  } finally { db.close(); }
});

test('manual outcomes never fabricate reply timestamps and do not double-count responses', () => {
  const db=seed();
  try {
    assert.equal(setOutcome(db,1,'Interested').status,409);
    assert.equal(setOutcome(db,3,'Interview Scheduled').status,200);
    assert.equal(trackingData(db).analytics?.manualOnlyReplies,1);
    assert.equal(db.prepare('SELECT replied_at FROM outreach WHERE id=3').get()?.replied_at,null);
    db.exec("UPDATE outreach SET replied_at='2026-11-08T12:00:00.000Z' WHERE id=3");
    const tracked=trackingData(db);
    assert.equal(tracked.analytics?.manualOnlyReplies,0);
    assert.equal(tracked.analytics?.recordedReplies,1);
    assert.equal(tracked.analytics?.confirmedReplies,1);
    assert.equal(tracked.analytics?.interviews,1);
    assert.equal(tracked.analytics?.confirmedSent,0);
    assert.ok(tracked.activity.some((e)=>e.kind==='Reply recorded' && e.source==='integration'));
  } finally { db.close(); }
});

test('local review is advisory, loopback-only, and rejects unmatched replacements', async () => {
  const db=seed();
  const previous=process.env.JOBAGENT_OLLAMA_MODEL;
  process.env.JOBAGENT_OLLAMA_MODEL='test-local';
  try {
    const stub: typeof fetch=async (url,options)=>{
      assert.equal(url,'http://127.0.0.1:11434/api/chat');
      assert.equal(options?.redirect,'error');
      return Response.json({message:{content:JSON.stringify({suggestions:[
        {advice:'Fix the wording',field:'body',before:'Body',after:'New wording'},
        {advice:'Check this fact',field:'subject',before:'Not in draft',after:'No'},
      ]})}});
    };
    const reviewed=await localReview(db,1,{email:'careers@example.com',subject:'One',body:'Body'},stub);
    assert.equal(reviewed.status,200);
    assert.deepEqual(reviewed.suggestions?.map((item)=>item.field),['body','advice']);
    assert.equal(db.prepare('SELECT body FROM outreach WHERE id=1').get()?.body,'Body');
  } finally {
    if (previous===undefined) delete process.env.JOBAGENT_OLLAMA_MODEL; else process.env.JOBAGENT_OLLAMA_MODEL=previous;
    db.close();
  }
});
