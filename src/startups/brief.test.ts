import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOf, inPersonClause, cleanMarkdown, formatBrief, freshUpdate, hnStoriesFor, launchSummary, toIso } from './brief.ts';
import type { StartupRole, StartupUpdate } from '../store/schema.ts';

const NOW = Date.parse('2026-10-05T12:00:00Z');

test('markdown is read as text: links keep their words, video links go', () => {
  assert.equal(
    cleanMarkdown('Our work includes [ITSMBench](https://newmeasure.ai/benchmarks).\n\nhttps://www.youtube.com/watch?v=x\n\n**The Problem**'),
    'Our work includes ITSMBench.\n\nThe Problem',
  );
});

test('a launch is summarised by its tagline and first real paragraph, not its phone numbers', () => {
  const body =
    'Call our AI Agents at [+1872](tel:+1872) to know everything!\n\nhttps://www.youtube.com/watch?v=Lq9\n\n' +
    'In India, phone calls are still how most businesses reach customers, and voice AI built for English fails there.';
  assert.equal(
    launchSummary('Voice AI for India', body),
    'Voice AI for India — In India, phone calls are still how most businesses reach customers, and voice AI built for English fails there.',
  );
});

test('dates in both shapes YC uses', () => {
  assert.equal(toIso('Jan 20, 2026')?.slice(0, 10), '2026-01-20');
  assert.equal(toIso('2025-09-30T05:29:03.741Z'), '2025-09-30T05:29:03.741Z');
  assert.equal(toIso('soon'), null);
});

test('a Hacker News story counts when it links to the site, or announces the company by name', () => {
  const hits = [
    { objectID: '1', title: 'Show HN: Rivet – open-source actors', url: 'https://github.com/rivet-dev/rivet', created_at: '2026-06-01T00:00:00Z' },
    { objectID: '2', title: 'Rivet Actors are now 2x faster', url: 'https://rivet.dev/blog/x', created_at: '2026-08-01T00:00:00Z' },
    // A short name in a title is a thousand things.
    { objectID: '3', title: 'The rivet that held the bridge', url: 'https://example.com/bridge', created_at: '2026-08-02T00:00:00Z' },
  ];
  assert.deepEqual(
    hnStoriesFor(hits, 'Rivet', 'rivet.dev').map((u) => u.url),
    ['https://news.ycombinator.com/item?id=1', 'https://news.ycombinator.com/item?id=2'],
  );
});

const update = (published_at: string | null, title = 'Something'): StartupUpdate => ({
  id: 1,
  startup_id: 1,
  kind: 'launch',
  title,
  summary: '',
  url: 'https://www.ycombinator.com/launches/x',
  published_at,
  created_at: '2026-10-05T00:00:00.000Z',
});

test('only a recent update is offered to the email; an old one is shown but flagged', () => {
  const old = [update('2023-03-13T20:31:18.735Z', 'Heroku for multiplayer games')];
  assert.equal(freshUpdate(old, NOW), null);
  assert.equal(freshUpdate([update('2026-08-01T00:00:00.000Z')], NOW)?.title, 'Something');

  const text = formatBrief({ name: 'Rivet', one_liner: 'Stateful workloads', source_url: 'https://y/c', role: null, updates: old, now: NOW });
  assert.match(text, /2023-03-13 {2}\(3\.6 years ago, YC launch\) {2}Heroku for multiplayer games/);
  assert.match(text, /Nothing in the last 6 months/);
  assert.match(text, /open application/);
});

test('the brief leads with the role in full', () => {
  const role: StartupRole = {
    id: 1,
    startup_id: 1,
    source_id: '1',
    title: 'Software Engineering Intern',
    location: 'Bengaluru, KA, IN',
    job_type: 'Internship',
    min_experience: '',
    salary: '₹25K - ₹75K INR / monthly',
    url: 'https://www.ycombinator.com/companies/ressl-ai/jobs/1',
    first_seen_at: '2026-10-05T00:00:00.000Z',
    last_seen_at: '2026-10-05T00:00:00.000Z',
    description: 'Build benchmarks for AI agents.',
    interview_process: 'Stage 1: Profile review',
    hiring_manager: 'Abhishek E',
    detail_fetched_at: '2026-10-05T00:00:00.000Z',
    notified_at: null,
  };
  const text = formatBrief({ name: 'Ressl AI', one_liner: 'Agents', source_url: 'https://y/c', role, updates: [], now: NOW });
  assert.ok(text.indexOf('THE ROLE') < text.indexOf('WHAT THEY ARE WORKING ON'));
  assert.match(text, /Build benchmarks for AI agents\./);
  assert.match(text, /Hiring manager on YC: Abhishek E/);
  assert.match(text, /Stage 1: Profile review/);
  assert.match(text, /Nothing dated found/);
});

test('ages read the way a person would say them', () => {
  assert.equal(ageOf('2026-10-03T12:00:00Z', NOW), '2 days ago');
  assert.equal(ageOf('2026-04-05T12:00:00Z', NOW), '6 months ago');
  assert.equal(ageOf(null, NOW), 'undated');
});

test('a remote listing whose description asks for office days is caught', () => {
  assert.equal(
    inPersonClause('You will wear many hats. You’ll work in person with the founders at least 3 days a week, white boarding.'),
    'You’ll work in person with the founders at least 3 days a week, white boarding.',
  );
  assert.equal(inPersonClause('We are a remote-first team across four time zones.'), null);
});
