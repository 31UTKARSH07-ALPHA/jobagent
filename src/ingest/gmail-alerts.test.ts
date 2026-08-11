/**
 * No network. Gmail is a stub returning canned messages, so what is under test is the source
 * contract: the cheap filters, company resolution, and the promise that one bad email never
 * costs the mailbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { gmail_v1 } from '@googleapis/gmail';
import { openDb } from '../store/db.ts';
import { upsertCompany } from '../store/companies.ts';
import { isUnknownDomain } from './resolve-company.ts';
import { gmailAlertSource } from './gmail-alerts.ts';
import type { RawJob } from './types.ts';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** A Naukri alert whose HTML links `count` postings. */
function naukriMessage(
  jobs: { slug: string; title: string }[],
  from = 'Naukri Campus Jobs <recommendationnc@naukri.com>',
): gmail_v1.Schema$Message {
  const html = jobs
    .map(
      (j) =>
        `<a href="https://www.naukri.com/jd/job-listings-${j.slug}?utm_source=joblink">${j.title}</a>`,
    )
    .join('');

  return {
    id: `msg-${jobs.map((j) => j.slug).join('_').slice(0, 20)}`,
    threadId: 't1',
    internalDate: '1786443017000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'Urgently hiring for Intern' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Job recommendations') } },
        { mimeType: 'text/html', body: { data: b64(html) } },
      ],
    },
  };
}

/** The two Gmail endpoints `searchEmails` uses, and nothing else. */
function fakeGmail(messages: gmail_v1.Schema$Message[], opts: { failOn?: string } = {}): gmail_v1.Gmail {
  return {
    users: {
      messages: {
        list: async () => ({ data: { messages: messages.map((m) => ({ id: m.id })) } }),
        get: async ({ id }: { id: string }) => {
          if (id === opts.failOn) throw new Error('Gmail said 500');
          return { data: messages.find((m) => m.id === id) };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

async function collect(
  gmail: gmail_v1.Gmail,
  db: ReturnType<typeof openDb>,
): Promise<{ jobs: RawJob[]; counts: Record<string, number>; errors: string[] }> {
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  const jobs: RawJob[] = [];

  const source = gmailAlertSource({ db, gmail });
  for await (const raw of source.fetch(new Date('2026-07-01T00:00:00Z'), {
    count: (k, n = 1) => {
      counts[k] = (counts[k] ?? 0) + n;
    },
    onError: (m) => errors.push(m),
  })) {
    jobs.push(raw);
  }

  return { jobs, counts, errors };
}

test('a Naukri alert becomes RawJobs', async () => {
  const db = openDb(':memory:');
  const gmail = fakeGmail([
    naukriMessage([
      { slug: 'backend-developer-intern-acme-labs-bengaluru-0-to-1-years-111', title: 'Backend Developer Intern' },
      { slug: 'ml-engineer-intern-beta-corp-pune-0-to-2-years-222', title: 'ML Engineer Intern' },
    ]),
  ]);

  const { jobs, counts } = await collect(gmail, db);

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.source, 'gmail-alert');
  assert.equal(jobs[0]?.title, 'Backend Developer Intern');
  assert.equal(jobs[0]?.location, 'Bengaluru');
  assert.equal(jobs[0]?.posted_at, new Date(1786443017000).toISOString(), 'the email date');
  assert.equal(counts['alert_naukri'], 1);
  assert.equal(counts['seen'], 2);
  db.close();
});

test('a known company resolves to its real domain; an unknown one is marked, not guessed', async () => {
  const db = openDb(':memory:');
  upsertCompany(db, { name: 'Zomato', domain: 'zomato.com' });

  const gmail = fakeGmail([
    naukriMessage([
      { slug: 'software-engineer-intern-zomato-gurugram-0-to-1-years-1', title: 'Software Engineer Intern' },
      { slug: 'backend-intern-nobody-has-heard-of-this-one-pune-0-to-1-years-2', title: 'Backend Intern' },
    ]),
  ]);

  const { jobs, counts } = await collect(gmail, db);

  assert.equal(jobs[0]?.company_domain, 'zomato.com');
  assert.equal(isUnknownDomain(jobs[1]?.company_domain ?? ''), true);
  assert.match(jobs[1]?.company_domain ?? '', /\.invalid$/, 'cannot resolve, cannot be emailed');
  assert.equal(counts['company_unresolved'], 1);
  db.close();
});

test('the cheap filters apply to alerts exactly as they do to boards', async () => {
  const db = openDb(':memory:');
  const gmail = fakeGmail([
    naukriMessage([
      { slug: 'senior-staff-engineer-acme-bengaluru-8-to-12-years-1', title: 'Senior Staff Engineer' },
      { slug: 'sales-development-intern-acme-bengaluru-0-to-1-years-2', title: 'Sales Development Intern' },
      { slug: 'software-engineer-intern-acme-0-to-1-years-3', title: 'Software Engineer Intern' },
    ]),
  ]);

  const { jobs, counts } = await collect(gmail, db);

  assert.equal(counts['seen'], 3);
  assert.equal(counts['dropped_title'], 2, 'the senior role and the sales role');
  assert.deepEqual(
    jobs.map((j) => j.title),
    ['Software Engineer Intern'],
  );
  db.close();
});

test('a sender with no parser is counted and reported, never silently dropped', async () => {
  // This is the signal that it is time to write the LinkedIn parser: the mail is arriving.
  const db = openDb(':memory:');
  const gmail = fakeGmail([
    naukriMessage([{ slug: 'x', title: 'y' }], 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>'),
  ]);

  const { jobs, counts, errors } = await collect(gmail, db);

  assert.deepEqual(jobs, []);
  assert.equal(counts['alert_unparsed'], 1);
  assert.match(errors.join(), /no parser for jobalerts-noreply@linkedin\.com/);
  db.close();
});

test('marketing mail from a known sender is counted, not treated as breakage', async () => {
  const db = openDb(':memory:');
  const gmail = fakeGmail([naukriMessage([])]);

  const { jobs, counts, errors } = await collect(gmail, db);

  assert.deepEqual(jobs, []);
  assert.equal(counts['alert_no_postings'], 1);
  assert.deepEqual(errors, [], 'a promo email is not an error');
  db.close();
});

test('one unreadable email does not cost the rest of the mailbox', async () => {
  const db = openDb(':memory:');
  const good = naukriMessage([
    { slug: 'software-engineer-intern-acme-bengaluru-0-to-1-years-9', title: 'Software Engineer Intern' },
  ]);
  const bad = naukriMessage([{ slug: 'data-intern-beta-pune-0-to-1-years-8', title: 'Data Intern' }]);

  const gmail = fakeGmail([bad, good], { failOn: bad.id! });
  const { jobs, errors } = await collect(gmail, db);

  assert.equal(jobs.length, 1, 'the readable one still arrived');
  assert.equal(jobs[0]?.title, 'Software Engineer Intern');
  assert.match(errors.join(), /unreadable/);
  db.close();
});
