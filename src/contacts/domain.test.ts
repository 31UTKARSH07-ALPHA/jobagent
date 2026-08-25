/**
 * The network half of this module is exercised by hand (`node src/contacts/domain.ts
 * --name=...`) and by the stage itself. What is tested here is the half that decides
 * *what to believe*: which candidates get tried, and what counts as proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apexOf, domainCandidates, pageNamesCompany } from './domain.ts';

test('candidates are ordered likeliest first', () => {
  const candidates = domainCandidates('Convin');
  assert.equal(candidates[0], 'convin.com');
  assert.ok(candidates.includes('convin.in'));
  assert.ok(candidates.includes('convin.ai'));
});

test('a name with a city stapled on still produces the company stem', () => {
  // The whole-name stem is hopeless here and the first word is the real company.
  const candidates = domainCandidates('Berryworks Kochi Adoor');
  assert.ok(candidates.includes('berryworkskochiadoor.com'));
  assert.ok(candidates.includes('berryworks.com'), 'first-word stem must be tried');
});

test('corporate suffixes never become part of a domain', () => {
  // normaliseCompanyName strips them, so "pvt"/"ltd" must not survive into a guess.
  for (const candidate of domainCandidates('RP INFOCARE PVT LTD')) {
    assert.ok(!/pvt|ltd/.test(candidate), `${candidate} carries a legal suffix`);
  }
  assert.ok(domainCandidates('AI4SEES Private Ltd').includes('ai4sees.com'));
});

test('a name too short to be distinctive produces nothing', () => {
  assert.deepEqual(domainCandidates('RP'), []);
  assert.deepEqual(domainCandidates(''), []);
});

test('the candidate list stays bounded', () => {
  // Each candidate is a DNS lookup and, if that passes, a page fetch — for dozens of
  // companies inside one stage budget.
  assert.ok(domainCandidates('Alpha Beta Gamma Delta Epsilon').length <= 12);
});

test('every candidate is distinct', () => {
  // A repeated candidate is a repeated probe. "Acme Acme" collapses to one stem.
  const candidates = domainCandidates('Acme Acme');
  assert.equal(new Set(candidates).size, candidates.length);
});

test('the page has to name the company', () => {
  assert.equal(
    pageNamesCompany('Discover Dollar', '<h1>Discover Dollar</h1><p>We recover margin.</p>'),
    true,
  );
  // The legal suffixes the alert mail adds are not expected to appear on the site.
  assert.equal(pageNamesCompany('Discover Dollar Technologies Pvt Ltd', '<h1>Discover Dollar</h1>'), true);
});

test('a page that never names the company proves nothing', () => {
  assert.equal(pageNamesCompany('Convin', '<h1>Welcome to nginx</h1>'), false);
});

test('an English word on somebody else\'s page is not a match', () => {
  // Measured against the real 69: accepting the first-word stem matched Chai Point to
  // chai.com, Stance Health to stance.com, and Sustainability Economics to a consultancy.
  assert.equal(pageNamesCompany('Chai Point', '<h1>Chai</h1><p>Loose leaf chai, shipped.</p>'), false);
  assert.equal(pageNamesCompany('Stance Health', '<h1>Stance</h1><p>Socks.</p>'), false);
  // ...and the real site, which does say it, still passes.
  assert.equal(pageNamesCompany('Chai Point', '<title>Buy Tea Online | Chai Point</title>'), true);
});

test('a parked domain is rejected even when it carries the name', () => {
  // These resolve and serve HTML, which is exactly why they need naming explicitly.
  assert.equal(
    pageNamesCompany('Berryworks', '<h1>BerryWorks</h1><p>This domain is for sale. Buy this domain.</p>'),
    false,
  );
});

test('markup is not mistaken for content', () => {
  // The name appearing only in a tracking attribute is not the page saying it.
  assert.equal(pageNamesCompany('Convin', '<div data-vendor="convin"></div>'), false);
});

test('the apex is the domain somebody owns', () => {
  // Chai Point's site redirects to its Shopify subdomain, which has no MX of its own —
  // recording the landing host instead of the apex threw the right answer away.
  assert.equal(apexOf('shop.chaipoint.com'), 'chaipoint.com');
  assert.equal(apexOf('www.acme.co.in'), 'acme.co.in');
  assert.equal(apexOf('careers.acme.co.in'), 'acme.co.in');
  assert.equal(apexOf('acme.com'), 'acme.com');
  assert.equal(apexOf('co.in'), 'co.in');
});
