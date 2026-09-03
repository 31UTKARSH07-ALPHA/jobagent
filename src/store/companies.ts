/**
 * Company reads and writes. Companies are deduped on normalised domain — one row per
 * real company however many boards or alert emails mention it.
 *
 * This matters more than it looks: `contacts` is scoped to `company_id`, so a company
 * that splits into two rows means running the expensive contact cascade twice and
 * potentially emailing the same person about two roles (decision 005).
 */
import type { Db } from './db.ts';
import { nowIso } from './schema.ts';
import type { AtsType } from './schema.ts';
import { dedupKey } from './jobs.ts';

/**
 * `https://www.Meesho.com/careers` → `meesho.com`.
 * Anything already bare passes through unchanged.
 */
export function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '') // path, query, fragment
    .replace(/\.$/, '') // trailing dot on a FQDN
    .replace(/:\d+$/, ''); // port
}

export type CompanyUpsert = {
  name: string;
  domain: string;
  ats_type?: AtsType;
  ats_slug?: string | null;
  careers_url?: string | null;
  team_url?: string | null;
};

/**
 * Insert the company, or update the fields we now know more about.
 *
 * Deliberately non-destructive: a later sighting that does not know the ATS or the team
 * page must not blank out one that did. `COALESCE(excluded.x, companies.x)` keeps the
 * best value we have ever seen.
 */
export function upsertCompany(db: Db, input: CompanyUpsert): number {
  const domain = normaliseDomain(input.domain);
  const now = nowIso();

  const row = db
    .prepare(
      `INSERT INTO companies (name, domain, ats_type, ats_slug, careers_url, team_url,
                              created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         ats_type    = CASE WHEN excluded.ats_type = 'none' THEN companies.ats_type
                            ELSE excluded.ats_type END,
         ats_slug    = COALESCE(excluded.ats_slug, companies.ats_slug),
         careers_url = COALESCE(excluded.careers_url, companies.careers_url),
         team_url    = COALESCE(excluded.team_url, companies.team_url),
         updated_at  = excluded.updated_at
       RETURNING id`,
    )
    .get(
      input.name,
      domain,
      input.ats_type ?? 'none',
      input.ats_slug ?? null,
      input.careers_url ?? null,
      input.team_url ?? null,
      now,
      now,
    ) as { id: number };

  return row.id;
}

/** Find a company by its domain. */
export function companyIdByDomain(db: Db, domain: string): number | null {
  const row = db.prepare('SELECT id FROM companies WHERE domain = ?').get(normaliseDomain(domain)) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/**
 * Replace a company's placeholder domain with the real one the contact stage proved.
 *
 * `companies.domain` is `UNIQUE` and is the dedup key for the entire system, so this is not
 * an `UPDATE`. Two outcomes have to be handled, and the second is the one that matters:
 *
 * - **Nobody holds the real domain.** Update in place. The company keeps its id and every
 *   score and contact pointing at it is untouched.
 * - **A row already holds it.** That is the case this function exists for: a company we know
 *   from a Greenhouse board *and* from a Naukri alert has been two rows all along — one real,
 *   one marker. Writing the domain would violate the constraint; keeping both would run the
 *   contact cascade twice and let the pipeline mail the same person about two roles, which is
 *   precisely what decision 005 scopes contacts per company to prevent. So the marker's rows
 *   are re-pointed at the real company and the marker is deleted.
 *
 * `dedup_key` is recomputed on every moved job, because it hashes the company domain
 * (`docs/architecture.md`). Leaving the old hash would mean tomorrow's ingest computing a
 * different key for the same posting and inserting it a second time. A job whose recomputed
 * key already exists on the surviving company **is** that posting, seen from the other
 * source, and is deleted rather than duplicated — unless something downstream refers to it,
 * in which case it is kept as-is, on the same principle migration 004 followed: an audit
 * trail is worth more than a tidy table.
 *
 * Returns the id the company now lives under.
 */
export function adoptDomain(db: Db, companyId: number, realDomain: string, name?: string): number {
  const domain = normaliseDomain(realDomain);
  const now = nowIso();

  const existing = db.prepare('SELECT id FROM companies WHERE domain = ?').get(domain) as
    | { id: number }
    | undefined;

  db.exec('BEGIN');
  try {
    const keep = existing?.id ?? companyId;

    if (existing === undefined || existing.id === companyId) {
      db.prepare(
        'UPDATE companies SET domain = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?',
      ).run(domain, name ?? null, now, companyId);
    }

    moveJobs(db, companyId, keep, domain);

    if (keep !== companyId) {
      // `contacts.email` is globally unique, so an address the surviving company already
      // holds is the same address; the duplicate is dropped rather than moved.
      db.prepare(
        `DELETE FROM contacts WHERE company_id = ?
           AND email IN (SELECT email FROM contacts WHERE company_id = ?)`,
      ).run(companyId, keep);
      db.prepare('UPDATE contacts SET company_id = ? WHERE company_id = ?').run(keep, companyId);

      db.prepare('DELETE FROM companies WHERE id = ?').run(companyId);
      db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(now, keep);
    }

    db.exec('COMMIT');
    return keep;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Re-point a company's jobs at `keep` and re-hash their dedup keys against `domain`.
 *
 * Both branches of {@link adoptDomain} need this, including the one where nothing merges:
 * the key hashes the company domain, so leaving the old hash behind means tomorrow's ingest
 * computes a different key for the same posting and inserts it a second time — a duplicate
 * digest line and a wasted 67-second scoring call (decision 021).
 */
function moveJobs(db: Db, from: number, keep: number, domain: string): void {
  const jobs = db
    .prepare('SELECT id, title, location FROM jobs WHERE company_id = ?')
    .all(from) as { id: number; title: string; location: string }[];

  for (const job of jobs) {
    const key = dedupKey(domain, job.title, job.location);
    const clash = db.prepare('SELECT id FROM jobs WHERE dedup_key = ? AND id <> ?').get(key, job.id) as
      | { id: number }
      | undefined;

    if (clash === undefined) {
      db.prepare('UPDATE jobs SET company_id = ?, dedup_key = ? WHERE id = ?').run(keep, key, job.id);
      continue;
    }

    const referenced = db
      .prepare(
        `SELECT 1 FROM job_scores WHERE job_id = ?
         UNION ALL SELECT 1 FROM outreach WHERE job_id = ?`,
      )
      .get(job.id, job.id);

    if (referenced === undefined) {
      db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
      continue;
    }

    // Keep the row and its history; only its owner moves. A stale key is the lesser evil,
    // and `upsertJob` still recognises the posting by its source id.
    db.prepare('UPDATE jobs SET company_id = ? WHERE id = ?').run(keep, job.id);
  }
}

/** One company by id — name and domain, which is all any stage downstream of ingest needs. */
export function companyById(db: Db, id: number): { id: number; name: string; domain: string } | null {
  return (
    (db.prepare('SELECT id, name, domain FROM companies WHERE id = ?').get(id) as
      | { id: number; name: string; domain: string }
      | undefined) ?? null
  );
}
