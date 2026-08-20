/**
 * No network. The model is replaced by a fake `Scorer`, so what is under test is the part
 * that can quietly corrupt the pipeline: how four factor ratings become one score, which
 * state that score lands a job in, and whether re-running costs a second API call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  TITLE_ONLY_CAP,
  clampToEvidence,
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
  assert.equal(fitScore(judgement()), 100);
  assert.equal(
    fitScore(judgement({ level_fit: 0, location_fit: 0, stack_fit: 0, domain_fit: 0 })),
    0,
  );
  // 10·.3 + 10·.25 + 5·.25 + 5·.2 = 7.75 → 78
  assert.equal(fitScore(judgement({ stack_fit: 5, domain_fit: 5 })), 78);
  // Same ratings twice must give the same number — that is the whole point of moving it
  // out of the model.
  const twice = judgement({ stack_fit: 3, domain_fit: 7 });
  assert.equal(fitScore(twice), fitScore(twice));
});

test('an impossible job cannot be rescued by a perfect stack match', () => {
  // "3+ years" with everything else ideal. Weighted this would be 73 — a MATCH.
  const experienceBar = judgement({ level_fit: 1 });
  assert.ok(fitScore(experienceBar) < MATCH_THRESHOLD, `got ${fitScore(experienceBar)}`);
  assert.equal(stateForScore(fitScore(experienceBar)), 'REJECTED');

  // Onsite in another country, no remote offered.
  const onsiteAbroad = judgement({ location_fit: 0 });
  assert.ok(fitScore(onsiteAbroad) < MATCH_THRESHOLD, `got ${fitScore(onsiteAbroad)}`);

  // A merely weak rating is not a blocker — it just costs its weight.
  assert.ok(fitScore(judgement({ level_fit: 4 })) > MATCH_THRESHOLD);
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

test('the clamp holds down only the two factors a title cannot evidence', () => {
  const perfect = judgement();
  const clamped = clampToEvidence(perfect, true);

  assert.equal(clamped.stack_fit, TITLE_ONLY_CAP);
  assert.equal(clamped.domain_fit, TITLE_ONLY_CAP);
  // Level and location *are* knowable from a title and a city, so they are untouched.
  assert.equal(clamped.level_fit, 10);
  assert.equal(clamped.location_fit, 10);
  // A modest rating is left alone rather than raised to the cap.
  assert.equal(clampToEvidence(judgement({ stack_fit: 2 }), true).stack_fit, 2);
  assert.deepEqual(clampToEvidence(perfect, false), perfect, 'a real JD is not clamped');
});

test('a title-only posting can be MATCHED but can never reach the auto-send band', () => {
  // The measured failure this exists for: on 2026-08-11 all three Naukri postings came back
  // 10/10/10/10 → 100, the same score Stripe got with a full JD backing it up.
  const best = fitScore(clampToEvidence(judgement(), true));
  assert.equal(best, 82, 'the ceiling for a posting nobody has read');
  assert.ok(best >= MATCH_THRESHOLD, 'still worth putting in the digest');
  assert.ok(best < 85, 'but never auto-sendable — Phase 3 requires >85');
});

test('the stage clamps a real alert-shaped job and counts it', async () => {
  const db = openDb(':memory:');
  seed(db, ['Python / AI-ML / Full Stack Developer Intern'], '');

  const scorer = fakeScorer(() => judgement()); // the model says 10/10/10/10
  const ctx = context(db);
  await runScore(ctx, { scorer, profile: PROFILE });

  const score = getScore(db, jobIdsInState(db, 'MATCHED')[0] ?? 1, PROMPT_VERSION);
  assert.equal(score?.stack_fit, TITLE_ONLY_CAP, 'stored clamped, so fit_score matches its factors');
  assert.equal(score?.fit_score, 82);
  assert.equal(ctx.counts['title_only'], 1);
  db.close();
});
