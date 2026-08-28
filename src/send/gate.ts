/**
 * Who may be written to, and how many a day.
 *
 * The sending machinery itself — the jittered 09:00 queue, the Telegram approve/reject taps —
 * is not built. This file is the *policy* half, and it exists already because the draft stage
 * needs it: a draft he has decided never to send is noise in the queue he reads each morning
 * (the same reasoning as decision 035).
 *
 * Two rules, both Utkarsh's calls on 2026-08-29 (decision 038).
 */
import type { Db } from '../store/db.ts';

/**
 * Emails a day, by week of sending. **Mandatory, and never start at the top** — invariant 5.
 *
 * A new sender going straight to eight a day is the volume pattern reputation systems are
 * built to catch. The ramp is also why `dailyCap` is derived from the *first send* rather
 * than from a date in a config file: week one begins when the first email actually leaves,
 * not when somebody edited a constant.
 */
export const RAMP: readonly number[] = [3, 5, 8];

/** When the first email ever left, or null if none has. */
export function firstSentAt(db: Db): string | null {
  const row = db.prepare('SELECT MIN(sent_at) AS at FROM outreach WHERE sent_at IS NOT NULL').get() as
    | { at: string | null }
    | undefined;
  return row?.at ?? null;
}

/** How many may go out today. Nothing sent yet means week one, which is three. */
export function dailyCap(first: string | null, now: Date = new Date()): number {
  if (first === null) return RAMP[0]!;
  const weeks = Math.floor((now.getTime() - Date.parse(first)) / (7 * 86_400_000));
  return RAMP[Math.min(Math.max(weeks, 0), RAMP.length - 1)]!;
}

/**
 * Is this job's company already being written to?
 *
 * **One live conversation per company.** Utkarsh's call: a second role at a company we have
 * already mailed is skipped, not queued — two cold emails from one student in the same week
 * is how a small company forms an opinion, and the second one is rarely the better role
 * anyway, because drafting takes the highest-scoring job first.
 *
 * Deliberately **not** a job state. Suppression is a fact about *now*, and it lifts by itself:
 * if that first email bounced, it never arrived, so the company was never really contacted and
 * the sibling role becomes eligible again. Encoding it as a state would make it permanent and
 * would need an edge out of a terminal state to undo.
 */
export const SUPPRESSED_BY_SIBLING = `
  EXISTS (
    SELECT 1 FROM outreach sib
      JOIN jobs sj ON sj.id = sib.job_id
     WHERE sj.company_id = j.company_id
       AND sib.job_id <> j.id
       AND sib.bounced_at IS NULL
  )`;

/** The same rule, for callers that have a job in hand rather than a query. */
export function suppressedBySibling(db: Db, jobId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS yes FROM outreach sib
         JOIN jobs sj ON sj.id = sib.job_id
         JOIN jobs j ON j.id = ?
        WHERE sj.company_id = j.company_id
          AND sib.job_id <> j.id
          AND sib.bounced_at IS NULL
        LIMIT 1`,
    )
    .get(jobId) as { yes: number } | undefined;
  return row !== undefined;
}
