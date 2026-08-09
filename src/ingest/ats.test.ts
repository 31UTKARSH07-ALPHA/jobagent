/**
 * Adapter tests run against payloads shaped like the real ones (captured from the live
 * APIs while writing the adapters), so a board changing its field names shows up here
 * rather than as a silently empty ingest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greenhouse, lever, ashby, workable, atsSource } from './ats.ts';
import type { SeedCompany } from './companies.ts';

test('greenhouse: unwraps jobs and decodes entity-escaped html', () => {
  const [post] = greenhouse.parse({
    jobs: [
      {
        id: 5101378008,
        title: 'Software Engineering Intern',
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/5101378008',
        location: { name: 'Bengaluru, India' },
        // greenhouse double-escapes: the field literally contains &lt;p&gt;
        content: '&lt;p&gt;Build &amp;amp; ship things&lt;/p&gt;&lt;li&gt;Python&lt;/li&gt;',
        first_published: '2026-07-01T10:00:00-04:00',
        updated_at: '2026-08-01T10:00:00-04:00',
      },
    ],
  });

  assert.equal(post?.sourceId, '5101378008');
  assert.equal(post?.location, 'Bengaluru, India');
  assert.equal(post?.description, 'Build & ship things\n• Python');
  // first_published wins over updated_at — we want when it appeared, not last edit
  assert.equal(post?.postedAt, '2026-07-01T14:00:00.000Z');
});

test('lever: merges description parts and reads epoch millis', () => {
  const [post] = lever.parse([
    {
      id: '7d9af9b5',
      text: 'Backend Engineer Intern',
      hostedUrl: 'https://jobs.lever.co/acme/7d9af9b5',
      createdAt: 1757916149833,
      workplaceType: 'remote',
      descriptionPlain: 'About the role',
      additionalPlain: 'Requirements',
      categories: { location: 'Bangalore, Karnataka', allLocations: ['Bangalore, Karnataka'] },
    },
  ]);

  assert.equal(post?.title, 'Backend Engineer Intern');
  assert.equal(post?.description, 'About the role\n\nRequirements');
  assert.equal(post?.remote, true);
  // allLocations repeats the primary location — it must not be duplicated
  assert.equal(post?.location, 'Bangalore, Karnataka');
  assert.equal(post?.postedAt, new Date(1757916149833).toISOString());
});

test('ashby: skips unlisted postings and joins secondary locations', () => {
  const posts = ashby.parse({
    jobs: [
      {
        id: 'a1',
        title: 'ML Intern',
        jobUrl: 'https://jobs.ashbyhq.com/acme/a1',
        location: 'Remote',
        secondaryLocations: [{ location: 'India' }],
        publishedAt: '2026-07-15T00:00:00.000Z',
        isRemote: true,
        isListed: true,
        descriptionPlain: 'Train models',
      },
      { id: 'a2', title: 'Hidden Role', jobUrl: 'https://x/a2', isListed: false },
    ],
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.location, 'Remote, India');
  assert.equal(posts[0]?.remote, true);
});

test('workable: builds location from city/state/country', () => {
  const [post] = workable.parse({
    jobs: [
      {
        shortcode: 'F4C096B22E',
        title: 'Graduate Software Engineer',
        url: 'https://apply.workable.com/j/F4C096B22E',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'India',
        telecommuting: false,
        published_on: '2026-02-12',
        description: '<p>Join us</p>',
      },
    ],
  });

  assert.equal(post?.location, 'Bengaluru, Karnataka, India');
  assert.equal(post?.description, 'Join us');
  assert.equal(post?.sourceId, 'F4C096B22E');
});

test('a malformed posting is dropped, not fatal', () => {
  const posts = greenhouse.parse({
    jobs: [
      { id: 'not-a-number', title: 'Broken' },
      {
        id: 1,
        title: 'Intern',
        absolute_url: 'https://x/1',
        location: { name: 'India' },
        content: '',
      },
    ],
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.title, 'Intern');
});

test('unexpected top-level shapes yield nothing instead of throwing', () => {
  assert.deepEqual(greenhouse.parse({ error: 'nope' }), []);
  assert.deepEqual(lever.parse({ ok: false }), []);
  assert.deepEqual(ashby.parse(null), []);
  assert.deepEqual(workable.parse({ name: 'Acme', jobs: null }), []);
});

test('atsSource applies the title and geography filters', async () => {
  const company: SeedCompany = {
    name: 'Acme',
    domain: 'acme.com',
    ats: 'greenhouse',
    slug: 'acme',
    regions: ['india'],
  };

  // Stub the board so the test never touches the network.
  const source = atsSource(
    {
      ats: 'greenhouse',
      url: () => 'https://example.invalid',
      parse: () => [
        {
          sourceId: '1',
          title: 'Software Engineering Intern',
          location: 'Bengaluru, India',
          description: 'x',
          url: 'https://acme.com/1',
          postedAt: null,
          remote: false,
        },
        {
          sourceId: '2',
          title: 'Senior Staff Engineer',
          location: 'Bengaluru, India',
          description: 'x',
          url: 'https://acme.com/2',
          postedAt: null,
          remote: false,
        },
        {
          sourceId: '3',
          title: 'Software Intern',
          location: 'San Francisco, CA',
          description: 'x',
          url: 'https://acme.com/3',
          postedAt: null,
          remote: false,
        },
      ],
    },
    [company],
  );

  // getJson would fetch example.invalid; intercept at the fetch layer instead.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as
    typeof fetch;

  try {
    const counts: Record<string, number> = {};
    const kept = [];
    for await (const job of source.fetch(new Date(0), {
      count: (k, n = 1) => {
        counts[k] = (counts[k] ?? 0) + n;
      },
    })) {
      kept.push(job);
    }

    assert.equal(kept.length, 1, 'only the India-based intern role survives');
    assert.equal(kept[0]?.source_id, '1');
    assert.equal(kept[0]?.company_domain, 'acme.com');
    assert.equal(counts['dropped_title'], 1);
    assert.equal(counts['dropped_geography'], 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
