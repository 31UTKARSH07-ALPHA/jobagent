/**
 * Parsing a Naukri alert email into postings.
 *
 * Written against three real emails in Utkarsh's mailbox on 2026-08-11, not against a guess.
 * Re-check with `node src/gmail/messages.ts --query="from:naukri.com" --links --full` if this
 * ever starts returning nothing — bulk-mail templates change without notice, and the failure
 * mode is silence rather than an error.
 *
 * **Everything comes out of the link, not the visible text.** The rendered email shows the
 * company truncated — "Discover Dollar Tec..." — while the URL slug carries it in full. So the
 * anchor supplies the exact title (its text) and the slug supplies company, location and the
 * experience band:
 *
 *   /jd/job-listings-software-development-intern-full-stack   ← title, matches the anchor text
 *                    -discover-dollar-technologies-pvt-ltd    ← company
 *                    -bengaluru                               ← location
 *                    -0-to-1-years                            ← experience band
 *                    -050826503011                            ← Naukri's posting id
 *
 * The company/location boundary is the only ambiguous part, because both are hyphenated and a
 * city can be two words ("navi-mumbai"). It is resolved by matching a *known* city at the end
 * rather than by guessing where the company name stops.
 *
 * **No description.** Alert emails carry a title and nothing else, and fetching the posting
 * page is exactly the scraping decision 004 rules out. The scorer's prompt already handles an
 * empty description by judging on title, company and location — see the note in
 * `docs/decisions.md` 016 about what that costs.
 */
import { RawJob } from '../store/schema.ts';
import { normaliseForKey } from '../store/jobs.ts';
import { extractLinks } from '../gmail/messages.ts';
import type { Email } from '../gmail/messages.ts';
import type { AlertPosting } from './types.ts';

/** Senders whose mail is worth parsing at all. */
export const NAUKRI_SENDERS = /@(.+\.)?naukri\.com$/i;

/** A posting link, as opposed to the twenty tracking and social links in the same email. */
const JOB_LINK = /naukri\.com\/jd\/job-listings-/i;

/**
 * Cities Naukri actually writes into its slugs, longest first so `navi-mumbai` is tested
 * before `mumbai`.
 *
 * Deliberately the same geography as `INDIA_LOCATION` in `./filter.ts`, kept in slug form
 * because that is what a URL contains. A city missing from here costs a location, not a
 * posting — the location simply comes out empty and the scorer sees "(not stated)".
 */
const CITY_SLUGS = [
  'navi-mumbai',
  'greater-noida',
  'new-delhi',
  'delhi-ncr',
  'bangalore-rural',
  'thiruvananthapuram',
  'visakhapatnam',
  'bhubaneswar',
  'coimbatore',
  'chandigarh',
  'ahmedabad',
  'bengaluru',
  'bangalore',
  'hyderabad',
  'gurugram',
  'gurgaon',
  'kolkata',
  'calcutta',
  'trivandrum',
  'mysuru',
  'mysore',
  'chennai',
  'madras',
  'mumbai',
  'bombay',
  'nagpur',
  'jaipur',
  'indore',
  'kochi',
  'cochin',
  'noida',
  'delhi',
  'pune',
  'vizag',
  'remote',
  'india',
  'ncr',
] as const;

/** `Software Development Intern (Full Stack)` → `software-development-intern-full-stack`. */
export const slugifyTitle = (title: string): string => normaliseForKey(title).replace(/ /g, '-');

/** Naukri's slugs also carry an experience band, which the shared shape does not require. */
export type NaukriPosting = AlertPosting & {
  /** `0-1` from `0-to-1-years`. Kept as written; the scorer reads the title, not this. */
  experience: string;
};

/** Tracking parameters are most of the URL and none of the identity. */
export function cleanUrl(href: string): string {
  try {
    const url = new URL(href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return href;
  }
}

/** `discover-dollar-technologies-pvt-ltd` → `Discover Dollar Technologies Pvt Ltd`. */
const unslug = (slug: string): string =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Pull a posting out of one job link.
 *
 * Returns null rather than throwing for anything that does not fit — a changed template must
 * cost one posting, never the whole ingest.
 */
export function parseJobLink(href: string, anchorText: string): NaukriPosting | null {
  const title = anchorText.trim();
  if (title === '') return null;

  const path = (() => {
    try {
      return new URL(href).pathname;
    } catch {
      return href;
    }
  })();

  const slug = /\/jd\/job-listings-(.+)$/i.exec(path)?.[1];
  if (slug === undefined) return null;

  // The tail is structured: experience band then Naukri's numeric id.
  const tail = /^(.*?)-(\d+)-to-(\d+)-years-(\d+)$/.exec(slug);
  if (tail === null) return null;

  const [, head = '', from = '', to = '', sourceId = ''] = tail;

  // The anchor text is the authoritative title, so its slug can simply be subtracted from the
  // front — no need to guess where the title ends.
  const titleSlug = slugifyTitle(title);
  let remainder = head.startsWith(titleSlug) ? head.slice(titleSlug.length).replace(/^-/, '') : head;

  // What is left is `<company>[-<city>]`. Match a known city at the end; anything else is all
  // company.
  let location = '';
  for (const city of CITY_SLUGS) {
    if (remainder === city || remainder.endsWith(`-${city}`)) {
      location = unslug(city);
      remainder = remainder.slice(0, remainder.length - city.length).replace(/-$/, '');
      break;
    }
  }

  const company = unslug(remainder);
  if (company === '') return null;

  return {
    title,
    company,
    location,
    url: cleanUrl(href),
    sourceId,
    experience: `${from}-${to}`,
  };
}

/**
 * Every posting in one Naukri email.
 *
 * Deduped on posting id: the same job is linked two or three times in one email (title, logo,
 * "apply now"), and `extractLinks` only dedupes identical hrefs — the tracking parameters
 * differ between those copies.
 */
export function parseNaukriEmail(email: Email): NaukriPosting[] {
  const byId = new Map<string, NaukriPosting>();

  for (const link of extractLinks(email.html)) {
    if (!JOB_LINK.test(link.href)) continue;
    const posting = parseJobLink(link.href, link.text);
    if (posting !== null && !byId.has(posting.sourceId)) byId.set(posting.sourceId, posting);
  }

  return [...byId.values()];
}

/**
 * A posting as the pipeline's canonical row.
 *
 * The company domain is left to the caller: resolving a name to a domain needs the DB
 * (`resolveCompany`), and an adapter must not reach into the store.
 */
export function toRawJob(
  posting: AlertPosting,
  company: { name: string; domain: string },
  receivedAt: string,
): RawJob | null {
  const parsed = RawJob.safeParse({
    company_name: company.name,
    company_domain: company.domain,
    source: 'gmail-alert',
    source_id: posting.sourceId,
    url: posting.url,
    title: posting.title,
    location: posting.location,
    // Alerts carry no job description, and fetching one is decision 004's scraping ban.
    description: '',
    // The email's arrival is the only date available. Better than null: it is right to within
    // a day, and staleness is what `posted_at` is for.
    posted_at: receivedAt,
  });

  return parsed.success ? parsed.data : null;
}
