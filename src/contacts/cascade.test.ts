/**
 * What is tested here is the filtering and the ranking — the two places where the cascade
 * decides whether an address is worth a real email. The network rungs are exercised against
 * live sites by the stage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceFor, contactLinks, emailsIn, findContacts, isUsable, rankEmail } from './cascade.ts';

test('addresses are found in text, HTML and entity-escaped HTML', () => {
  assert.deepEqual(emailsIn('write to Careers@Acme.com please'), ['careers@acme.com']);
  assert.deepEqual(emailsIn('<a href="mailto:hr@acme.com">HR</a>'), ['hr@acme.com']);
  assert.deepEqual(emailsIn('hr&#64;acme.com'), ['hr@acme.com']);
});

test('the two obfuscations that actually appear are undone', () => {
  assert.deepEqual(emailsIn('careers [at] acme [dot] com'), ['careers@acme.com']);
  assert.deepEqual(emailsIn('careers (at) acme (dot) com'), ['careers@acme.com']);
  // Bare " at " is not decoded: "meet the team at acme.com" is not an address.
  assert.deepEqual(emailsIn('meet the team at acme.com'), []);
});

test('trailing punctuation is not part of the address', () => {
  assert.deepEqual(emailsIn('mail hr@acme.com.'), ['hr@acme.com']);
  assert.deepEqual(emailsIn('(hr@acme.com)'), ['hr@acme.com']);
});

test('addresses that exist to not be replied to are rejected', () => {
  for (const local of ['no-reply', 'noreply', 'donotreply', 'postmaster', 'unsubscribe', 'privacy', 'legal']) {
    assert.equal(isUsable(`${local}@acme.com`, 'acme.com', 'Acme'), false, local);
  }
});

test('departments that are not hiring are rejected', () => {
  // Writing a cold job application to sales@ is how a small company decides you are spam.
  for (const local of ['sales', 'billing', 'invoices', 'press', 'newsletter']) {
    assert.equal(isUsable(`${local}@acme.com`, 'acme.com', 'Acme'), false, local);
  }
});

test('customer service is the wrong desk, and a high-confidence one', () => {
  // Measured live: the cascade returned customercare@chaipoint.com and support@bytebeam.io
  // as team_page finds, which Phase 3 may auto-send. A careers@ guess needing approval is
  // the better outcome.
  for (const local of ['support', 'customercare', 'customer-support', 'helpdesk', 'grievance']) {
    assert.equal(isUsable(`${local}@acme.com`, 'acme.com', 'Acme'), false, local);
  }
});

test('image filenames are not email addresses', () => {
  assert.equal(isUsable('logo@2x.png', 'acme.com', 'Acme'), false);
});

test('placeholder and platform domains are rejected', () => {
  for (const domain of ['example.com', 'yourcompany.com', 'sentry.wixpress.com', 'users.noreply.github.com']) {
    assert.equal(isUsable(`careers@${domain}`, 'acme.com', 'Acme'), false, domain);
  }
});

test('an unverified marker domain can never produce an address', () => {
  assert.equal(isUsable('careers@acme.unknown.invalid', 'acme.unknown.invalid', 'Acme'), false);
});

test('a subdomain of the company still counts as the company', () => {
  assert.equal(isUsable('careers@mail.acme.com', 'acme.com', 'Acme'), true);
});

test('a mailbox-provider address is kept when it is plausibly the company', () => {
  // Small Indian firms really do publish a gmail address, and refusing it would leave only
  // a guess at the company domain.
  assert.equal(isUsable('acmehr@gmail.com', 'acme.com', 'Acme'), true, 'carries the company name');
  assert.equal(isUsable('hr@gmail.com', 'acme.com', 'Acme'), true, 'role address');
  assert.equal(isUsable('rahul.sharma@gmail.com', 'acme.com', 'Acme'), false, 'someone unrelated');
});

test("another company's mailbox is never ours to write to", () => {
  // Live run 2026-08-25: the aggregator "Top Gen AI Jobs" published
  // jobs.accommodations@sandisk.com, which a hiring-local-part rule stored as a
  // high-confidence contact for an unrelated company.
  assert.equal(isUsable('jobs.accommodations@sandisk.com', 'topgenaijobs.com', 'Top Gen AI Jobs'), false);
  assert.equal(isUsable('careers@othercorp.com', 'acme.com', 'Acme'), false);
  // ...unless the address itself names the company, which is a real pattern for subsidiaries.
  assert.equal(isUsable('acme.careers@parentco.com', 'acme.com', 'Acme'), true);
});

test('accommodation and accessibility mailboxes are never contacted', () => {
  // A legally-mandated accessibility inbox is the wrong desk in a way that matters.
  for (const local of ['accommodations', 'accommodation', 'accessibility']) {
    assert.equal(isUsable(`${local}@acme.com`, 'acme.com', 'Acme'), false, local);
  }
});

test('the rung outranks everything about the address', () => {
  // A named person in the posting beats careers@ scraped from the site: the posting is the
  // strongest provenance there is.
  assert.ok(
    rankEmail('priya@acme.com', 'posting', 'acme.com') > rankEmail('careers@acme.com', 'team_page', 'acme.com'),
  );
  assert.ok(
    rankEmail('careers@acme.com', 'team_page', 'acme.com') > rankEmail('careers@acme.com', 'pattern', 'acme.com'),
  );
});

test('within a rung, hiring addresses beat front-door ones', () => {
  const rank = (email: string) => rankEmail(email, 'team_page', 'acme.com');
  assert.ok(rank('careers@acme.com') > rank('hello@acme.com'));
  assert.ok(rank('hello@acme.com') > rank('bengaluru.office.reception@acme.com'));
  assert.ok(rank('careers@acme.com') > rank('careers@gmail.com'), 'the company domain wins ties');
});

test('links are followed only when they lead somewhere with an address on it', () => {
  const html = `
    <a href="/careers">Careers</a>
    <a href="/contact-us">Get in touch</a>
    <a href="/pricing">Pricing</a>
    <a href="https://boards.greenhouse.io/acme">Open roles</a>
    <a href="mailto:hr@acme.com">Mail us</a>`;
  const links = contactLinks(html, 'https://acme.com/');

  assert.deepEqual(links, ['https://acme.com/careers', 'https://acme.com/contact-us']);
});

test('a careers link pointing off-site is not followed', () => {
  // It is a job board, not a contact page, and following it reads somebody else's site.
  assert.deepEqual(contactLinks('<a href="https://jobs.lever.co/acme">Jobs</a>', 'https://acme.com/'), []);
});

test('the same link twice is followed once', () => {
  const html = '<a href="/careers">Careers</a><a href="/careers#open">Open roles</a>';
  assert.deepEqual(contactLinks(html, 'https://acme.com/'), ['https://acme.com/careers']);
});

test('a page-published address off the company domain is capped at medium', () => {
  // `high` is the band that may auto-send with nobody reading it first, and it means "read
  // off the company's own site" — which has to mean the company's own domain. Live, two
  // gmail.com addresses were stored `high` because a company page named them, and both were
  // trivially MX-valid because gmail.com takes mail (decision 047).
  assert.equal(confidenceFor('careers@acme.com', 'team_page', 'acme.com'), 'high');
  assert.equal(confidenceFor('careers@jobs.acme.com', 'team_page', 'acme.com'), 'high');
  assert.equal(confidenceFor('acmehr@gmail.com', 'team_page', 'acme.com'), 'medium');
  assert.equal(confidenceFor('hiring@example.net', 'team_page', 'example.com'), 'medium');
});

test('a rung that was never high is not raised by being on the right domain', () => {
  // The domain rule only ever lowers. `pattern` is a guess at any address.
  assert.equal(confidenceFor('careers@acme.com', 'pattern', 'acme.com'), 'low');
  assert.equal(confidenceFor('careers@acme.com', 'github', 'acme.com'), 'medium');
});

test('an address a send has already proven wrong is never offered again', async () => {
  // The company's pages still publish it, and it still ranks first for all the reasons it did
  // the first time. Re-finding it is not a second opinion (decision 047).
  const found = await findContacts(
    { name: 'Acme', domain: 'acme.com' },
    { exclude: ['careers@acme.com'], timeoutMs: 1, postings: ['write to careers@acme.com'] },
  );
  assert.equal(
    found.some((c) => c.email === 'careers@acme.com'),
    false,
  );
});

test('the exclusion covers the pattern rung too', async () => {
  // `careers@acme.com` is exactly as guessable after it bounced as before, and a low-confidence
  // guess still occupies the company's one cached contact row.
  const found = await findContacts({ name: 'Acme', domain: 'acme.invalid' }, { exclude: ['careers@acme.invalid'] });
  assert.equal(
    found.some((c) => c.email === 'careers@acme.invalid'),
    false,
  );
  assert.equal(
    found.some((c) => c.email === 'hr@acme.invalid'),
    true,
    'the other guesses are still offered',
  );
});
