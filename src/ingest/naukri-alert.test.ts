/**
 * The URLs in this file are **real**, captured from Utkarsh's mailbox on 2026-08-11. That is
 * the point: a bulk-mail parser written against imagined HTML passes its tests and reads
 * nothing, and the failure is silent — "0 new jobs" every morning looks exactly like a quiet
 * week. If Naukri changes its template, these are the assertions that should break.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Email } from '../gmail/messages.ts';
import { cleanUrl, parseJobLink, parseNaukriEmail, slugifyTitle, toRawJob } from './naukri-alert.ts';

/** Three postings, one email — exactly as Naukri sent them. */
const REAL = [
  {
    href:
      'https://www.naukri.com/jd/job-listings-software-development-intern-full-stack-discover-dollar-technologies-pvt-ltd-bengaluru-0-to-1-years-050826503011' +
      '?xp=1&src=ja_campus20240216800&xid=20240216800^gm^350704612&uid=350704612&alertId=&utm_campaign=ja_campus_mailer',
    text: 'Software Development Intern (Full Stack)',
    company: 'Discover Dollar Technologies Pvt Ltd',
    location: 'Bengaluru',
    sourceId: '050826503011',
    experience: '0-1',
  },
  {
    href:
      'https://www.naukri.com/jd/job-listings-python-ai-ml-full-stack-developer-intern-lakkshions-it-hyderabad-0-to-1-years-060826035232' +
      '?xp=2&utm_source=joblink',
    text: 'Python / AI-ML / Full Stack Developer Intern',
    company: 'Lakkshions It',
    location: 'Hyderabad',
    sourceId: '060826035232',
    experience: '0-1',
  },
  {
    href:
      'https://www.naukri.com/jd/job-listings-intern-fullstack-ai-innovation-nexx-base-gurugram-0-to-2-years-030826503755?xp=3',
    text: 'Intern - Fullstack & AI Innovation',
    company: 'Nexx Base',
    location: 'Gurugram',
    sourceId: '030826503755',
    experience: '0-2',
  },
] as const;

const email = (html: string): Email => ({
  id: 'm1',
  threadId: 't1',
  from: 'Naukri Campus Jobs <recommendationnc@naukri.com>',
  fromAddress: 'recommendationnc@naukri.com',
  subject: 'Utkarsh Pathak, Urgently hiring for Intern',
  receivedAt: '2026-08-10T10:10:17.000Z',
  text: 'Job recommendations based on your Naukri.com profile',
  html,
  labelIds: ['INBOX'],
});

test('all three real postings parse out of their URLs', () => {
  for (const expected of REAL) {
    const posting = parseJobLink(expected.href, expected.text);
    assert.equal(posting?.title, expected.text);
    // The rendered email truncates this to "Discover Dollar Tec…"; the slug does not.
    assert.equal(posting?.company, expected.company, expected.text);
    assert.equal(posting?.location, expected.location, expected.text);
    assert.equal(posting?.sourceId, expected.sourceId);
    assert.equal(posting?.experience, expected.experience);
  }
});

test('tracking parameters are stripped from the stored URL', () => {
  const posting = parseJobLink(REAL[0].href, REAL[0].text);
  assert.equal(posting?.url.includes('utm_'), false);
  assert.equal(posting?.url.includes('uid='), false);
  assert.match(posting?.url ?? '', /^https:\/\/www\.naukri\.com\/jd\/job-listings-.*-050826503011$/);
  // But a URL that is not a URL is passed through rather than lost.
  assert.equal(cleanUrl('not a url'), 'not a url');
});

test('the title slug is subtracted from the front, so the company never absorbs it', () => {
  // The anchor text is authoritative, which is what makes the company boundary solvable.
  assert.equal(slugifyTitle('Software Development Intern (Full Stack)'), 'software-development-intern-full-stack');
  assert.equal(slugifyTitle('Python / AI-ML / Full Stack Developer Intern'), 'python-ai-ml-full-stack-developer-intern');
  assert.equal(slugifyTitle('Intern - Fullstack & AI Innovation'), 'intern-fullstack-ai-innovation');
});

test('a two-word city does not get eaten by the company name', () => {
  const posting = parseJobLink(
    'https://www.naukri.com/jd/job-listings-backend-intern-acme-labs-navi-mumbai-0-to-1-years-123456',
    'Backend Intern',
  );
  assert.equal(posting?.location, 'Navi Mumbai', 'longest city match wins over "mumbai"');
  assert.equal(posting?.company, 'Acme Labs');
});

test('an unrecognised city costs the location, not the posting', () => {
  const posting = parseJobLink(
    'https://www.naukri.com/jd/job-listings-backend-intern-acme-labs-someplace-0-to-1-years-123456',
    'Backend Intern',
  );
  assert.notEqual(posting, null, 'still a usable posting');
  assert.equal(posting?.location, '');
  assert.equal(posting?.company, 'Acme Labs Someplace', 'the unknown token stays with the company');
});

test('anything that does not fit the shape returns null rather than throwing', () => {
  for (const [href, text] of [
    ['https://www.naukri.com/mnjuser/recommendedjobs', 'View All Recommendations'],
    ['https://www.naukri.com/jd/job-listings-no-experience-band-999', 'Some Job'],
    ['https://www.naukri.com/jd/job-listings-only-a-company-0-to-1-years-1', ''],
    ['nonsense', 'Backend Intern'],
  ] as const) {
    assert.equal(parseJobLink(href, text), null, href);
  }
});

test('one email yields each posting once, though it links them three times', () => {
  // A real alert links every job from its title, its logo and an "apply" button, each with
  // different tracking parameters — so href-level dedup is not enough.
  const html = REAL.map(
    (r) =>
      `<a href="${r.href}"><img src="logo.png"></a>` +
      `<a href="${r.href}&amp;from=title">${r.text}</a>` +
      `<a href="${r.href}&amp;from=button">Apply now</a>` +
      `<a href="https://www.ambitionbox.com/reviews/x-reviews">reviews</a>`,
  ).join('');

  const postings = parseNaukriEmail(email(html));
  assert.equal(postings.length, 3, 'three jobs, not nine');
  assert.deepEqual(
    postings.map((p) => p.sourceId),
    REAL.map((r) => r.sourceId),
    'in the order the email lists them',
  );
});

test('non-posting links are ignored', () => {
  const html =
    '<a href="https://www.ambitionbox.com/reviews/acme-reviews">Reviews</a>' +
    '<a href="https://www.facebook.com/Naukri/">Facebook</a>' +
    '<a href="https://www.naukri.com/mnjuser/settings/communication">Unsubscribe</a>' +
    '<a href="https://cm.naukri.com?data=%7B%22widget%22%3A1%7D">Get App</a>';
  assert.deepEqual(parseNaukriEmail(email(html)), []);
});

test('a marketing email from the same sender yields nothing, quietly', () => {
  // Six of the seven Naukri emails in the mailbox are this: "Get up to 4x more profile views".
  const postings = parseNaukriEmail(
    email('<h1>Become a pro at aptitude</h1><a href="https://www.naukri.com/">Naukri</a>'),
  );
  assert.deepEqual(postings, [], 'not an error — just not a job alert');
});

test('a posting becomes a RawJob with no description and the email date', () => {
  const posting = parseJobLink(REAL[1].href, REAL[1].text)!;
  const raw = toRawJob(posting, { name: 'Lakkshions IT', domain: 'lakkshions.com' }, '2026-08-10T10:10:17.000Z');

  assert.equal(raw?.source, 'gmail-alert');
  assert.equal(raw?.source_id, '060826035232');
  assert.equal(raw?.company_domain, 'lakkshions.com');
  assert.equal(raw?.company_name, 'Lakkshions IT', 'the resolved name wins over the slug form');
  // Alerts carry no JD, and fetching one is the scraping decision 004 forbids.
  assert.equal(raw?.description, '');
  assert.equal(raw?.posted_at, '2026-08-10T10:10:17.000Z');
});

test('a posting that cannot make a valid RawJob is rejected, not half-written', () => {
  const posting = parseJobLink(REAL[0].href, REAL[0].text)!;
  // An empty domain fails the schema; the caller counts it and moves on.
  assert.equal(toRawJob(posting, { name: 'Acme', domain: '' }, '2026-08-10T10:10:17.000Z'), null);
});
