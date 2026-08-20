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
import { transaction, type Db } from '../store/db.ts';
import { loadCompanies, SEED_PATH, type SeedCompany } from './companies.ts';
import { atsSources } from './ats.ts';
import { gmailAlertSource } from './gmail-alerts.ts';
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

/**
 * Every source, in the order they are polled.
 *
 * The Gmail source takes the DB because it is the only adapter that receives a company *name*
 * rather than a board it already knows the owner of — see `AlertPosting` in `./types.ts`.
 */
export function sources(db: Db): JobSource[] {
  return [...atsSources(loadCompanies()), gmailAlertSource({ db })];
}

export async function runIngest(ctx: StageContext): Promise<void> {
  let companies: SeedCompany[] = [];
  try {
    companies = loadCompanies();
  } catch (err) {
    // Not fatal, and no longer a reason to stop: alert email needs no seed list, and it is
    // where the companies that have no board at all come from (decision 010).
    ctx.log(
      `no usable seed list at ${SEED_PATH} (${err instanceof Error ? err.message : String(err)}). ` +
        'Run: node src/ingest/refresh-companies.ts — continuing with alert email only.',
    );
  }

  const all = [...atsSources(companies), gmailAlertSource({ db: ctx.db })];
  ctx.log(`${companies.length} companies across ${all.length - 1} boards, plus alert email`);

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
    // Out of budget. Stop cleanly rather than starting a source that cannot finish — the
    // stages after this one, the digest above all, still need their turn.
    if (ctx.signal.aborted) {
      ctx.log(`out of time — skipped ${source.name} and any source after it`);
      ctx.count('source_skipped');
      break;
    }

    const before = Date.now();
    let fromSource = 0;

    try {
      for await (const raw of source.fetch(since, {
        onError: (message) => ctx.log(`warn: ${message}`),
        count: ctx.count,
        signal: ctx.signal,
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
