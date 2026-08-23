/**
 * Telling Utkarsh when the pipeline is broken.
 *
 * Every failure in this project's first three weeks was **silent**: a green exit code, an
 * empty digest, and the real cause sitting in `runs.errors` where nobody looked. Gmail's
 * token expired on 2026-08-19 and was found on 08-23, by reading logs. Before that: three
 * mornings of a starved ingest, four of a digest that could not send, and a fortnight of a
 * score that was secretly a constant.
 *
 * **This is not the daily status ping decision 014 refused, and the difference matters.** 014's
 * objection was to a message that is usually empty — you stop reading it, and then it is worse
 * than nothing because it looks like coverage. This message is sent only when something is
 * newly broken. On a healthy pipeline it never arrives at all, so its arrival means something.
 *
 * The dedupe is what makes that true: a fault already reported by the previous run is not
 * reported again. A credential that stays expired for a fortnight costs one message, not
 * fourteen.
 */
import type { Db } from '../store/db.ts';
import { RunError, type RunError as RunErrorType } from '../store/schema.ts';
import { escapeHtml, sendMessage, telegramConfig, type TelegramConfig } from './telegram.ts';

/**
 * The identity of a fault, for comparing one run against the last.
 *
 * Numbers are stripped so "exceeded its 12 min budget" and "exceeded its 8 min budget" are
 * the same ongoing problem rather than two new ones, and so a message carrying a job id or a
 * count does not re-alert every morning.
 */
export const signature = (e: RunErrorType): string =>
  `${e.stage}:${e.message.toLowerCase().replace(/\d+/g, '#').slice(0, 120)}`;

/** Faults in `errors` that the previous finished run did not already have. */
export function newFaults(errors: RunErrorType[], previous: RunErrorType[]): RunErrorType[] {
  const known = new Set(previous.map(signature));
  const seen = new Set<string>();

  return errors.filter((e) => {
    const sig = signature(e);
    if (known.has(sig) || seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

/** The errors of the newest finished run before `runId`. */
export function previousFaults(db: Db, runId: number): RunErrorType[] {
  const row = db
    .prepare(
      `SELECT errors FROM runs
        WHERE id < ? AND finished_at IS NOT NULL AND dry_run = 0
        ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as { errors: string } | undefined;

  if (row === undefined) return [];
  const parsed = RunError.array().safeParse(JSON.parse(row.errors));
  return parsed.success ? parsed.data : [];
}

export function formatFaults(faults: RunErrorType[]): string {
  const lines = [
    `⚠️ <b>jobagent needs attention</b> — ${faults.length} new problem${faults.length === 1 ? '' : 's'}`,
    '',
  ];

  for (const f of faults) {
    lines.push(`<b>${escapeHtml(f.stage)}</b> — ${escapeHtml(f.message)}`);
  }

  lines.push('', '<code>node src/schedule/launchd.ts --status</code>', '<code>tail -40 logs/daily.log</code>');
  return lines.join('\n');
}

export type HealthDeps = {
  send?: (config: TelegramConfig, text: string) => Promise<unknown>;
  config?: TelegramConfig;
};

/**
 * Report anything newly broken. Returns what it sent, for the caller to log.
 *
 * Called after every stage has run and `runs` has been written, so it sees the whole run.
 * It never throws: a failure to report a failure must not become the thing that breaks the
 * pipeline.
 */
export async function reportFaults(
  db: Db,
  runId: number,
  errors: RunErrorType[],
  opts: { dryRun: boolean; log: (m: string) => void },
  deps: HealthDeps = {},
): Promise<RunErrorType[]> {
  if (errors.length === 0) return [];

  const faults = newFaults(errors, previousFaults(db, runId));
  if (faults.length === 0) {
    opts.log(`${errors.length} problem(s), all already reported by the previous run`);
    return [];
  }

  if (opts.dryRun) {
    opts.log(`would report ${faults.length} new problem(s):\n\n${formatFaults(faults)}\n`);
    return faults;
  }

  const config = deps.config ?? (() => {
    const resolved = telegramConfig();
    return 'config' in resolved ? resolved.config : null;
  })();

  if (config === null) {
    opts.log('cannot report problems — Telegram is not configured');
    return [];
  }

  try {
    await (deps.send ?? sendMessage)(config, formatFaults(faults));
    opts.log(`reported ${faults.length} new problem(s)`);
    return faults;
  } catch (err) {
    // The pipeline's own errors are already recorded; this one only goes to the log.
    opts.log(`could not report problems: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
