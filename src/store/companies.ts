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

export function companyIdByDomain(db: Db, domain: string): number | null {
  const row = db.prepare('SELECT id FROM companies WHERE domain = ?').get(normaliseDomain(domain)) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}
