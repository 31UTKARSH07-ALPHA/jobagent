/**
 * The seed list of company job boards to poll.
 *
 * `data/companies.json` is an *input*, not state — it is the one thing under `data/`
 * that is committed. Every entry in it has been verified against the live ATS API by
 * `src/ingest/refresh-companies.ts`; slugs are guessable but wrong roughly half the
 * time, so nothing goes in this file unverified.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AtsType } from '../store/schema.ts';

export const SEED_PATH = process.env['JOBAGENT_COMPANIES'] ?? 'data/companies.json';

/** Which of Utkarsh's target geographies this company hires into. */
export const Region = z.enum(['india', 'remote-global']);
export type Region = z.infer<typeof Region>;

/** A board we can actually poll — `none` is not a pollable ATS. */
export const BoardAts = AtsType.exclude(['none']);
export type BoardAts = z.infer<typeof BoardAts>;

export const SeedCompany = z.object({
  name: z.string().min(1),
  /** Normalised: lowercase, no scheme, no `www.`. Becomes `companies.domain`. */
  domain: z.string().min(3),
  ats: BoardAts,
  slug: z.string().min(1),
  regions: z.array(Region).nonempty(),
  /** Live job count at the time the list was last verified. Purely informational. */
  verified_jobs: z.number().int().min(0).optional(),
});
export type SeedCompany = z.infer<typeof SeedCompany>;

export const CompanySeed = z.object({
  generated_at: z.iso.datetime(),
  companies: z.array(SeedCompany),
});
export type CompanySeed = z.infer<typeof CompanySeed>;

/** Reads and validates the seed list. Throws loudly — a malformed seed is a bug. */
export function loadCompanies(path: string = SEED_PATH): SeedCompany[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return CompanySeed.parse(raw).companies;
}

/** Just the companies whose board is on this ATS. */
export const companiesByAts = (companies: readonly SeedCompany[], ats: BoardAts): SeedCompany[] =>
  companies.filter((c) => c.ats === ats);
