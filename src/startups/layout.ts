/**
 * How `briefs/` is laid out: by what he would do about a startup, then by where he would work.
 * Decision 060.
 *
 *     briefs/
 *       _index.md                  every startup, grouped like the folders
 *       1-internships/<where>/     an internship is listed
 *       2-new-grad-roles/<where>/  a junior full-time role ("new grads ok")
 *       3-open-applications/<where>/  hiring, nothing junior listed (India only)
 *       4-emailed/                 a draft exists; out of the to-do folders
 *       my-notes/                  his; never touched
 *
 * `<where>` is `bengaluru`, `india-other` or `remote-abroad`. Files are numbered best first
 * inside each folder, so Finder's name order is the ranking.
 *
 * His ask, 2026-10-06: one flat folder of 49 files was too hard to use. The whole tree is
 * regenerated every run, so a startup moves by itself when its state changes. That is why the
 * generated folders are wiped first, and why his own notes live in a folder that never is.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Startup } from '../store/schema.ts';
import type { Fit } from './fit.ts';

export const CATEGORIES = {
  internships: '1-internships',
  newGrad: '2-new-grad-roles',
  open: '3-open-applications',
  emailed: '4-emailed',
} as const;
export const NOTES_DIR = 'my-notes';

const WHERE = { bengaluru: 'bengaluru', india: 'india-other', remote: 'remote-abroad' } as const;

const HEADINGS: Record<string, string> = {
  [CATEGORIES.internships]: 'Internships listed',
  [CATEGORIES.newGrad]: 'New-grad roles (junior full-time, "new grads ok")',
  [CATEGORIES.open]: 'Open applications (hiring, nothing junior listed)',
  [CATEGORIES.emailed]: 'Already emailed (drafted or sent)',
};

export type LayoutEntry = {
  startup: Startup;
  fit: Fit;
  roleTitle: string | null;
  /** "published, high", or null when no address was found. */
  email: string | null;
  hasIdeas: boolean;
  emailed: boolean;
  text: string;
};

/** The folder a startup belongs in. Pure, so the rules can be tested without a disk. */
export function folderOf(entry: Pick<LayoutEntry, 'fit' | 'emailed'>): string {
  if (entry.emailed) return CATEGORIES.emailed;
  const category =
    entry.fit.best === null ? CATEGORIES.open : entry.fit.best.level === 'intern' ? CATEGORIES.internships : CATEGORIES.newGrad;
  return join(category, WHERE[entry.fit.reach]);
}

export const slugOf = (startup: Startup): string => startup.source_id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

/**
 * Write every brief into its folder and the index. Returns where each landed.
 *
 * Wipes only what it generates: the four category folders, and old flat `<slug>.md` files
 * left at the top level by the first version. Never `my-notes/`, never a file it does not
 * recognise.
 */
export function layoutBriefs(
  dir: string,
  entries: readonly LayoutEntry[],
  updatedAt: string,
): { index: string; files: Map<number, string> } {
  mkdirSync(join(dir, NOTES_DIR), { recursive: true });
  for (const category of Object.values(CATEGORIES)) rmSync(join(dir, category), { recursive: true, force: true });
  const known = new Set(entries.map((e) => `${slugOf(e.startup)}.md`));
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) if (known.has(name)) rmSync(join(dir, name));
  }

  // Best first within each folder; the shortlist already arrives in rank order.
  const byFolder = new Map<string, LayoutEntry[]>();
  for (const entry of entries) byFolder.set(folderOf(entry), [...(byFolder.get(folderOf(entry)) ?? []), entry]);

  const paths = new Map<LayoutEntry, string>();
  for (const [folder, list] of byFolder) {
    mkdirSync(join(dir, folder), { recursive: true });
    const width = String(list.length).length < 2 ? 2 : String(list.length).length;
    list.forEach((entry, i) => {
      const file = join(folder, `${String(i + 1).padStart(width, '0')}-${slugOf(entry.startup)}.md`);
      writeFileSync(join(dir, file), `# ${entry.startup.name}\n\n${entry.text}\n`);
      paths.set(entry, file);
    });
  }

  const sections: string[] = [];
  for (const category of Object.values(CATEGORIES)) {
    const inCategory = [...byFolder.entries()].filter(([folder]) => folder.startsWith(category));
    const count = inCategory.reduce((n, [, list]) => n + list.length, 0);
    if (count === 0) continue;
    sections.push(`## ${HEADINGS[category]} — ${count}`, '');
    for (const [folder, list] of inCategory.sort(([a], [b]) => a.localeCompare(b))) {
      const where = folder.slice(category.length + 1);
      if (where !== '') sections.push(`### ${where.replace('-', ' ')} (${list.length})`, '');
      sections.push('| Rank | Startup | Role | Why | Email | Ideas |', '|---|---|---|---|---|---|');
      for (const e of list) {
        const link = `./${paths.get(e)!.split('\\').join('/')}`;
        sections.push(
          `| ${e.fit.rank} | [${e.startup.name}](${link}) | ${e.roleTitle ?? '—'} | ${e.fit.why} | ${e.email ?? 'none found'} | ${e.hasIdeas ? '✓' : ''} |`,
        );
      }
      sections.push('');
    }
  }

  const index = join(dir, '_index.md');
  writeFileSync(
    index,
    [
      '# Startup briefs',
      '',
      `${entries.length} startups, updated ${updatedAt.slice(0, 16).replace('T', ' ')} UTC. Each name opens its brief.`,
      'Folders are regenerated every run, so edits to a brief are overwritten. Keep your own notes in `my-notes/`.',
      'Demo ideas (✓) are added 3 per run, best first; `node src/startups/index.ts --ideas=<name>` gets one now.',
      '',
      ...sections,
    ].join('\n'),
  );
  return {
    index: resolve(index),
    files: new Map([...paths].map(([entry, file]) => [entry.startup.id, resolve(dir, file)])),
  };
}
