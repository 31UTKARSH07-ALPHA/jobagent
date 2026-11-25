/**
 * Demo ideas: two or three things he could build in a day that would make a founder stop and
 * look. Decision 058.
 *
 * His idea, 2026-10-06: a small demo tied to what the startup is working on makes more impact
 * than any paragraph. It does, at a three-person company, with three rules this prompt holds the
 * model to:
 *
 * 1. **Next to their product, never a copy of it.** They know their product better than he does.
 *    An eval of it, an integration with it, or a fix for a rough edge is what is worth building.
 * 2. **A merged pull request beats a demo** when the company is open source. Said in the prompt
 *    whenever the startup has a GitHub org.
 * 3. **One day of work each**, built from what he has actually done. The profile is in the prompt
 *    and the ideas must name which of his projects or skills each one uses.
 *
 * One Groq call per startup, on demand only (`--ideas=<name>`), cached in `startup_ideas`. Never
 * run in bulk: the daily pipeline needs the budget (055).
 *
 * Plain text, not structured output: these are paragraphs, and strict JSON 400s on long text
 * (decisions 030, 032).
 */
import { chat } from '../llm/groq.ts';
import { modelFor } from '../llm/models.ts';
import { profileForPrompt } from '../match/score.ts';
import type { Db } from '../store/db.ts';
import { StartupIdeas, nowIso, type Profile } from '../store/schema.ts';

const SYSTEM = [
  'You suggest small demos a student could build to get an internship at an early-stage startup.',
  '',
  'You are given the student\'s profile and a brief about one startup: the role, and what the',
  'startup has shipped recently, with dates. Suggest exactly 3 demo ideas.',
  '',
  'Rules:',
  '1. Each idea sits NEXT TO their product, never a clone of it: an evaluation or benchmark of it,',
  '   an integration with a tool their users already use, a small tool that fixes a rough edge, or',
  '   a worked example that shows their product doing something it does not advertise.',
  '2. Each must be buildable by one person in ONE day, and demonstrable in a 60-second video or a',
  '   public link. No idea that needs their private data, an account they would have to grant, or',
  '   more than a day.',
  '3. Each must use something the student has actually built or listed in the profile, and say',
  '   which. Never invent skills or projects.',
  '4. Tie each idea to something specific in the brief — the role description or a dated update —',
  '   and prefer the most recent update. If the newest update is over 6 months old, say the',
  '   student should check their site first, and lean on the role description instead.',
  '5. If you are told the startup is open source, make one of the three a pull request: a small,',
  '   real improvement to their public repository, found by reading their open issues.',
  '6. Plain, direct language. No hype, no exclamation marks.',
  '',
  'Reply in exactly this format, three times, with nothing before or after:',
  '',
  'IDEA <n>: <a short name>',
  'What: <one or two sentences — what he builds and what it shows>',
  'Why they would care: <one sentence, tied to the brief>',
  'Uses: <which of his projects or skills>',
  'In one day: <three short steps separated by " → ">',
  'Show it as: <a public repo, a hosted page, a 60-second video, or a pull request>',
].join('\n');

export const IDEA_LINE = /^IDEA\s+(\d)\s*:\s*\S/m;

/** Three ideas, each with every field. Anything else is rejected and asked again once. */
export function problemsWithIdeas(text: string, openSource: string | null = null): string[] {
  const problems: string[] = [];
  // Ressl's first set proposed a PR to a "Pidrive repository" nobody had shown to exist. A pull
  // request is only an idea when we know there is a public repo to send it to.
  if (openSource === null && /\bpull request\b|\bPR\b|\bfork (their|the) repo/i.test(text)) {
    problems.push('suggests a pull request, but the startup has no public repository we know of — replace that idea');
  }
  const ideas = text.split(/^(?=IDEA\s+\d\s*:)/m).filter((b) => IDEA_LINE.test(b));
  if (ideas.length !== 3) problems.push(`returned ${ideas.length} ideas, not 3`);
  for (const [i, idea] of ideas.entries()) {
    for (const field of ['What:', 'Why they would care:', 'Uses:', 'In one day:', 'Show it as:']) {
      if (!idea.includes(field)) problems.push(`idea ${i + 1} has no "${field}" line`);
    }
  }
  if (/\[[^\]]{2,}\]|\{\{|\bTODO\b/.test(text)) problems.push('contains a placeholder');
  return problems;
}

export type IdeaWriter = { model: string; write: (brief: string, profile: Profile, openSource: string | null, signal?: AbortSignal) => Promise<string> };

export const groqIdeaWriter: IdeaWriter = {
  model: modelFor('draft').id,
  write: async (brief, profile, openSource, signal) => {
    const prompt = [
      profileForPrompt(profile),
      '',
      '---',
      '',
      brief.slice(0, 7000),
      '',
      '---',
      '',
      openSource === null
        ? 'The startup has no public GitHub organisation that we know of.'
        : `The startup is open source: ${openSource}. One idea should be a pull request there.`,
    ].join('\n');

    let complaints = '';
    let last = ['the model returned nothing usable'];
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await chat({
        job: 'draft',
        signal,
        system: SYSTEM,
        messages: [{ role: 'user', content: complaints === '' ? prompt : `${prompt}\n\n---\n\n${complaints}` }],
        maxTokens: 1500,
        reasoningEffort: 'low',
        temperature: 0.5,
      });
      const text = raw.trim();
      const problems = problemsWithIdeas(text, openSource);
      if (problems.length === 0) return text;
      last = problems;
      complaints = `Your previous answer was rejected for: ${problems.join('; ')}. Reply again in exactly the required format.`;
    }
    throw new Error(`ideas never came back usable — ${last.join('; ')}`);
  },
};

export function ideasOf(db: Db, startupId: number): StartupIdeas | null {
  const row = db.prepare('SELECT * FROM startup_ideas WHERE startup_id = ?').get(startupId) as Record<string, unknown> | undefined;
  return row === undefined ? null : StartupIdeas.parse(row);
}

export function saveIdeas(db: Db, startupId: number, body: string, model: string): void {
  db.prepare(
    `INSERT INTO startup_ideas (startup_id, body, model, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (startup_id) DO UPDATE SET body = excluded.body, model = excluded.model, created_at = excluded.created_at`,
  ).run(startupId, body, model, nowIso());
}

/** The ideas section as it appears under the brief, in the terminal and in the saved file. */
export function formatIdeas(ideas: StartupIdeas | null): string {
  if (ideas === null) return 'DEMO IDEAS\n  None yet. Run --ideas=<name> to get three (one Groq call).';
  return [`DEMO IDEAS (written ${ideas.created_at.slice(0, 10)})`, '', ideas.body.split('\n').map((l) => `  ${l}`).join('\n')].join('\n');
}
