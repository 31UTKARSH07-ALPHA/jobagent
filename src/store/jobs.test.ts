import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { normaliseDomain, upsertCompany } from './companies.ts';
import { dedupKey, upsertJob, staleJobIds, getJob } from './jobs.ts';
import { RawJob } from './schema.ts';
import { stateOf, transition } from './state.ts';

const raw = (over: Partial<ReturnType<typeof RawJob.parse>> = {}) =>
  RawJob.parse({
    company_name: 'Acme',
    company_domain: 'acme.com',
    ats_type: 'greenhouse',
    ats_slug: 'acme',
    source: 'greenhouse',
    source_id: '1',
    url: 'https://acme.com/jobs/1',
    title: 'Software Engineering Intern',
    location: 'Bengaluru, India',
    description: 'Build things',
    ...over,
  });

test('domains normalise to a single canonical form', () => {
  for (const input of [
    'https://www.Meesho.com/careers',
    'http://meesho.com',
    'www.meesho.com',
    'MEESHO.com',
    'meesho.com:443',
    'meesho.com.',
  ]) {
    assert.equal(normaliseDomain(input), 'meesho.com', input);
  }
});

test('the same role from two sources produces one dedup key', () => {
  // The whole point: Greenhouse and a LinkedIn alert describing the same posting.
  const fromBoard = dedupKey('acme.com', 'Software Engineering Intern', 'Bengaluru, India');
  const fromEmail = dedupKey('https://www.acme.com', 'software engineering  intern!', 'bengaluru india');
  assert.equal(fromBoard, fromEmail);
});

test('different roles at the same company differ', () => {
  assert.notEqual(
    dedupKey('acme.com', 'Backend Intern', 'Pune'),
    dedupKey('acme.com', 'Frontend Intern', 'Pune'),
  );
});

test('re-ingesting is a no-op beyond last_seen_at', async () => {
  const db = openDb(':memory:');
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com', ats_type: 'greenhouse' });

  const first = upsertJob(db, companyId, raw());
  assert.equal(first.created, true);

  const seenAt = getJob(db, first.id)?.last_seen_at;
  await new Promise((r) => setTimeout(r, 5));

  const second = upsertJob(db, companyId, raw({ source: 'gmail-alert', source_id: 'abc' }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id, 'same job, not a duplicate row');

  const after = getJob(db, first.id);
  assert.notEqual(after?.last_seen_at, seenAt, 'last_seen_at moved');
  assert.equal(after?.source, 'greenhouse', 'original source is not overwritten');

  const count = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
  assert.equal(count.n, 1);
  db.close();
});

test('re-ingesting never resets a job that has moved on', () => {
  const db = openDb(':memory:');
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  const { id } = upsertJob(db, companyId, raw());

  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'MATCHED');
  upsertJob(db, companyId, raw());

  assert.equal(stateOf(db, id), 'MATCHED', 'a re-seen posting must not go back to DISCOVERED');
  db.close();
});

test('company upsert does not blank out fields a later sighting lacks', () => {
  const db = openDb(':memory:');
  upsertCompany(db, {
    name: 'Acme',
    domain: 'acme.com',
    ats_type: 'greenhouse',
    ats_slug: 'acme',
    team_url: 'https://acme.com/team',
  });
  // A Gmail alert knows the company but nothing about its ATS or team page.
  const id = upsertCompany(db, { name: 'Acme', domain: 'www.acme.com' });

  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row['ats_type'], 'greenhouse');
  assert.equal(row['ats_slug'], 'acme');
  assert.equal(row['team_url'], 'https://acme.com/team');

  const count = db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number };
  assert.equal(count.n, 1, 'www. and bare domain are the same company');
  db.close();
});

test('stale jobs are found only in pre-draft states', () => {
  const db = openDb(':memory:');
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  const { id } = upsertJob(db, companyId, raw());

  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  db.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?').run(old, id);

  assert.deepEqual(staleJobIds(db, 14), [id]);
  assert.deepEqual(staleJobIds(db, 60), [], 'not stale under a longer window');

  transition(db, id, 'DISCOVERED', 'SCORED');
  transition(db, id, 'SCORED', 'REJECTED');
  assert.deepEqual(staleJobIds(db, 14), [], 'terminal states are left alone');
  db.close();
});
