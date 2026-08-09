/**
 * The one interface every job source implements.
 *
 * Adding a source is a new file that exports a `JobSource` plus one line in
 * `src/ingest/index.ts`. Nothing else in the pipeline changes — there is deliberately no
 * separate normalise stage, so an adapter's job is to emit already-canonical `RawJob`
 * rows (`docs/architecture.md`).
 */
import type { JobSourceName, RawJob } from '../store/schema.ts';

export type { RawJob };

export interface JobSource {
  readonly name: JobSourceName;
  /**
   * Yield every posting the source knows about that is newer than `since`.
   *
   * Contract: an adapter must not throw for one bad board. Swallow the per-board error,
   * report it through `onError`, and keep going — Lever being down must not stop
   * Greenhouse (`docs/architecture.md`, failure semantics).
   */
  fetch(since: Date, ctx?: SourceContext): AsyncIterable<RawJob>;
}

export type SourceContext = {
  /** Non-fatal problems: one dead board, one unparseable posting. */
  onError?: (message: string) => void;
  /** Bump a counter that ends up in `runs.stats.ingest`. */
  count?: (key: string, n?: number) => void;
};
