/**
 * Reads and writes for the startup tables. Nothing outside `src/startups/` calls these, and
 * nothing here touches the job pipeline's tables except {@link pipelineAlreadyWrote}, which
 * only reads.
 *
 * Every write is an upsert keyed on the source's own id, so running any command twice changes
 * nothing but `last_seen_at` (invariant 4, applied to this feature too).
 */
import type { Db } from '../store/db.ts';
import { transaction } from '../store/db.ts';
import { normaliseDomain } from '../store/companies.ts';
import { apexOf } from '../contacts/domain.ts';
import {
  Startup,
  StartupContact,
  StartupPerson,
  StartupRole,
  nowIso,
  type StartupSource,
  type YcCompanyPage,
} from '../store/schema.ts';
import type { StartupCandidate } from './people.ts';
import { absoluteYcUrl } from './yc.ts';
import { saveUpdates, updatesFromCompanyPage } from './brief.ts';

export type StartupUpsert = {
  source: StartupSource;
  source_id: string;
  name: string;
  website: string | null;
  location: string;
  batch: string;
  team_size: number | null;
  one_liner: string;
  description: string;
  tags: readonly string[];
  source_url: string;
};

/** A website → the domain to write to. Null for anything that is not a plain http(s) site. */
export function domainOfWebsite(website: string | null): string | null {
  if (website === null || website.trim() === '') return null;
  const url = URL.parse(/^https?:\/\//i.test(website) ? website : `https://${website}`);
  if (url === null || !/^https?:$/.test(url.protocol)) return null;
  const domain = normaliseDomain(url.hostname);
  return domain.includes('.') ? domain : null;
}

export function upsertStartup(db: Db, s: StartupUpsert): number {
  const now = nowIso();
  const row = db
    .prepare(
      `INSERT INTO startups (source, source_id, name, website, domain, location, batch, team_size,
                             one_liner, description, tags, source_url, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, source_id) DO UPDATE SET
         name = excluded.name, website = excluded.website, domain = excluded.domain,
         location = excluded.location, batch = excluded.batch, team_size = excluded.team_size,
         one_liner = excluded.one_liner, description = excluded.description, tags = excluded.tags,
         source_url = excluded.source_url, last_seen_at = excluded.last_seen_at
       RETURNING id`,
    )
    .get(
      s.source,
      s.source_id,
      s.name,
      s.website,
      domainOfWebsite(s.website),
      s.location,
      s.batch,
      s.team_size,
      s.one_liner,
      s.description,
      JSON.stringify(s.tags),
      s.source_url,
      now,
      now,
    ) as { id: number };
  return row.id;
}

/**
 * Founders and open roles from a company page.
 *
 * A role missing from this fetch keeps its row with an old `last_seen_at`; {@link openRoles}
 * is what treats it as closed. Rows are never deleted, so an email already drafted against a
 * role still points at it.
 */
export function saveDetails(db: Db, startupId: number, page: YcCompanyPage): void {
  const now = nowIso();
  transaction(db, () => {
    db.prepare('UPDATE startups SET github_url = ?, details_fetched_at = ? WHERE id = ?').run(
      page.company.github_url,
      now,
      startupId,
    );

    const person = db.prepare(
      `INSERT INTO startup_people (startup_id, name, title, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (startup_id, name) DO UPDATE SET title = excluded.title`,
    );
    for (const f of page.company.founders) {
      if (!f.is_active || f.full_name.trim() === '') continue;
      person.run(startupId, f.full_name.trim(), (f.title ?? '').trim(), now);
    }

    const role = db.prepare(
      `INSERT INTO startup_roles (startup_id, source_id, title, location, job_type, min_experience,
                                  salary, url, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (startup_id, source_id) DO UPDATE SET
         title = excluded.title, location = excluded.location, job_type = excluded.job_type,
         min_experience = excluded.min_experience, salary = excluded.salary, url = excluded.url,
         last_seen_at = excluded.last_seen_at`,
    );
    for (const j of page.jobPostings) {
      role.run(
        startupId,
        j.id,
        j.title.trim(),
        j.location ?? '',
        j.type ?? '',
        j.minExperience ?? '',
        j.salaryRange ?? '',
        absoluteYcUrl(j.url),
        now,
        now,
      );
    }

    // Launches and press arrive on the same page, so they are kept on the same read (057).
    saveUpdates(db, startupId, updatesFromCompanyPage(page));
  });
}

/**
 * YC startups whose company page has not been read in `days`, oldest first. YC only: a Peak XV
 * company has no YC page, and its roles arrive with the board read itself.
 */
export function needingDetails(db: Db, days: number, limit: number): { id: number; source_id: string; name: string }[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT id, source_id, name FROM startups
        WHERE source = 'yc' AND (details_fetched_at IS NULL OR details_fetched_at < ?)
        ORDER BY details_fetched_at IS NOT NULL, details_fetched_at, id
        LIMIT ?`,
    )
    .all(cutoff, limit) as { id: number; source_id: string; name: string }[];
}

const parseStartup = (row: Record<string, unknown>): Startup =>
  Startup.parse({ ...row, tags: JSON.parse(String(row['tags'] ?? '[]')) });

export function allStartups(db: Db): Startup[] {
  return (db.prepare('SELECT * FROM startups WHERE details_fetched_at IS NOT NULL ORDER BY id').all() as Record<
    string,
    unknown
  >[]).map(parseStartup);
}

export function startupById(db: Db, id: number): Startup | null {
  const row = db.prepare('SELECT * FROM startups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row === undefined ? null : parseStartup(row);
}

/** Roles seen on the latest read of the company page. Anything older has closed. */
export function openRoles(db: Db, startupId: number): StartupRole[] {
  return (
    db
      .prepare(
        `SELECT r.* FROM startup_roles r JOIN startups s ON s.id = r.startup_id
          WHERE r.startup_id = ? AND r.last_seen_at >= s.details_fetched_at
          ORDER BY r.id`,
      )
      .all(startupId) as Record<string, unknown>[]
  ).map((r) => StartupRole.parse(r));
}

export function peopleOf(db: Db, startupId: number): StartupPerson[] {
  return (db.prepare('SELECT * FROM startup_people WHERE startup_id = ? ORDER BY id').all(startupId) as Record<
    string,
    unknown
  >[]).map((r) => StartupPerson.parse(r));
}

/** Store what the search found, and that it ran. Existing addresses keep their row. */
export function saveContacts(db: Db, startupId: number, candidates: readonly StartupCandidate[]): number {
  const people = peopleOf(db, startupId);
  const now = nowIso();
  let added = 0;
  transaction(db, () => {
    const insert = db.prepare(
      `INSERT INTO startup_contacts (startup_id, person_id, email, name, source, confidence, rank, found_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (startup_id, email) DO NOTHING`,
    );
    for (const c of candidates) {
      const personId = c.name === null ? null : (people.find((p) => p.name === c.name)?.id ?? null);
      const result = insert.run(startupId, personId, c.email, c.name, c.source, c.confidence, c.rank, c.found_at, now);
      added += Number(result.changes);
    }
    db.prepare('UPDATE startups SET contacts_checked_at = ? WHERE id = ?').run(now, startupId);
  });
  return added;
}

/** The best live address for a startup — highest rank, never a dead one. */
export function bestContactOf(db: Db, startupId: number): StartupContact | null {
  const row = db
    .prepare(
      `SELECT * FROM startup_contacts WHERE startup_id = ? AND dead_at IS NULL
        ORDER BY rank DESC, id LIMIT 1`,
    )
    .get(startupId) as Record<string, unknown> | undefined;
  return row === undefined ? null : StartupContact.parse(row);
}

/** Addresses already proven wrong for this startup. */
export function deadContactsOf(db: Db, startupId: number): string[] {
  return (
    db.prepare('SELECT email FROM startup_contacts WHERE startup_id = ? AND dead_at IS NOT NULL').all(startupId) as {
      email: string;
    }[]
  ).map((r) => r.email);
}

export function hasOutreach(db: Db, startupId: number): boolean {
  return db.prepare('SELECT 1 FROM startup_outreach WHERE startup_id = ?').get(startupId) !== undefined;
}

/**
 * Has the **job pipeline** already written to this company, or proven one of its addresses dead?
 *
 * The one place the two features meet, and it only reads. Two cold emails from the same person
 * to the same ten-person company — one about a posting, one about an internship nobody
 * advertised — is the fastest way to look like a mailing list. Matched on the apex domain,
 * because the pipeline may know the company as `www.acme.com` and YC as `acme.com`.
 */
export function pipelineAlreadyWrote(db: Db, domain: string): boolean {
  const apex = apexOf(normaliseDomain(domain));
  const rows = db
    .prepare(
      `SELECT c.domain FROM outreach o JOIN jobs j ON j.id = o.job_id JOIN companies c ON c.id = j.company_id
        WHERE o.gmail_draft_id IS NOT NULL`,
    )
    .all() as { domain: string }[];
  return rows.some((r) => apexOf(normaliseDomain(r.domain)) === apex);
}

/** Every address the job pipeline has seen bounce. Never written to from here either. */
export function pipelineDeadEmails(db: Db): string[] {
  return (db.prepare('SELECT email FROM contacts WHERE dead_at IS NOT NULL').all() as { email: string }[]).map(
    (r) => r.email,
  );
}
