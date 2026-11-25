import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Startup } from '../store/schema.ts';
import type { Fit } from './fit.ts';
import { folderOf, layoutBriefs, type LayoutEntry } from './layout.ts';

const fit = (over: Partial<Fit> = {}): Fit => ({ rank: 90, best: { index: 0, level: 'intern', reach: 'bengaluru', lakh: 9 }, reach: 'bengaluru', ai: true, why: 'w', ...over });

test('a startup is filed by what he would do about it, then where he would work', () => {
  assert.equal(folderOf({ fit: fit(), emailed: false }), join('1-internships', 'bengaluru'));
  assert.equal(
    folderOf({ fit: fit({ best: { index: 0, level: 'new_grad', reach: 'remote', lakh: 50 }, reach: 'remote' }), emailed: false }),
    join('2-new-grad-roles', 'remote-abroad'),
  );
  assert.equal(folderOf({ fit: fit({ best: null, reach: 'india' }), emailed: false }), join('3-open-applications', 'india-other'));
  // Once emailed, it leaves the to-do folders whatever it is.
  assert.equal(folderOf({ fit: fit(), emailed: true }), '4-emailed');
});

const startup = (id: number, slug: string): Startup => ({
  id, source: 'yc', source_id: slug, name: slug.toUpperCase(), website: null, domain: null, location: '', batch: '',
  team_size: null, one_liner: '', description: '', tags: [], github_url: null, source_url: 'https://y.c/x',
  details_fetched_at: null, contacts_checked_at: null, updates_fetched_at: null, demo_url: null,
  first_seen_at: '2026-10-06T00:00:00.000Z', last_seen_at: '2026-10-06T00:00:00.000Z',
});
const entry = (id: number, slug: string, over: Partial<LayoutEntry> = {}): LayoutEntry => ({
  startup: startup(id, slug), fit: fit(), roleTitle: 'Intern', email: null, hasIdeas: false, emailed: false, text: `brief ${slug}`, ...over,
});

test('files are numbered best first, a moved startup leaves its old folder, and notes are never touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'layout-'));
  mkdirSync(join(dir, 'my-notes'), { recursive: true });
  writeFileSync(join(dir, 'my-notes', 'ressl.md'), 'my own notes');
  // A flat file from the first version, and a stranger it does not recognise.
  writeFileSync(join(dir, 'ressl.md'), 'old flat brief');
  writeFileSync(join(dir, 'todo.txt'), 'his');

  layoutBriefs(dir, [entry(1, 'ressl'), entry(2, 'kalam')], '2026-10-06T00:00:00.000Z');
  assert.deepEqual(readdirSync(join(dir, '1-internships', 'bengaluru')), ['01-ressl.md', '02-kalam.md']);
  assert.equal(existsSync(join(dir, 'ressl.md')), false);

  const { files } = layoutBriefs(dir, [entry(1, 'ressl', { emailed: true }), entry(2, 'kalam')], '2026-10-06T00:00:00.000Z');
  assert.deepEqual(readdirSync(join(dir, '1-internships', 'bengaluru')), ['01-kalam.md']);
  assert.deepEqual(readdirSync(join(dir, '4-emailed')), ['01-ressl.md']);
  assert.match(files.get(1) ?? '', /4-emailed\/01-ressl\.md$/);

  assert.equal(readFileSync(join(dir, 'my-notes', 'ressl.md'), 'utf8'), 'my own notes');
  assert.equal(readFileSync(join(dir, 'todo.txt'), 'utf8'), 'his');
  const index = readFileSync(join(dir, '_index.md'), 'utf8');
  assert.match(index, /## Internships listed — 1/);
  assert.match(index, /## Already emailed \(drafted or sent\) — 1/);
});
