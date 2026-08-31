/**
 * Approval is a permission boundary. Most of these tests are about what must *not* happen:
 * a tap from the wrong chat, a second tap on the same draft, or an approval quietly becoming
 * a send without going through the queue.
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
import { runApprove, readOffset, formatAsk, MAX_ASKS_PER_RUN } from './approve.ts';
import { decodeCallback, encodeCallback, type Tap } from './telegram.ts';

const config = { token: 't', chatId: '4242' };

const context = (db: Db, dryRun = false) => {
  const counts: Record<string, number> = {};
  const logs: string[] = [];
  const faults: string[] = [];
  const ctx: StageContext = {
    db,
    dryRun,
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
  level_fit: 9, location_fit: 9, stack_fit: 8, domain_fit: 8, reasoning: 'why', hook: 'hook',
});

let seq = 0;

/** A drafted job sitting in the approval queue. Returns its outreach id. */
function pending(db: Db, opts: { company?: string } = {}): { outreachId: number; jobId: number } {
  const company = opts.company ?? `Co${seq++}`;
  const domain = `${company.toLowerCase()}.com`;
  const companyId = upsertCompany(db, { name: company, domain });
  const { id } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: company,
      company_domain: domain,
      source: 'greenhouse',
      url: `https://${domain}/jobs/1`,
      title: 'Backend Intern',
      location: 'Bengaluru',
    }),
  );
  insertScore(db, id, 4, 84, judgement(), 'test');
  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  transition(db, id, 'MATCHED', 'DRAFTED');
  transition(db, id, 'DRAFTED', 'PENDING_APPROVAL');

  const contact = db
    .prepare(
      `INSERT INTO contacts (company_id, email, source, confidence, mx_valid, created_at)
       VALUES (?, ?, 'pattern', 'low', 1, ?) RETURNING id`,
    )
    .get(companyId, `careers@${domain}`, nowIso()) as { id: number };

  const row = db
    .prepare(
      `INSERT INTO outreach (job_id, contact_id, subject, body, gmail_draft_id, drafted_at)
       VALUES (?, ?, 'Backend Intern', 'Hi there.', ?, ?) RETURNING id`,
    )
    .get(id, contact.id, `draft-${id}`, nowIso()) as { id: number };

  return { outreachId: row.id, jobId: id };
}

const stubs = (taps: Tap[] = []) => {
  const asked: string[] = [];
  const answers: string[] = [];
  return {
    asked,
    answers,
    ask: async (_c: unknown, text: string) => {
      asked.push(text);
      return { message_id: 100 + asked.length };
    },
    taps: async () => taps,
    answer: async (_c: unknown, _id: string, text: string) => void answers.push(text),
    settle: async () => {},
  };
};

const tap = (outreachId: number, action: 'approve' | 'reject', over: Partial<Tap> = {}): Tap => ({
  updateId: 1,
  callbackId: 'cb1',
  data: { action, outreachId },
  chatId: config.chatId,
  messageId: 100,
  ...over,
});

test('the whole email is shown, not a summary', () => {
  // Approving something you have not read is a rubber stamp, which is the opposite of why
  // this exists.
  const db = openDb(':memory:');
  const { outreachId } = pending(db, { company: 'Acme' });
  const item = db
    .prepare(
      `SELECT o.id AS outreach_id, o.job_id, c.name AS company, j.title, j.url, k.email,
              k.confidence, o.subject, o.body
         FROM outreach o JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id JOIN contacts k ON k.id = o.contact_id
        WHERE o.id = ?`,
    )
    .get(outreachId) as never;

  const text = formatAsk(item);
  assert.match(text, /Hi there\./, 'the body itself');
  assert.match(text, /careers@acme\.com/);
  assert.match(text, /guessed/, 'and how much to trust the address');
});

test('each draft is asked about once, however often the agent runs', async () => {
  const db = openDb(':memory:');
  pending(db);
  const s = stubs();

  await runApprove(context(db).ctx, { config, ...s });
  await runApprove(context(db).ctx, { config, ...s });

  assert.equal(s.asked.length, 1);
});

test('a tap approves without sending anything', async () => {
  // Approval is permission, not delivery: it joins the 09:00 queue like an auto-send.
  const db = openDb(':memory:');
  const { outreachId, jobId } = pending(db);
  const { ctx, counts } = context(db);

  await runApprove(ctx, { config, ...stubs([tap(outreachId, 'approve')]) });

  const row = db.prepare('SELECT approved_at, sent_at FROM outreach WHERE id = ?').get(outreachId) as {
    approved_at: string | null; sent_at: string | null;
  };
  assert.notEqual(row.approved_at, null);
  assert.equal(row.sent_at, null, 'still waiting for its slot');
  assert.equal(stateOf(db, jobId), 'PENDING_APPROVAL');
  assert.equal(counts['approved'], 1);
});

test('a reject is terminal', async () => {
  const db = openDb(':memory:');
  const { outreachId, jobId } = pending(db);
  const { ctx, counts } = context(db);

  await runApprove(ctx, { config, ...stubs([tap(outreachId, 'reject')]) });

  assert.equal(stateOf(db, jobId), 'REJECTED_BY_USER');
  assert.equal(counts['rejected'], 1);
});

test('rejecting after approving clears the approval', async () => {
  // Changing your mind is legitimate, and it left a row that was both APPROVED and
  // REJECTED_BY_USER. The send query is guarded on state, but that safety should not rest
  // on a single clause.
  const db = openDb(':memory:');
  const { outreachId, jobId } = pending(db);

  await runApprove(context(db).ctx, { config, ...stubs([tap(outreachId, 'approve')]) });
  await runApprove(context(db).ctx, { config, ...stubs([tap(outreachId, 'reject', { updateId: 2 })]) });

  const row = db.prepare('SELECT approved_at FROM outreach WHERE id = ?').get(outreachId) as {
    approved_at: string | null;
  };
  assert.equal(row.approved_at, null, 'no row is ever both approved and rejected');
  assert.equal(stateOf(db, jobId), 'REJECTED_BY_USER');
});

test('every tap is accounted for in the log, including the boring ones', async () => {
  // A batch reporting "6 taps" and explaining two of them is how an hour went into
  // diagnosing a system that was working correctly.
  const db = openDb(':memory:');
  const { outreachId } = pending(db);

  const { ctx, counts } = context(db);
  await runApprove(ctx, {
    config,
    ...stubs([tap(outreachId, 'reject'), tap(outreachId, 'approve', { updateId: 2 }), tap(9999, 'approve', { updateId: 3 })]),
  });

  assert.equal(counts['rejected'], 1);
  assert.equal(counts['tap_already_decided'], 1);
  assert.equal(counts['tap_unknown'], 1);
});

test('a tap from another chat cannot approve anything', async () => {
  // The token is a secret, but a leaked one must not be able to send mail in his name.
  const db = openDb(':memory:');
  const { outreachId } = pending(db);
  const { ctx, counts, faults } = context(db);

  await runApprove(ctx, { config, ...stubs([tap(outreachId, 'approve', { chatId: '9999' })]) });

  const row = db.prepare('SELECT approved_at FROM outreach WHERE id = ?').get(outreachId) as {
    approved_at: string | null;
  };
  assert.equal(row.approved_at, null);
  assert.equal(counts['tap_rejected'], 1);
  assert.match(faults[0]!, /not the configured one/);
});

test('an ignored tap still advances the cursor', async () => {
  // Otherwise one bad update replays forever and blocks every real tap behind it.
  const db = openDb(':memory:');
  const { outreachId } = pending(db);
  const { ctx } = context(db);

  await runApprove(ctx, { config, ...stubs([tap(outreachId, 'approve', { updateId: 77, chatId: '9999' })]) });

  assert.equal(readOffset(ctx), 78);
});

test('tapping twice does not approve twice', async () => {
  const db = openDb(':memory:');
  const { outreachId, jobId } = pending(db);

  await runApprove(context(db).ctx, { config, ...stubs([tap(outreachId, 'reject')]) });
  const second = context(db);
  await runApprove(second.ctx, { config, ...stubs([tap(outreachId, 'approve', { updateId: 2 })]) });

  assert.equal(stateOf(db, jobId), 'REJECTED_BY_USER', 'the first decision stands');
  assert.equal(second.counts['approved'], undefined);
});

test('a tap on an already-sent draft is refused', async () => {
  const db = openDb(':memory:');
  const { outreachId, jobId } = pending(db);
  db.prepare('UPDATE outreach SET sent_at = ? WHERE id = ?').run(nowIso(), outreachId);
  transition(db, jobId, 'PENDING_APPROVAL', 'SENT');

  const s = stubs([tap(outreachId, 'approve')]);
  const { ctx, counts } = context(db);
  await runApprove(ctx, { config, ...s });

  assert.equal(counts['approved'], undefined);
  assert.match(s.answers[0]!, /Already sent/i);
});

test('a tap for a draft that no longer exists is handled, not crashed on', async () => {
  const db = openDb(':memory:');
  const s = stubs([tap(9999, 'approve')]);
  await runApprove(context(db).ctx, { config, ...s });
  assert.match(s.answers[0]!, /gone/i);
});

test('only a few decisions are asked for at a time', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < MAX_ASKS_PER_RUN + 2; i++) pending(db);
  const s = stubs();

  await runApprove(context(db).ctx, { config, ...s });

  // A phone full of decisions is a phone put down.
  assert.equal(s.asked.length, MAX_ASKS_PER_RUN);
});

test('a dry run asks nobody', async () => {
  const db = openDb(':memory:');
  pending(db);
  const s = stubs();

  const { ctx, counts } = context(db, true);
  await runApprove(ctx, { config, ...s });

  assert.equal(s.asked.length, 0);
  assert.equal(counts['would_ask'], 1);
});

test('a failed ask is retried next run rather than lost', async () => {
  const db = openDb(':memory:');
  pending(db);
  const { ctx, counts } = context(db);

  await runApprove(ctx, {
    config,
    ...stubs(),
    ask: async () => {
      throw new Error('telegram down');
    },
  });
  assert.equal(counts['ask_failed'], 1);

  const s = stubs();
  await runApprove(context(db).ctx, { config, ...s });
  assert.equal(s.asked.length, 1);
});

test('button payloads survive the round trip and reject junk', () => {
  assert.equal(encodeCallback({ action: 'approve', outreachId: 12 }), 'a:12');
  assert.deepEqual(decodeCallback('r:7'), { action: 'reject', outreachId: 7 });
  assert.equal(decodeCallback('drop table'), null);
  assert.equal(decodeCallback('a:'), null);
});
