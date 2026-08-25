/**
 * What is tested here is the filtering and the ranking — the two places where the cascade
 * decides whether an address is worth a real email. The network rungs are exercised against
 * live sites by the stage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactLinks, emailsIn, isUsable, rankEmail } from './cascade.ts';

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

test('an off-domain address is kept only when it is about hiring or names the company', () => {
  // Small Indian firms really do publish a gmail address, and refusing it would leave only
  // a guess at the company domain.
  assert.equal(isUsable('acmehr@gmail.com', 'acme.com', 'Acme'), true, 'carries the company name');
  assert.equal(isUsable('hr@gmail.com', 'acme.com', 'Acme'), true, 'role address');
  assert.equal(isUsable('rahul.sharma@gmail.com', 'acme.com', 'Acme'), false, 'someone unrelated');
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
