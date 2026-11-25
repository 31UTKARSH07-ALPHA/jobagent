/**
 * The correction layer, which is the only part of profile extraction that can be tested
 * without a PDF and a model call.
 *
 * What it protects: on 2026-08-27 every quantified claim the pipeline can put in an email was
 * checked against the repository it describes, and two did not survive (decision 034). Those
 * corrections were hand-edited into `data/profile.json` — a generated, gitignored file that
 * `saveProfile` overwrites unconditionally — so the next extraction would have restored the
 * resume's original wording without saying anything, and 8 of 8 drafted emails opened on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Profile, ProfileCorrections, nowIso } from '../store/schema.ts';
import { CORRECTIONS_PATH, applyCorrections, loadCorrections } from './profile.ts';

/** A profile shaped like the extractor's output, with the resume's *uncorrected* wording. */
const asExtracted = (over: Partial<Profile> = {}): Profile =>
  Profile.parse({
    name: 'Utkarsh Pathak',
    email: 'u@example.com',
    phone: '',
    links: [],
    education: [],
    summary: 'Undergraduate building distributed backend systems.',
    skills: [{ category: 'Core Concepts', items: ['Distributed Systems', 'Consistent Hashing'] }],
    domains: ['distributed systems'],
    projects: [
      {
        name: 'Search Typeahead System — Distributed Suggestion Engine',
        summary: 'A distributed typeahead system over Redis Cluster.',
        tech: ['Redis', 'Kafka'],
        highlights: ['Achieved a 5× write reduction via Kafka batch aggregation'],
      },
      {
        name: 'Distributed Cache System — In-Memory Cache in Java',
        summary: 'Implemented a distributed in-memory cache using design patterns.',
        tech: ['Java'],
        highlights: ['Sustained 1M+ ops/sec'],
      },
    ],
    experience: [],
    achievements: [],
    target_roles: ['Distributed Systems Engineer'],
    extracted_at: nowIso(),
    model: 'test-model',
    ...over,
  });

const corrections = (): ProfileCorrections =>
  ProfileCorrections.parse({
    why: 'test',
    projects: [
      {
        match: 'typeahead',
        decision: '034',
        why: 'single-host, and the 5× is unsupported',
        name: 'Search Typeahead System: Suggestion Engine on a Redis Cluster',
        summary: 'Built a read-heavy typeahead system on a 6-node Redis Cluster, single host under Docker.',
        highlights: ['Collapsed repeated queries within a flush window into a single Postgres upsert'],
      },
      {
        match: 'cache',
        decision: '034',
        why: 'no sockets, no RPC — one JVM',
        name: 'Sharded In-Memory Cache in Java',
        summary: 'Sharded an in-memory Java cache across in-JVM partitions.',
        highlights: ['Sustained 1M+ ops/sec in single-JVM benchmarks'],
      },
    ],
    forbidden: [
      { pattern: '\\bdistributed\\b', in: 'projects', decision: '034', why: 'neither project is distributed' },
      { pattern: '\\b5\\s*[x×]', in: 'anywhere', decision: '034', why: 'measured 1.08, not 5' },
    ],
  });

test('the verified wording replaces what the extractor read off the PDF', () => {
  const fixed = applyCorrections(asExtracted(), corrections());

  assert.equal(fixed.projects[0]!.name, 'Search Typeahead System: Suggestion Engine on a Redis Cluster');
  assert.equal(fixed.projects[1]!.name, 'Sharded In-Memory Cache in Java');
  // The 5× claim is gone, and what replaced it is the mechanism with no multiplier.
  assert.match(fixed.projects[0]!.highlights[0]!, /Collapsed repeated queries/);
  assert.doesNotMatch(JSON.stringify(fixed.projects), /5\s*[x×]/);
});

test('"distributed systems" survives where it is honest', () => {
  // The scoping is the load-bearing part. He studies distributed systems and lists it as a
  // skill, a domain and a target role; 034's objection was only to two *projects* claiming it.
  const fixed = applyCorrections(asExtracted(), corrections());

  assert.deepEqual(fixed.domains, ['distributed systems']);
  assert.deepEqual(fixed.target_roles, ['Distributed Systems Engineer']);
  assert.ok(fixed.skills[0]!.items.includes('Distributed Systems'));
  assert.match(fixed.summary, /distributed backend systems/);
});

test('a corrected claim an override does not reach fails the whole extraction', () => {
  // The model paraphrases, so the same claim lands in a different field between runs. Here it
  // reappears in `tech`, which no override rewrites — and writing the profile anyway is how
  // this was lost the first time.
  const leaked = asExtracted();
  leaked.projects[0]!.tech.push('distributed tracing');

  assert.throws(
    () => applyCorrections(leaked, corrections()),
    (err: Error) => {
      assert.match(err.message, /nothing was written/);
      assert.match(err.message, /projects\[0\]\.tech\[2\]/, 'says exactly where');
      assert.match(err.message, /neither project is distributed/, 'and why it is wrong');
      return true;
    },
  );
});

test('an `anywhere` tripwire catches the claim outside the projects too', () => {
  const leaked = asExtracted({ summary: 'Delivered a 5x write reduction across the stack.' });

  assert.throws(() => applyCorrections(leaked, corrections()), /summary/);
});

test('an override that matches nothing is reported rather than ignored', () => {
  // Means the PDF was fixed — retire the correction — or the project was renamed past
  // recognition. Both need a human, and silence would hide either.
  const withoutCache = asExtracted();
  withoutCache.projects = [withoutCache.projects[0]!];

  const said: string[] = [];
  applyCorrections(withoutCache, corrections(), (m) => said.push(m));

  const warning = said.find((m) => m.startsWith('WARNING'));
  assert.ok(warning, `expected a warning, got: ${said.join(' | ')}`);
  assert.match(warning, /"cache" matched no project/);
  assert.match(warning, /retire it/);
});

test('a profile with nothing to correct passes through untouched', () => {
  const clean = asExtracted({
    projects: [
      { name: 'Notebook RAG', summary: 'Hybrid retrieval pipeline.', tech: ['Qdrant'], highlights: ['92% grounded'] },
    ],
  });

  const fixed = applyCorrections(clean, corrections());
  assert.deepEqual(fixed.projects, clean.projects);
});

test('missing corrections refuse the extraction instead of quietly proceeding', () => {
  // Without this, deleting the file reintroduces the original bug and the failure looks
  // exactly like a successful re-extraction.
  assert.throws(() => loadCorrections('does/not/exist.json'), /refusing to extract/);
});

test('the public corrections template is valid and does not contain personal overrides', () => {
  const template = loadCorrections('profile-corrections.example.json');
  assert.deepEqual(template.projects, []);
  assert.deepEqual(template.forbidden, []);
});

test('personal corrections and the profile are excluded from version control', () => {
  // The entire failure in 034 was that the corrections lived only in a gitignored file.
  const ignored = readFileSync('.gitignore', 'utf8');
  assert.match(ignored, new RegExp(CORRECTIONS_PATH.replace('.', '\\.')));
  assert.match(ignored, /data\/\*/, 'while data/profile.json stays out of git — it has a phone number');
});
