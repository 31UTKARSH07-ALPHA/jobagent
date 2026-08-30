/**
 * The classifier is the important half. It decides whether a failure means "the address was
 * wrong" (fix the contact cascade) or "we were refused" (fix the account's standing) — and
 * that distinction is the only spam signal a sender can get at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { upsertJob } from '../store/jobs.ts';
import { insertScore } from '../store/scores.ts';
import { RawJob, nowIso, type ScoreResult } from '../store/schema.ts';
import { stateOf, transition } from '../store/state.ts';
import type { StageContext } from '../stage.ts';
import type { Email } from '../gmail/messages.ts';
import { classifyBounce, isBounce, bounceMentions, runTrack, trackable, workingDaysSince } from './replies.ts';

const context = (db: Db) => {
  const counts: Record<string, number> = {};
  const logs: string[] = [];
  const faults: string[] = [];
  const ctx: StageContext = {
    db,
    dryRun: false,
    log: (m) => logs.push(m),
    count: (k, n = 1) => {
      counts[k] = (counts[k] ?? 0) + n;
    },
    fault: (m) => faults.push(m),
    signal: new AbortController().signal,
  };
  return { ctx, counts, logs, faults };
};

const judgement = (): ScoreResult => ({
  level_fit: 9, location_fit: 9, stack_fit: 8, domain_fit: 8,
  reasoning: 'why', hook: 'a hook',
});

const email = (over: Partial<Email> = {}): Email => ({
  id: 'm1',
  threadId: 't1',
  from: 'Priya <priya@acme.com>',
  fromAddress: 'priya@acme.com',
  subject: 'Re: Backend Intern',
  receivedAt: new Date(Date.now() - 60_000).toISOString(),
  text: 'Thanks for reaching out.',
  html: '',
  labelIds: [],
  ...over,
});

/** A job with a sent email awaiting an answer. */
function sent(db: Db, opts: { email?: string; thread?: string } = {}): number {
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  const { id } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: 'Acme',
      company_domain: 'acme.com',
      source: 'greenhouse',
      url: 'https://acme.com/jobs/1',
      title: 'Backend Intern',
      location: 'Bengaluru',
    }),
  );
  insertScore(db, id, 4, 90, judgement(), 'test');
  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  transition(db, id, 'MATCHED', 'DRAFTED');
  transition(db, id, 'DRAFTED', 'PENDING_APPROVAL');
  transition(db, id, 'PENDING_APPROVAL', 'SENT');

  db.prepare(
    `INSERT INTO contacts (id, company_id, email, source, confidence, mx_valid, created_at)
     VALUES (1, ?, ?, 'team_page', 'high', 1, ?)`,
  ).run(companyId, opts.email ?? 'careers@acme.com', nowIso());
  db.prepare(
    `INSERT INTO outreach (job_id, contact_id, subject, body, gmail_draft_id, gmail_thread_id,
                           drafted_at, sent_at)
     VALUES (?, 1, 'Backend Intern', 'body', 'gd-1', ?, ?, ?)`,
  ).run(id, opts.thread ?? 't1', nowIso(), new Date(Date.now() - 3_600_000).toISOString());
  return id;
}

const searching = (inbox: Email[]) =>
  async function* () {
    for (const e of inbox) yield e;
  };

test('a wrong address and a refusal are different failures', () => {
  // The whole point of the classifier: one means fix the cascade, the other means fix the
  // account's standing. Lumping them together leaves both undiagnosable.
  assert.equal(classifyBounce('550 5.1.1 The email account that you tried to reach does not exist'), 'unknown-mailbox');
  assert.equal(classifyBounce('550 5.7.1 Message rejected due to policy reasons'), 'blocked');
});

test('status codes are trusted over prose', () => {
  // Providers word the sentence differently; they agree on RFC 3463 codes.
  assert.equal(classifyBounce('5.1.10 recipient rejected'), 'unknown-mailbox');
  assert.equal(classifyBounce('5.7.26 unauthenticated email is not accepted'), 'blocked');
});

test('spam wording is caught even without a code', () => {
  for (const text of [
    'Your message was blocked as spam',
    'Sender reputation is too low',
    'Message rejected by content filter',
    'blocked using a blocklist',
  ]) {
    assert.equal(classifyBounce(text), 'blocked', text);
  }
});

test('a deferral is not a bounce', () => {
  // 4.x.x is the server asking us to come back, and BOUNCED is terminal.
  assert.equal(classifyBounce('452 4.2.2 The recipient mailbox is full, try again later'), 'temporary');
  assert.equal(classifyBounce('421 4.7.0 Try again later, greylisted'), 'temporary');
});

test('a permanent code beats a temporary one in the same report', () => {
  // NDRs often quote a retry history before the final verdict.
  assert.equal(classifyBounce('tried 4.2.2 earlier; final: 550 5.1.1 user unknown'), 'unknown-mailbox');
});

test('an unfamiliar bounce is counted rather than guessed at', () => {
  assert.equal(classifyBounce('something went wrong'), 'other');
});

test('bounce reports are told apart from human replies', () => {
  assert.equal(isBounce(email({ fromAddress: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' })), true);
  assert.equal(isBounce(email({ fromAddress: 'postmaster@acme.com', subject: 'Undeliverable: Backend Intern' })), true);
  assert.equal(isBounce(email()), false, 'a real reply from a person');
});

test('a bounce is matched to its recipient by the address in the body', () => {
  // Gmail does not reliably thread a bounce with the message that caused it.
  const ndr = email({ text: 'Your message to careers@acme.com was not delivered.' });
  assert.equal(bounceMentions(ndr, 'careers@acme.com'), true);
  assert.equal(bounceMentions(ndr, 'hr@other.com'), false);
});

test('a reply moves the job to REPLIED', async () => {
  const db = openDb(':memory:');
  const jobId = sent(db);
  const { ctx, counts } = context(db);

  await runTrack(ctx, { client: {} as never, search: searching([email()]) as never, self: 'me@gmail.com' });

  assert.equal(counts['replied'], 1);
  assert.equal(stateOf(db, jobId), 'REPLIED');
  assert.equal(trackable(context(db).ctx).length, 0, 'resolved rows are not re-checked');
});

test('a bounce moves the job to BOUNCED and records why', async () => {
  const db = openDb(':memory:');
  const jobId = sent(db);
  const { ctx, counts } = context(db);

  const ndr = email({
    fromAddress: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    text: 'Your message to careers@acme.com was not delivered.\n550 5.1.1 does not exist',
  });
  await runTrack(ctx, { client: {} as never, search: searching([ndr]) as never });

  assert.equal(counts['bounced_unknown-mailbox'], 1);
  assert.equal(stateOf(db, jobId), 'BOUNCED');
  const row = db.prepare('SELECT bounce_reason FROM outreach').get() as { bounce_reason: string };
  assert.equal(row.bounce_reason, 'unknown-mailbox');
});

test('a policy refusal is raised as a fault, not just logged', async () => {
  const db = openDb(':memory:');
  sent(db);
  const { ctx, faults } = context(db);

  const ndr = email({
    fromAddress: 'postmaster@acme.com',
    subject: 'Undeliverable',
    text: 'careers@acme.com — 550 5.7.1 message rejected as spam',
  });
  await runTrack(ctx, { client: {} as never, search: searching([ndr]) as never });

  // A wrong address is one job's problem. Being refused on policy affects every future send,
  // so it goes where the health check will report it (decision 026).
  assert.equal(faults.length, 1);
  assert.match(faults[0]!, /reputation/);
});

test('a deferral leaves the job sent and does not mark it bounced', async () => {
  const db = openDb(':memory:');
  const jobId = sent(db);
  const { ctx, counts } = context(db);

  const ndr = email({
    fromAddress: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Delay)',
    text: 'careers@acme.com — 452 4.2.2 mailbox full, will retry',
  });
  await runTrack(ctx, { client: {} as never, search: searching([ndr]) as never });

  assert.equal(counts['deferred'], 1);
  assert.equal(stateOf(db, jobId), 'SENT', 'BOUNCED is terminal; a retry is not a failure');
  assert.equal(trackable(context(db).ctx).length, 1, 'still waiting on an answer');
});

test('our own message in the thread is not a reply', async () => {
  const db = openDb(':memory:');
  const jobId = sent(db);
  const { ctx } = context(db);

  const own = email({ fromAddress: 'me@gmail.com', subject: 'Backend Intern' });
  await runTrack(ctx, { client: {} as never, search: searching([own]) as never, self: 'me@gmail.com' });

  assert.equal(stateOf(db, jobId), 'SENT');
});

test('mail that arrived before we sent is ignored', async () => {
  const db = openDb(':memory:');
  const jobId = sent(db);
  const { ctx } = context(db);

  const older = email({ receivedAt: new Date(Date.now() - 7 * 86_400_000).toISOString() });
  await runTrack(ctx, { client: {} as never, search: searching([older]) as never });

  assert.equal(stateOf(db, jobId), 'SENT');
});

test('a reply in somebody else\'s thread is not ours', async () => {
  const db = openDb(':memory:');
  const jobId = sent(db, { thread: 't1' });
  const { ctx } = context(db);

  await runTrack(ctx, { client: {} as never, search: searching([email({ threadId: 'other' })]) as never });

  assert.equal(stateOf(db, jobId), 'SENT');
});

test('nothing sent means no mailbox read at all', async () => {
  const db = openDb(':memory:');
  let searched = false;
  const { ctx } = context(db);

  await runTrack(ctx, {
    client: {} as never,
    search: (() => {
      searched = true;
      return searching([])();
    }) as never,
  });

  assert.equal(searched, false);
});

test('waiting is counted in working days, which is the recruiter\'s clock', () => {
  // Decision 039 is judged on "four or five working days", so a Friday send must not read as
  // overdue on Sunday.
  const friday = new Date('2026-08-28T10:00:00Z'); // a Friday
  const sunday = new Date('2026-08-30T10:00:00Z');
  const wednesday = new Date('2026-09-02T10:00:00Z');

  assert.equal(workingDaysSince(friday.toISOString(), sunday), 0, 'the weekend does not count');
  assert.equal(workingDaysSince(friday.toISOString(), wednesday), 3);
});

test('a same-day send has waited no time at all', () => {
  const now = new Date('2026-09-02T18:00:00Z');
  assert.equal(workingDaysSince('2026-09-02T09:00:00Z', now), 0);
});
