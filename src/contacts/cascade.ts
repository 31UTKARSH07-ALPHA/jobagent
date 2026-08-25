/**
 * A company → an address worth writing to, found once per company and cached (decision 005).
 *
 * Four rungs, best evidence first, stopping as soon as one of them produces something good
 * enough. The order is not arbitrary — it is the confidence ladder invariant 3 is built on,
 * because *where* an address came from is the only signal this project has about whether it
 * is real (decision 006, which chose provenance over a paid verifier API):
 *
 * | Rung | Confidence | What it is |
 * |---|---|---|
 * | `posting` | high | an address written into the job description itself |
 * | `team_page` | high | an address published on the company's own site |
 * | `github` | medium | a commit author at the company's GitHub org |
 * | `pattern` | low | `careers@` and friends, guessed |
 *
 * Only the two `high` rungs can ever auto-send. A pattern guess is a guess however plausible
 * it looks, and it goes to the approval queue for a human to read first.
 *
 * Everything here needs a **verified** domain — see `./domain.ts` and decision 030. Handing
 * this a `.unknown.invalid` marker is a bug, not a slow path.
 */
import { getJson, getText, HttpError } from '../ingest/http.ts';
import { decodeEntities, htmlToText } from '../ingest/html.ts';
import { normaliseCompanyName } from '../ingest/resolve-company.ts';
import { normaliseDomain } from '../store/companies.ts';
import { confidenceForSource, type ContactSource } from '../store/schema.ts';
import { apexOf } from './domain.ts';
import { domainOfEmail, hasMx } from './verify.ts';

/**
 * Addresses whose whole job is to not be replied to, plus every desk that is not the hiring
 * desk. `sales@`, `billing@` and `support@` are real humans, and reading a cold job
 * application is not their job — writing to them is how a small company decides this sender
 * is spam.
 *
 * Customer service is on this list for a sharper reason than tidiness. Run live, the cascade
 * returned `customercare@chaipoint.com` and `support@bytebeam.io` as `team_page` finds, and
 * `team_page` is a **high**-confidence rung — so Phase 3 would have been entitled to auto-send
 * a job application into a customer-service queue with nobody reading it first. Excluding them
 * costs those companies a `careers@` pattern guess instead, which is `low` confidence and
 * therefore goes to the approval queue where it belongs.
 */
const JUNK_LOCAL =
  /^(no-?reply|donot-?reply|do-not-reply|postmaster|webmaster|hostmaster|abuse|privacy|legal|dmca|copyright|unsubscribe|mailer-daemon|bounce|notifications?|alerts?|security|sales|billing|invoices?|accounts?payable|press|media|newsletter|subscribe|orders?|returns?|refunds?|support|customer-?(care|support|service)|helpdesk|help|care|services?|feedback|complaints?|grievances?)([._+-]|$)/i;

/** Addresses that belong to the *website*, not the company behind it. */
const JUNK_DOMAINS = new Set([
  'example.com',
  'example.org',
  'domain.com',
  'yourdomain.com',
  'yourcompany.com',
  'company.com',
  'email.com',
  'sentry.io',
  'wixpress.com',
  'sentry.wixpress.com',
  'godaddy.com',
  'squarespace.com',
  'shopify.com',
  'wordpress.com',
  'users.noreply.github.com',
]);

/** `logo@2x.png` parses as an email address. It is not one. */
const FILE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ico|pdf|mp4)$/i;

/**
 * The local parts of an address that exists to receive exactly this email.
 *
 * Ranked above everything else on purpose: `careers@` is monitored by whoever handles
 * hiring, where a named engineer's address is a person being interrupted.
 */
const HIRING_LOCAL =
  /^(careers?|jobs?|hr|hiring|recruit(ing|ment)?|talent|people(ops)?|internships?|interns?|apply|joinus|join|work(with|at)us)([._+-]|$)/i;

/** Front-door addresses. Real, monitored, not specifically about hiring. */
const GENERIC_LOCAL = /^(hello|hi|info|contact|connect|enquir(y|ies)|inquir(y|ies)|reach|team|admin|office|mail)([._+-]|$)/i;

/** Guessed local parts, likeliest to be monitored first. */
const PATTERN_LOCALS = ['careers', 'hr', 'jobs', 'hiring', 'hello', 'contact', 'info'] as const;

/**
 * Pages worth reading when the site does not link to them itself.
 *
 * Only used as a fallback: the home page's own links are followed first, because a site that
 * has a careers page almost always links to it and guessing paths costs a 404 each time.
 */
const FALLBACK_PATHS = ['/careers', '/contact', '/about'] as const;

/** How many pages of one company's site to read. Each is a network round trip. */
const MAX_PAGES = 4;

const PAGE_TIMEOUT_MS = 8_000;

/**
 * Local parts that are almost certainly a person rather than a role — used only to *rank*,
 * never to reject, because at a ten-person startup the founder's address may be the only one
 * published anywhere.
 */
const looksPersonal = (local: string): boolean => /^[a-z]+([._-][a-z]+)?$/i.test(local) && local.length <= 20;

export type ContactCandidate = {
  email: string;
  name: string | null;
  title: string | null;
  source: ContactSource;
  /** Higher is better. Ordering only — never compared across companies. */
  rank: number;
  /** Where it was read from, for the log line and for debugging a bad address later. */
  found_at: string;
};

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)+/gi;

/**
 * De-obfuscation, kept to the two forms that actually appear.
 *
 * `careers [at] acme [dot] com` is what a site writes when it wants a human to read it and a
 * scraper not to. Bare " at " is deliberately not handled — "meet the team at acme.com" would
 * turn into an address.
 */
const deobfuscate = (text: string): string =>
  text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');

/** Every address in a blob of text or HTML, lowercased and de-duplicated. */
export function emailsIn(input: string): string[] {
  if (input === '') return [];
  const text = deobfuscate(decodeEntities(input));
  const found = text.match(EMAIL) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/[.,;:)\]}>'"]+$/, '')))];
}

/**
 * Is this an address, and is it one we would write to?
 *
 * Off-domain addresses are allowed through deliberately. A ten-person firm in Kochi
 * genuinely does put `acmehr@gmail.com` on its contact page, and refusing those would throw
 * away the real address in favour of a guess at the company domain — but only when the local
 * part is about hiring or carries the company's own name, since an arbitrary personal address
 * on a company page is as likely to be a vendor's as an employee's.
 */
export function isUsable(email: string, companyDomain: string, companyName: string): boolean {
  const local = email.split('@')[0] ?? '';
  const domain = domainOfEmail(email);
  if (domain === null || local === '') return false;
  if (FILE_EXTENSIONS.test(email) || JUNK_LOCAL.test(local)) return false;
  if (JUNK_DOMAINS.has(domain) || JUNK_DOMAINS.has(apexOf(domain))) return false;
  if (domain.endsWith('.invalid')) return false;

  const own = normaliseDomain(companyDomain);
  if (domain === own || apexOf(domain) === apexOf(own)) return true;

  const stem = normaliseCompanyName(companyName).replace(/\s+/g, '');
  return HIRING_LOCAL.test(local) || (stem.length >= 4 && local.replace(/[^a-z0-9]/gi, '').includes(stem));
}

/**
 * Ordering within a company's findings. Rung first, then how likely the address is to be
 * read by somebody who hires.
 */
export function rankEmail(email: string, source: ContactSource, companyDomain: string): number {
  const local = email.split('@')[0] ?? '';
  const domain = domainOfEmail(email) ?? '';

  const bySource = { posting: 400, team_page: 300, github: 200, pattern: 100 }[source];
  const byLocal = HIRING_LOCAL.test(local) ? 50 : GENERIC_LOCAL.test(local) ? 30 : looksPersonal(local) ? 20 : 10;
  const byDomain = apexOf(domain) === apexOf(normaliseDomain(companyDomain)) ? 5 : 0;

  return bySource + byLocal + byDomain;
}

/** Same-site links that look like they lead to a page with an address on it. */
export function contactLinks(html: string, baseUrl: string): string[] {
  const base = URL.parse(baseUrl);
  if (base === null) return [];

  const out: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = decodeEntities(match[1] ?? '');
    const label = htmlToText(match[2] ?? '');
    if (href === '' || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    if (!/care+rs?|jobs?|hiring|vacanc|contact|about|team|people|work.?with.?us|join/i.test(`${href} ${label}`)) {
      continue;
    }

    const resolved = URL.parse(href, base.href);
    // Same site only. A careers link pointing at a Greenhouse board is a job list, not a
    // contact page, and following it would read somebody else's site.
    if (resolved === null || apexOf(resolved.hostname) !== apexOf(base.hostname)) continue;
    resolved.hash = '';
    out.push(resolved.href);
  }

  return [...new Set(out)];
}

export type CascadeOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Job descriptions for this company's open postings — the first rung reads these. */
  postings?: readonly string[];
  /** GitHub is rate-limited to 60 requests an hour unauthenticated; the stage caps it. */
  allowGithub?: boolean;
};

/** Read one page and keep whatever addresses are on it. Never throws. */
async function harvest(
  url: string,
  company: { name: string; domain: string },
  source: ContactSource,
  opts: CascadeOptions,
): Promise<{ candidates: ContactCandidate[]; html: string }> {
  let page;
  try {
    page = await getText(url, {
      timeoutMs: opts.timeoutMs ?? PAGE_TIMEOUT_MS,
      retries: 0,
      signal: opts.signal,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) opts.log?.(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    return { candidates: [], html: '' };
  }
  if (page === null) return { candidates: [], html: '' };

  const candidates = emailsIn(page.html)
    .filter((email) => isUsable(email, company.domain, company.name))
    .map((email) => ({
      email,
      name: null,
      title: null,
      source,
      rank: rankEmail(email, source, company.domain),
      found_at: url,
    }));

  return { candidates, html: page.html };
}

/** GitHub's public API, unauthenticated. Null rather than throwing for every failure mode. */
async function githubEmails(
  company: { name: string; domain: string },
  opts: CascadeOptions,
): Promise<ContactCandidate[]> {
  const org = normaliseCompanyName(company.name).replace(/\s+/g, '');
  if (org.length < 4) return [];

  const api = `https://api.github.com/orgs/${encodeURIComponent(org)}`;

  let profile;
  try {
    profile = await getJson<{ email?: string | null }>(api, {
      timeoutMs: opts.timeoutMs ?? PAGE_TIMEOUT_MS,
      retries: 0,
      signal: opts.signal,
    });
  } catch {
    // 403 is the rate limit, 404 is "no org by that name" — both mean nothing to add.
    return [];
  }

  // The org's own public email, when it has one. Commit-log mining is deliberately not done:
  // it costs three more requests against a 60-per-hour limit shared by every company in the
  // run, and what it yields is an engineer's personal address rather than anyone who hires.
  // Revisit if the team-page rung stops finding anything.
  const email = profile?.email ?? '';
  if (email === '' || !isUsable(email, company.domain, company.name)) return [];

  return [
    {
      email: email.toLowerCase(),
      name: company.name,
      title: null,
      source: 'github',
      rank: rankEmail(email, 'github', company.domain),
      found_at: api,
    },
  ];
}

/**
 * Every address this company will give up, best first.
 *
 * Stops early when a rung produces an address specifically about hiring on the company's own
 * domain — there is nothing better further down, and the remaining rungs cost network.
 */
export async function findContacts(
  company: { name: string; domain: string },
  opts: CascadeOptions = {},
): Promise<ContactCandidate[]> {
  const found: ContactCandidate[] = [];
  const seen = new Set<string>();

  // A function, not a repeated `opts.signal?.aborted === true`: TypeScript narrows the
  // second such check to `false`, having no idea the value flips while the code above it
  // awaits the network. Decision 029 hit exactly this in the scorer.
  const outOfTime = (): boolean => opts.signal?.aborted === true;

  const add = (candidates: ContactCandidate[]): void => {
    for (const candidate of candidates) {
      if (seen.has(candidate.email)) continue;
      seen.add(candidate.email);
      found.push(candidate);
    }
  };

  const done = (): boolean =>
    found.some(
      (c) =>
        confidenceForSource(c.source) === 'high' &&
        HIRING_LOCAL.test(c.email.split('@')[0] ?? '') &&
        apexOf(domainOfEmail(c.email) ?? '') === apexOf(company.domain),
    );

  // 1. The posting itself. Free — this text is already in the database.
  for (const posting of opts.postings ?? []) {
    add(
      emailsIn(posting)
        .filter((email) => isUsable(email, company.domain, company.name))
        .map((email) => ({
          email,
          name: null,
          title: null,
          source: 'posting' as const,
          rank: rankEmail(email, 'posting', company.domain),
          found_at: 'job description',
        })),
    );
  }
  if (done()) return sorted(found);

  // 2. The company's own site: home page, then the pages it links to that sound like they
  //    carry an address, then a couple of guessed paths if it linked to none.
  let pages = 0;
  const home = `https://${company.domain}/`;
  const first = await harvest(home, company, 'team_page', opts);
  add(first.candidates);
  pages++;

  if (!done() && !outOfTime()) {
    const links = contactLinks(first.html, home);
    const targets = links.length > 0 ? links : FALLBACK_PATHS.map((p) => `https://${company.domain}${p}`);

    for (const target of targets) {
      if (pages >= MAX_PAGES || done() || outOfTime()) break;
      const next = await harvest(target, company, 'team_page', opts);
      add(next.candidates);
      pages++;
    }
  }
  if (done()) return sorted(found);

  // 3. GitHub, when the stage still has requests to spare.
  if (opts.allowGithub === true && !outOfTime()) add(await githubEmails(company, opts));
  if (done()) return sorted(found);

  // 4. The guess. Always available, never trusted: `confidence: 'low'`, approval queue only.
  add(
    PATTERN_LOCALS.map((local) => ({
      email: `${local}@${company.domain}`,
      name: null,
      title: null,
      source: 'pattern' as const,
      rank: rankEmail(`${local}@${company.domain}`, 'pattern', company.domain) - PATTERN_LOCALS.indexOf(local),
      found_at: 'pattern',
    })),
  );

  return sorted(found);
}

const sorted = (candidates: ContactCandidate[]): ContactCandidate[] =>
  [...candidates].sort((a, b) => b.rank - a.rank);

/**
 * The best candidate whose domain can actually receive mail.
 *
 * The MX check is here rather than inside the ranking because it costs a DNS round trip:
 * asking it of the top candidate and walking down only on failure means the common case is
 * one lookup, not seven.
 */
export async function bestContact(
  candidates: readonly ContactCandidate[],
): Promise<ContactCandidate | null> {
  for (const candidate of candidates) {
    const domain = domainOfEmail(candidate.email);
    if (domain !== null && (await hasMx(domain))) return candidate;
  }
  return null;
}
