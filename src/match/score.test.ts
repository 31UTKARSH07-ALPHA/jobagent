/**
 * No network. The model is replaced by a fake `Scorer`, so what is under test is the part
 * that can quietly corrupt the pipeline: how four factor ratings become one score, which
 * state that score lands a job in, and whether re-running costs a second API call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, type Db } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { upsertJob } from '../store/jobs.ts';
import { getScore, insertScore } from '../store/scores.ts';
import { jobIdsInState, stateOf } from '../store/state.ts';
import { Profile, RawJob, type Job, type ScoreResult } from '../store/schema.ts';
import type { StageContext } from '../stage.ts';
import {
  MATCH_THRESHOLD,
  MAX_SCORES_PER_RUN,
  PROMPT_VERSION,
  EVIDENCE_PENALTY,
  TITLE_ONLY_CEILING,
  WEIGHTS,
  calibration,
  factorLine,
  fitScore,
  isTitleOnly,
  jobForPrompt,
  profileForPrompt,
  runScore,
  stateForScore,
  type Scorer,
} from './score.ts';

const PROFILE: Profile = Profile.parse({
  name: 'Test Candidate',
  email: 'test@example.com',
  phone: '+91 90000 00000',
  links: ['https://github.com/test'],
  education: [
    {
      institution: 'Scaler School of Technology',
      degree: 'B.Sc. Computer Science',
      dates: '2024 – 2027',
      location: 'Bengaluru',
      score: '9.1 CGPA',
    },
  ],
  summary: 'Builds retrieval systems.',
  skills: [{ category: 'Languages', items: ['TypeScript', 'Python'] }],
  domains: ['retrieval-augmented generation'],
  projects: [
    {
      name: 'Searchling',
      summary: 'A hybrid search engine.',
      tech: ['Qdrant', 'FastAPI'],
      highlights: ['p95 8ms over 2M documents'],
    },
  ],
  experience: [
    { company: 'Acme', role: 'SWE Intern', dates: 'May 2025 – Aug 2025', summary: 'Built things.' },
  ],
  achievements: ['460+ problems solved'],
  target_roles: ['Backend Engineer'],
  extracted_at: new Date('2026-08-09T00:00:00.000Z').toISOString(),
  model: 'test-model',
});

/** A perfect posting; override the factors a test cares about. */
const judgement = (over: Partial<ScoreResult> = {}): ScoreResult => ({
  level_fit: 10,
  location_fit: 10,
  stack_fit: 10,
  domain_fit: 10,
  employer_fit: 10,
  reasoning: 'r',
  hook: 'h',
  ...over,
});

/** A scorer that records what it was asked and returns whatever the test wants. */
function fakeScorer(
  fn: (job: Job) => ScoreResult | Promise<never>,
): Scorer & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    model: 'fake-scorer',
    score: async (job) => {
      calls.push(job.id);
      return fn(job);
    },
  };
}

function context(db: Db): StageContext & { counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  return {
    db,
    counts,
    dryRun: false,
    // Never aborts: these tests are not about the stage budget.
    signal: new AbortController().signal,
    fault: () => {},
    log: () => {},
    count: (key, n = 1) => {
      counts[key] = (counts[key] ?? 0) + n;
    },
  };
}

/** Long enough to count as evidence, so the title-only clamp does not apply (decision 016). */
const REAL_JD =
  'We are looking for an intern to work on our Python backend services. You will build APIs, ' +
  'work with PostgreSQL and Redis, and help ship features to production. Familiarity with ' +
  'distributed systems is a plus. This is a paid internship based in our Bengaluru office.';

function seed(db: Db, titles: string[], description = REAL_JD): number[] {
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  return titles.map(
    (title, i) =>
      upsertJob(
        db,
        companyId,
        RawJob.parse({
          company_name: 'Acme',
          company_domain: 'acme.com',
          source: 'greenhouse',
          url: `https://acme.com/jobs/${i}`,
          title,
          location: 'Bengaluru, India',
          description,
        }),
      ).id,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The arithmetic — the part that used to be the model's job (decision 012)
// ─────────────────────────────────────────────────────────────────────────────

test('the score is a pure function of the factors, and spans the full range', () => {
  assert.equal(fitScore(judgement(), false), 100);
  assert.equal(
    fitScore(
      judgement({ level_fit: 0, location_fit: 0, stack_fit: 0, domain_fit: 0, employer_fit: 0 }),
      false,
    ),
    0,
  );
  // 10·.25 + 10·.2 + 5·.2 + 5·.15 + 10·.2 = 8.25 → 83 (half rounds up)
  assert.equal(fitScore(judgement({ stack_fit: 5, domain_fit: 5 }), false), 83);
  // Same ratings twice must give the same number — that is the whole point of moving it
  // out of the model.
  const twice = judgement({ stack_fit: 3, domain_fit: 7 });
  assert.equal(fitScore(twice, false), fitScore(twice, false));
});

test('an impossible job cannot be rescued by a perfect stack match', () => {
  // "3+ years" with everything else ideal. Weighted this would be 73 — a MATCH.
  const experienceBar = judgement({ level_fit: 1 });
  assert.ok(fitScore(experienceBar, false) < MATCH_THRESHOLD, `got ${fitScore(experienceBar, false)}`);
  assert.equal(stateForScore(fitScore(experienceBar, false)), 'REJECTED');

  // Onsite in another country, no remote offered.
  const onsiteAbroad = judgement({ location_fit: 0 });
  assert.ok(fitScore(onsiteAbroad, false) < MATCH_THRESHOLD, `got ${fitScore(onsiteAbroad, false)}`);

  // A merely weak rating is not a blocker — it just costs its weight.
  assert.ok(fitScore(judgement({ level_fit: 4 }), false) > MATCH_THRESHOLD);
});

test('the threshold is applied in exactly one place, and the boundary is inclusive', () => {
  assert.equal(stateForScore(MATCH_THRESHOLD), 'MATCHED', 'the threshold itself matches');
  assert.equal(stateForScore(MATCH_THRESHOLD - 1), 'REJECTED');
  assert.equal(stateForScore(100), 'MATCHED');
  assert.equal(stateForScore(0), 'REJECTED');
});

// ─────────────────────────────────────────────────────────────────────────────
// The stage
// ─────────────────────────────────────────────────────────────────────────────

test('scoring writes a score row and lands the job on the right side of the threshold', async () => {
  const db = openDb(':memory:');
  const [high, low] = seed(db, ['Backend Intern', 'Senior Staff Engineer']);

  const scorer = fakeScorer((job) =>
    job.id === high
      ? judgement({ stack_fit: 9, reasoning: 'stack overlap', hook: 'p95 8ms over 2M documents' })
      : judgement({ level_fit: 0, reasoning: 'needs 8 years', hook: 'nothing connects' }),
  );

  const ctx = context(db);
  await runScore(ctx, { scorer, profile: PROFILE });

  assert.equal(stateOf(db, high!), 'MATCHED');
  assert.equal(stateOf(db, low!), 'REJECTED');

  const score = getScore(db, high!, PROMPT_VERSION);
  assert.equal(score?.fit_score, 98, 'the stored score is the computed one');
  assert.equal(score?.stack_fit, 9, 'the factors are kept so a surprise can be taken apart');
  assert.equal(score?.hook, 'p95 8ms over 2M documents');
  assert.equal(score?.model, 'fake-scorer', 'the row records what actually produced it');

  assert.deepEqual(ctx.counts, { scored: 2, matched: 1, rejected: 1 });
  db.close();
});

test('re-running the stage costs nothing — invariant 4', async () => {
  const db = openDb(':memory:');
  seed(db, ['Backend Intern', 'ML Intern']);

  const scorer = fakeScorer(() => judgement());
  await runScore(context(db), { scorer, profile: PROFILE });
  assert.equal(scorer.calls.length, 2);

  const second = context(db);
  await runScore(second, { scorer, profile: PROFILE });
  assert.equal(scorer.calls.length, 2, 'no second round of model calls');
  assert.deepEqual(second.counts, {}, 'nothing to do, nothing counted');
  db.close();
});

test('a score written before a crash is reused, not paid for twice', async () => {
  // The gap the transaction closes: insert committed, transition never happened.
  const db = openDb(':memory:');
  const [jobId] = seed(db, ['Backend Intern']);
  insertScore(db, jobId!, PROMPT_VERSION, 95, judgement({ stack_fit: 8 }), 'model-a');

  const scorer = fakeScorer(() => judgement({ level_fit: 0 }));
  const ctx = context(db);
  await runScore(ctx, { scorer, profile: PROFILE });

  assert.equal(scorer.calls.length, 0, 'the model was never asked again');
  assert.equal(stateOf(db, jobId!), 'MATCHED', 'the stored factors decided it, not fresh ones');
  assert.equal(ctx.counts['reused_score'], 1);
  db.close();
});

test('one failing job does not cost the run the others', async () => {
  const db = openDb(':memory:');
  const [bad, good] = seed(db, ['Malformed Posting', 'Backend Intern']);

  const scorer = fakeScorer((job) => {
    if (job.id === bad) return Promise.reject(new Error('model never produced schema-valid output'));
    return judgement();
  });

  const ctx = context(db);
  await runScore(ctx, { scorer, profile: PROFILE });

  assert.equal(stateOf(db, bad!), 'DISCOVERED', 'left for tomorrow, no bookkeeping');
  assert.equal(stateOf(db, good!), 'MATCHED');
  assert.equal(ctx.counts['failed'], 1);
  assert.equal(ctx.counts['scored'], 1);
  db.close();
});

test('a failed job leaves no half-written score row behind', async () => {
  const db = openDb(':memory:');
  const [jobId] = seed(db, ['Malformed Posting']);

  const scorer = fakeScorer(() => Promise.reject(new Error('groq 429: rate limited')));
  await runScore(context(db), { scorer, profile: PROFILE });

  assert.equal(getScore(db, jobId!, PROMPT_VERSION), null);
  db.close();
});

test('the per-run cap defers the overflow instead of dropping it', async () => {
  const db = openDb(':memory:');
  const ids = seed(
    db,
    Array.from({ length: MAX_SCORES_PER_RUN + 3 }, (_, i) => `Intern ${i}`),
  );

  const scorer = fakeScorer(() => judgement({ stack_fit: 5, domain_fit: 5 }));
  await runScore(context(db), { scorer, profile: PROFILE });

  assert.equal(scorer.calls.length, MAX_SCORES_PER_RUN);
  assert.equal(jobIdsInState(db, 'DISCOVERED').length, 3, 'the rest are still waiting');

  // The next run finishes them, which is what makes the cap safe.
  await runScore(context(db), { scorer, profile: PROFILE });
  assert.equal(jobIdsInState(db, 'DISCOVERED').length, 0);
  assert.equal(scorer.calls.length, ids.length);
  db.close();
});

test('a missing profile is reported, not thrown — the rows just wait', async () => {
  const db = openDb(':memory:');
  seed(db, ['Backend Intern']);

  const logs: string[] = [];
  const ctx = { ...context(db), log: (m: string) => logs.push(m) };
  const scorer = fakeScorer(() => judgement());
  await runScore(ctx, { scorer, profilePath: 'data/does-not-exist.json' });

  assert.equal(scorer.calls.length, 0, 'no job was scored against a missing resume');
  assert.equal(jobIdsInState(db, 'DISCOVERED').length, 1, 'the row waits where it was');
  assert.match(logs.join('\n'), /profile\.ts --resume=/, 'the log says how to fix it');
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

test('the prompt does not ship contact details to a third-party API', () => {
  const text = profileForPrompt(PROFILE);
  assert.equal(text.includes('+91 90000 00000'), false, 'phone number must not be sent');
  assert.equal(text.includes('test@example.com'), false, 'email must not be sent');
  // But everything the rubric actually judges on is there.
  assert.match(text, /p95 8ms over 2M documents/, 'quantified highlights survive verbatim');
  assert.match(text, /Qdrant/);
  assert.match(text, /460\+ problems solved/);
  assert.match(text, /Backend Engineer/);
});

test('a long JD is truncated and an empty one still gets a usable prompt', () => {
  const db = openDb(':memory:');
  const [jobId] = seed(db, ['Backend Intern']);
  db.prepare('UPDATE jobs SET description = ? WHERE id = ?').run('x'.repeat(20_000), jobId!);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId!) as Job;
  const prompt = jobForPrompt(job, 'Acme');
  assert.ok(prompt.length < 7_000, `prompt was ${prompt.length} chars`);
  assert.match(prompt, /truncated/);

  const empty = jobForPrompt({ ...job, description: '', location: '' }, 'Acme');
  assert.match(empty, /no description/);
  assert.match(empty, /not stated/, 'a missing location is stated as missing, not left blank');
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Evidence — a posting with no description cannot earn a top score (decision 016)
// ─────────────────────────────────────────────────────────────────────────────

test('a description-free posting is recognised as title-only', () => {
  assert.equal(isTitleOnly({ description: '' }), true, 'alert-email postings, by construction');
  assert.equal(isTitleOnly({ description: '   \n  ' }), true, 'whitespace is not evidence');
  assert.equal(isTitleOnly({ description: 'Backend intern. Apply now.' }), true, 'a stub is not either');
  assert.equal(isTitleOnly({ description: REAL_JD }), false);
});

test('a missing description still ranks postings against each other', () => {
  // The regression this replaces: clamping stack and domain to 6 made every title-only
  // posting score exactly 82 — 31 of 32 measured on 2026-08-20 — so the score ranked
  // nothing and MATCH_THRESHOLD meant nothing (decision 023).
  const strong = fitScore(judgement({ stack_fit: 9, domain_fit: 9 }), true);
  const weak = fitScore(judgement({ stack_fit: 2, domain_fit: 2 }), true);

  assert.ok(strong > weak + 20, `"AI Engineering Intern" must outrank a bare "Intern": ${strong} vs ${weak}`);
  assert.ok(strong >= MATCH_THRESHOLD, 'a title that clearly matches is still worth the digest');
  assert.ok(weak < MATCH_THRESHOLD, 'a title that says nothing is not');
});

test('a title-only posting can be MATCHED but can never reach the auto-send band', () => {
  // Why the ceiling is 84 and not 85: Phase 3 auto-sends above 85, and 10/10/10/10 × 0.85
  // lands exactly on it. A posting nobody has read must not be able to mail itself.
  const best = fitScore(judgement(), true);

  assert.equal(best, TITLE_ONLY_CEILING);
  assert.ok(best >= MATCH_THRESHOLD, 'still worth putting in the digest');
  assert.ok(best <= 85, 'but never auto-sendable — Phase 3 requires >85');
  assert.ok(EVIDENCE_PENALTY < 1, 'the discount is a discount');
});

test('the same ratings score higher with a description behind them', () => {
  const ratings = judgement({ stack_fit: 8, domain_fit: 8 });
  assert.ok(
    fitScore(ratings, false) > fitScore(ratings, true),
    'evidence is worth something, which is the whole point of the discount',
  );
});

test('the stage stores what the model actually said, not a flattened copy', async () => {
  const db = openDb(':memory:');
  seed(db, ['Python / AI-ML / Full Stack Developer Intern'], '');

  const scorer = fakeScorer(() => judgement()); // the model says 10/10/10/10
  const ctx = context(db);
  await runScore(ctx, { scorer, profile: PROFILE });

  const score = getScore(db, jobIdsInState(db, 'MATCHED')[0] ?? 1, PROMPT_VERSION);
  // v3 stored the clamped 6 here, which threw away the model's real opinion for good.
  assert.equal(score?.stack_fit, 10, 'the rating is the model, unedited');
  assert.equal(score?.fit_score, TITLE_ONLY_CEILING, 'the discount lives on the total');
  assert.equal(ctx.counts['title_only'], 1);
  db.close();
});


// ─────────────────────────────────────────────────────────────────────────────
// Rubric v6 — the employer signal (decision 051)
// ─────────────────────────────────────────────────────────────────────────────

test('the employer factor is what separates postings the other four cannot', () => {
  // The v5 pile-up, exactly: 81 of 99 scores landed on 84 because an internship in Bengaluru
  // is level 10 · location 10 by construction, and a title like "Full Stack Development
  // Internship" genuinely is this candidate's stack and domain. Four factors pinned at 10 is
  // arithmetic with no inputs left.
  const titleOnly = true;
  const spread = [10, 7, 4, 1, 0].map((employer_fit) =>
    fitScore(judgement({ employer_fit }), titleOnly),
  );

  // Every one distinct, where v5 gave the same number five times.
  assert.equal(new Set(spread).size, spread.length, `got ${spread.join(', ')}`);
  // And ordered: a real employer outranks a job board.
  assert.deepEqual(spread, [...spread].sort((a, b) => b - a));
});

test('an aggregator reposting somebody else\'s role falls below the threshold', () => {
  // "NexisGrow Jobs & Internships" advertising "Software Engineer Intern at Cargill" scored 84
  // under v5 — tied with Stripe. We cannot tell who is hiring or where to write, which is the
  // same problem decision 031 found on the contacts side.
  const aggregated = fitScore(judgement({ employer_fit: 0 }), true);
  assert.ok(aggregated < MATCH_THRESHOLD, `got ${aggregated}`);
  assert.equal(stateForScore(aggregated), 'REJECTED');
});

test('a strong title-only posting still cannot reach the auto-send band', () => {
  // The ceiling from decision 023 survives the new factor: a posting nobody has read must not
  // be able to mail itself, whatever its employer rating.
  const best = fitScore(judgement(), true);
  assert.equal(best, TITLE_ONLY_CEILING);
  assert.ok(best < 85);
});

test('the weights still sum to one, so a perfect posting is exactly 100', () => {
  // Adding a fifth factor without re-dividing the other four would have inflated every score
  // by 20% and quietly moved every job across the threshold.
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
  assert.equal(fitScore(judgement(), false), 100);
});

test('a factor line omits the employer rating when the row predates it', () => {
  // v2–v5 rows were never asked. Printing a 0 or a dash there would put an opinion the model
  // never gave in front of him every morning.
  assert.match(factorLine(judgement()), /employer 10$/);
  assert.doesNotMatch(factorLine({ ...judgement(), employer_fit: null }), /employer/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The calibration report (decision 055)
// ─────────────────────────────────────────────────────────────────────────────

/** A scored job, with or without a description, at a given rubric version. */
function scored(
  db: ReturnType<typeof openDb>,
  opts: { title: string; fit: number; version?: number; described?: boolean },
): number {
  const companyId = upsertCompany(db, { name: `Co-${opts.title}`, domain: `${opts.fit}-x.com` });
  const { id } = upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: `Co-${opts.title}`,
      company_domain: `${opts.fit}-x.com`,
      source: opts.described === true ? 'greenhouse' : 'gmail-alert',
      source_id: opts.title,
      url: `https://x.com/${encodeURIComponent(opts.title)}`,
      title: opts.title,
      location: 'Bengaluru',
      description: opts.described === true ? 'A real job description. '.repeat(20) : '',
    }),
  );
  insertScore(db, id, opts.version ?? PROMPT_VERSION, opts.fit, judgement(), 'test');
  return id;
}

test('the report splits by source, because the two carry different evidence', () => {
  // An ATS posting arrives with a description; an alert posting arrives with a title (016), and
  // title-only totals are additionally capped at 84 (023). One histogram across both compares
  // unlike things — which is what `phases.md` has asked for since Phase 1.
  const db = openDb(':memory:');
  scored(db, { title: 'Described Intern', fit: 94, described: true });
  scored(db, { title: 'Alert Intern A', fit: 75 });
  scored(db, { title: 'Alert Intern B', fit: 84 });

  const c = calibration(db);
  const byLabel = Object.fromEntries(c.groups.map((g) => [g.label, g.scores]));

  assert.deepEqual(byLabel['described (ATS)'], [94]);
  assert.deepEqual(byLabel['title-only (alert)'], [75, 84]);
  db.close();
});

test('a candidate threshold is reported with the postings it would cost', () => {
  // A count is not reviewable; the titles are. Only the band between the incumbent and the
  // candidate is listed — everything under 70 was already rejected.
  const db = openDb(':memory:');
  scored(db, { title: 'Keeper', fit: 84 });
  scored(db, { title: 'Marginal', fit: 72 });
  scored(db, { title: 'Already rejected', fit: 40 });

  const group = calibration(db).groups.find((g) => g.label.startsWith('title-only'))!;
  const at80 = group.candidates.find((k) => k.threshold === 80)!;

  assert.equal(at80.matched, 1);
  assert.equal(at80.rejected.length, 1, 'the 40 was never a match, so it is not a new cost');
  assert.match(at80.rejected[0]!, /Marginal/);
  db.close();
});

test('the report says how much of the re-score it is looking at', () => {
  // A threshold chosen on a third of a re-score is chosen on whatever `ORDER BY j.id` reached.
  const db = openDb(':memory:');
  scored(db, { title: 'Scored', fit: 84 });
  // Two more jobs that exist but have no v6 row yet.
  scored(db, { title: 'Old A', fit: 84, version: PROMPT_VERSION - 1 });
  scored(db, { title: 'Old B', fit: 84, version: PROMPT_VERSION - 1 });

  const c = calibration(db);
  assert.equal(c.scored, 1);
  assert.equal(c.total, 3, 'counts live jobs, not scored ones');
  db.close();
});

test('a job that changed sides of the threshold is named, with both scores', () => {
  const db = openDb(':memory:');
  const job = scored(db, { title: 'Fell below', fit: 84, version: PROMPT_VERSION - 1 });
  insertScore(db, job, PROMPT_VERSION, 63, judgement(), 'test');

  const c = calibration(db);
  assert.equal(c.previous, PROMPT_VERSION - 1);
  assert.equal(c.moved.length, 1);
  assert.deepEqual(
    { from: c.moved[0]!.from, to: c.moved[0]!.to, direction: c.moved[0]!.direction },
    { from: 84, to: 63, direction: 'down' },
  );
  db.close();
});

test('a job whose score moved but not across the threshold is not reported as movement', () => {
  // The question is which side of the line a job is on, not how far it travelled.
  const db = openDb(':memory:');
  const job = scored(db, { title: 'Still a match', fit: 100, version: PROMPT_VERSION - 1 });
  insertScore(db, job, PROMPT_VERSION, 84, judgement(), 'test');

  assert.deepEqual(calibration(db).moved, []);
  db.close();
});
