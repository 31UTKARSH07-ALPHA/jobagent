/**
 * A company **name** → the domain it actually owns, proved rather than assumed.
 *
 * `src/ingest/resolve-company.ts` refuses to guess: a name it cannot place becomes
 * `berryworks.unknown.invalid`, an RFC 2606 marker that can never resolve and can never be
 * mailed. That is the right call at ingest time, and it is also why the contact stage cannot
 * start work: **73 of the 78 matched jobs belong to a company with one of those markers**,
 * all of them from LinkedIn and Naukri alert mail, whose posting URLs are aggregator URLs
 * and carry no company domain anywhere in them.
 *
 * So this is the piece that upgrades a marker to a real domain — the "the contact cascade
 * can upgrade it later" that `resolve-company.ts` promises.
 *
 * **Guessing is fine; believing a guess is not.** `convin.com` is a reasonable guess for a
 * company called Convin and also, quite possibly, somebody else's company entirely. Every
 * candidate here — heuristic or model-proposed — has to clear the same two gates before it
 * is stored:
 *
 * 1. **The domain publishes MX records.** No MX, no mailbox, nothing to find.
 * 2. **The live page says the company's name.** Fetched over the network, read as text.
 *
 * A guess that clears both is not certain, but it is evidence rather than optimism. And the
 * blast radius of being wrong is bounded by design: an address *found on that site* is what
 * earns `confidence: 'high'`, while a pattern guess at the same domain stays `low` and can
 * never auto-send (invariant 3).
 */
import { getText, HttpError } from '../ingest/http.ts';
import { htmlToText } from '../ingest/html.ts';
import { normaliseCompanyName } from '../ingest/resolve-company.ts';
import { normaliseDomain } from '../store/companies.ts';
import { chat } from '../llm/groq.ts';
import { hasMx } from './verify.ts';

/**
 * TLDs worth trying, most likely first.
 *
 * Ordered for this candidate list rather than the internet at large: decision 009 targets
 * India plus remote-global, and the alert mail that produced these companies is
 * overwhelmingly Indian, so `.in` outranks `.io`. `.ai` earns its place because a
 * disproportionate share of the matched postings are from AI startups. `.app` is here
 * because it cost FRND — a real matched company at `frnd.app` — a resolution when the list
 * stopped at five.
 *
 * Length is cheap in a way it looks like it should not be: a candidate whose domain has no
 * MX dies on a DNS lookup costing milliseconds, and only survivors are ever fetched.
 */
const TLDS = ['com', 'in', 'ai', 'io', 'co', 'co.in', 'app', 'tech'] as const;

/** Beyond the first stem, only the two likeliest TLDs — each extra candidate is a probe. */
const SECONDARY_TLDS = ['com', 'in'] as const;

/**
 * Every candidate costs a DNS lookup and, if that passes, a page fetch, and the stage runs
 * this for dozens of companies inside one wall-clock budget. Twelve is where the marginal
 * candidate stops being a plausible domain and starts being a lottery ticket.
 */
const MAX_CANDIDATES = 12;

/** A stem shorter than this matches too much: "rp" would hit half the internet. */
const MIN_STEM_LENGTH = 4;

/**
 * Hosts that are somebody's *presence*, never somebody's *domain*.
 *
 * This list exists because of redirects. A small company whose `.com` expired often points
 * it at their LinkedIn page or a site builder, and `fetch` follows that quietly — so without
 * this the pipeline would happily record `linkedin.com` as Convin's domain, then pattern-guess
 * `hr@linkedin.com` and queue a draft to it. Judged on the **final** URL, after redirects.
 */
const NEVER_A_COMPANY_DOMAIN = new Set([
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'medium.com',
  'notion.site',
  'linktr.ee',
  'sites.google.com',
  'business.site',
  'wixsite.com',
  'wordpress.com',
  'blogspot.com',
  'godaddysites.com',
  'squarespace.com',
  'github.io',
  'naukri.com',
  'indeed.com',
  'glassdoor.com',
  'crunchbase.com',
  'zaubacorp.com',
  'tofler.in',
]);

/**
 * Suffixes that are a registry rather than a registrant, so `foo.co.in` is a company and
 * `co.in` is not. Not a full public-suffix list — this is the handful the target geography
 * actually produces, and shipping a 15,000-entry list to answer it would be absurd.
 */
const MULTI_PART_TLDS = new Set([
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'firm.in', 'gen.in', 'ind.in',
  'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.sg', 'co.za',
]);

/**
 * `shop.chaipoint.com` → `chaipoint.com`. The domain a company owns, not the host that
 * answered.
 *
 * This is load-bearing rather than cosmetic. Chai Point's site redirects to its Shopify
 * subdomain, and an earlier version recorded the host it landed on, asked whether
 * `shop.chaipoint.com` had MX records — subdomains almost never do — and threw the correct
 * answer away. It then fell through to `chai.com`, a page that says "chai" and belongs to
 * somebody else entirely.
 */
export function apexOf(host: string): string {
  const parts = normaliseDomain(host).split('.');
  const size = MULTI_PART_TLDS.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.length <= size ? parts.join('.') : parts.slice(-size).join('.');
}

/** Registrar holding pages resolve, serve HTML, and mean nothing. */
const PARKED = /this domain (is|name is) for sale|buy this domain|domain (parking|for sale)|parked (free )?(at|by)|coming soon\b.{0,40}\bregistrar|godaddy\.com\/domainsearch|sedo\.com/i;

/** Letters and digits only, so "Berry Works!" and "berryworks" compare equal. */
const squash = (input: string): string => input.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * What convinced us.
 *
 * - `page` — the live site names the company. The standard of proof.
 * - `exact-domain` — the site refused to be read (a 403 from a bot filter, typically) but the
 *   domain *is* the company's name, letter for letter, and it accepts mail. Weaker, and
 *   deliberately narrow: see {@link probe}.
 */
export type DomainProof = 'page' | 'exact-domain';

export type DomainDiscovery = {
  /** Normalised, and the apex of wherever the fetch *ended*, not where it started. */
  domain: string;
  /** The name as we hold it — this never renames the company, only re-domains it. */
  name: string;
  via: 'heuristic' | 'llm';
  proof: DomainProof;
};

/**
 * Plausible domains for a company name, likeliest first.
 *
 * The stems matter more than the TLDs. "Berryworks Kochi Adoor" is one company with two city
 * names stapled on by whoever typed the job alert, so the whole-name stem is hopeless and the
 * first-word stem is exactly right; "Discover Dollar Technologies Pvt Ltd" is the reverse,
 * where the first word alone is a credit card company. Neither ordering is safe on its own,
 * which is why both are generated and the verification decides.
 */
export function domainCandidates(name: string): string[] {
  const tokens = normaliseCompanyName(name).split(' ').filter((t) => t !== '');
  if (tokens.length === 0) return [];

  const joined = tokens.join('');
  const stems: string[] = [joined];

  if (tokens.length > 1) {
    stems.push(tokens.join('-'));
    // The first word alone, for names carrying a location or a division.
    if (tokens[0]!.length >= MIN_STEM_LENGTH) stems.push(tokens[0]!);
  }

  const out: string[] = [];
  for (const [index, stem] of stems.entries()) {
    if (stem.replace(/-/g, '').length < MIN_STEM_LENGTH) continue;
    for (const tld of index === 0 ? TLDS : SECONDARY_TLDS) out.push(`${stem}.${tld}`);
  }

  return [...new Set(out)].slice(0, MAX_CANDIDATES);
}

/**
 * Does this page belong to this company?
 *
 * The bar is the **whole** company name, normalised, appearing in the page's text. An
 * earlier version also accepted the domain's first-word stem, and measured against the
 * 69 real companies in the database that tier was wrong every time it was the deciding
 * evidence: Chai Point matched `chai.com`, Stance Health matched `stance.com`, and
 * Sustainability Economics matched a consultancy called ERM. All three were pages that
 * merely contained an English word.
 *
 * `normaliseCompanyName` is what makes the strict rule workable — it drops the legal
 * suffixes and division noise the alert mail adds, so "Discover Dollar Technologies Pvt
 * Ltd" only has to find "discoverdollar" on the page, which is what the page says.
 *
 * A company whose site is bot-blocked or renders its name only in JavaScript therefore
 * stays unresolved. That is the intended answer: unread is not the same as verified, and
 * the job goes to NEEDS_CONTACT and is retried in three days.
 */
export function pageNamesCompany(name: string, html: string): boolean {
  const text = htmlToText(html);
  if (PARKED.test(text)) return false;

  const wanted = squash(normaliseCompanyName(name));
  return wanted.length >= MIN_STEM_LENGTH && squash(text).includes(wanted);
}

export type ProbeOptions = {
  signal?: AbortSignal;
  /** Per-page ceiling. Short on purpose: a company site that is slow is one of many. */
  timeoutMs?: number;
};

const PAGE_TIMEOUT_MS = 8_000;

/**
 * Fetch a candidate and decide whether it is really this company.
 *
 * MX is asked first because it is the cheap half — one DNS round trip against a page fetch
 * that may be eight seconds of nothing — and it eliminates most bad guesses on its own.
 *
 * `https` is tried before `http` and both are tried, because a plain-http company site is
 * exactly the kind of small Indian firm this list is full of. Never throws: a candidate that
 * fails for any reason is simply not this company.
 */
export async function probe(
  candidate: string,
  name: string,
  opts: ProbeOptions = {},
): Promise<DomainDiscovery | null> {
  const domain = normaliseDomain(candidate);
  if (domain === '' || NEVER_A_COMPANY_DOMAIN.has(apexOf(domain))) return null;
  if (!(await hasMx(domain))) return null;

  let refusedToBeRead = false;

  for (const scheme of ['https', 'http'] as const) {
    let page;
    try {
      page = await getText(`${scheme}://${domain}/`, {
        timeoutMs: opts.timeoutMs ?? PAGE_TIMEOUT_MS,
        retries: 0,
        signal: opts.signal,
      });
    } catch (err) {
      // A status code means something is *there*, serving, and declining to talk to us —
      // which is different from a dead host. Remembered for the exact-name case below.
      if (err instanceof HttpError) refusedToBeRead = true;
      continue; // dead, refused, TLS broken — try the other scheme, then give up
    }
    if (page === null) continue;
    if (!pageNamesCompany(name, page.html)) continue;

    // Where we *landed*, reduced to the domain somebody owns. A redirect to a better domain
    // is a better answer than the guess that caused it; a redirect to a social profile is
    // not an answer at all.
    const landed = apexOf(URL.parse(page.url)?.hostname ?? domain);
    if (NEVER_A_COMPANY_DOMAIN.has(landed)) return null;

    // Redirected somewhere genuinely different — `berryworks.com` → `berryworks.io`. The MX
    // gate applies to whatever is about to be stored, not to the domain we happened to type.
    if (landed !== domain && !(await hasMx(landed))) continue;

    return { domain: landed, name, via: 'heuristic', proof: 'page' };
  }

  // Nothing could be read. There is one case where that is still enough, and CoinDCX is it:
  // `coindcx.com` accepts mail and 403s every request behind a bot filter, so the page test
  // can never pass however many times it is retried — and decision 024 named CoinDCX
  // specifically as a posting this pipeline should be reaching.
  //
  // Narrow on purpose. The domain has to spell the company's name **exactly** — not a prefix,
  // which is what matched `chai.com` to Chai Point — so the only way to be wrong is for
  // somebody else to hold the exact-name domain of the company hiring. And the consequence of
  // being wrong is bounded: with no readable page there is nothing to scrape, so the only
  // address such a company can ever produce is a pattern guess, which is `confidence: 'low'`
  // and can never auto-send (invariant 3). A human reads it before it goes anywhere.
  const stem = normaliseDomain(domain).split('.')[0] ?? '';
  if (refusedToBeRead && stem !== '' && stem === squash(normaliseCompanyName(name))) {
    return { domain, name, via: 'heuristic', proof: 'exact-domain' };
  }

  return null;
}

/**
 * Ask the model for a domain, for names no URL heuristic will ever produce.
 *
 * This is a fallback and is written like one. It is asked for a fact rather than a
 * judgement, it is told to say nothing rather than guess — and it is not believed either
 * way: whatever comes back goes through {@link probe} like any other candidate. That
 * inversion is what makes a hallucinated domain harmless here, where anywhere else in this
 * project it would be a silent corruption.
 *
 * **Plain text, not structured output** — the one call in this project that does not use a
 * Zod schema. With `response_format: json_schema`, Groq returned `400 Failed to validate
 * JSON` for 10 of the 12 real company names tried, and the ten were precisely the ones where
 * the honest answer is "I don't know": strict mode rejects the model's own way of expressing
 * an empty answer, so the schema was silently converting *correct refusals* into errors. A
 * single bare domain needs no schema anyway — a regex both parses and validates it.
 */
export async function proposeDomain(
  name: string,
  hint: string,
  opts: ProbeOptions = {},
): Promise<string | null> {
  const answer = await chat({
    job: 'domain',
    temperature: 0,
    maxTokens: 96,
    signal: opts.signal,
    system:
      'You map company names to the domain of their official website. Answer with the bare ' +
      'registrable domain and nothing else — no scheme, no www, no path, no explanation. ' +
      'If you are not confident the company exists and owns that exact domain, answer NONE. ' +
      'NONE is a correct and useful answer; a plausible-looking wrong domain is not.',
    messages: [{ role: 'user', content: `Company: ${name}\nContext: ${hint}` }],
  });

  const domain = normaliseDomain(answer.trim().split(/\s+/)[0] ?? '');

  // A bare word, a sentence, `NONE`, or an `.invalid` marker echoed back: all not a domain.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !domain.endsWith('.invalid')
    ? domain
    : null;
}

export type DiscoverOptions = ProbeOptions & {
  /** Context for the model — a job title and location is enough to disambiguate a name. */
  hint?: string;
  /** False keeps this entirely free and offline of the LLM. See the run-level cap. */
  allowLlm?: boolean;
  log?: (msg: string) => void;
};

/**
 * The whole thing: heuristics first, the model only for what they miss.
 *
 * That order is a token-budget decision as much as a cost one. Groq's free tier is 8,000
 * tokens a minute and scoring already spends ~67 seconds per job inside it (decision 017);
 * a model call for every unknown company would put ~73 more requests in front of the work
 * that produces the digest. Heuristics are free and instant, so they go first and the model
 * sees only the residue.
 */
export async function discoverDomain(
  name: string,
  opts: DiscoverOptions = {},
): Promise<DomainDiscovery | null> {
  // An `exact-domain` match is held back rather than returned, because taking it early is
  // how FRND resolved to `frnd.io` — an unreadable domain spelling the right name, three
  // candidates ahead of `frnd.app`, which is the company and says so on its home page. A
  // weaker proof has to lose to a stronger one found later, so the loop runs to the end.
  let weak: DomainDiscovery | null = null;

  for (const candidate of domainCandidates(name)) {
    if (opts.signal?.aborted === true) return weak;
    const found = await probe(candidate, name, opts);
    if (found?.proof === 'page') {
      opts.log?.(`${name}: ${found.domain} via guess`);
      return found;
    }
    weak ??= found;
  }

  if (opts.allowLlm !== true) return report(weak, opts);

  let proposed: string | null = null;
  try {
    proposed = await proposeDomain(name, opts.hint ?? '', opts);
  } catch (err) {
    // The model being unavailable is not a reason to fail a company — it stays unknown and
    // is retried in three days like any other unresolved one.
    opts.log?.(`${name}: model lookup failed — ${err instanceof Error ? err.message : String(err)}`);
    return report(weak, opts);
  }
  if (proposed === null) return report(weak, opts);

  const found = await probe(proposed, name, opts);
  if (found === null) {
    opts.log?.(`${name}: model said ${proposed}, unverified`);
    return report(weak, opts);
  }

  opts.log?.(`${name}: ${found.domain} via model (${found.proof})`);
  return { ...found, via: 'llm' };
}

/** Log and return whatever the weaker path produced, so the two exits read the same. */
function report(weak: DomainDiscovery | null, opts: DiscoverOptions): DomainDiscovery | null {
  if (weak !== null) opts.log?.(`${weak.name}: ${weak.domain} via guess (${weak.proof})`);
  return weak;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — probe a name by hand before trusting the stage with it
//
//   node src/contacts/domain.ts --name="Convin" --llm
// ─────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('../env.ts')).loadEnv();

  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      hint: { type: 'string', default: '' },
      llm: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || values.name === undefined) {
    console.log('usage: node src/contacts/domain.ts --name="Acme Labs" [--hint="..."] [--llm]');
    process.exit(values.help ? 0 : 2);
  }

  console.log(`candidates: ${domainCandidates(values.name).join(', ') || '(none)'}`);
  const found = await discoverDomain(values.name, {
    hint: values.hint,
    allowLlm: values.llm,
    log: (m) => console.log(`  ${m}`),
  });
  console.log(found === null ? 'unresolved' : `→ ${found.domain} (${found.via}, ${found.proof})`);
  process.exit(0);
}
