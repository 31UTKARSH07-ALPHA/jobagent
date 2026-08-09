import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { upsertCompany } from './companies.ts';
import { upsertJob } from './jobs.ts';
import {
  factorsOf,
  getScore,
  hasScore,
  insertScore,
  latestScore,
  scoreDistribution,
} from './scores.ts';
import { RawJob, type ScoreResult } from './schema.ts';

/** The model's half of a row. `fit_score` is computed elsewhere and passed separately. */
const judgement = (over: Partial<ScoreResult> = {}): ScoreResult => ({
  level_fit: 10,
  location_fit: 8,
  stack_fit: 6,
  domain_fit: 4,
  reasoning: 'because',
  hook: 'p95 8ms',
  ...over,
});

function seedJob(db: ReturnType<typeof openDb>, title = 'Software Engineering Intern'): number {
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  return upsertJob(
    db,
    companyId,
    RawJob.parse({
      company_name: 'Acme',
      company_domain: 'acme.com',
      source: 'greenhouse',
      url: 'https://acme.com/jobs/1',
      title,
    }),
  ).id;
}

test('a second insert under the same rubric version leaves the first score standing', () => {
  const db = openDb(':memory:');
  const jobId = seedJob(db);

  assert.equal(insertScore(db, jobId, 1, 82, judgement(), 'model-a'), true);
  assert.equal(hasScore(db, jobId, 1), true);

  assert.equal(insertScore(db, jobId, 1, 30, judgement(), 'model-b'), false, 'reports it wrote nothing');
  assert.equal(getScore(db, jobId, 1)?.fit_score, 82, 'the original score is intact');
  db.close();
});

test('bumping the rubric version keeps both scores — that is the whole point', () => {
  const db = openDb(':memory:');
  const jobId = seedJob(db);

  insertScore(db, jobId, 1, 64, judgement(), 'model-a');
  insertScore(db, jobId, 2, 88, judgement(), 'model-a');

  assert.equal(getScore(db, jobId, 1)?.fit_score, 64, 'history survives a re-score');
  assert.equal(getScore(db, jobId, 2)?.fit_score, 88);
  assert.equal(latestScore(db, jobId)?.fit_score, 88, 'latest = highest version, not highest score');
  db.close();
});

test('hasScore is version-specific', () => {
  const db = openDb(':memory:');
  const jobId = seedJob(db);
  insertScore(db, jobId, 1, 50, judgement(), 'model-a');

  assert.equal(hasScore(db, jobId, 1), true);
  assert.equal(hasScore(db, jobId, 2), false, 'a new rubric has not scored it yet');
  db.close();
});

test('a stored row hands back exactly what the model said', () => {
  // What a resumed run reads to finish a job without paying for a second judgement.
  const db = openDb(':memory:');
  const jobId = seedJob(db);
  const said = judgement({ level_fit: 7, location_fit: 3, stack_fit: 9, domain_fit: 2 });
  insertScore(db, jobId, 1, 61, said, 'model-a');

  assert.deepEqual(factorsOf(getScore(db, jobId, 1)!), said);
  db.close();
});

test('the distribution the calibration gate reads', () => {
  const db = openDb(':memory:');
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });

  // 0, 5, 70, 71, 100 → bands 0, 0, 7, 7, 9
  const scores = [0, 5, 70, 71, 100];
  scores.forEach((s, i) => {
    const { id } = upsertJob(
      db,
      companyId,
      RawJob.parse({
        company_name: 'Acme',
        company_domain: 'acme.com',
        source: 'greenhouse',
        url: `https://acme.com/jobs/${i}`,
        title: `Intern ${i}`,
      }),
    );
    insertScore(db, id, 1, s, judgement(), 'model-a');
  });

  const dist = scoreDistribution(db, 1);
  assert.equal(dist?.total, 5);
  assert.equal(dist?.min, 0);
  assert.equal(dist?.max, 100);
  assert.equal(dist?.median, 70);
  assert.equal(dist?.bands[0], 2);
  assert.equal(dist?.bands[7], 2);
  assert.equal(dist?.bands[9], 1, '100 belongs in the top band, not an eleventh one');
  assert.equal(dist?.bands.reduce((a, b) => a + b, 0), 5, 'every score landed in exactly one band');

  assert.equal(scoreDistribution(db, 2), null, 'an unscored rubric version has no distribution');
  db.close();
});
