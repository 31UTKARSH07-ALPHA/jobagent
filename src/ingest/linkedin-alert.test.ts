/**
 * The fixture below is a **real** LinkedIn alert from Utkarsh's mailbox, 2026-08-15 — the
 * "internship in Greater Bengaluru Area" digest, six cards, exactly as LinkedIn laid it out.
 * Same reasoning as `./naukri-alert.test.ts`: a parser written against imagined bulk-mail HTML
 * passes its own tests and reads nothing, and "0 new jobs" looks identical to a quiet week.
 *
 * The `trackingId`/`midToken`/`otpToken` query parameters are redacted. They are single-use
 * values tied to Utkarsh's account and this repo is public; the parser only ever reads the job
 * id from the path, so redacting them costs the tests nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Email } from '../gmail/messages.ts';
import { cleanUrl, jobIdFrom, parseLinkedInEmail, titlesByJobId } from './linkedin-alert.ts';

const link = (id: string, kind: string) =>
  `https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=REDACTED%3D%3D&refId=REDACTED` +
  `&trk=eml-email_job_alert_digest_01-primary_job_list-0-jobcard_${kind}_jobid_${id}`;

/** Note the header riding along above the first card, and the badges between the fields. */
const TEXT = `
Your job alert for internship in Greater Bengaluru Area
30+ new jobs match your preferences.

Intern
Kapiva
Bengaluru

This company is actively hiring
View job: ${link('4451208160', 'body_text_0')}

---------------------------------------------------------


Software Intern
Terralogic
Greater Bengaluru Area

This company is actively hiring
View job: ${link('4451230158', 'body_text_1')}

---------------------------------------------------------


Technology Intern
Marzi by Primus
Bengaluru
View job: ${link('4453528918', 'body_text_2')}

---------------------------------------------------------


Intern
KLING BREWERY
Bengaluru
Apply with resume & profile
View job: ${link('4450812521', 'body_text_3')}

---------------------------------------------------------


Intern Bios Programming
GSK
Bengaluru

This company is actively hiring
View job: ${link('4450815101', 'body_text_4')}

---------------------------------------------------------

See all jobs on LinkedIn:  https://www.linkedin.com/comm/jobs/search-results/?keywords=internship
`;

/** Each card links its job twice — once from the logo, with no anchor text, then the title. */
const HTML = [
  ['4451208160', 'Intern'],
  ['4451230158', 'Software Intern'],
  ['4453528918', 'Technology Intern'],
  ['4450812521', 'Intern'],
  ['4450815101', 'Intern Bios Programming'],
]
  .map(
    ([id, title]) =>
      `<a href="${link(id!, 'image_0').replace(/&/g, '&amp;')}"><img src="https://media.licdn.com/x.png"></a>` +
      `<a href="${link(id!, 'body_text_0').replace(/&/g, '&amp;')}"><span>${title}</span></a>`,
  )
  .join('\n');

const email = (over: Partial<Email> = {}): Email =>
  ({
    id: 'm1',
    threadId: 't1',
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    fromAddress: 'jobalerts-noreply@linkedin.com',
    subject: '“internship”: Kapiva - Intern posted on 8/14/26',
    receivedAt: '2026-08-15T15:27:04.000Z',
    text: TEXT,
    html: HTML,
    labelIds: [],
    ...over,
  }) as Email;

test('reads every card in a real digest', () => {
  const postings = parseLinkedInEmail(email());

  assert.deepEqual(
    postings.map((p) => [p.title, p.company, p.location]),
    [
      ['Intern', 'Kapiva', 'Bengaluru'],
      ['Software Intern', 'Terralogic', 'Greater Bengaluru Area'],
      ['Technology Intern', 'Marzi by Primus', 'Bengaluru'],
      ['Intern', 'KLING BREWERY', 'Bengaluru'],
      ['Intern Bios Programming', 'GSK', 'Bengaluru'],
    ],
  );
});

test('the header does not contaminate the first card', () => {
  // The first card has no separator above it, so "30+ new jobs match your preferences."
  // is in the same block. Anchoring on the title is what makes that irrelevant.
  const [first] = parseLinkedInEmail(email());
  assert.equal(first?.company, 'Kapiva');
});

test('a badge is never mistaken for the location', () => {
  const kling = parseLinkedInEmail(email()).find((p) => p.company === 'KLING BREWERY');
  assert.equal(kling?.location, 'Bengaluru');
});

test('a card with a badge where the location should be reports no location', () => {
  const text = TEXT.replace('KLING BREWERY\nBengaluru', 'KLING BREWERY\nEasy Apply');
  const kling = parseLinkedInEmail(email({ text })).find((p) => p.company === 'KLING BREWERY');
  // Empty is honest; the scorer shows "(not stated)" and judges on what it has.
  assert.equal(kling?.location, '');
});

test('the logo anchor does not win the title', () => {
  // Both anchors point at the same job; the logo's text is empty and comes first.
  const titles = titlesByJobId(HTML);
  assert.equal(titles.get('4451208160'), 'Intern');
  assert.equal(titles.size, 5);
});

test('urls are canonical, with the single-use tokens stripped', () => {
  const [first] = parseLinkedInEmail(email());
  assert.equal(first?.url, 'https://www.linkedin.com/jobs/view/4451208160/');
  assert.equal(first?.sourceId, '4451208160');
  assert.ok(!first?.url.includes('trackingId'));
});

test('the same job listed twice in one email yields one posting', () => {
  const doubled = email({ text: TEXT + TEXT });
  assert.equal(parseLinkedInEmail(doubled).length, 5);
});

test('links but no readable cards throws rather than returning nothing', () => {
  // The silent-failure case: LinkedIn moves the template, every card stops aligning, and
  // "0 new jobs" every morning looks exactly like a quiet week. This must be loud.
  assert.throws(
    () => parseLinkedInEmail(email({ html: '<a href="https://x.test">nothing</a>' })),
    /template has changed/,
  );
});

test('marketing mail with no job links parses to nothing, quietly', () => {
  assert.deepEqual(parseLinkedInEmail(email({ text: 'Try Premium for ₹0', html: '' })), []);
});

test('job ids come out of any LinkedIn job url shape', () => {
  assert.equal(jobIdFrom('https://www.linkedin.com/comm/jobs/view/4451208160/?x=1'), '4451208160');
  assert.equal(jobIdFrom('https://www.linkedin.com/jobs/view/4451208160'), '4451208160');
  assert.equal(jobIdFrom('https://www.linkedin.com/comm/jobs/search-results/?k=x'), null);
  assert.equal(cleanUrl('123'), 'https://www.linkedin.com/jobs/view/123/');
});
