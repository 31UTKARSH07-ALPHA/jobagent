/**
 * Builds `data/companies.json` by probing every candidate against the live ATS APIs.
 *
 *   node src/ingest/refresh-companies.ts            # rebuild from src/ingest/candidates.ts
 *   node src/ingest/refresh-companies.ts --prune    # re-verify the existing list only
 *
 * Why this exists: ATS slugs are guessable and wrong about half the time —
 * `boards-api.greenhouse.io/v1/boards/razorpay` is a 404 even though Razorpay is real.
 * A hand-written list would quietly poll dead URLs forever. Here nothing enters the seed
 * list without having answered with at least one live posting.
 *
 * This is also the Sunday "prune dead slugs" job from `docs/architecture.md`.
 */
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { ADAPTERS } from './ats.ts';
import { CANDIDATES, type Candidate } from './candidates.ts';
import { loadCompanies, SEED_PATH, type BoardAts, type SeedCompany } from './companies.ts';
import { getJson, mapPool } from './http.ts';

/** Probes in flight. These are free APIs — stay polite. */
const CONCURRENCY = 8;

/** Order matters only for tie-breaks; whichever board has the most postings wins. */
const ATS_ORDER: BoardAts[] = ['greenhouse', 'lever', 'ashby', 'workable'];

/**
 * Slugs worth trying for a company: the domain's root label, and the name with
 * punctuation removed or hyphenated. Covers nearly every real slug.
 */
export function slugCandidates(c: Candidate): string[] {
  const root = c.domain.split('.')[0] ?? '';
  // "Weights & Biases" is "weightsandbiases" on some boards, "weightsbiases" on others.
  const spoken = c.name.toLowerCase().replace(/&/g, ' and ');
  const squashed = spoken.replace(/[^a-z0-9]+/g, '');
  const hyphenated = spoken.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const bare = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '');

  return [
    ...new Set(
      [...(c.slugs ?? []), root, bare, squashed, hyphenated].filter((s) => s.length > 1),
    ),
  ];
}

type Hit = { ats: BoardAts; slug: string; jobs: number };

/**
 * A probe has three outcomes, and collapsing them into two is a bug: a timeout is not
 * evidence that a company has no board. Hugging Face was dropped from an early run
 * exactly this way — one flaky request, and it looked identical to a 404.
 */
type ProbeOutcome =
  | { kind: 'hit'; hit: Hit }
  | { kind: 'absent' } // 404, or a board with no open postings
  | { kind: 'error'; message: string };

/** Ask one ATS whether this slug is a real board with jobs on it. */
async function probe(ats: BoardAts, slug: string): Promise<ProbeOutcome> {
  const adapter = ADAPTERS[ats];
  try {
    const payload = await getJson<unknown>(adapter.url(slug), { timeoutMs: 15_000, retries: 2 });
    if (payload === null) return { kind: 'absent' };
    const jobs = adapter.parse(payload).length;
    return jobs > 0 ? { kind: 'hit', hit: { ats, slug, jobs } } : { kind: 'absent' };
  } catch (err) {
    return { kind: 'error', message: `${ats}/${slug}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type BoardSearch = { best: Hit | null; errors: string[] };

/**
 * Every (ats, slug) pair for one company, stopping at the first live board.
 *
 * A company is on exactly one ATS, so there is nothing to compare — and stopping early
 * matters practically: it keeps most companies from ever reaching the Workable probe,
 * which is the rate-limited one.
 */
async function findBoard(c: Candidate): Promise<BoardSearch> {
  const errors: string[] = [];
  const slugs = slugCandidates(c);

  for (const [i, slug] of slugs.entries()) {
    for (const ats of ATS_ORDER) {
      // Workable is rate-limited hard and, across 153 candidates, produced two hits.
      // It gets one shot at the most likely slug rather than a share of every sweep.
      if (ats === 'workable' && i > 0) continue;

      const outcome = await probe(ats, slug);
      if (outcome.kind === 'hit') return { best: outcome.hit, errors };
      if (outcome.kind === 'error') errors.push(outcome.message);
    }
  }
  return { best: null, errors };
}

/** CLI entry: re-verify every candidate board and rewrite data/companies.json. */
async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prune: { type: 'boolean', default: false },
      only: { type: 'string' },
      out: { type: 'string', default: SEED_PATH },
    },
  });

  /**
   * What the seed list already knows. A company in here is only ever dropped when a
   * probe *confirms* it has no board — never because a probe failed. Otherwise one
   * Workable 429 silently deletes a company that was verified last week.
   */
  let existing: SeedCompany[] = [];
  try {
    existing = loadCompanies(values.out);
  } catch {
    // no seed file yet — first run
  }

  let candidates: Candidate[] = values.prune
    ? existing.map((c) => ({
        name: c.name,
        domain: c.domain,
        regions: c.regions,
        slugs: [c.slug],
      }))
    : CANDIDATES;

  if (values.only !== undefined) {
    const needle = values.only.toLowerCase();
    candidates = candidates.filter((c) => c.name.toLowerCase().includes(needle));
    if (candidates.length === 0) {
      console.error(`--only=${values.only} matched no candidates`);
      return 2;
    }
  }

  console.log(
    `probing ${candidates.length} companies × up to ${ATS_ORDER.length} boards ` +
      `(${values.prune ? 'prune mode' : 'full rebuild'})`,
  );

  let done = 0;
  const search = async (c: Candidate) => {
    const { best, errors } = await findBoard(c);
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${candidates.length}`);
    if (best) console.log(`  ✓ ${c.name} → ${best.ats}/${best.slug} (${best.jobs} jobs)`);
    return { candidate: c, best, errors };
  };

  let results = await mapPool(candidates, CONCURRENCY, search);

  // Anything that errored without finding a board is *unknown*, not absent. Give those
  // one more pass, alone, before writing them off.
  const unresolved = results.filter((r) => r.best === null && r.errors.length > 0);
  if (unresolved.length > 0) {
    console.log(`\nretrying ${unresolved.length} companies that only saw errors`);
    done = 0;
    const retried = await mapPool(
      unresolved.map((r) => r.candidate),
      2,
      search,
    );
    const byDomain = new Map(retried.map((r) => [r.candidate.domain, r]));
    results = results.map((r) => byDomain.get(r.candidate.domain) ?? r);
  }

  const verified: SeedCompany[] = results
    .filter((r): r is typeof r & { best: Hit } => r.best !== null)
    .map(({ candidate, best: hit }) => ({
      name: candidate.name,
      domain: candidate.domain,
      ats: hit.ats,
      slug: hit.slug,
      regions: candidate.regions,
      verified_jobs: hit.jobs,
    }));

  // Carry forward anything this sweep did not manage to check: entries we probed and
  // confirmed absent are dropped, entries that only errored are kept, and entries this
  // sweep never looked at (--only, a shrunken candidate list) are left untouched.
  const checked = new Set(
    results.filter((r) => r.best !== null || r.errors.length === 0).map((r) => r.candidate.domain),
  );
  const carried = existing.filter(
    (c) => !checked.has(c.domain) && !verified.some((v) => v.domain === c.domain),
  );

  const companies = [...verified, ...carried].sort((a, b) => a.name.localeCompare(b.name));
  if (carried.length > 0) console.log(`carried forward ${carried.length} unchecked entries`);

  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(
    values.out,
    JSON.stringify({ generated_at: new Date().toISOString(), companies }, null, 2) + '\n',
  );

  const byAts = ATS_ORDER.map(
    (ats) => `${ats}=${companies.filter((c) => c.ats === ats).length}`,
  ).join(' ');
  console.log(
    `\n${verified.length}/${candidates.length} probed companies have a live board; ` +
      `${companies.length} in the seed list (${byAts})\nwrote ${values.out}`,
  );

  const absent = results.filter((r) => r.best === null && r.errors.length === 0);
  const unknown = results.filter((r) => r.best === null && r.errors.length > 0);

  if (absent.length > 0) {
    console.log(
      `\nno public board on these four ATSes (${absent.length}): ` +
        absent.map((r) => r.candidate.name).join(', '),
    );
  }
  // Reported separately and loudly: these were not checked, they failed to be checked.
  if (unknown.length > 0) {
    console.log(
      `\nUNVERIFIED — errors on every probe (${unknown.length}), re-run to retry: ` +
        unknown.map((r) => r.candidate.name).join(', '),
    );
    console.log(`  first error: ${unknown[0]?.errors[0]}`);
  }
  return 0;
}

if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('../env.ts')).loadEnv();

  process.exitCode = await main(process.argv.slice(2));
}
