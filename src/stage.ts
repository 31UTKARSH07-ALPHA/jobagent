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
};

export type Stage = {
  /** Which phase implements it. Unimplemented stages no-op instead of failing the run. */
  phase: 1 | 2 | 3;
  run: (ctx: StageContext) => Promise<void>;
};
