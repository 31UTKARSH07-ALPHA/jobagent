/**
 * `adoptDomain` is the one write in this project that can *merge* two companies, so what is
 * tested here is mostly what it must not lose while doing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { adoptDomain, companyById, upsertCompany } from './companies.ts';
import { dedupKey, upsertJob } from './jobs.ts';
import { RawJob } from './schema.ts';
import { nowIso } from './schema.ts';

const db = () => openDb(':memory:');

const raw = (over: Partial<ReturnType<typeof RawJob.parse>> = {}) =>
  RawJob.parse({
    company_name: 'Convin',
    company_domain: 'convin.unknown.invalid',
    source: 'gmail-alert',
    source_id: null,
    url: 'https://www.linkedin.com/jobs/view/1',
    title: 'Data Labs Intern',
    location: 'Bengaluru',
    ...over,
  });

test('a marker domain is upgraded in place when nothing else holds the real one', () => {
  const d = db();
  const id = upsertCompany(d, { name: 'Convin', domain: 'convin.unknown.invalid' });
  const job = upsertJob(d, id, raw());

  assert.equal(adoptDomain(d, id, 'convin.ai'), id, 'the company keeps its id');
  assert.equal(companyById(d, id)?.domain, 'convin.ai');

  // The job moved with it, and its key now hashes the real domain — otherwise tomorrow's
  // ingest would compute a different key for the same posting and insert it again.
  const row = d.prepare('SELECT company_id, dedup_key FROM jobs WHERE id = ?').get(job.id) as {
    company_id: number;
    dedup_key: string;
  };
  assert.equal(row.company_id, id);
  assert.equal(row.dedup_key, dedupKey('convin.ai', 'Data Labs Intern', 'Bengaluru'));
});

test('a marker that collides with a real company merges into it', () => {
  const d = db();
  const real = upsertCompany(d, { name: 'Convin', domain: 'convin.ai', ats_type: 'greenhouse' });
  const marker = upsertCompany(d, { name: 'Convin', domain: 'convin.unknown.invalid' });
  const fromAlert = upsertJob(d, marker, raw({ title: 'ML Intern' }));

  assert.equal(adoptDomain(d, marker, 'convin.ai'), real, 'the real row survives');
  assert.equal(companyById(d, marker), null, 'the marker row is gone');

  // Two company rows would mean running the contact cascade twice and mailing the same
  // person about two roles — the thing decision 005 exists to prevent.
  const companies = d.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number };
  assert.equal(companies.n, 1);

  const moved = d.prepare('SELECT company_id FROM jobs WHERE id = ?').get(fromAlert.id) as {
    company_id: number;
  };
  assert.equal(moved.company_id, real);
});

test('the same posting seen from both sources collapses to one job', () => {
  const d = db();
  const real = upsertCompany(d, { name: 'Convin', domain: 'convin.ai' });
  const marker = upsertCompany(d, { name: 'Convin', domain: 'convin.unknown.invalid' });

  const fromBoard = upsertJob(
    d,
    real,
    raw({ company_domain: 'convin.ai', source: 'greenhouse', source_id: 'gh-1' }),
  );
  const fromAlert = upsertJob(d, marker, raw({ source_id: 'li-1' }));
  assert.notEqual(fromBoard.id, fromAlert.id, 'two rows to begin with');

  adoptDomain(d, marker, 'convin.ai');

  const jobs = d.prepare('SELECT id FROM jobs').all() as { id: number }[];
  assert.deepEqual(jobs.map((j) => j.id), [fromBoard.id], 'the duplicate is dropped');
});

test('a duplicate that anything downstream refers to is kept, not deleted', () => {
  const d = db();
  const real = upsertCompany(d, { name: 'Convin', domain: 'convin.ai' });
  const marker = upsertCompany(d, { name: 'Convin', domain: 'convin.unknown.invalid' });
  const fromBoard = upsertJob(d, real, raw({ company_domain: 'convin.ai', source_id: 'gh-1' }));
  const fromAlert = upsertJob(d, marker, raw({ source_id: 'li-1' }));

  // The alert-sourced row is the one that was actually scored — deleting it would throw
  // away the score history migration 004 was careful to preserve.
  d.prepare(
    `INSERT INTO job_scores (job_id, prompt_version, fit_score, level_fit, location_fit,
                             stack_fit, domain_fit, reasoning, hook, model, scored_at)
     VALUES (?, 4, 84, 8, 9, 7, 7, 'why', 'hook', 'test', ?)`,
  ).run(fromAlert.id, nowIso());

  adoptDomain(d, marker, 'convin.ai');

  const ids = (d.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: number }[]).map((j) => j.id);
  assert.deepEqual(ids, [fromBoard.id, fromAlert.id]);
  const kept = d.prepare('SELECT company_id FROM jobs WHERE id = ?').get(fromAlert.id) as {
    company_id: number;
  };
  assert.equal(kept.company_id, real, 'it still moves to the surviving company');
});

test('contacts follow the company, and duplicate addresses are not cloned', () => {
  const d = db();
  const real = upsertCompany(d, { name: 'Convin', domain: 'convin.ai' });
  const marker = upsertCompany(d, { name: 'Convin', domain: 'convin.unknown.invalid' });

  const contact = (companyId: number, email: string) =>
    d.prepare(
      `INSERT INTO contacts (company_id, email, source, confidence, created_at)
       VALUES (?, ?, 'team_page', 'high', ?)`,
    ).run(companyId, email, nowIso());

  contact(real, 'careers@convin.ai');
  contact(marker, 'hr@convin.ai');

  adoptDomain(d, marker, 'convin.ai');

  const emails = (d.prepare('SELECT email FROM contacts ORDER BY email').all() as { email: string }[])
    .map((c) => c.email);
  assert.deepEqual(emails, ['careers@convin.ai', 'hr@convin.ai']);
  const orphans = d.prepare('SELECT COUNT(*) AS n FROM contacts WHERE company_id <> ?').get(real) as {
    n: number;
  };
  assert.equal(orphans.n, 0);
});

test('adopting the domain a company already has is a no-op', () => {
  const d = db();
  const id = upsertCompany(d, { name: 'Convin', domain: 'convin.ai' });
  assert.equal(adoptDomain(d, id, 'https://www.Convin.ai/'), id);
  assert.equal(companyById(d, id)?.domain, 'convin.ai');
});
