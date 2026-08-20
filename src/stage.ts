/**
 * What a stage is handed when the runner calls it.
 *
 * Lives in its own module so stages can import it without importing the runner —
 * `main.ts` depends on the stages, never the other way round.
 */
import type { Db } from './store/db.ts';

export type StageContext = {
  db: Db;
  /** True means: do everything except irreversible outside effects (sending mail). */
  dryRun: boolean;
  log: (msg: string) => void;
  /** Counters merged into `runs.stats` under this stage's name. */
  count: (key: string, n?: number) => void;
  /**
   * Aborts when the stage runs out of its wall-clock budget (`STAGE_BUDGET_MS` in
   * `main.ts`). Pass it to every network call and check it between units of work.
   *
   * This exists because a per-request timeout is not enough. On 2026-08-20 a run with
   * intermittent DNS spent 33 minutes in ingest and 27 minutes on a *single* scoring call,
   * and the digest — the only part that matters — came last (decision 022). A hung
   * `getaddrinfo` is not reliably interruptible, so `main.ts` also stops waiting on a stage
   * that overruns; honouring this signal is what makes that stop promptly and cleanly.
   */
  signal: AbortSignal;
};

export type Stage = {
  /** Which phase implements it. Unimplemented stages no-op instead of failing the run. */
  phase: 1 | 2 | 3;
  run: (ctx: StageContext) => Promise<void>;
};
