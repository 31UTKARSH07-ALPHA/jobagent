/**
 * A company *name* → the domain the pipeline keys companies on.
 *
 * ATS pollers never need this: a Greenhouse board already tells us who it belongs to. Alert
 * emails only ever give a display name — "Zomato", "Swiggy · Bengaluru" — and
 * `companies.domain` is the dedup key for the whole system, so getting from one to the other
 * is the alert parsers' hardest problem.
 *
 * **Why not just guess `zomato.com`.** A wrong domain is worse than an unknown one. Contacts
 * are cached per company (decision 005), so a company split across two domain rows runs the
 * expensive cascade twice and can email the same person about two roles. And a guessed domain
 * that happens to belong to somebody else is an address we might actually write to.
 *
 * So an unresolved name gets an explicitly-unknown domain — `zomato.unknown.invalid`. `.invalid`
 * is reserved by RFC 2606 and can never resolve, which makes the marker safe by construction:
 * it is stable enough to dedup on, greppable in the DB, and impossible to accidentally mail.
 * The contact cascade can upgrade it later when it learns the real one.
 */
import { CANDIDATES } from './candidates.ts';
import { normaliseDomain } from '../store/companies.ts';
import type { Db } from '../store/db.ts';

/** RFC 2606 reserved TLD: guaranteed never to resolve. */
export const UNKNOWN_DOMAIN_SUFFIX = '.unknown.invalid';

export const isUnknownDomain = (domain: string): boolean => domain.endsWith(UNKNOWN_DOMAIN_SUFFIX);

/**
 * Company names for matching: case, punctuation and the corporate-suffix noise that appears
 * in one source and not another all removed.
 *
 * "Zomato Ltd." / "zomato" / "Zomato Limited" have to collide, because LinkedIn, Naukri and a
 * Greenhouse board will each write the same company differently.
 */
export function normaliseCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents: Société → Societe
    // Anything after a separator is decoration in alert mail: "Swiggy · Bengaluru",
    // "Zomato | Hiring", "Acme – via Naukri".
    .split(/[|·–—]|\s-\s/)[0]!
    .replace(/&/g, ' and ')
    .replace(/\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|co|company|technologies|technology|labs|solutions|services|systems|india|group|holdings)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** `Zomato Ltd.` → `zomato`. The stem of the unknown-domain marker. */
const slug = (name: string): string => normaliseCompanyName(name).replace(/\s+/g, '-');

/** Built once: 153 hand-picked companies, most of which have no ATS at all. */
const CANDIDATE_DOMAINS: ReadonlyMap<string, { name: string; domain: string }> = new Map(
  CANDIDATES.map((c) => [normaliseCompanyName(c.name), { name: c.name, domain: c.domain }]),
);

/**
 * Shortest key that may be matched as a prefix. Below this, a prefix match is a coincidence
 * waiting to happen — a company called "One" would swallow "One Card" and "Onedigital".
 */
const MIN_PREFIX_LENGTH = 4;

/**
 * Does `key` name the same company as the start of `full`?
 *
 * Naukri writes legal names — "Razorpay Software Private Limited" normalises to
 * `razorpay software`, which no exact match will ever find. The boundary check is what keeps
 * this honest: `razorpay` matches `razorpay software`, but never `razorpayx`.
 */
const isWordPrefix = (key: string, full: string): boolean =>
  key.length >= MIN_PREFIX_LENGTH && full.startsWith(`${key} `);

/** Longest key wins, so "swiggy instamart" beats "swiggy" when both are known. */
function bestPrefix<T>(entries: Iterable<[string, T]>, full: string): T | undefined {
  let best: { key: string; value: T } | undefined;
  for (const [key, value] of entries) {
    if (isWordPrefix(key, full) && (best === undefined || key.length > best.key.length)) {
      best = { key, value };
    }
  }
  return best?.value;
}

export type Resolution = {
  /** What to store as `companies.domain`. */
  domain: string;
  /** The canonical name, preferring one we already hold over the email's wording. */
  name: string;
  /** How it was resolved. `unknown` means the domain is an RFC 2606 marker, not a real one. */
  via: 'db' | 'candidates' | 'unknown';
};

/**
 * Resolve a company name against what we already know.
 *
 * Order matters: the DB first, because it accumulates everything ingest has ever seen —
 * including companies the contact cascade has since learned the real domain for — and only
 * then the static candidate list.
 */
export function resolveCompany(db: Db, rawName: string): Resolution {
  const name = rawName.trim();
  const key = normaliseCompanyName(name);

  if (key === '') return { domain: `unnamed${UNKNOWN_DOMAIN_SUFFIX}`, name: name || 'Unknown', via: 'unknown' };

  // A company already in the DB, matched on the same normalisation. Done in SQL against a
  // small table rather than loaded into memory, because ingest calls this per posting.
  const rows = db.prepare('SELECT name, domain FROM companies').all() as {
    name: string;
    domain: string;
  }[];

  const known = rows.filter((r) => !isUnknownDomain(r.domain));

  for (const row of known) {
    if (normaliseCompanyName(row.name) === key) {
      return { domain: row.domain, name: row.name, via: 'db' };
    }
  }

  const candidate = CANDIDATE_DOMAINS.get(key);
  if (candidate) {
    return { domain: normaliseDomain(candidate.domain), name: candidate.name, via: 'candidates' };
  }

  // Exact matching exhausted; now the legal-name case.
  const dbPrefix = bestPrefix(
    known.map((r) => [normaliseCompanyName(r.name), r] as [string, typeof r]),
    key,
  );
  if (dbPrefix) return { domain: dbPrefix.domain, name: dbPrefix.name, via: 'db' };

  const candidatePrefix = bestPrefix(CANDIDATE_DOMAINS, key);
  if (candidatePrefix) {
    return {
      domain: normaliseDomain(candidatePrefix.domain),
      name: candidatePrefix.name,
      via: 'candidates',
    };
  }

  // Reuse an existing marker row rather than minting a second one for the same name.
  const marker = `${slug(name)}${UNKNOWN_DOMAIN_SUFFIX}`;
  const existing = rows.find((r) => r.domain === marker);
  return { domain: marker, name: existing?.name ?? name, via: 'unknown' };
}
