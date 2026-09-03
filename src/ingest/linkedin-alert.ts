/**
 * Parsing a LinkedIn job-alert email into postings.
 *
 * Written against real mail in Utkarsh's mailbox on 2026-08-16 — 26 of them, which had been
 * piling up unparsed since the alerts were created. Same rule as Naukri (decision 016): a
 * bulk-mail parser written against imagined HTML passes its own tests and reads nothing.
 *
 * **The title comes from the HTML, the company and location from the text.** LinkedIn's
 * `text/plain` part is a clean stack of cards:
 *
 *     Software Intern            ← title
 *     Terralogic                 ← company
 *     Greater Bengaluru Area     ← location
 *     This company is actively hiring        ← a badge, and not always present
 *     View job: https://www.linkedin.com/comm/jobs/view/4451230158/?trackingId=…
 *
 * Reading that by counting lines works right up until LinkedIn adds a badge — and then the
 * company silently becomes "Apply with resume & profile" and pollutes `companies`. So the
 * title is taken from the anchor in the HTML instead, and the text is only asked "where is
 * that line, and what are the two lines under it". Badges move; the title/company/location
 * order does not.
 *
 * Unlike Naukri, the URL carries **only the job id** — no company, no city — so the slug
 * trick from `./naukri-alert.ts` does not apply here.
 *
 * Re-check with `node src/gmail/messages.ts --query="from:linkedin.com" --body --full` if this
 * starts returning nothing. The failure mode is silence, not an error.
 */
import type { Email } from '../gmail/messages.ts';
import { extractLinks } from '../gmail/messages.ts';
import type { AlertPosting } from './types.ts';

/** `jobalerts-noreply@linkedin.com` today; kept wide because LinkedIn has many senders. */
export const LINKEDIN_SENDERS = /@(.+\.)?linkedin\.com$/i;

/** A posting link. `/comm/` is the tracking-domain variant and appears in every alert. */
const JOB_VIEW = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i;

/** Where each card ends in the text part. The URL is the only reliable card boundary. */
const VIEW_JOB = /View job:\s*(\S+)/g;

/**
 * Badges LinkedIn slots between the location and the link. They are not fields.
 *
 * This list only has to be right about *rejecting* — the title anchor tells us where the
 * fields start, so an unknown badge costs a location, never a wrong company.
 */
const BADGE =
  /^(this company is actively hiring|apply with resume|easy apply|be an early applicant|actively recruiting|promoted|your profile matches|viewed|\d+ (connection|school alum))/i;

/** The posting id, from any LinkedIn job URL. */
export const jobIdFrom = (url: string): string | null => JOB_VIEW.exec(url)?.[1] ?? null;

/**
 * The canonical URL for a posting id.
 *
 * Every link in the email carries a per-email `trackingId`, `midToken` and `otpToken`, so the
 * same job mailed twice would otherwise arrive as two different URLs. Rebuilding from the id
 * also keeps single-use tokens out of the database.
 */
export const cleanUrl = (id: string): string => `https://www.linkedin.com/jobs/view/${id}/`;

/**
 * Job id → title, from the HTML anchors.
 *
 * Each card links its job twice: once from the company logo, whose anchor text is empty, and
 * once from the title. Both hrefs point at the same job with a different `trk=` parameter, so
 * the empty one must not win.
 */
export function titlesByJobId(html: string): Map<string, string> {
  const titles = new Map<string, string>();

  for (const { href, text } of extractLinks(html)) {
    const id = jobIdFrom(href);
    if (id === null || text === '') continue;
    if (!titles.has(id)) titles.set(id, text);
  }
  return titles;
}

/** The lines of one card, trimmed, with blanks and rules removed. */
const meaningfulLines = (block: string): string[] =>
  block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^-{3,}$/.test(l));

/** Pull the job postings out of one LinkedIn alert email. */
export function parseLinkedInEmail(email: Email): AlertPosting[] {
  const titles = titlesByJobId(email.html);
  const postings: AlertPosting[] = [];
  const seen = new Set<string>();

  let cursor = 0;
  let cards = 0;
  VIEW_JOB.lastIndex = 0;

  for (const match of email.text.matchAll(VIEW_JOB)) {
    const block = email.text.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const id = jobIdFrom(match[1] ?? '');
    if (id === null) continue;
    cards++;
    if (seen.has(id)) continue;

    const title = titles.get(id);
    if (title === undefined) continue;

    // The card is everything since the previous link, so the header block rides along with
    // the first one. Finding the title is what makes that harmless.
    const lines = meaningfulLines(block);
    const at = lines.findIndex((l) => l.toLowerCase() === title.toLowerCase());
    if (at === -1) continue;

    const company = lines[at + 1] ?? '';
    if (company === '' || BADGE.test(company)) continue; // no company, nothing to email

    const next = lines[at + 2] ?? '';
    const location = BADGE.test(next) ? '' : next;

    seen.add(id);
    postings.push({ title, company, location, url: cleanUrl(id), sourceId: id });
  }

  // Every card unreadable while the email plainly contains cards means the template moved.
  // Loud beats silent: this is counted as `alert_parse_failed` with the subject attached.
  if (cards > 0 && postings.length === 0) {
    throw new Error(`${cards} job link(s) but none parsed — LinkedIn's template has changed`);
  }

  return postings;
}
