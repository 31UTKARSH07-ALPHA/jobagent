import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import {
  isUnknownDomain,
  normaliseCompanyName,
  resolveCompany,
  UNKNOWN_DOMAIN_SUFFIX,
} from './resolve-company.ts';

test('the same company written three ways normalises to one key', () => {
  // LinkedIn, Naukri and a careers page each write it differently. If these do not collide,
  // one company becomes three rows and the contact cascade runs three times (decision 005).
  for (const variant of ['Zomato', 'ZOMATO', 'Zomato Ltd.', 'Zomato Limited', 'zomato  ']) {
    assert.equal(normaliseCompanyName(variant), 'zomato', variant);
  }
  assert.equal(normaliseCompanyName('Flipkart Internet Private Limited'), 'flipkart internet');
});

test('alert-email decoration after a separator is dropped', () => {
  assert.equal(normaliseCompanyName('Swiggy · Bengaluru'), 'swiggy');
  assert.equal(normaliseCompanyName('Flipkart | Hiring Now'), 'flipkart');
  assert.equal(normaliseCompanyName('Acme – via Naukri'), 'acme');
  assert.equal(normaliseCompanyName('Acme - Bangalore'), 'acme');
  // But a hyphen inside a name is not a separator.
  assert.equal(normaliseCompanyName('Coca-Cola'), 'coca cola');
});

test('accents and ampersands survive as matchable text', () => {
  assert.equal(normaliseCompanyName('Société Générale'), 'societe generale');
  assert.equal(normaliseCompanyName('H&M'), 'h and m');
});

test('a known company resolves to its real domain', () => {
  const db = openDb(':memory:');
  for (const name of ['Zomato', 'Razorpay', 'Zoho']) {
    const r = resolveCompany(db, name);
    assert.equal(isUnknownDomain(r.domain), false, name);
    assert.equal(r.via, 'candidates', name);
  }
  db.close();
});

test("Naukri's legal names resolve through the prefix tier", () => {
  const db = openDb(':memory:');
  for (const [written, expected] of [
    ['Razorpay Software Private Limited', 'razorpay.com'],
    ['Swiggy Bundl Technologies', 'swiggy.com'],
    ['Flipkart Internet Pvt Ltd', 'flipkart.com'],
  ] as const) {
    const r = resolveCompany(db, written);
    assert.equal(r.domain, expected, written);
  }
  db.close();
});

test('a prefix match respects word boundaries', () => {
  const db = openDb(':memory:');
  // `zomato` must not swallow a genuinely different company whose name merely starts with
  // those letters.
  const r = resolveCompany(db, 'Zomatox Analytics');
  assert.equal(isUnknownDomain(r.domain), true, r.domain);
  db.close();
});

test('the DB wins over the static list, so a learned domain sticks', () => {
  const db = openDb(':memory:');
  // Suppose the candidate list has the wrong domain and ingest has since seen the right one.
  upsertCompany(db, { name: 'Zomato', domain: 'zomato.in' });

  const r = resolveCompany(db, 'Zomato Ltd.');
  assert.equal(r.domain, 'zomato.in');
  assert.equal(r.via, 'db');
  db.close();
});

test('an unknown company gets a marker that can never be emailed', () => {
  const db = openDb(':memory:');
  const r = resolveCompany(db, 'Some Random Startup XYZ');

  assert.equal(r.via, 'unknown');
  assert.equal(r.domain, `some-random-startup-xyz${UNKNOWN_DOMAIN_SUFFIX}`);
  // RFC 2606 reserves .invalid precisely so it can never resolve — the marker is safe by
  // construction rather than by anyone remembering to check it.
  assert.match(r.domain, /\.invalid$/);
  assert.equal(r.name, 'Some Random Startup XYZ', 'the name is kept as written');
  db.close();
});

test('the same unknown company gets one row, not one per sighting', () => {
  const db = openDb(':memory:');
  const first = resolveCompany(db, 'Mystery Corp');
  upsertCompany(db, { name: first.name, domain: first.domain });

  // A second alert writes it differently.
  const second = resolveCompany(db, 'Mystery Corp Pvt Ltd');
  assert.equal(second.domain, first.domain, 'still one company');

  upsertCompany(db, { name: second.name, domain: second.domain });
  const count = db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number };
  assert.equal(count.n, 1);
  db.close();
});

test('an unknown-domain row never satisfies a later lookup as if it were real', () => {
  const db = openDb(':memory:');
  const marker = resolveCompany(db, 'Mystery Corp');
  upsertCompany(db, { name: 'Mystery Corp', domain: marker.domain });

  // The candidate list is still consulted, so the day Mystery Corp is added there — or the
  // cascade learns its domain — the real one takes over instead of the marker sticking.
  const again = resolveCompany(db, 'Mystery Corp');
  assert.equal(again.via, 'unknown', 'not reported as a confident DB hit');
  db.close();
});

test('an empty or punctuation-only name does not produce a garbage domain', () => {
  const db = openDb(':memory:');
  for (const junk of ['', '   ', '—', '|']) {
    const r = resolveCompany(db, junk);
    assert.equal(r.domain, `unnamed${UNKNOWN_DOMAIN_SUFFIX}`, JSON.stringify(junk));
  }
  db.close();
});
