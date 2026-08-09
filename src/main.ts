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
import { runDigest } from './notify/digest.ts';

export type { Stage, StageContext };

const notYet = (phase: 1 | 2 | 3, what: string): Stage => ({
  phase,
  run: async (ctx) => ctx.log(`not implemented yet — ${what} (phase ${phase})`),
});

/**
 * Execution order for the daily run. `track` is deliberately excluded: it runs on its
 * own 4-hourly schedule because replies and bounces arrive continuously.
 */
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

export const STAGES: Record<string, Stage> = {
  ingest: { phase: 1, run: runIngest },
  prefilter: notYet(1, 'bge-small embeddings + cosine top ~30'),
  score: { phase: 1, run: runScore },
  contacts: notYet(2, 'contact cascade + MX check'),
  draft: notYet(2, 'Groq drafting into Gmail drafts'),
  digest: { phase: 1, run: runDigest },
  send: notYet(3, 'gate, daily cap, jittered 09:00 queue'),
  track: notYet(3, 'replies, bounces, follow-ups'),
};

function startRun(db: Db, dryRun: boolean): number {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO runs (started_at, dry_run) VALUES (?, ?)')
    .run(nowIso(), dryRun ? 1 : 0);
  return Number(lastInsertRowid);
}

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      stage: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(
      [
        'usage: node src/main.ts [--stage=<name>] [--dry-run] [--db=<path>]',
        `stages: ${Object.keys(STAGES).join(', ')}`,
      ].join('\n'),
    );
    return 0;
  }

  if (values.stage !== undefined && !(values.stage in STAGES)) {
    console.error(`unknown stage "${values.stage}" — expected one of: ${Object.keys(STAGES).join(', ')}`);
    return 2;
  }

  const dryRun = values['dry-run'];
  const toRun = values.stage !== undefined ? [values.stage] : [...DAILY_STAGES];

  const db = openDb(values.db);
  const runId = startRun(db, dryRun);
  const stats: Record<string, Record<string, number>> = {};
  const errors: RunError[] = [];

  console.log(`run ${runId} — ${values.db}${dryRun ? ' (dry run)' : ''}`);

  for (const name of toRun) {
    const stage = STAGES[name]!;
    const bucket: Record<string, number> = {};
    stats[name] = bucket;

    const ctx: StageContext = {
      db,
      dryRun,
      log: (msg) => console.log(`  [${name}] ${msg}`),
      count: (key, n = 1) => {
        bucket[key] = (bucket[key] ?? 0) + n;
      },
    };

    const started = performance.now();
    try {
      await stage.run(ctx);
    } catch (err) {
      // A failed stage never aborts the run — the rows it did not touch stay put and
      // the next run picks them up.
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ stage: StageName.parse(name), message, at: nowIso() });
      console.error(`  [${name}] failed: ${message}`);
    }
    ctx.log(`done in ${Math.round(performance.now() - started)}ms`);
  }

  finishRun(db, runId, stats, errors);

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
  process.exitCode = await main();
}
