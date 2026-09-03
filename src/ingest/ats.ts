/**
 * Pollers for the four ATS platforms that publish a free, unauthenticated JSON board:
 * Greenhouse, Lever, Ashby, Workable.
 *
 * All four work the same way — one GET per company slug returns every open posting — so
 * the differences are isolated to a small {@link BoardAdapter} each, and one generic
 * source factory does the fetching, filtering and error handling.
 *
 * The response schemas below describe *their* JSON, not ours, which is why they live
 * here and not in `src/store/schema.ts`. They are intentionally loose: unknown fields are
 * ignored and each posting is parsed on its own, so one malformed row cannot take down a
 * whole board.
 */
import { z } from 'zod';
import { RawJob, type JobSourceName } from '../store/schema.ts';
import type { JobSource, SourceContext } from './types.ts';
import type { BoardAts, SeedCompany } from './companies.ts';
import { companiesByAts } from './companies.ts';
import { getJson } from './http.ts';
import { htmlToText } from './html.ts';
import { isEarlyCareerTechRole, matchesGeography } from './filter.ts';

/** Boards polled at once. Low on purpose — these are free APIs doing us a favour. */
const CONCURRENCY = 6;

/** One posting, after an adapter has flattened the board's own shape. */
export type BoardPosting = {
  sourceId: string;
  title: string;
  location: string;
  description: string;
  url: string;
  /** UTC ISO, or null when the board does not say. */
  postedAt: string | null;
  /** The board explicitly flagged this as remote. */
  remote: boolean;
};

export type BoardAdapter = {
  ats: BoardAts;
  url: (slug: string) => string;
  parse: (payload: unknown) => BoardPosting[];
};

/** Whatever date shape a board sent, as a UTC ISO string — or null if it is not a date. */
const toIso = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Join the location fields a board provides into one string, without repeats. */
const joinLocations = (...parts: (string | null | undefined)[]): string =>
  [...new Set(parts.filter((p): p is string => typeof p === 'string' && p.trim() !== ''))]
    .join(', ')
    .trim();

/**
 * Parse a list of postings one at a time, dropping (not throwing on) the ones that do
 * not fit the schema. `map` returning null drops a posting the board itself says is not
 * public.
 */
function parseEach<T>(
  items: unknown[],
  schema: z.ZodType<T>,
  map: (item: T) => BoardPosting | null,
): BoardPosting[] {
  const out: BoardPosting[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (!result.success) continue;
    const posting = map(result.data);
    if (posting !== null) out.push(posting);
  }
  return out;
}

// ── Greenhouse ───────────────────────────────────────────────────────────────
// `content` is entity-escaped HTML — htmlToText handles the double decode.

const GreenhouseJob = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.object({ name: z.string() }).nullish(),
  content: z.string().nullish(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
});

export const greenhouse: BoardAdapter = {
  ats: 'greenhouse',
  url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
  parse: (payload) => {
    const body = z.object({ jobs: z.array(z.unknown()) }).safeParse(payload);
    if (!body.success) return [];
    return parseEach(body.data.jobs, GreenhouseJob, (j) => ({
      sourceId: String(j.id),
      title: j.title,
      location: j.location?.name ?? '',
      description: htmlToText(j.content ?? ''),
      url: j.absolute_url,
      postedAt: toIso(j.first_published) ?? toIso(j.updated_at),
      remote: false,
    }));
  },
};

// ── Lever ────────────────────────────────────────────────────────────────────
// Top-level array. Already gives us plain text, and `createdAt` is epoch millis.

const LeverPosting = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number().nullish(),
  workplaceType: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
});

export const lever: BoardAdapter = {
  ats: 'lever',
  url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
  parse: (payload) => {
    if (!Array.isArray(payload)) return [];
    return parseEach(payload, LeverPosting, (p) => ({
      sourceId: p.id,
      title: p.text,
      location: joinLocations(p.categories?.location, ...(p.categories?.allLocations ?? [])),
      description: [p.descriptionPlain, p.additionalPlain].filter(Boolean).join('\n\n'),
      url: p.hostedUrl,
      postedAt: toIso(p.createdAt),
      remote: p.workplaceType?.toLowerCase() === 'remote',
    }));
  },
};

// ── Ashby ────────────────────────────────────────────────────────────────────
// `isListed: false` means the posting exists but is not public — skip those.

const AshbyJob = z.object({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string() })).nullish(),
  publishedAt: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  descriptionPlain: z.string().nullish(),
});

export const ashby: BoardAdapter = {
  ats: 'ashby',
  url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  parse: (payload) => {
    const body = z.object({ jobs: z.array(z.unknown()) }).safeParse(payload);
    if (!body.success) return [];
    return parseEach(body.data.jobs, AshbyJob, (j) =>
      j.isListed === false
        ? null // exists on the board but is not public
        : {
            sourceId: j.id,
            title: j.title,
            location: joinLocations(
              j.location,
              ...(j.secondaryLocations ?? []).map((s) => s.location),
            ),
            description: j.descriptionPlain ?? '',
            url: j.jobUrl,
            postedAt: toIso(j.publishedAt),
            remote: j.isRemote === true,
          },
    );
  },
};

// ── Workable ─────────────────────────────────────────────────────────────────
// The public widget endpoint. `details=true` is what includes the description.

const WorkableJob = z.object({
  shortcode: z.string(),
  title: z.string(),
  url: z.string(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
  telecommuting: z.boolean().nullish(),
  published_on: z.string().nullish(),
  description: z.string().nullish(),
});

export const workable: BoardAdapter = {
  ats: 'workable',
  url: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
  parse: (payload) => {
    const body = z.object({ jobs: z.array(z.unknown()).nullish() }).safeParse(payload);
    if (!body.success || !body.data.jobs) return [];
    return parseEach(body.data.jobs, WorkableJob, (j) => ({
      sourceId: j.shortcode,
      title: j.title,
      location: joinLocations(j.city, j.state, j.country),
      description: htmlToText(j.description ?? ''),
      url: j.url,
      postedAt: toIso(j.published_on),
      remote: j.telecommuting === true,
    }));
  },
};

export const ADAPTERS: Record<BoardAts, BoardAdapter> = { greenhouse, lever, ashby, workable };

// ── Source factory ───────────────────────────────────────────────────────────

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Turn one adapter plus the companies on that ATS into a `JobSource`.
 *
 * Per-board failures are counted and reported, never thrown: a dead slug or a 500 from
 * one company must not cost us the other few hundred.
 */
export function atsSource(adapter: BoardAdapter, companies: readonly SeedCompany[]): JobSource {
  return {
    name: adapter.ats as JobSourceName,

    /**
     * `since` is deliberately ignored here.
     *
     * An ATS board only publishes roles that are *currently open*, so a posting first
     * published eight months ago and still listed is still hiring. Filtering by
     * `posted_at` threw away 3,224 of 4,709 live postings on the first real run,
     * including nearly every open internship. Freshness for these sources is tracked by
     * `jobs.last_seen_at` — a posting that leaves the board stops being seen and expires.
     *
     * Date-based sources (Gmail alerts) do use `since`.
     */
    async *fetch(_since: Date, ctx: SourceContext = {}) {
      const count = ctx.count ?? (() => {});

      for (const batch of chunk(companies, CONCURRENCY)) {
        if (ctx.signal?.aborted === true) break;

        const settled = await Promise.all(
          batch.map(async (company) => {
            try {
              const payload = await getJson<unknown>(adapter.url(company.slug), {
                signal: ctx.signal,
              });
              if (payload === null) {
                // 404 = the slug is gone. Normal; refresh-companies prunes these.
                count(`${adapter.ats}_board_missing`);
                return { company, postings: [] as BoardPosting[] };
              }
              count(`${adapter.ats}_board_ok`);
              return { company, postings: adapter.parse(payload) };
            } catch (err) {
              count(`${adapter.ats}_board_error`);
              ctx.onError?.(
                `${adapter.ats}/${company.slug}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return { company, postings: [] as BoardPosting[] };
            }
          }),
        );

        for (const { company, postings } of settled) {
          for (const posting of postings) {
            count('seen');

            if (!isEarlyCareerTechRole(posting.title)) {
              count('dropped_title');
              continue;
            }
            // Boards often bury the real location in the title ("… - Austin, TX") while
            // the location field says something useless like "In-Office".
            if (!matchesGeography(`${posting.title} ${posting.location}`)) {
              count('dropped_geography');
              continue;
            }

            const parsed = RawJob.safeParse({
              company_name: company.name,
              company_domain: company.domain,
              ats_type: company.ats,
              ats_slug: company.slug,
              source: adapter.ats,
              source_id: posting.sourceId,
              url: posting.url,
              title: posting.title.trim(),
              location: posting.location,
              description: posting.description,
              posted_at: posting.postedAt,
            });

            if (!parsed.success) {
              count('dropped_malformed');
              ctx.onError?.(`${adapter.ats}/${company.slug}: ${parsed.error.issues[0]?.message}`);
              continue;
            }

            count('kept');
            yield parsed.data;
          }
        }
      }
    },
  };
}

/** Every ATS source, wired to the companies in the seed list that use it. */
export function atsSources(companies: readonly SeedCompany[]): JobSource[] {
  return (Object.keys(ADAPTERS) as BoardAts[])
    .map((ats) => ({ ats, companies: companiesByAts(companies, ats) }))
    .filter((x) => x.companies.length > 0)
    .map((x) => atsSource(ADAPTERS[x.ats], x.companies));
}
