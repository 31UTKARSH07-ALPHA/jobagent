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
 * How long any one source gets before the rest of the stage is protected from it.
 *
 * Measured 2026-08-23: `api.lever.co` hung for **1048 seconds** on five boards, ate the whole
 * 12-minute stage budget, and ingest never reached the two sources after it — including alert
 * email, which supplies 67 of 76 postings. A stage budget alone cannot prevent that; it only
 * says when to stop, not who got the time (decision 025).
 *
 * Three minutes is generous: a healthy source finishes in under 30 seconds.
 */
export const SOURCE_BUDGET_MS = 3 * 60_000;

/**
 * Every source, **best first**.
 *
 * Alert email leads because it is the most valuable and the cheapest: 67 postings a run
 * against 9 from all 51 ATS boards combined, in ~23 seconds, and it is the only source that
 * reaches the Indian companies with no public ATS at all (decision 010). Being last is what
 * got it starved three mornings running.
 *
 * The Gmail source takes the DB because it is the only adapter that receives a company *name*
 * rather than a board it already knows the owner of — see `AlertPosting` in `./types.ts`.
 */
export function sources(db: Db): JobSource[] {
  return [gmailAlertSource({ db }), ...atsSources(loadCompanies())];
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

  const all = [gmailAlertSource({ db: ctx.db }), ...atsSources(companies)];
  ctx.log(`alert email first, then ${companies.length} companies across ${all.length - 1} boards`);

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

    // One source cannot spend the whole stage. `AbortSignal.any` keeps the stage deadline
    // above it, so whichever expires first wins.
    const perSource = AbortSignal.any([ctx.signal, AbortSignal.timeout(SOURCE_BUDGET_MS)]);

    try {
      for await (const raw of source.fetch(since, {
        onError: (message) => ctx.log(`warn: ${message}`),
        count: ctx.count,
        signal: perSource,
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
