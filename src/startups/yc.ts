/**
 * Y Combinator's companies: the directory for *which* startups, each company's page for *who*
 * founded it and *what* it is hiring for.
 *
 * Two sources, both public and free, and neither needs a login:
 *
 * - **The directory**, via `yc-oss.github.io/api` — a daily mirror of YC's own company search as
 *   static JSON. One 2.5MB file holds every company that is hiring (1,492 on 2026-10-05) with
 *   its stage, batch, team size and regions. That is enough to cut the list to early-stage
 *   companies in India or open to remote work *before* any company page is fetched.
 * - **The company page**, `ycombinator.com/companies/<slug>`. YC renders it with Inertia, so
 *   the founders (name and title) and the open roles (title, location, salary, minimum
 *   experience) arrive as JSON in a `data-page` attribute. Read as data; nothing on the page is
 *   scraped as layout.
 *
 * Why YC and not a funding database: Crunchbase is paid, Wellfound blocks automated readers, and
 * LinkedIn is ruled out for the account-ban reason (decision 004). A YC company is a startup by
 * construction, and its batch says roughly how far along it is.
 */
import { decodeEntities } from '../ingest/html.ts';
import { getJson, getText } from '../ingest/http.ts';
import { YcCompanyPage, YcIndexCompany } from '../store/schema.ts';
import { EARLY_STAGE, MAX_TEAM_SIZE, MIN_BATCH_YEAR, batchYear } from './fit.ts';

export const YC_INDEX_URL = 'https://yc-oss.github.io/api/companies/hiring.json';
export const ycCompanyUrl = (slug: string): string => `https://www.ycombinator.com/companies/${encodeURIComponent(slug)}`;

/** Regions in the directory that say a company works with people who are not in its office. */
const REMOTE_REGIONS = /\b(remote|fully remote|partly remote)\b/i;

/**
 * Worth fetching the page for: active, early, recent, small, hiring, and either in India or
 * open to remote work.
 *
 * Cut on the directory's own fields because each page is a request. On 2026-10-05 this left
 * 16 Indian and 270 remote companies out of 1,492. "Remote" here is the *company's* flag — the
 * roles on its page are checked again, one by one, by `judgeRole`, since most remote YC roles
 * are "Remote (US)".
 */
export function isCandidate(c: YcIndexCompany): boolean {
  if (c.status !== null && c.status !== 'Active') return false;
  if (!c.isHiring || c.stage !== EARLY_STAGE) return false;
  if (batchYear(c.batch) < MIN_BATCH_YEAR) return false;
  if (c.team_size !== null && c.team_size > MAX_TEAM_SIZE) return false;

  const india = c.regions.includes('India') || /\b(india|bengaluru|bangalore)\b/i.test(c.all_locations ?? '');
  const remote = c.regions.some((r) => REMOTE_REGIONS.test(r));
  return india || remote;
}

/** The directory, filtered. Throws when the mirror cannot be read — there is nothing to do without it. */
export async function fetchIndex(signal?: AbortSignal): Promise<YcIndexCompany[]> {
  const raw = await getJson<unknown[]>(YC_INDEX_URL, { timeoutMs: 60_000, signal });
  if (!Array.isArray(raw)) throw new Error(`${YC_INDEX_URL} did not return a list`);

  return raw.flatMap((row) => {
    const parsed = YcIndexCompany.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The JSON YC embeds in a company page, or null when the page has none.
 *
 * Attribute-decoded by hand: the value is HTML-escaped JSON, and `&quot;` has to become `"`
 * before it parses. `decodeEntities` does the rest.
 */
export function parseCompanyPage(html: string): YcCompanyPage | null {
  const parsed = YcCompanyPage.safeParse(decodePageProps(html));
  return parsed.success ? parsed.data : null;
}

/** The `props` of a YC page's embedded Inertia data, or null. Shared by company and job pages. */
export function decodePageProps(html: string): unknown {
  const match = /data-page="([^"]*)"/.exec(html);
  if (match === null) return null;
  try {
    return (JSON.parse(decodeEntities(match[1] ?? '')) as { props?: unknown }).props ?? null;
  } catch {
    return null;
  }
}

/** One company page, parsed. Null for a page that is gone or carries no data. */
export async function fetchCompanyPage(slug: string, signal?: AbortSignal): Promise<YcCompanyPage | null> {
  // 1MB: the page is ~120KB today, and a truncated attribute would fail to parse silently.
  const page = await getText(ycCompanyUrl(slug), { timeoutMs: 20_000, retries: 1, signal, maxBytes: 1024 * 1024 });
  return page === null ? null : parseCompanyPage(page.html);
}

/** A YC job link is site-relative. */
export const absoluteYcUrl = (path: string): string => new URL(path, 'https://www.ycombinator.com').href;
