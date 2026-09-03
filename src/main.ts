/**
 * Stage runner.
 *
 * The daily pipeline is not a script that carries data top to bottom — it is a list of
 * stages that each pick up rows in a state, do work, and advance the state
 * (`docs/architecture.md`). This file only sequences them and records what happened.
 *
 *   node src/main.ts                  full pipeline
 *   node src/main.ts --stage=score    one stage in isolation
 *   node src/main.ts --dry-run        everything except sending
 *
 * Every stage is wrapped: a thrown error lands in `runs.errors` and the run continues.
 * Rows stay in whatever state they were in, so tomorrow's run retries them for free.
 */
import { parseArgs } from 'node:util';
import { openDb, DEFAULT_DB_PATH, type Db } from './store/db.ts';
import { stateCounts } from './store/state.ts';
import { nowIso, StageName, type RunError } from './store/schema.ts';
import type { Stage, StageContext } from './stage.ts';
import { runIngest } from './ingest/index.ts';
import { runScore } from './match/score.ts';
import { runContacts } from './contacts/index.ts';
import { runDraft } from './draft/index.ts';
import { runDigest } from './notify/digest.ts';
import { runAlert } from './notify/alert.ts';
import { runTrack } from './track/replies.ts';
import { runSend } from './send/queue.ts';
import { runApprove } from './notify/approve.ts';
import { reportFaults } from './notify/health.ts';

export type { Stage, StageContext };

/** A stage that is not built yet: it logs and does nothing. */
const notYet = (phase: 1 | 2 | 3, what: string): Stage => ({
  phase,
  run: async (ctx) => ctx.log(`not implemented yet — ${what} (phase ${phase})`),
});

/**
 * Execution order for the daily run. `track` is deliberately excluded: it runs on its
 * own 4-hourly schedule because replies and bounces arrive continuously.
 */
/**
 * The hourly fast lane: find new postings and say so, nothing else.
 *
 * Contacts, drafting and the digest stay on the 06:00 schedule — they are slow, they write to
 * Gmail, and none of them gets better for running twenty-four times a day. What does get
 * better is *when he hears about a job*: measured 2026-08-28, a posting reached the pipeline a
 * median of 3–12 hours after the alert email arrived, purely because the poll was daily
 * (decision 036).
 *
 * Every stage here is idempotent, so an hourly run that overlaps the daily one is safe; the
 * lock in `run-daily.sh` is about not paying for the same Groq call twice, not correctness.
 *
 * `track` rides this lane rather than taking a third agent. `docs/architecture.md` specified
 * four-hourly; hourly costs two Gmail searches and notices a reply three hours sooner, and a
 * reply is the one event in this system worth being prompt about.
 */
export const FAST_STAGES = ['ingest', 'score', 'alert', 'track'] as const;

export const DAILY_STAGES = [
  'ingest',
  'prefilter',
  'score',
  'contacts',
  'draft',
  // Before `send`, not after: the 06:05 digest is what you read before anything leaves at
  // 09:00, and from Phase 2 it carries the drafts awaiting approval.
  'digest',
  'send',
] as const;

// `alert` is deliberately absent from the daily list: at 06:00 the digest is about to run
// anyway, and two messages about the same job is the failure decision 014 describes.

/**
 * Wall-clock budget per stage. A stage that overruns is abandoned and the run moves on.
 *
 * Measured on 2026-08-20, with DNS coming and going mid-run: ingest took **33 minutes** to
 * return nothing, one scoring call took **27**, and the digest — the only stage whose output
 * anybody sees — ran last, after all of it, and failed. On 08-16 the same pathology delayed
 * the digest from 07:00 to 13:24 (decision 022).
 *
 * A per-request timeout cannot fix this: 51 boards × 3 attempts is within its rights to take
 * an hour. The budget is what says "this stage has had long enough".
 *
 * Numbers are healthy-case times with room to spare: ingest normally finishes in 40 seconds,
 * and scoring is bounded by `MAX_SCORES_PER_RUN` (60) at ~67s each ≈ 67 minutes, so its
 * budget has to clear that or a full queue would be cut off mid-run.
 */
export const STAGE_BUDGET_MS: Record<string, number> = {
  ingest: 12 * 60_000,
  score: 75 * 60_000,
  // Four send attempts × a 20s request timeout, plus the 2+8+32s backoff ladder, is ~122s
  // per message part — and a ten-match digest is two or three parts. At 5 minutes the budget
  // was killing its own retries: measured 08-21 to 08-23, three digests died mid-ladder with
  // `send_retry: 2` (decision 025).
  digest: 8 * 60_000,
  // Up to twelve DNS probes and four page fetches per company, against dozens of companies
  // that have never been looked up before — 0.5 to 11 seconds each, measured live. The
  // per-company budget inside the stage is what stops one dead host from taking all of it.
  contacts: 15 * 60_000,
  // Sending is a handful of Gmail calls; the length here is for the ambiguous-failure check,
  // which is a second round trip per message and is the whole reason a send is recoverable.
  send: 10 * 60_000,
  // Eight drafts at ~2s each once `reasoning_effort` is low, plus a Gmail write apiece. The
  // headroom is for the token pacer: drafting shares the same 8,000/min window as scoring,
  // so a draft can legitimately sit waiting for room (decision 017).
  draft: 20 * 60_000,
};

export const DEFAULT_STAGE_BUDGET_MS = 10 * 60_000;

export const STAGES: Record<string, Stage> = {
  ingest: { phase: 1, run: runIngest },
  prefilter: notYet(1, 'bge-small embeddings + cosine top ~30'),
  score: { phase: 1, run: runScore },
  contacts: { phase: 2, run: runContacts },
  draft: { phase: 2, run: runDraft },
  digest: { phase: 1, run: runDigest },
  alert: { phase: 1, run: runAlert },
  approve: { phase: 3, run: runApprove },
  send: { phase: 3, run: runSend },
  track: { phase: 3, run: runTrack },
};

/** Open a row in `runs` for this execution and return its id. */
function startRun(db: Db, dryRun: boolean): number {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO runs (started_at, dry_run) VALUES (?, ?)')
    .run(nowIso(), dryRun ? 1 : 0);
  return Number(lastInsertRowid);
}

/** Close that row with the stats and errors the run produced. */
function finishRun(
  db: Db,
  runId: number,
  stats: Record<string, Record<string, number>>,
  errors: RunError[],
): void {
  db.prepare('UPDATE runs SET finished_at = ?, stats = ?, errors = ? WHERE id = ?').run(
    nowIso(),
    JSON.stringify(stats),
    JSON.stringify(errors),
    runId,
  );
}

/** CLI entry: run the pipeline, or one stage of it. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      stage: { type: 'string' },
      fast: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(
      [
        'usage: node src/main.ts [--stage=<name>[,<name>]] [--fast] [--dry-run] [--db=<path>]',
        'fast: the hourly lane — ' + FAST_STAGES.join(' → '),
        `stages: ${Object.keys(STAGES).join(', ')}`,
      ].join('\n'),
    );
    return 0;
  }

  // `--stage` takes a list, because the send agent needs `approve` and `send` in one process:
  // asking and acting on taps are the two halves of one loop and splitting them across agents
  // would double the launchd surface for no gain.
  const named = values.stage === undefined ? [] : values.stage.split(',').map((s) => s.trim());
  const unknown = named.filter((name) => !(name in STAGES));
  if (unknown.length > 0) {
    console.error(`unknown stage "${unknown[0]}" — expected one of: ${Object.keys(STAGES).join(', ')}`);
    return 2;
  }

  const dryRun = values['dry-run'];
  const toRun = named.length > 0 ? named : values.fast ? [...FAST_STAGES] : [...DAILY_STAGES];

  const db = openDb(values.db);
  const runId = startRun(db, dryRun);
  const stats: Record<string, Record<string, number>> = {};
  const errors: RunError[] = [];

  console.log(`run ${runId} — ${values.db}${values.fast ? ' (fast)' : ''}${dryRun ? ' (dry run)' : ''}`);

  for (const name of toRun) {
    const stage = STAGES[name]!;
    const bucket: Record<string, number> = {};
    stats[name] = bucket;

    const budgetMs = STAGE_BUDGET_MS[name] ?? DEFAULT_STAGE_BUDGET_MS;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`stage exceeded its ${Math.round(budgetMs / 60_000)} min budget`)),
      budgetMs,
    );

    const ctx: StageContext = {
      db,
      dryRun,
      log: (msg) => console.log(`  [${name}] ${msg}`),
      count: (key, n = 1) => {
        bucket[key] = (bucket[key] ?? 0) + n;
      },
      fault: (message) => {
        errors.push({ stage: StageName.parse(name), message, at: nowIso() });
        console.error(`  [${name}] ${message}`);
      },
      signal: controller.signal,
    };

    const started = performance.now();
    try {
      // A stage that honours `ctx.signal` stops on its own. One stuck in an
      // uninterruptible call — a hung `getaddrinfo` is the real example — does not, so the
      // race is what lets the run continue without it. The abandoned promise keeps its own
      // rejection handler so a late failure cannot take down the process; `node:sqlite` is
      // synchronous, so it cannot be mid-write when the DB closes.
      const running = stage.run(ctx);
      running.catch(() => {});

      await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (err) {
      // A failed stage never aborts the run — the rows it did not touch stay put and
      // the next run picks them up.
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ stage: StageName.parse(name), message, at: nowIso() });
      console.error(`  [${name}] failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    ctx.log(`done in ${Math.round(performance.now() - started)}ms`);
  }

  finishRun(db, runId, stats, errors);

  // After `finishRun`, so what is reported is exactly what was recorded, and after every
  // stage, so one message covers the whole run. Silent when nothing is newly broken — that is
  // what makes it different from the status ping decision 014 refused.
  await reportFaults(db, runId, errors, {
    dryRun,
    log: (m) => console.log(`  [health] ${m}`),
  });

  const counts = stateCounts(db);
  console.log(
    Object.keys(counts).length === 0
      ? 'jobs: none yet'
      : `jobs: ${Object.entries(counts)
          .map(([s, n]) => `${s}=${n}`)
          .join(' ')}`,
  );
  console.log(`run ${runId} finished with ${errors.length} error(s)`);

  db.close();
  return 0;
}

if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('./env.ts')).loadEnv();

  const code = await main();

  // An abandoned stage keeps its own timers and sockets alive, so the process would sit
  // there long after the work that matters is done — a hung ingest held a run open for
  // hours (decision 022). Everything durable is already written: `node:sqlite` is
  // synchronous and `main` closes the DB before returning, so there is nothing in flight
  // to truncate. Only the CLI does this; `main()` stays callable from tests.
  process.exit(code);
}
