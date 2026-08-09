/**
 * The ingest stage: every source, into `jobs` and `companies`.
 *
 * Adding a source means adding it to {@link sources} and nothing else. The stage itself
 * knows only the `JobSource` interface.
 */
import type { StageContext } from '../stage.ts';
import { upsertCompany } from '../store/companies.ts';
import { staleJobIds, upsertJob } from '../store/jobs.ts';
import { tryTransition, stateOf } from '../store/state.ts';
import { transaction } from '../store/db.ts';
import { loadCompanies, SEED_PATH } from './companies.ts';
import { atsSources } from './ats.ts';
import type { JobSource } from './types.ts';

/**
 * How far back a source is asked to look. Comfortably wider than a day so a few missed
 * runs (laptop shut, no wifi) self-heal instead of leaving a hole.
 */
export const INGEST_WINDOW_DAYS = 30;

/**
 * A posting unseen for this long is gone from its board — filled or pulled. Two ingest
 * windows of slack, so one flaky board does not expire good jobs.
 */
export const STALE_AFTER_DAYS = 14;

/** Rows written per transaction. Batched so a crash costs at most this many. */
const BATCH_SIZE = 50;

export function sources(): JobSource[] {
  return atsSources(loadCompanies());
}

export async function runIngest(ctx: StageContext): Promise<void> {
  let companies;
  try {
    companies = loadCompanies();
  } catch (err) {
    // Not fatal to the run — the other stages still have yesterday's rows to work on.
    ctx.log(
      `no usable seed list at ${SEED_PATH} (${err instanceof Error ? err.message : String(err)}). ` +
        'Run: node src/ingest/refresh-companies.ts',
    );
    return;
  }

  const all = atsSources(companies);
  ctx.log(`${companies.length} companies across ${all.length} boards`);

  const since = new Date(Date.now() - INGEST_WINDOW_DAYS * 86_400_000);
  const pending: { companyId: number; raw: Parameters<typeof upsertJob>[2] }[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    transaction(ctx.db, () => {
      for (const { companyId, raw } of pending) {
        const { created } = upsertJob(ctx.db, companyId, raw);
        ctx.count(created ? 'discovered' : 'already_known');
      }
    });
    pending.length = 0;
  };

  for (const source of all) {
    const before = Date.now();
    let fromSource = 0;

    try {
      for await (const raw of source.fetch(since, {
        onError: (message) => ctx.log(`warn: ${message}`),
        count: ctx.count,
      })) {
        // Companies are upserted outside the batch: several jobs share one company and
        // we need its id before the job row can be written.
        const companyId = upsertCompany(ctx.db, {
          name: raw.company_name,
          domain: raw.company_domain,
          ats_type: raw.ats_type,
          ats_slug: raw.ats_slug,
        });
        pending.push({ companyId, raw });
        fromSource++;
        if (pending.length >= BATCH_SIZE) flush();
      }
      flush();
    } catch (err) {
      // One source dying must not cost us the others.
      flush();
      ctx.log(`source ${source.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.count('source_failed');
    }

    ctx.log(`${source.name}: ${fromSource} kept in ${Math.round((Date.now() - before) / 1000)}s`);
  }

  expireStale(ctx);
}

/** Postings that have vanished from their board. Idempotent — already-EXPIRED rows are skipped. */
function expireStale(ctx: StageContext): void {
  const stale = staleJobIds(ctx.db, STALE_AFTER_DAYS);
  if (stale.length === 0) return;

  transaction(ctx.db, () => {
    for (const id of stale) {
      if (tryTransition(ctx.db, id, stateOf(ctx.db, id), 'EXPIRED')) ctx.count('expired');
    }
  });
  ctx.log(`expired ${stale.length} posting(s) unseen for ${STALE_AFTER_DAYS}d`);
}
