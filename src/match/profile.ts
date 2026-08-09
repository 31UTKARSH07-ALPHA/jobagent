/**
 * Resume PDF → typed profile. Runs once, ever.
 *
 *   node src/match/profile.ts --resume=/path/to/resume.pdf
 *   node src/match/profile.ts --show
 *
 * The result is written to `data/profile.json`, which is gitignored — it contains a phone
 * number and an email address. Everything downstream (scoring rubric, email hooks) reads
 * that file rather than the PDF, so the parse happens once and is inspectable afterwards.
 *
 * Re-run it by hand if the extraction looks wrong; there is no automatic re-parse.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extractText, getDocumentProxy } from 'unpdf';
import { complete } from '../llm/groq.ts';
import { modelFor } from '../llm/models.ts';
import { Profile, ProfileExtraction, nowIso } from '../store/schema.ts';

export const PROFILE_PATH = process.env['JOBAGENT_PROFILE'] ?? 'data/profile.json';

const SYSTEM = `You extract structured data from a resume. You are precise and you never invent facts.

Rules:
- Use only what the resume states. If a field is not present, use an empty string or an empty array.
- Keep the quantified results exactly as written — "p95 8ms", "92% grounded-answer rate",
  "460+ problems". These numbers are the most useful thing in the document and become the
  specific detail a cold email opens with. Never round them or paraphrase them away.
- List EVERY institution under education, including concurrent or dual-degree programmes.
- Reproduce the resume's own skill groupings in "skills" — one entry per heading it uses,
  with every item under that heading. Do not drop a group and do not merge groups.
- "domains" are problem areas, not tools: "retrieval-augmented generation", "distributed
  systems", "browser automation" — not "Python", "Redis".
- "target_roles" are the job titles this person should be matched against, inferred from
  what they have actually built. Be specific and realistic for their level.`;

/** PDF → plain text. Layout is discarded; the model only needs the words. */
export async function pdfToText(path: string): Promise<string> {
  const bytes = new Uint8Array(readFileSync(path));
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractProfile(resumePath: string): Promise<Profile> {
  const text = await pdfToText(resumePath);
  if (text.length < 200) {
    throw new Error(
      `only ${text.length} characters of text in ${resumePath} — is it a scanned image? ` +
        'This parser reads text PDFs, not scans.',
    );
  }

  const extracted = await complete(ProfileExtraction, 'profile', {
    job: 'profile',
    system: SYSTEM,
    messages: [{ role: 'user', content: `Resume:\n\n${text}` }],
    maxTokens: 4096,
  });

  return Profile.parse({
    ...extracted,
    extracted_at: nowIso(),
    model: modelFor('profile').id,
  });
}

export function saveProfile(profile: Profile, path: string = PROFILE_PATH): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(profile, null, 2) + '\n');
}

/** Throws with a useful message if the profile has not been extracted yet. */
export function loadProfile(path: string = PROFILE_PATH): Profile {
  try {
    return Profile.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(
      `no usable profile at ${path} — run: node src/match/profile.ts --resume=<path/to/resume.pdf>` +
        ` (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** A short human-readable digest, so a bad parse is obvious at a glance. */
function summarise(p: Profile): string {
  return [
    `${p.name} <${p.email}>  ${p.phone}`,
    '',
    `education (${p.education.length}):`,
    ...p.education.map(
      (e) => `  • ${e.degree || '(degree?)'} — ${e.institution} ${e.dates}${e.score ? `, ${e.score}` : ''}`,
    ),
    '',
    p.summary,
    '',
    ...p.skills.map((g) => `  ${g.category}: ${g.items.join(', ')}`),
    `  domains: ${p.domains.join(', ') || '—'}`,
    `  targets: ${p.target_roles.join(', ') || '—'}`,
    '',
    `projects (${p.projects.length}):`,
    ...p.projects.map((x) => `  • ${x.name} [${x.tech.slice(0, 5).join(', ')}]\n      ${x.highlights[0] ?? x.summary}`),
    `experience (${p.experience.length}):`,
    ...p.experience.map((x) => `  • ${x.role} @ ${x.company} (${x.dates})`),
    `achievements (${p.achievements.length}):`,
    ...p.achievements.map((a) => `  • ${a}`),
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      resume: { type: 'string' },
      out: { type: 'string', default: PROFILE_PATH },
      show: { type: 'boolean', default: false },
    },
  });

  if (values.show) {
    console.log(summarise(loadProfile(values.out)));
    return 0;
  }

  if (values.resume === undefined) {
    console.error('usage: node src/match/profile.ts --resume=<path/to/resume.pdf> [--out=<path>]');
    console.error('       node src/match/profile.ts --show');
    return 2;
  }

  console.log(`reading ${values.resume} …`);
  const profile = await extractProfile(values.resume);
  saveProfile(profile, values.out);

  console.log(`\n${summarise(profile)}\n`);
  console.log(`wrote ${values.out} (parsed by ${profile.model})`);
  console.log('Check the numbers above against the PDF — re-run if anything is wrong.');
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
