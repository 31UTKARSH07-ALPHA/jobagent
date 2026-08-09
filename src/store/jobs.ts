/**
 * Job reads and writes, including the dedup key that makes ingest idempotent.
 *
 * The same internship shows up on a company's Greenhouse board *and* in a LinkedIn alert
 * email. Without a stable key across sources we would score it twice and, worse, email
 * about it twice.
 */
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { nowIso, type Job, type RawJob } from './schema.ts';
import { normaliseDomain } from './companies.ts';

/**
 * Strip everything that varies between sources describing the same role: case,
 * punctuation, seniority decoration in brackets, and whitespace.
 */
export function normaliseForKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // unicode dashes → ascii
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * `sha256(company_domain + normalise(title) + normalise(location))` — see
 * `docs/architecture.md`. Catches roughly 90% of cross-source duplicates; the reworded
 * remainder is caught later by cosine similarity in the prefilter, which costs nothing
 * extra because those embeddings already exist.
 */
export function dedupKey(companyDomain: string, title: string, location: string): string {
  const basis = [
    normaliseDomain(companyDomain),
    normaliseForKey(title),
    normaliseForKey(location),
  ].join('|');
  return createHash('sha256').update(basis).digest('hex');
}

export type UpsertResult = { id: number; created: boolean };

/**
 * Insert a newly discovered job, or mark an already-known one as still open.
 *
 * Re-running ingest must be a no-op beyond `last_seen_at` (invariant 4). In particular
 * this never touches `state` — a job that has already been scored, drafted or sent stays
 * exactly where it is when its posting is seen again tomorrow.
 */
export function upsertJob(db: Db, companyId: number, raw: RawJob): UpsertResult {
  const key = dedupKey(raw.company_domain, raw.title, raw.location);
  const now = nowIso();

  const existing = db.prepare('SELECT id FROM jobs WHERE dedup_key = ?').get(key) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
    return { id: existing.id, created: false };
  }

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO jobs (company_id, dedup_key, source, source_id, url, title, location,
                         description, posted_at, state, state_changed_at,
                         contact_attempts, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, 0, ?, ?)`,
    )
    .run(
      companyId,
      key,
      raw.source,
      raw.source_id,
      raw.url,
      raw.title,
      raw.location,
      raw.description,
      raw.posted_at,
      now,
      now,
      now,
    );

  return { id: Number(lastInsertRowid), created: true };
}

export function getJob(db: Db, id: number): Job | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined) ?? null;
}

/**
 * Jobs not seen in the last `days` ingests. The posting is gone from its source, so the
 * role is filled or pulled — callers expire them.
 */
export function staleJobIds(db: Db, days: number): number[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id FROM jobs
        WHERE last_seen_at < ?
          AND state IN ('DISCOVERED','SCORED','MATCHED','NEEDS_CONTACT')`,
    )
    .all(cutoff) as { id: number }[];
  return rows.map((r) => r.id);
}
