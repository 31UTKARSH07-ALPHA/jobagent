/**
 * The job state machine. This is the **only** place `jobs.state` is written.
 *
 * Stages must never `UPDATE jobs SET state = ...` themselves. Going through here buys
 * two things: illegal transitions throw instead of silently corrupting the pipeline,
 * and the UPDATE is guarded on the expected current state, so a stage that races with
 * itself (or re-runs against an already-advanced row) fails loudly rather than
 * re-doing work.
 *
 * Diagram: `docs/architecture.md`. Values: `JobState` in `./schema.ts`.
 */
import type { Db } from './db.ts';
import { JobState, nowIso } from './schema.ts';

/** Legal edges. A state whose array is empty is terminal. */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  DISCOVERED: ['SCORED', 'EXPIRED'],
  // EXPIRED is reachable from every pre-draft state: a posting can vanish from its board
  // at any point before we have written a draft about it.
  SCORED: ['MATCHED', 'REJECTED', 'EXPIRED'],
  MATCHED: ['DRAFTED', 'NEEDS_CONTACT', 'EXPIRED'],
  // retried every 3 days, 3 attempts, then EXPIRED
  NEEDS_CONTACT: ['DRAFTED', 'EXPIRED'],
  DRAFTED: ['AUTO_SEND', 'PENDING_APPROVAL'],
  // `AUTO_SEND → PENDING_APPROVAL` is a demotion, and it exists on a principle worth stating:
  // **human review may always be added, never automatically removed.** There is deliberately
  // no edge the other way, so a job cannot be promoted out of the approval queue by anything
  // except a person's tap.
  //
  // It earned its place. On 2026-08-30 the gate read `MAX(fit_score)` across every rubric
  // version and cleared a title-only posting to auto-send on a v2 score of 100 that v4 had
  // since replaced with 84. Without this edge, unwinding that needed a hand-edit; with it,
  // the next run demotes it by itself (decision 041).
  AUTO_SEND: ['SENT', 'PENDING_APPROVAL'],
  PENDING_APPROVAL: ['SENT', 'REJECTED_BY_USER'],
  SENT: ['REPLIED', 'FOLLOW_UP_SENT', 'BOUNCED'],
  FOLLOW_UP_SENT: ['REPLIED', 'BOUNCED', 'CLOSED'],

  // terminal
  REJECTED: [],
  EXPIRED: [],
  REJECTED_BY_USER: [],
  REPLIED: [],
  BOUNCED: [],
  CLOSED: [],
};

/** Max cascade attempts before a MATCHED job gives up and expires. */
export const MAX_CONTACT_ATTEMPTS = 3;
/** Days between contact-cascade retries for a NEEDS_CONTACT job. */
export const CONTACT_RETRY_DAYS = 3;

export class IllegalTransitionError extends Error {
  // Plain fields, not parameter properties — those are not erasable syntax and Node's
  // type stripping rejects them.
  from: JobState;
  to: JobState;
  jobId: number | undefined;

  constructor(from: JobState, to: JobState, jobId?: number) {
    const where = jobId === undefined ? '' : ` (job ${jobId})`;
    super(`illegal transition ${from} → ${to}${where}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.jobId = jobId;
  }
}

/** Is this a state a job can never leave? */
export const isTerminal = (state: JobState): boolean => TRANSITIONS[state].length === 0;

/** Is this move between states allowed? */
export const canTransition = (from: JobState, to: JobState): boolean =>
  TRANSITIONS[from].includes(to);

/**
 * Move a job from `from` to `to`.
 *
 * The UPDATE is conditional on the row still being in `from`, so this is safe to call
 * from a re-run: if another pass already advanced the row, nothing is written and the
 * call throws rather than double-processing.
 *
 * Callers that legitimately might race (the tracker, approval taps) should use
 * {@link tryTransition}.
 */
export function transition(db: Db, jobId: number, from: JobState, to: JobState): void {
  if (!tryTransition(db, jobId, from, to)) {
    const row = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as
      | { state: string }
      | undefined;
    if (!row) throw new Error(`job ${jobId} does not exist`);
    throw new Error(
      `job ${jobId} was ${row.state}, not ${from} — refusing to transition to ${to}`,
    );
  }
}

/**
 * Same as {@link transition} but returns false instead of throwing when the row is no
 * longer in `from`. Still throws on an illegal edge — that is a code bug, not a race.
 */
export function tryTransition(db: Db, jobId: number, from: JobState, to: JobState): boolean {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, jobId);

  const result = db
    .prepare('UPDATE jobs SET state = ?, state_changed_at = ? WHERE id = ? AND state = ?')
    .run(to, nowIso(), jobId, from);

  return Number(result.changes) === 1;
}

/** Current state of a job, validated. Throws if the job is missing. */
export function stateOf(db: Db, jobId: number): JobState {
  const row = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as
    | { state: string }
    | undefined;
  if (!row) throw new Error(`job ${jobId} does not exist`);
  return JobState.parse(row.state);
}

/** Every job sitting in a given state. Stages start their work with this. */
export function jobIdsInState(db: Db, state: JobState, limit?: number): number[] {
  const sql =
    'SELECT id FROM jobs WHERE state = ? ORDER BY first_seen_at' +
    (limit === undefined ? '' : ' LIMIT ?');
  const rows = (
    limit === undefined ? db.prepare(sql).all(state) : db.prepare(sql).all(state, limit)
  ) as { id: number }[];
  return rows.map((r) => r.id);
}

/** How many jobs sit in each state. Used by the digest and by `--stage` dry runs. */
export function stateCounts(db: Db): Partial<Record<JobState, number>> {
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all() as {
    state: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [JobState.parse(r.state), r.n]));
}
