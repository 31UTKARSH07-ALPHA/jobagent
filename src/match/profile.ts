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
 *
 * **Re-extraction used to silently undo hand-verified corrections.** `data/profile.json` is
 * gitignored (it holds a phone number), `saveProfile` overwrites it unconditionally, and the
 * PDF still contains the claims decision 034 disproved — so the corrections lived nowhere
 * durable and came back wrong on the next run, including a "5×" figure his own `CHANGES.md`
 * measured at 1.08. `profile-corrections.json` is now the committed source of truth for those,
 * applied inside `extractProfile` and enforced by tripwires that fail the extraction rather
 * than write an overstated claim. Decision 053.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extractText, getDocumentProxy } from 'unpdf';
import { complete } from '../llm/groq.ts';
import { modelFor } from '../llm/models.ts';
import { Profile, ProfileCorrections, ProfileExtraction, nowIso } from '../store/schema.ts';

export const PROFILE_PATH = process.env['JOBAGENT_PROFILE'] ?? 'data/profile.json';

/**
 * Verified corrections to what the PDF claims. **Committed, unlike the profile itself.**
 *
 * `data/profile.json` is gitignored because it holds a phone number and an email, and that is
 * exactly how decision 034's corrections were lost: they lived only in the generated file, and
 * `saveProfile` overwrites it unconditionally. Anyone re-running the extractor silently got the
 * resume's original wording back, including a "5×" figure his own `CHANGES.md` measured at 1.08
 * (decision 053).
 */
export const CORRECTIONS_PATH = process.env['JOBAGENT_CORRECTIONS'] ?? 'profile-corrections.json';

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

/**
 * Load the verified corrections.
 *
 * A missing file is **fatal for an extraction**, never a warning. Silently proceeding without
 * it reintroduces the exact bug this exists to prevent — and the failure would look like a
 * successful re-extraction, which is the shape of every expensive mistake in this project.
 */
export function loadCorrections(path: string = CORRECTIONS_PATH): ProfileCorrections {
  try {
    return ProfileCorrections.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(
      `cannot read the verified corrections at ${path}, so refusing to extract: without them ` +
        'the resume\'s uncorrected claims go straight into every email (decisions 034, 053). ' +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Every string in a profile that could carry a claim, with a label for the error message. */
function claimFields(p: Profile): { where: string; text: string }[] {
  return [
    { where: 'summary', text: p.summary },
    ...p.domains.map((d, i) => ({ where: `domains[${i}]`, text: d })),
    ...p.target_roles.map((r, i) => ({ where: `target_roles[${i}]`, text: r })),
    ...p.skills.flatMap((g, i) => g.items.map((it, j) => ({ where: `skills[${i}].items[${j}]`, text: it }))),
    ...p.achievements.map((a, i) => ({ where: `achievements[${i}]`, text: a })),
    ...p.experience.flatMap((x, i) => [{ where: `experience[${i}].summary`, text: x.summary }]),
    ...projectFields(p),
  ];
}

/** The project-scoped subset, which is what the `distributed` tripwire is aimed at. */
function projectFields(p: Profile): { where: string; text: string }[] {
  return p.projects.flatMap((x, i) => [
    { where: `projects[${i}].name`, text: x.name },
    { where: `projects[${i}].summary`, text: x.summary },
    ...x.highlights.map((h, j) => ({ where: `projects[${i}].highlights[${j}]`, text: h })),
    ...x.tech.map((t, j) => ({ where: `projects[${i}].tech[${j}]`, text: t })),
  ]);
}

/**
 * Replace the model's wording for a verified project with the verified wording, then refuse the
 * whole extraction if a corrected claim survives anywhere it should not.
 *
 * Two mechanisms, and both are needed. **Overrides** put the checked wording back — they are
 * the reason this is not a manual patch. **Tripwires** catch the same claim reappearing
 * somewhere an override does not reach: the model paraphrases freely, so "distributed" can
 * surface in a `highlights` line or a `tech` entry on one run and not the next.
 *
 * An override that matches nothing is reported, not ignored. It means either the PDF has been
 * fixed — in which case the correction can be retired — or the project has been renamed past
 * recognition. Either way a human has to look, which is the whole point.
 */
export function applyCorrections(
  profile: Profile,
  corrections: ProfileCorrections,
  log: (msg: string) => void = () => {},
): Profile {
  const projects = profile.projects.map((project) => {
    const fix = corrections.projects.find((c) => project.name.toLowerCase().includes(c.match.toLowerCase()));
    if (fix === undefined) return project;
    log(`corrected "${project.name}" → "${fix.name}" (decision ${fix.decision})`);
    return { ...project, name: fix.name, summary: fix.summary, highlights: fix.highlights };
  });

  const corrected = { ...profile, projects };

  const unmatched = corrections.projects.filter(
    (c) => !profile.projects.some((p) => p.name.toLowerCase().includes(c.match.toLowerCase())),
  );
  for (const c of unmatched) {
    log(
      `WARNING: the correction for "${c.match}" matched no project. Either the PDF has been ` +
        `fixed — retire it from ${CORRECTIONS_PATH} — or the project was renamed. Check before trusting this profile.`,
    );
  }

  const violations: string[] = [];
  for (const rule of corrections.forbidden) {
    const re = new RegExp(rule.pattern, 'i');
    const scope = rule.in === 'projects' ? projectFields(corrected) : claimFields(corrected);
    for (const field of scope) {
      if (re.test(field.text)) {
        violations.push(`  ${field.where}: "${field.text.slice(0, 120)}"\n    ${rule.why} (decision ${rule.decision})`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `${violations.length} corrected claim(s) came back from the extractor and are not covered ` +
        `by an override, so nothing was written:\n\n${violations.join('\n')}\n\n` +
        `Either fix the wording in the resume PDF, or widen an override in ${CORRECTIONS_PATH}.`,
    );
  }

  return corrected;
}

/** Ask the model to turn resume text into the structured profile. */
export async function extractProfile(resumePath: string, log: (msg: string) => void = () => {}): Promise<Profile> {
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

  const parsed = Profile.parse({
    ...extracted,
    extracted_at: nowIso(),
    model: modelFor('profile').id,
  });

  // Corrections are applied here, not in `saveProfile`, so that every caller of
  // `extractProfile` gets the verified wording — including a future one that does not save.
  return applyCorrections(parsed, loadCorrections(), log);
}

/** Write the profile to disk. */
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

/** CLI entry: read the resume PDF and regenerate data/profile.json. */
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

  let profile: Profile;
  try {
    profile = await extractProfile(values.resume, (m) => console.log(`  ${m}`));
  } catch (err) {
    // A refused extraction is a designed outcome, not a crash: it means the resume still makes
    // a claim its own repository does not support (053). The message says which and why, so
    // print it plainly rather than burying it under a stack trace.
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  saveProfile(profile, values.out);

  console.log(`\n${summarise(profile)}\n`);
  console.log(`wrote ${values.out} (parsed by ${profile.model})`);
  console.log('Check the numbers above against the PDF — re-run if anything is wrong.');
  return 0;
}

if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('../env.ts')).loadEnv();

  process.exitCode = await main(process.argv.slice(2));
}
