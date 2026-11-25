/**
 * Peak XV Partners' portfolio jobs board (Peak XV runs Surge, its early-stage programme).
 * Decision 058.
 *
 * `careers.peakxv.com` is a Consider board. The page lists every open role at every portfolio
 * company, and it loads them from its own JSON endpoint. That endpoint asks for the session
 * token the page hands every visitor, so this does exactly what the page's own script does: read
 * the page once for its cookie and token, then ask for jobs 100 at a time. Nothing is behind a
 * login.
 *
 * Measured 2026-10-05: 2,401 jobs at 108 companies, mostly growth-stage. The stage labels are
 * not trustworthy alone, since apna (1,607 people) is tagged "Seed". So a company counts as
 * early only by its **size**: at most 60 people, or at most 150 if it is also tagged Seed or
 * Series A. That kept 22.
 *
 * What this source does **not** give, compared with YC: founder names (so no founder guess; only
 * addresses published on the company's site), launches, or a description of the company. The
 * brief says so instead of filling the gap.
 */
import { z } from 'zod';
import type { YcCompanyPage } from '../store/schema.ts';
import { MAX_TEAM_SIZE } from './fit.ts';
import type { StartupUpsert } from './store.ts';

export const PEAKXV_BOARD = 'https://careers.peakxv.com';

/** A Seed or Series A company can be larger than a YC one and still be early; not much larger. */
export const MAX_TAGGED_EARLY_SIZE = 150;

const Label = z.object({ label: z.string() });

export const ConsiderJob = z.object({
  jobId: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  url: z.string(),
  companyName: z.string(),
  companySlug: z.string(),
  companyDomain: z.string().nullable().catch(null),
  companyStaffCount: z.number().nullable().catch(null),
  locations: z.array(z.string()).catch([]),
  remote: z.boolean().nullable().catch(null),
  minYearsExp: z.number().nullable().catch(null),
  stages: z.array(Label).catch([]),
  markets: z.array(Label).catch([]),
  salary: z
    .object({
      minValue: z.number().nullable().catch(null),
      maxValue: z.number().nullable().catch(null),
      currency: Label.nullable().catch(null),
      period: Label.nullable().catch(null),
    })
    .nullable()
    .catch(null),
});
export type ConsiderJob = z.infer<typeof ConsiderJob>;

/** Small enough to be early. Size, not the stage label, decides; see the file comment. */
export function isEarly(job: Pick<ConsiderJob, 'companyStaffCount' | 'stages'>): boolean {
  const size = job.companyStaffCount;
  if (size === null) return false;
  if (size <= MAX_TEAM_SIZE) return true;
  return size <= MAX_TAGGED_EARLY_SIZE && job.stages.some((s) => /^(seed|series a|pre-?seed)$/i.test(s.label));
}

/** `{maxValue: 20000, currency: USD, period: Year}` → "$0K - $20K USD / year", the shape `parseSalary` reads. */
export function salaryText(salary: ConsiderJob['salary']): string {
  if (salary === null || (salary.maxValue ?? 0) <= 0) return '';
  const code = salary.currency?.label ?? 'USD';
  const symbol = { USD: '$', INR: '₹', GBP: '£', EUR: '€' }[code] ?? '$';
  const k = (n: number | null) => `${symbol}${Math.round((n ?? 0) / 1000)}K`;
  const period = (salary.period?.label ?? 'Year').toLowerCase();
  return `${k(salary.minValue)} - ${k(salary.maxValue)} ${code} / ${period === 'month' ? 'monthly' : period === 'hour' ? 'hourly' : 'year'}`;
}

/**
 * The jobs, grouped into the two shapes the store takes: one startup row per company, and its
 * roles in the same shape as a YC company page so `saveDetails` stores both sources alike.
 */
export function toStartups(jobs: readonly ConsiderJob[]): { startup: StartupUpsert; page: YcCompanyPage }[] {
  const byCompany = new Map<string, ConsiderJob[]>();
  for (const job of jobs.filter(isEarly)) byCompany.set(job.companySlug, [...(byCompany.get(job.companySlug) ?? []), job]);

  return [...byCompany.values()].map((list) => {
    const first = list[0]!;
    const locations = [...new Set(list.flatMap((j) => j.locations))];
    return {
      startup: {
        source: 'peakxv' as const,
        source_id: first.companySlug,
        name: first.companyName,
        website: first.companyDomain === null ? null : `https://${first.companyDomain}`,
        location: locations.slice(0, 4).join(' / '),
        batch: '',
        team_size: first.companyStaffCount,
        one_liner: first.markets.map((m) => m.label).join(', '),
        description: '',
        tags: [...first.markets.map((m) => m.label), ...first.stages.map((s) => s.label)],
        source_url: `${PEAKXV_BOARD}/companies/${encodeURIComponent(first.companySlug)}`,
      },
      page: {
        company: { github_url: null, founders: [] },
        launches: [],
        newsItems: [],
        jobPostings: list.map((j) => ({
          id: j.jobId,
          title: j.title,
          url: j.url,
          location: [...j.locations, ...(j.remote === true ? ['Remote'] : [])].join(' / '),
          type: /\bintern(ship)?\b/i.test(j.title) ? 'Internship' : null,
          role: null,
          salaryRange: salaryText(j.salary),
          minExperience: j.minYearsExp === null ? null : `${j.minYearsExp}+ years`,
          visa: null,
        })),
      },
    };
  });
}

/** Every job on the board, 100 at a time, the way the page itself asks for them. */
export async function fetchPeakXvJobs(signal?: AbortSignal): Promise<ConsiderJob[]> {
  const timeout = () => (signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  const userAgent = 'jobagent/0.1 (personal job-search agent)';

  const page = await fetch(`${PEAKXV_BOARD}/jobs`, { headers: { 'user-agent': userAgent }, signal: timeout() });
  if (!page.ok) throw new Error(`${PEAKXV_BOARD}/jobs answered ${page.status}`);
  const html = await page.text();
  const csrf = /csrfToken":"([^"]+)"/.exec(html)?.[1];
  const board = /"fixedBoard":"([^"]+)"/.exec(html)?.[1];
  if (csrf === undefined || board === undefined) throw new Error('the board page no longer carries a session token — its format changed');
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const jobs: ConsiderJob[] = [];
  let sequence: string | undefined;
  for (let request = 0; request < 50; request++) {
    const res = await fetch(`${PEAKXV_BOARD}/api-boards/search-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie, 'user-agent': userAgent },
      body: JSON.stringify({ meta: { size: 100, sequence }, board: { id: board, isParent: true }, query: {} }),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`search-jobs answered ${res.status}`);
    const body = (await res.json()) as { jobs?: unknown[]; meta?: { sequence?: string } };
    const batch = body.jobs ?? [];
    for (const raw of batch) {
      const parsed = ConsiderJob.safeParse(raw);
      if (parsed.success) jobs.push(parsed.data);
    }
    sequence = body.meta?.sequence;
    if (batch.length < 100 || sequence === undefined) break;
  }
  return jobs;
}
