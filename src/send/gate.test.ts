/**
 * The two policy rules, tested apart from the machinery that will use them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { upsertJob } from '../store/jobs.ts';
import { RawJob, nowIso } from '../store/schema.ts';
import { RAMP, dailyCap, firstSentAt, suppressedBySibling } from './gate.ts';

const day = 86_400_000;

test('the ramp never starts at the top', () => {
  // Invariant 5. A new sender going straight to eight a day is the volume pattern
  // reputation systems exist to catch.
  assert.equal(RAMP[0], 3);
  assert.equal(dailyCap(null), 3, 'nothing sent yet is week one');
});

test('the cap climbs a week at a time and then stops', () => {
  const first = new Date(Date.now() - 0).toISOString();
  const at = (days: number) => dailyCap(first, new Date(Date.now() + days * day));

  assert.equal(at(0), 3);
  assert.equal(at(6), 3, 'still week one');
  assert.equal(at(7), 5);
  assert.equal(at(14), 8);
  assert.equal(at(90), 8, 'and never higher');
});

test('week one begins at the first send, not at a date in a config file', () => {
  // Editing a constant must not be able to fast-forward the ramp.
  const longAgo = new Date(Date.now() - 60 * day).toISOString();
  assert.equal(dailyCap(longAgo), 8);
  assert.equal(dailyCap(null), 3, 'and an unsent pipeline is always at the start');
});

/** Two jobs at one company, and an optional outreach row against the first. */
function pair(opts: { sent?: boolean; bounced?: boolean } = {}) {
  const db = openDb(':memory:');
  const companyId = upsertCompany(db, { name: 'Acme', domain: 'acme.com' });
  const make = (title: string) =>
    upsertJob(
      db,
      companyId,
      RawJob.parse({
        company_name: 'Acme',
        company_domain: 'acme.com',
        source: 'greenhouse',
        url: `https://acme.com/jobs/${title}`,
        title,
        location: 'Bengaluru',
      }),
    ).id;

  const first = make('Backend Intern');
  const second = make('ML Intern');

  db.prepare(
    `INSERT INTO contacts (id, company_id, email, source, confidence, mx_valid, created_at)
     VALUES (1, ?, 'careers@acme.com', 'team_page', 'high', 1, ?)`,
  ).run(companyId, nowIso());

  if (opts.sent !== false) {
    db.prepare(
      `INSERT INTO outreach (job_id, contact_id, subject, body, drafted_at, sent_at, bounced_at)
       VALUES (?, 1, 's', 'b', ?, ?, ?)`,
    ).run(first, nowIso(), nowIso(), opts.bounced === true ? nowIso() : null);
  }

  return { db, first, second };
}

test('a second role at a company we are already writing to is suppressed', () => {
  const { db, second } = pair();
  assert.equal(suppressedBySibling(db, second), true);
});

test('the job that owns the outreach is not suppressed by itself', () => {
  const { db, first } = pair();
  assert.equal(suppressedBySibling(db, first), false);
});

test('suppression lifts once the first email has bounced', () => {
  // It never arrived, so the company was never really contacted.
  const { db, second } = pair({ bounced: true });
  assert.equal(suppressedBySibling(db, second), false);
});

test('a company with no outreach at all suppresses nothing', () => {
  const { db, second } = pair({ sent: false });
  assert.equal(suppressedBySibling(db, second), false);
});

test('the first send is what the ramp reads', () => {
  const { db } = pair();
  assert.notEqual(firstSentAt(db), null);
  assert.equal(firstSentAt(openDb(':memory:')), null);
});
