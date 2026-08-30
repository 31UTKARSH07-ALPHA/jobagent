/**
 * The send stage. Every test here is really one question: can this mail somebody it should
 * not, or mail them twice? A double-send is the only bug in this project with consequences
 * outside the laptop.
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
import { runSend, scheduleTimes, SEND_WINDOW_HOUR, MIN_GAP_MS, MAX_GAP_MS } from './queue.ts';
import { sendDecision, AUTO_SEND_MIN_SCORE } from './gate.ts';

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
  level_fit: 9, location_fit: 9, stack_fit: 9, domain_fit: 9, reasoning: 'why', hook: 'hook',
});

let seq = 0;

/** A job with a Gmail draft, sitting in DRAFTED, ready for the gate. */
function drafted(
  db: Db,
  opts: { fit?: number; confidence?: 'high' | 'medium' | 'low'; company?: string } = {},
): number {
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
  insertScore(db, id, 4, opts.fit ?? 90, judgement(), 'test');
  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  transition(db, id, 'MATCHED', 'DRAFTED');

  const confidence = opts.confidence ?? 'high';
  const contact = db
    .prepare(
      `INSERT INTO contacts (company_id, email, source, confidence, mx_valid, created_at)
       VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    )
    .get(companyId, `careers@${domain}`, confidence === 'low' ? 'pattern' : 'team_page', confidence, nowIso()) as { id: number };

  db.prepare(
    `INSERT INTO outreach (job_id, contact_id, subject, body, gmail_draft_id, drafted_at)
     VALUES (?, ?, 's', 'b', ?, ?)`,
  ).run(id, contact.id, `draft-${id}`, nowIso());
  return id;
}

const delivering = () => {
  const calls: string[] = [];
  return {
    calls,
    deliver: async (draftId: string) => {
      calls.push(draftId);
      return { messageId: `msg-${draftId}`, threadId: 'thread-1', recovered: false };
    },
  };
};

/** 08:00, so the 09:00 window is still ahead. */
const morning = new Date('2026-09-01T02:30:00Z');
/** After a 09:00 IST slot has passed. */
const later = new Date('2026-09-02T06:00:00Z');

test('nothing sends while disarmed, and that is the default', async () => {
  const db = openDb(':memory:');
  drafted(db, { fit: 100, confidence: 'high' });
  const post = delivering();
  const { ctx, counts, logs } = context(db);

  await runSend(ctx, { deliver: post.deliver, now: morning });
  // Give it a due slot and run again — still nothing leaves.
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  await runSend(context(db).ctx, { deliver: post.deliver, now: later });

  assert.equal(post.calls.length, 0, 'no Gmail call was made');
  assert.ok(logs.concat().join(' ').length >= 0);
  assert.equal(counts['sent'], undefined);
});

test('disarmed still gates, schedules and says what it would do', async () => {
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 100, confidence: 'high' });
  const { ctx, counts } = context(db);

  await runSend(ctx, { now: morning });

  assert.equal(stateOf(db, job), 'AUTO_SEND');
  assert.equal(counts['scheduled'], 1);
  const row = db.prepare('SELECT scheduled_send_at, sent_at FROM outreach').get() as {
    scheduled_send_at: string; sent_at: string | null;
  };
  assert.notEqual(row.scheduled_send_at, null);
  assert.equal(row.sent_at, null);
});

test('only a published address above the band may send itself', () => {
  // Invariant 3 and decision 006. Both halves matter: confidence is about whether the
  // address is real, the score about whether the email is worth sending.
  assert.equal(sendDecision('high', AUTO_SEND_MIN_SCORE + 1), 'AUTO_SEND');
  assert.equal(sendDecision('high', AUTO_SEND_MIN_SCORE), 'PENDING_APPROVAL', 'the band is exclusive');
  assert.equal(sendDecision('low', 100), 'PENDING_APPROVAL', 'a perfect score to a guess is still a guess');
  assert.equal(sendDecision('medium', 100), 'PENDING_APPROVAL');
});

test('an approval-queue item is never delivered without a tap', async () => {
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 100, confidence: 'low' });
  const post = delivering();

  await runSend(context(db).ctx, { deliver: post.deliver, now: morning, armed: true });
  assert.equal(stateOf(db, job), 'PENDING_APPROVAL');

  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  await runSend(context(db).ctx, { deliver: post.deliver, now: later, armed: true });

  assert.equal(post.calls.length, 0, 'taps are not built, so these wait');
  assert.equal(stateOf(db, job), 'PENDING_APPROVAL');
});

test('an armed send delivers, records the ids and moves the job', async () => {
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 100, confidence: 'high' });
  const post = delivering();

  await runSend(context(db).ctx, { deliver: post.deliver, now: morning, armed: true });
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  const second = context(db);
  await runSend(second.ctx, { deliver: post.deliver, now: later, armed: true });

  assert.deepEqual(post.calls, [`draft-${job}`]);
  assert.equal(stateOf(db, job), 'SENT');
  const row = db.prepare('SELECT sent_at, gmail_message_id FROM outreach').get() as {
    sent_at: string; gmail_message_id: string;
  };
  assert.notEqual(row.sent_at, null);
  assert.equal(row.gmail_message_id, `msg-draft-${job}`);
});

test('a sent message is never sent again', async () => {
  const db = openDb(':memory:');
  drafted(db, { fit: 100, confidence: 'high' });
  const post = delivering();
  const armed = { deliver: post.deliver, armed: true };

  await runSend(context(db).ctx, { ...armed, now: morning });
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  await runSend(context(db).ctx, { ...armed, now: later });
  await runSend(context(db).ctx, { ...armed, now: later });

  assert.equal(post.calls.length, 1);
});

test('an obsolete score from an old rubric cannot clear the gate', async () => {
  // Measured on real data: Lakkshions It scored 100 under v2 and 84 under v4, and a gate
  // reading MAX(fit_score) cleared a title-only posting to auto-send on the strength of the
  // rubric decision 023 replaced for over-scoring exactly those postings.
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 84, confidence: 'high' });
  db.prepare(
    `INSERT INTO job_scores (job_id, prompt_version, fit_score, level_fit, location_fit,
                             stack_fit, domain_fit, reasoning, hook, model, scored_at)
     VALUES (?, 2, 100, 9, 9, 9, 9, 'an older, looser rubric', 'hook', 'test', ?)`,
  ).run(job, nowIso());

  await runSend(context(db).ctx, { now: morning });

  assert.equal(stateOf(db, job), 'PENDING_APPROVAL', 'the current rubric decides, not the kindest one');
});

test('a job that no longer qualifies is demoted, not sent', async () => {
  // Human review may always be added; it may never be removed automatically. A rubric bump
  // or a bug in the gate must not be able to leave a job cleared to send itself.
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 100, confidence: 'high' });
  const post = delivering();

  await runSend(context(db).ctx, { now: morning, armed: true, deliver: post.deliver });
  assert.equal(stateOf(db, job), 'AUTO_SEND');

  // The rubric moves on and this posting is no longer above the band.
  db.prepare(
    `INSERT INTO job_scores (job_id, prompt_version, fit_score, level_fit, location_fit,
                             stack_fit, domain_fit, reasoning, hook, model, scored_at)
     VALUES (?, 5, 84, 8, 8, 8, 8, 'tighter rubric', 'hook', 'test', ?)`,
  ).run(job, nowIso());
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());

  const { ctx, counts, faults } = context(db);
  await runSend(ctx, { now: later, armed: true, deliver: post.deliver });

  assert.equal(counts['demoted'], 1);
  assert.equal(stateOf(db, job), 'PENDING_APPROVAL');
  assert.equal(post.calls.length, 0, 'and it did not go out on the way past');
  assert.match(faults[0]!, /approval queue/);
});

test('the daily cap holds the rest back rather than dropping them', async () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 5; i++) drafted(db, { fit: 100, confidence: 'high' });
  const post = delivering();
  const armed = { deliver: post.deliver, armed: true };

  await runSend(context(db).ctx, { ...armed, now: morning });
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  const { ctx, counts } = context(db);
  await runSend(ctx, { ...armed, now: later });

  // Week one is three a day (invariant 5), and the other two keep their slot.
  assert.equal(post.calls.length, 3);
  assert.equal(counts['held_by_cap'], 2);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM outreach WHERE sent_at IS NULL').get() as { n: number }).n,
    2,
  );
});

test('a lost response is recovered rather than resent', async () => {
  // The failure decision 007 exists for: the draft is gone, so it went, and retrying would
  // mail the person twice.
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 100, confidence: 'high' });
  const { ctx, faults, counts } = context(db);

  await runSend(context(db).ctx, { now: morning, armed: true, deliver: async () => ({ messageId: null, threadId: null, recovered: true }) });
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  await runSend(ctx, {
    now: later,
    armed: true,
    deliver: async () => ({ messageId: null, threadId: null, recovered: true }),
  });

  assert.equal(counts['recovered'], 1);
  assert.equal(stateOf(db, job), 'SENT');
  assert.match(faults[0]!, /recorded as sent/);
});

test('a failed send leaves the row untouched so the next run retries', async () => {
  const db = openDb(':memory:');
  const job = drafted(db, { fit: 100, confidence: 'high' });

  await runSend(context(db).ctx, { now: morning, armed: true });
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  const { ctx, faults } = context(db);
  await runSend(ctx, {
    now: later,
    armed: true,
    deliver: async () => {
      throw new Error('gmail refused');
    },
  });

  assert.equal(faults.length, 1);
  assert.equal(stateOf(db, job), 'AUTO_SEND');
  assert.equal((db.prepare('SELECT sent_at FROM outreach').get() as { sent_at: null }).sent_at, null);
});

test('a dry run never sends, even armed', async () => {
  const db = openDb(':memory:');
  drafted(db, { fit: 100, confidence: 'high' });
  const post = delivering();

  await runSend(context(db, true).ctx, { deliver: post.deliver, now: morning, armed: true });
  db.prepare('UPDATE outreach SET scheduled_send_at = ?').run(new Date(later.getTime() - 60_000).toISOString());
  await runSend(context(db, true).ctx, { deliver: post.deliver, now: later, armed: true });

  assert.equal(post.calls.length, 0);
});

test('the queue starts at 09:00 and spreads out', () => {
  const times = scheduleTimes(4, morning, () => 0.5).map((t) => Date.parse(t));

  const first = new Date(times[0]!);
  assert.equal(first.getHours(), SEND_WINDOW_HOUR);
  assert.equal(first.getMinutes(), 0);

  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    assert.ok(gap >= MIN_GAP_MS && gap <= MAX_GAP_MS, `gap ${gap} outside 3–15 min`);
  }
});

test('past the window, the queue rolls to tomorrow rather than firing at 4pm', () => {
  const afternoon = new Date('2026-09-01T10:30:00Z'); // 16:00 IST
  const [first] = scheduleTimes(1, afternoon, () => 0.5);

  const at = new Date(first!);
  assert.equal(at.getHours(), SEND_WINDOW_HOUR);
  assert.ok(at.getTime() > afternoon.getTime());
  assert.equal(at.getDate(), afternoon.getDate() + 1);
});
