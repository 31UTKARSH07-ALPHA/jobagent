/**
 * A startup's founders → an address that reaches one of them.
 *
 * Utkarsh's call, 2026-10-05: use a published address when there is one, and otherwise **guess**
 * from the founder's name — marked low-confidence so he sees that before he sends it. The job
 * pipeline refuses guesses entirely (decision 035) and that rule stands there; this is a
 * different kind of email to a different kind of inbox. A careers@ guess lands in a shared
 * queue nobody owns. A founder at a ten-person company reads their own mail.
 *
 * Best evidence first, and the order is the whole design:
 *
 * | | Source | Confidence | What it is |
 * |---|---|---|---|
 * | 1 | `published` | high¹ | an address on the company's site whose local part is a founder's name |
 * | 2 | `github` | medium | a founder's own commits, under their own name |
 * | 3 | `guess` | low | the founder's name in the address pattern the *company's* commits use |
 * | 4 | `published` | high¹ | a role address on the site — `hello@`, `careers@` |
 * | 5 | `guess` | low | `firstname@` at the website's domain |
 *
 * ¹ Capped at medium when it is not on the company's own domain — the job pipeline's rule
 * (decision 047), reused rather than restated: `confidenceFor` in `src/contacts/cascade.ts`.
 *
 * Rung 3 is the one worth understanding. Bolna's site is `sample.ai`, but its engineers commit
 * as `firstname@sample.dev`, which a guess built from the website's domain would never reach.
 * The company's own commits say both the mail domain and the pattern, for free.
 *
 * Nothing here proves a mailbox exists. Only a bounce does (decision 047). MX records prove the
 * *domain* takes mail, and nothing without MX is ever stored.
 */
import { apexOf } from '../contacts/domain.ts';
import { confidenceFor, findContacts } from '../contacts/cascade.ts';
import { domainOfEmail, hasMx } from '../contacts/verify.ts';
import { getJson } from '../ingest/http.ts';
import { normaliseDomain } from '../store/companies.ts';
import type { ContactConfidence, StartupContactSource } from '../store/schema.ts';

/** `Sébastien O'Brien-Diaz` → `{ first: 'sebastien', last: 'obriendiaz' }`. */
export function nameParts(full: string): { first: string; last: string } | null {
  const words = full
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms)\.?\s+/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter((w) => w !== '');
  if (words.length === 0) return null;
  return { first: words[0]!, last: words.length > 1 ? words[words.length - 1]! : '' };
}

/**
 * The address shapes people actually have. Ordered by how common they are at small companies,
 * which is the order a tie is broken in.
 */
export const PATTERNS = {
  first: (f: string) => f,
  'first.last': (f: string, l: string) => (l === '' ? null : `${f}.${l}`),
  firstlast: (f: string, l: string) => (l === '' ? null : `${f}${l}`),
  flast: (f: string, l: string) => (l === '' ? null : `${f[0]}${l}`),
  'f.last': (f: string, l: string) => (l === '' ? null : `${f[0]}.${l}`),
  first_last: (f: string, l: string) => (l === '' ? null : `${f}_${l}`),
  firstl: (f: string, l: string) => (l === '' ? null : `${f}${l[0]}`),
} as const satisfies Record<string, (first: string, last: string) => string | null>;
export type Pattern = keyof typeof PATTERNS;

/** Which pattern turns `name` into `local`, if any. */
export function patternOf(local: string, name: string): Pattern | null {
  const parts = nameParts(name);
  if (parts === null || parts.first.length < 2) return null;
  const lower = local.toLowerCase();
  for (const [key, build] of Object.entries(PATTERNS) as [Pattern, (f: string, l: string) => string | null][]) {
    if (build(parts.first, parts.last) === lower) return key;
  }
  return null;
}

/** `name` in `pattern` at `domain`, or null when the pattern needs a surname the name lacks. */
export function addressFor(name: string, pattern: Pattern, domain: string): string | null {
  const parts = nameParts(name);
  if (parts === null) return null;
  const local = (PATTERNS[pattern] as (f: string, l: string) => string | null)(parts.first, parts.last);
  return local === null ? null : `${local}@${normaliseDomain(domain)}`;
}

/**
 * Is this mail domain the company's, even when it is not the website's?
 *
 * Same apex, or the same first label — `sample.dev` for `sample.ai`. Four characters at least, so
 * `ai.com` is not mistaken for every `ai.*`.
 */
export function isRelatedDomain(mailDomain: string, website: string): boolean {
  const a = apexOf(normaliseDomain(mailDomain));
  const b = apexOf(normaliseDomain(website));
  if (a === b) return true;
  const stemA = a.split('.')[0] ?? '';
  return stemA.length >= 4 && stemA === (b.split('.')[0] ?? '');
}

/** An author line from a commit. */
export type Author = { name: string; email: string };

const NOREPLY = /noreply|no-reply|users\.noreply\.github\.com|@localhost|\.local$|^root@/i;

/**
 * The address pattern a company's own people use, read off their commits.
 *
 * Counted, not assumed: the pattern with the most authors on a company domain wins, and it must
 * be seen at least once. Null when no commit is on a company domain — most early repos are
 * committed from personal Gmail, and nothing can be inferred from those.
 */
export function inferPattern(
  authors: readonly Author[],
  website: string,
): { pattern: Pattern; domain: string; seen: number } | null {
  const tally = new Map<string, { pattern: Pattern; domain: string; seen: number }>();
  for (const a of authors) {
    const domain = domainOfEmail(a.email);
    if (domain === null || NOREPLY.test(a.email) || !isRelatedDomain(domain, website)) continue;
    const pattern = patternOf(a.email.split('@')[0] ?? '', a.name);
    if (pattern === null) continue;
    const key = `${pattern}@${domain}`;
    const entry = tally.get(key) ?? { pattern, domain, seen: 0 };
    entry.seen++;
    tally.set(key, entry);
  }
  return [...tally.values()].sort((a, b) => b.seen - a.seen)[0] ?? null;
}

/**
 * Whom to write to, best first. For an engineering internship that is the technical founder:
 * the CTO reads the application as the person who would supervise it, and a CEO forwards it
 * there anyway.
 */
export function rankPeople<T extends { name: string; title: string }>(people: readonly T[]): T[] {
  const weight = (title: string): number =>
    /\b(cto|chief technology|technical|engineering|tech lead)\b/i.test(title)
      ? 0
      : /\b(ceo|chief executive)\b/i.test(title)
        ? 1
        : 2;
  return [...people].sort((a, b) => weight(a.title) - weight(b.title));
}

/** `https://github.com/bolna-ai` → `bolna-ai`. Null for a user or repo link that is not an org root. */
export function githubOrg(url: string | null): string | null {
  if (url === null) return null;
  const parsed = URL.parse(url);
  if (parsed === null || !/(^|\.)github\.com$/i.test(parsed.hostname)) return null;
  const org = parsed.pathname.split('/').filter((p) => p !== '')[0];
  return org === undefined || org === '' ? null : org;
}

/**
 * Commit authors from the org's two most recently pushed repositories.
 *
 * Three requests per startup against GitHub's unauthenticated 60 an hour, so the caller caps how
 * many startups ask. `GITHUB_TOKEN`, when set, raises that to 5,000 — optional, never required.
 * Every failure is "no authors", because this rung only ever adds evidence.
 */
export async function githubAuthors(org: string, signal?: AbortSignal, log?: (msg: string) => void): Promise<Author[]> {
  const token = process.env['GITHUB_TOKEN'];
  // `getJson` owns its headers and takes no extra ones, so a token needs a plain fetch. Without
  // a token the shared client is used, with its timeout and user agent.
  const get = async <T>(url: string): Promise<T | null> => {
    if (token === undefined || token === '') return getJson<T>(url, { timeoutMs: 10_000, retries: 0, signal });
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'jobagent' },
      signal: signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    return res.ok ? ((await res.json()) as T) : null;
  };

  try {
    const repos = await get<{ name: string; fork: boolean }[]>(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=5&type=sources`,
    );
    if (!Array.isArray(repos)) {
      log?.(`github.com/${org}: no public repositories`);
      return [];
    }

    const seen = new Map<string, Author>();
    for (const repo of repos.filter((r) => !r.fork).slice(0, 2)) {
      const commits = await get<{ commit?: { author?: { name?: string; email?: string } } }[]>(
        `https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo.name)}/commits?per_page=50`,
      );
      if (!Array.isArray(commits)) continue;
      for (const c of commits) {
        const name = c.commit?.author?.name ?? '';
        const email = (c.commit?.author?.email ?? '').toLowerCase();
        if (name === '' || email === '' || NOREPLY.test(email)) continue;
        seen.set(email, { name, email });
      }
    }
    log?.(`github.com/${org}: ${seen.size} commit author(s)`);
    return [...seen.values()];
  } catch (err) {
    // Said out loud: the first live run lost every GitHub result to failures nobody saw, and
    // the only symptom was that no pattern was ever inferred.
    log?.(`github.com/${org}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export type StartupCandidate = {
  email: string;
  /** The founder's name as listed, when the address is theirs. */
  name: string | null;
  source: StartupContactSource;
  confidence: ContactConfidence;
  rank: number;
  found_at: string;
};

/** A plausible address shape. Not proof of anything — just not obviously malformed. */
const EMAIL_SHAPE = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Turn the evidence into ranked candidates. Pure, so the ordering can be tested without the
 * network; {@link findFounderContacts} gathers the evidence.
 */
export function rankCandidates(input: {
  name: string;
  domain: string;
  /** Best first, per {@link rankPeople}. */
  people: readonly { name: string; title: string }[];
  published: readonly { email: string; found_at: string }[];
  authors: readonly Author[];
  githubSource?: string;
}): StartupCandidate[] {
  const out = new Map<string, StartupCandidate>();
  const add = (c: StartupCandidate): void => {
    const email = c.email.toLowerCase();
    if (!EMAIL_SHAPE.test(email)) return;
    const prior = out.get(email);
    if (prior === undefined || prior.rank < c.rank) out.set(email, { ...c, email });
  };

  const personFor = (local: string) => input.people.find((p) => patternOf(local, p.name) !== null) ?? null;

  // 1 and 4. What the site publishes — a founder's own address, or the front door.
  for (const p of input.published) {
    const local = p.email.split('@')[0] ?? '';
    const person = personFor(local);
    const confidence = confidenceFor(p.email, 'team_page', input.domain);
    add({
      email: p.email,
      name: person?.name ?? null,
      source: 'published',
      confidence,
      rank: person !== null ? 500 : 200,
      found_at: p.found_at,
    });
  }

  // 2. A founder committing under their own name. A personal Gmail is fine here: it is the
  //    address that founder actually uses, taken from their own work.
  for (const a of input.authors) {
    const person = input.people.find((p) => {
      const mine = nameParts(p.name);
      const theirs = nameParts(a.name);
      return mine !== null && theirs !== null && mine.first === theirs.first && (mine.last === '' || mine.last === theirs.last);
    });
    if (person === undefined) continue;
    add({
      email: a.email,
      name: person.name,
      source: 'github',
      confidence: 'medium',
      rank: 400,
      found_at: input.githubSource ?? 'github commits',
    });
  }

  // 3 and 5. The guess, for the founder he most wants to reach.
  const target = input.people[0];
  if (target !== undefined) {
    const inferred = inferPattern(input.authors, input.domain);
    if (inferred !== null) {
      const email = addressFor(target.name, inferred.pattern, inferred.domain);
      if (email !== null) {
        add({
          email,
          name: target.name,
          source: 'guess',
          confidence: 'low',
          rank: 300,
          found_at: `pattern ${inferred.pattern}@${inferred.domain}, seen in ${inferred.seen} commit author(s)`,
        });
      }
    }
    const plain = addressFor(target.name, 'first', input.domain);
    if (plain !== null) {
      add({ email: plain, name: target.name, source: 'guess', confidence: 'low', rank: 100, found_at: 'pattern first@ (no evidence)' });
    }
  }

  return [...out.values()].sort((a, b) => b.rank - a.rank);
}

/**
 * Customer desks the job pipeline's junk list does not name — `customers@example.org` came
 * back as Landeed's best published address on the first live run. Kept here rather than
 * widened there, so this feature changes nothing about the pipeline's cascade.
 */
const CUSTOMER_DESK = /^(customers?|clients?|onboarding|partners?|investors?|ir)([._+-]|$)/i;

export type FounderDeps = {
  findContacts?: typeof findContacts;
  githubAuthors?: typeof githubAuthors;
  hasMx?: typeof hasMx;
};

/**
 * Everything worth storing for one startup: ranked candidates whose domains take mail.
 *
 * `allowGithub` is the caller's rate-limit budget. Published pages come from the job pipeline's
 * own cascade, with its junk filters — `sales@`, `support@`, another company's mailbox — so the
 * two features agree about what an unusable address is.
 */
export async function findFounderContacts(
  startup: { name: string; domain: string; github_url: string | null },
  people: readonly { name: string; title: string }[],
  opts: { signal?: AbortSignal; allowGithub: boolean; exclude?: readonly string[]; log?: (msg: string) => void },
  deps: FounderDeps = {},
): Promise<StartupCandidate[]> {
  const find = deps.findContacts ?? findContacts;
  const authorsOf = deps.githubAuthors ?? githubAuthors;
  const mx = deps.hasMx ?? hasMx;

  const site = await find({ name: startup.name, domain: startup.domain }, { signal: opts.signal, allowGithub: false });
  const published = site
    .filter((c) => c.source === 'team_page' && !CUSTOMER_DESK.test(c.email.split('@')[0] ?? ''))
    .map((c) => ({ email: c.email, found_at: c.found_at }));

  const org = githubOrg(startup.github_url);
  const authors = org !== null && opts.allowGithub ? await authorsOf(org, opts.signal, opts.log) : [];

  const ranked = rankCandidates({
    name: startup.name,
    domain: startup.domain,
    people: rankPeople(people.map((p) => ({ name: p.name, title: p.title }))),
    published,
    authors,
    githubSource: org === null ? undefined : `github.com/${org} commits`,
  });

  const dead = new Set((opts.exclude ?? []).map((e) => e.toLowerCase()));
  const kept: StartupCandidate[] = [];
  for (const c of ranked) {
    if (dead.has(c.email)) continue;
    const domain = domainOfEmail(c.email);
    if (domain !== null && (await mx(domain))) kept.push(c);
  }
  return kept;
}
