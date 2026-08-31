/**
 * The send stage: gate what is drafted, schedule it across the morning, deliver what is due.
 *
 * Three jobs in one pass, because they are the same decision at three points in time:
 *
 * 1. **Gate** — every `DRAFTED` job becomes `AUTO_SEND` or `PENDING_APPROVAL` (decision 006).
 * 2. **Schedule** — anything cleared to go gets a `scheduled_send_at`, jittered from 09:00.
 * 3. **Deliver** — anything already due is sent, up to what the ramp allows today.
 *
 * **Nothing sends unless `JOBAGENT_SEND=armed`.** Disarmed — the default, and the state this
 * shipped in — the stage still gates, still schedules and still logs exactly what would have
 * gone where. Watching it decide correctly for a week costs nothing and is the only way to
 * earn confidence in a thing whose mistakes cannot be taken back.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import type { StageContext } from '../stage.ts';
import { nowIso } from '../store/schema.ts';
import { transition, tryTransition } from '../store/state.ts';
import { CURRENT_FIT_SCORE } from '../store/scores.ts';
import { deliver, type Delivered } from './deliver.ts';
import { remainingToday, sendDecision, sendingArmed } from './gate.ts';

/**
 * When the day's sending starts, local time.
 *
 * Not the pipeline's own run time, which is 06:00. Mail that arrives at 06:05 was obviously
 * not written by a person at 06:05, and a recruiter reading it at 09:30 is the point.
 */
export const SEND_WINDOW_HOUR = 9;

/** Minimum and maximum gap between two sends. Five emails in one second is the tell. */
export const MIN_GAP_MS = 3 * 60_000;
export const MAX_GAP_MS = 15 * 60_000;

/**
 * Times for `count` sends, starting at the next 09:00 and drifting apart by 3–15 minutes.
 *
 * The randomness is injected so tests are not flaky and so a run is reproducible when
 * something needs explaining afterwards.
 */
export function scheduleTimes(
  count: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): string[] {
  const start = new Date(now);
  start.setHours(SEND_WINDOW_HOUR, 0, 0, 0);
  // Past this morning's window already — the queue rolls to tomorrow rather than firing a
  // backlog at 16:00, which is neither early nor human.
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);

  const times: string[] = [];
  let at = start.getTime();

  for (let i = 0; i < count; i++) {
    if (i > 0) at += MIN_GAP_MS + Math.floor(random() * (MAX_GAP_MS - MIN_GAP_MS));
    times.push(new Date(at).toISOString());
  }
  return times;
}

type Gateable = { job_id: number; outreach_id: number; confidence: string; fit_score: number; company: string; email: string };
type Due = { outreach_id: number; job_id: number; draft_id: string; state: string; company: string; email: string };

/** Drafted jobs that have not been through the gate yet. */
function ungated(ctx: StageContext): Gateable[] {
  return ctx.db
    .prepare(
      `SELECT o.id AS outreach_id, o.job_id, k.confidence, k.email, c.name AS company,
              ${CURRENT_FIT_SCORE} AS fit_score
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE j.state = 'DRAFTED'
          AND o.sent_at IS NULL
        ORDER BY fit_score DESC, o.id`,
    )
    .all() as Gateable[];
}

/** Everything cleared to go whose moment has arrived. */
function due(ctx: StageContext, now: Date): Due[] {
  return ctx.db
    .prepare(
      `SELECT o.id AS outreach_id, o.job_id, o.gmail_draft_id AS draft_id, j.state,
              c.name AS company, k.email
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE o.sent_at IS NULL
          AND o.gmail_draft_id IS NOT NULL
          AND o.scheduled_send_at IS NOT NULL
          AND o.scheduled_send_at <= ?
          -- Auto-sends, and approved items -- one code path for both, which is the point of
          -- decision 007. PENDING_APPROVAL without approved_at is deliberately excluded:
          -- a scheduled slot is not permission.
          AND (j.state = 'AUTO_SEND' OR (j.state = 'PENDING_APPROVAL' AND o.approved_at IS NOT NULL))
        ORDER BY o.scheduled_send_at`,
    )
    .all(now.toISOString()) as Due[];
}

export type SendDeps = {
  client?: gmail_v1.Gmail;
  deliver?: (draftId: string, client?: gmail_v1.Gmail, signal?: AbortSignal) => Promise<Delivered>;
  now?: Date;
  random?: () => number;
  /** Tests arm the switch without touching the environment. */
  armed?: boolean;
};

export async function runSend(ctx: StageContext, deps: SendDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  const armed = deps.armed ?? sendingArmed();

  // ── 1. Gate ────────────────────────────────────────────────────────────────
  const waiting = ungated(ctx);
  for (const row of waiting) {
    const next = sendDecision(row.confidence, row.fit_score ?? 0);
    transition(ctx.db, row.job_id, 'DRAFTED', next);
    ctx.count(next === 'AUTO_SEND' ? 'auto' : 'needs_approval');
    ctx.log(`${row.company} → ${row.email}: ${next === 'AUTO_SEND' ? 'cleared to send' : 'waiting for approval'} (${row.fit_score}, ${row.confidence})`);
  }

  // ── 1b. Re-gate ────────────────────────────────────────────────────────────
  //
  // Anything already cleared is re-checked every run against the *current* score and
  // confidence. A rubric bump, a re-score, or a bug in the gate itself can all mean a job no
  // longer qualifies, and the safe direction is always available: back to the approval queue.
  const cleared = ctx.db
    .prepare(
      `SELECT o.job_id, k.confidence, k.email, c.name AS company, ${CURRENT_FIT_SCORE} AS fit_score
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE j.state = 'AUTO_SEND' AND o.sent_at IS NULL`,
    )
    .all() as { job_id: number; confidence: string; email: string; company: string; fit_score: number }[];

  for (const row of cleared) {
    if (sendDecision(row.confidence, row.fit_score ?? 0) === 'AUTO_SEND') continue;
    tryTransition(ctx.db, row.job_id, 'AUTO_SEND', 'PENDING_APPROVAL');
    ctx.count('demoted');
    ctx.fault(
      `${row.company} → ${row.email} no longer qualifies to send itself (${row.fit_score}, ${row.confidence}) — moved to the approval queue`,
    );
  }

  // ── 2. Schedule ────────────────────────────────────────────────────────────
  const unscheduled = ctx.db
    .prepare(
      `SELECT o.id FROM outreach o JOIN jobs j ON j.id = o.job_id
        WHERE o.scheduled_send_at IS NULL AND o.sent_at IS NULL
          AND j.state IN ('AUTO_SEND', 'PENDING_APPROVAL')
        ORDER BY o.id`,
    )
    .all() as { id: number }[];

  if (unscheduled.length > 0) {
    const times = scheduleTimes(unscheduled.length, now, deps.random);
    const stmt = ctx.db.prepare('UPDATE outreach SET scheduled_send_at = ? WHERE id = ?');
    unscheduled.forEach((row, i) => stmt.run(times[i]!, row.id));
    ctx.count('scheduled', unscheduled.length);
    ctx.log(`scheduled ${unscheduled.length} from ${times[0]!.slice(11, 16)} UTC, 3–15 min apart`);
  }

  // ── 3. Deliver ─────────────────────────────────────────────────────────────
  const allowance = remainingToday(ctx.db, now);
  const ready = due(ctx, now);

  if (ready.length === 0) {
    ctx.log('nothing due');
    return;
  }
  if (allowance === 0) {
    // Not an error: the ramp is doing its job. They keep their scheduled time and go tomorrow.
    ctx.log(`${ready.length} due but today's cap is used up`);
    ctx.count('held_by_cap', ready.length);
    return;
  }

  const batch = ready.slice(0, allowance);
  if (ready.length > batch.length) ctx.count('held_by_cap', ready.length - batch.length);

  for (const row of batch) {
    if (ctx.signal.aborted) {
      ctx.log('out of time — the rest keep their slot');
      break;
    }

    if (!armed || ctx.dryRun) {
      ctx.count('would_send');
      ctx.log(`WOULD SEND → ${row.email} (${row.company}) — disarmed, set JOBAGENT_SEND=armed to enable`);
      continue;
    }

    try {
      const send = deps.deliver ?? deliver;
      const sent = await send(row.draft_id, deps.client, ctx.signal);

      ctx.db
        .prepare(
          `UPDATE outreach SET sent_at = ?, gmail_message_id = COALESCE(?, gmail_message_id),
                               gmail_thread_id = COALESCE(?, gmail_thread_id)
            WHERE id = ? AND sent_at IS NULL`,
        )
        .run(nowIso(), sent.messageId, sent.threadId, row.outreach_id);

      tryTransition(ctx.db, row.job_id, row.state as 'AUTO_SEND' | 'PENDING_APPROVAL', 'SENT');

      ctx.count('sent');
      if (sent.recovered) {
        // It went, we just did not hear the answer. Worth a fault: it means a request failed
        // in a way that would have caused a double-send under a naive retry.
        ctx.count('recovered');
        ctx.fault(`${row.email}: send response was lost, but the draft is gone — recorded as sent`);
      } else {
        ctx.log(`sent → ${row.email} (${row.company})`);
      }
    } catch (err) {
      // `sent_at` stays null and the draft is still in Gmail, so the next run retries. That
      // is only safe because `deliver` already established the draft still exists.
      ctx.count('failed');
      ctx.fault(`${row.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
