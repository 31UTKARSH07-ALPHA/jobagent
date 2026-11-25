import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../store/db.ts';
import type { Profile } from '../store/schema.ts';
import { discover, ideasFor, setDemo, shortlist, writeAllBriefs } from './index.ts';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problemsWithIdeas } from './ideas.ts';
import { isEarly, salaryText, toStartups, type ConsiderJob } from './peakxv.ts';
import { startupForPrompt } from './draft.ts';

const idea = (n: number) =>
  `IDEA ${n}: Eval harness\nWhat: A thing.\nWhy they would care: Because.\nUses: Notebook RAG.\nIn one day: a → b → c\nShow it as: a public repo\n`;

test('ideas must be exactly three, each with every line', () => {
  assert.deepEqual(problemsWithIdeas([1, 2, 3].map(idea).join('\n')), []);
  assert.match(problemsWithIdeas([1, 2].map(idea).join('\n')).join(), /returned 2 ideas/);
  assert.match(problemsWithIdeas([1, 2, 3].map(idea).join('\n').replace('Uses: Notebook RAG.\n', '')).join(), /has no "Uses:"/);
  // A PR needs a repo we know is public.
  const withPr = [1, 2, 3].map(idea).join('\n').replace('Show it as: a public repo\n', 'Show it as: a pull request link\n');
  assert.match(problemsWithIdeas(withPr, null).join(), /no public repository/);
  assert.deepEqual(problemsWithIdeas(withPr, 'https://github.com/rivet-dev'), []);
});

const noNetwork = { fetchJobPage: async () => null, fetchHnStories: async () => [] };

async function oneStartup() {
  const db = openDb(':memory:');
  await discover(db, () => {}, {}, {
    fetchIndex: async () => [
      {
        name: 'Ressl AI', slug: 'ressl-ai', website: 'https://fictional.example', all_locations: 'Bengaluru, KA, India',
        long_description: '', one_liner: 'Agents', team_size: 3, tags: [], industries: [], regions: ['India'],
        batch: 'Winter 2026', status: 'Active', stage: 'Early', isHiring: true, url: 'https://www.ycombinator.com/companies/ressl-ai',
      },
    ],
    fetchCompanyPage: async () => ({ company: { github_url: null, founders: [] }, launches: [], newsItems: [], jobPostings: [] }),
    fetchPeakXvJobs: async () => [],
  });
  return db;
}

test('ideas cost one call, are kept, and are replaced only when asked', async () => {
  const db = await oneStartup();
  const [item] = shortlist(db);
  assert.ok(item !== undefined);
  let calls = 0;
  const writer = { model: 'fake', write: async () => (calls++, [1, 2, 3].map(idea).join('\n')) };
  const deps = { writer, profile: { name: 'U' } as Profile, brief: noNetwork };

  const text = await ideasFor(db, item, () => {}, {}, deps);
  await ideasFor(db, shortlist(db)[0]!, () => {}, {}, deps);
  assert.equal(calls, 1);
  assert.match(text, /DEMO IDEAS \(written/);
  assert.match(text, /IDEA 3: Eval harness/);

  await ideasFor(db, shortlist(db)[0]!, () => {}, { regenerate: true }, deps);
  assert.equal(calls, 2);
});

test('a recorded demo reaches the email prompt with an instruction to link it', async () => {
  const db = await oneStartup();
  const id = shortlist(db)[0]!.startup.id;
  setDemo(db, id, 'https://github.com/u/ressl-eval');
  const prompt = startupForPrompt(shortlist(db)[0]!.startup, null, 'in Bengaluru');
  assert.match(prompt, /built a small demo specifically for this startup: https:\/\/github\.com\/u\/ressl-eval/);
});

const job = (over: Partial<ConsiderJob> = {}): ConsiderJob => ({
  jobId: '1',
  title: 'Software Engineering Intern',
  url: 'https://last9.io/careers/1',
  companyName: 'Last9',
  companySlug: 'last9',
  companyDomain: 'last9.io',
  companyStaffCount: 39,
  locations: ['Bengaluru, Karnataka, India'],
  remote: false,
  minYearsExp: 0,
  stages: [{ label: 'Series A' }],
  markets: [{ label: 'Observability' }],
  salary: null,
  ...over,
});

test('Peak XV: early is decided by size, because the stage labels are stale', () => {
  assert.equal(isEarly(job()), true);
  // apna, 2026-10-05: tagged Seed, 1,607 people.
  assert.equal(isEarly(job({ companyStaffCount: 1607, stages: [{ label: 'Seed' }] })), false);
  assert.equal(isEarly(job({ companyStaffCount: 120, stages: [{ label: 'Series A' }] })), true);
  assert.equal(isEarly(job({ companyStaffCount: 120, stages: [{ label: 'Growth' }] })), false);
  assert.equal(isEarly(job({ companyStaffCount: null })), false);
});

test('Peak XV: jobs become one startup per company, with roles the fit rules can read', () => {
  const [one, ...rest] = toStartups([job(), job({ jobId: '2', title: 'SDE 1' }), job({ companySlug: 'big', companyStaffCount: 900 })]);
  assert.equal(rest.length, 0);
  assert.equal(one?.startup.source, 'peakxv');
  assert.equal(one?.startup.website, 'https://last9.io');
  assert.equal(one?.page.jobPostings.length, 2);
  assert.equal(one?.page.jobPostings[0]?.type, 'Internship');
  assert.equal(one?.page.jobPostings[0]?.minExperience, '0+ years');
});

test('Peak XV salary objects become text parseSalary reads', () => {
  assert.equal(
    salaryText({ minValue: 0, maxValue: 20000, currency: { label: 'USD' }, period: { label: 'Year' } }),
    '$0K - $20K USD / year',
  );
  assert.equal(salaryText({ minValue: 20000, maxValue: 40000, currency: { label: 'INR' }, period: { label: 'Month' } }), '₹20K - ₹40K INR / monthly');
  assert.equal(salaryText(null), '');
});

test('every shortlisted startup gets a brief file, and ideas stop at the per-run cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefs-'));
  process.env['JOBAGENT_BRIEFS'] = dir;
  try {
    const db = await oneStartup();
    let calls = 0;
    const writer = { model: 'fake', write: async () => (calls++, [1, 2, 3].map(idea).join('\n')) };
    const deps = { writer, profile: { name: 'U' } as Profile, brief: noNetwork };

    const none = await writeAllBriefs(db, () => {}, { ideas: 0 }, deps);
    assert.equal(none.briefs, 1);
    assert.equal(calls, 0);
    assert.deepEqual(readdirSync(join(dir, '3-open-applications', 'bengaluru')), ['01-ressl-ai.md']);
    assert.match(
      readFileSync(join(dir, '_index.md'), 'utf8'),
      /\| \d+ \| \[Ressl AI\]\(\.\/3-open-applications\/bengaluru\/01-ressl-ai\.md\) \| — \|/,
    );

    const some = await writeAllBriefs(db, () => {}, {}, deps);
    assert.equal(some.ideas, 1);
    assert.match(readFileSync(join(dir, '3-open-applications', 'bengaluru', '01-ressl-ai.md'), 'utf8'), /IDEA 1: Eval harness/);
  } finally {
    delete process.env['JOBAGENT_BRIEFS'];
  }
});

test('a Groq failure costs the ideas, never the brief', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefs-'));
  process.env['JOBAGENT_BRIEFS'] = dir;
  try {
    const db = await oneStartup();
    const writer = { model: 'fake', write: async (): Promise<string> => { throw new Error('groq 429'); } };
    const result = await writeAllBriefs(db, () => {}, {}, { writer, profile: { name: 'U' } as Profile, brief: noNetwork });
    assert.equal(result.briefs, 1);
    assert.equal(result.ideas, 0);
    assert.match(readFileSync(join(dir, '3-open-applications', 'bengaluru', '01-ressl-ai.md'), 'utf8'), /None yet/);
  } finally {
    delete process.env['JOBAGENT_BRIEFS'];
  }
});
