import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressFor,
  findFounderContacts,
  githubOrg,
  inferPattern,
  isRelatedDomain,
  nameParts,
  patternOf,
  rankCandidates,
  rankPeople,
} from './people.ts';

test('names become address parts', () => {
  assert.deepEqual(nameParts('Jordan Cole'), { first: 'jordan', last: 'cole' });
  assert.deepEqual(nameParts('Sébastien O’Brien'), { first: 'sebastien', last: 'obrien' });
  assert.deepEqual(nameParts('Varun AV'), { first: 'varun', last: 'av' });
  assert.deepEqual(nameParts('Riley'), { first: 'riley', last: '' });
  assert.equal(nameParts('  '), null);
});

test('a local part is matched to the pattern that produced it', () => {
  assert.equal(patternOf('jordan', 'Jordan Cole'), 'first');
  assert.equal(patternOf('jordan.cole', 'Jordan Cole'), 'first.last');
  assert.equal(patternOf('jcole', 'Jordan Cole'), 'flast');
  assert.equal(patternOf('hello', 'Jordan Cole'), null);
  assert.equal(addressFor('Riley Morgan', 'first.last', 'sample.dev'), 'riley.morgan@sample.dev');
  // A pattern that needs a surname cannot be built from one name.
  assert.equal(addressFor('Riley', 'first.last', 'sample.dev'), null);
});

test('a company can mail from a domain that is not its website', () => {
  assert.equal(isRelatedDomain('sample.dev', 'sample.ai'), true);
  assert.equal(isRelatedDomain('mail.acme.com', 'acme.com'), true);
  assert.equal(isRelatedDomain('gmail.com', 'sample.ai'), false);
  // Too short a stem to mean anything.
  assert.equal(isRelatedDomain('ai.dev', 'ai.com'), false);
});

test('the pattern comes from the company domain, never from personal mail', () => {
  // The shape of Bolna's commits on 2026-10-05: company addresses on sample.dev, the rest Gmail.
  const authors = [
    { name: 'Alex Lane', email: 'alex.lane@sample.dev' },
    { name: 'Casey Reed', email: 'casey.reed@sample.dev' },
    { name: 'Sam Park', email: 'sam@example.net' },
    { name: 'taylor-code', email: 'taylor@sample.dev' },
  ];
  assert.deepEqual(inferPattern(authors, 'sample.ai'), { pattern: 'first.last', domain: 'sample.dev', seen: 2 });
  assert.equal(inferPattern([{ name: 'Sam Park', email: 'sam@example.net' }], 'sample.ai'), null);
});

test('the technical founder is written to first', () => {
  const ranked = rankPeople([
    { name: 'Jordan Cole', title: 'Founder/CEO' },
    { name: 'Riley Morgan', title: 'Founder/CTO' },
  ]);
  assert.equal(ranked[0]?.name, 'Riley Morgan');
});

test('GitHub org from a profile link', () => {
  assert.equal(githubOrg('https://github.com/bolna-ai/bolna'), 'bolna-ai');
  assert.equal(githubOrg('https://github.com/hud-evals'), 'hud-evals');
  assert.equal(githubOrg('https://gitlab.com/acme'), null);
  assert.equal(githubOrg(null), null);
  // What YC stores for most companies. Treating it as an org spent the whole budget once.
  assert.equal(githubOrg(''), null);
});

const people = [
  { name: 'Riley Morgan', title: 'Founder/CTO' },
  { name: 'Jordan Cole', title: 'Founder/CEO' },
];

test('a founder’s published address beats everything, and a front door beats a bare guess', () => {
  const ranked = rankCandidates({
    name: 'Bolna',
    domain: 'sample.ai',
    people,
    published: [
      { email: 'hello@sample.ai', found_at: 'https://sample.ai/contact' },
      { email: 'jordan@sample.ai', found_at: 'https://sample.ai/about' },
    ],
    authors: [],
  });
  assert.deepEqual(
    ranked.map((c) => [c.email, c.source, c.confidence, c.name]),
    [
      ['jordan@sample.ai', 'published', 'high', 'Jordan Cole'],
      ['hello@sample.ai', 'published', 'high', null],
      ['riley@sample.ai', 'guess', 'low', 'Riley Morgan'],
    ],
  );
});

test('a guess built from the company’s own commit pattern outranks the front door', () => {
  const ranked = rankCandidates({
    name: 'Bolna',
    domain: 'sample.ai',
    people,
    published: [{ email: 'hello@sample.ai', found_at: 'site' }],
    authors: [
      { name: 'Alex Lane', email: 'alex.lane@sample.dev' },
      { name: 'Riley Morgan', email: 'riley.m@example.net' },
    ],
  });
  assert.deepEqual(
    ranked.map((c) => [c.email, c.source]),
    [
      // The CTO's own commits — his real address, even at Gmail.
      ['riley.m@example.net', 'github'],
      ['riley.morgan@sample.dev', 'guess'],
      ['hello@sample.ai', 'published'],
      ['riley@sample.ai', 'guess'],
    ],
  );
  assert.ok(ranked.filter((c) => c.source === 'guess').every((c) => c.confidence === 'low'));
});

test('a domain that takes no mail is never stored, and a dead address is never offered', async () => {
  const found = await findFounderContacts(
    { name: 'Bolna', domain: 'sample.ai', github_url: null },
    people,
    { allowGithub: false, exclude: ['riley@sample.ai'] },
    {
      findContacts: async () => [
        { email: 'hello@sample.ai', name: null, title: null, source: 'team_page', rank: 1, found_at: 'site' },
        { email: 'customers@sample.ai', name: null, title: null, source: 'team_page', rank: 1, found_at: 'site' },
        { email: 'careers@sample.ai', name: null, title: null, source: 'pattern', rank: 1, found_at: 'pattern' },
      ],
      hasMx: async (domain) => domain === 'sample.ai',
    },
  );
  // The cascade's own pattern guesses are not used, a customer desk is not a founder, and the
  // dead guess is gone.
  assert.deepEqual(found.map((c) => c.email), ['hello@sample.ai']);
});
