/**
 * The email to a founder. Its own prompt, the job pipeline's checks.
 *
 * Different from `src/draft/compose.ts` in what it is *for*: that one answers a posting, this
 * one asks a founder whether they would take an intern — sometimes for a role they listed,
 * sometimes for one they did not. So there is no scorer's hook to open with; the model picks
 * the one project in the profile closest to what the startup builds, from the profile alone.
 *
 * The same in everything that keeps an email honest: `problemsWith` runs on the output, so a
 * placeholder, an invented employer, a claimed year of study or a missing signature is
 * rejected here exactly as it is there. One retry, with the complaints attached.
 */
import { chat } from '../llm/groq.ts';
import { modelFor } from '../llm/models.ts';
import { greetingName, parseDraft, problemsWith, type DraftResult } from '../draft/compose.ts';
import { profileForPrompt } from '../match/score.ts';
import type { Profile, Startup, StartupRole, StartupUpdate } from '../store/schema.ts';
import { nameParts } from './people.ts';

const SYSTEM = [
  'You write short cold emails from a student to the founder of an early-stage startup,',
  'asking about an internship. Plain text.',
  '',
  'Rules, in order of importance:',
  '1. Every factual claim about the candidate must come from the profile you are given. Do not',
  '   invent employers, job titles, dates, degrees, metrics or technologies. If the profile',
  '   lists no work experience, the email must not imply any.',
  '2. Begin with the exact greeting you are given, on its own line, then a blank line.',
  '3. The first sentence after the greeting says, in the first person, the one project from the',
  '   profile that is closest to what this startup builds — "I built…", never a résumé',
  '   fragment like "Built…". Choose it for its relevance to the startup, not its size.',
  '4. One sentence on why this startup specifically. If you are given a recent product update,',
  '   name it — it is the most current thing they have shipped. Otherwise use the description.',
  '   Do not flatter, and do not mention anything not given to you.',
  '5. If a role is given, ask about that role by name. If none is given, ask plainly whether',
  '   they would consider an intern for the work you describe — do not pretend a role exists.',
  '6. Say whether the candidate can work remotely or in Bengaluru, as you are told.',
  '7. 80 to 140 words in the body. Three short paragraphs at most.',
  '8. End with one low-friction ask — a 15-minute call, or whether they would look at a short',
  "   sample of work — then the candidate's name on its own line.",
  '9. No placeholders, no square brackets, no exclamation marks, no salary or pay, and do not',
  '   state a year of study, a graduation date or years of experience.',
  '',
  'The subject line names the internship and one specific thing about the candidate, under 70',
  'characters. Do not start it with "Application for".',
  '',
  'Reply in exactly this format, with no preamble and no markdown:',
  'Subject: <the subject line>',
  '',
  '<the email body, greeting through sign-off>',
].join('\n');

/** `Jordan Cole` → `Maitreya`. Original casing, because it is going in a greeting. */
export function firstNameOf(full: string): string | null {
  const word = full.trim().split(/\s+/)[0] ?? '';
  return nameParts(full) === null || word.length < 2 ? null : word;
}

export function greetingFor(contactName: string | null, company: string): string {
  const first = contactName === null ? null : firstNameOf(contactName);
  return first === null ? `Hi ${greetingName(company)} team,` : `Hi ${first},`;
}

export function startupForPrompt(
  s: Startup,
  role: StartupRole | null,
  where: string,
  latest: StartupUpdate | null = null,
): string {
  return [
    `Startup: ${s.name}${s.batch !== '' ? ` (Y Combinator, ${s.batch})` : ''}`,
    `What it does: ${s.one_liner}`,
    s.description !== '' ? `Description: ${s.description.slice(0, 1200)}` : '',
    `Based in: ${s.location || '(not stated)'}`,
    // Only an update recent enough to be what they are building now (`freshUpdate`, 057).
    latest === null
      ? ''
      : `Most recent product update (${latest.published_at?.slice(0, 10)}): ${latest.title}${latest.summary !== '' ? ` — ${latest.summary}` : ''}`,
    role === null
      ? 'Role: none listed — this is an open application for a software or AI internship.'
      : `Role: ${role.title} (${role.location || 'location not stated'})`,
    role !== null && role.description !== '' ? `Role description:\n${role.description.slice(0, 1500)}` : '',
    s.demo_url === null
      ? ''
      : `The candidate built a small demo specifically for this startup: ${s.demo_url}\n` +
        'Mention it in the first paragraph, in one plain sentence saying what it shows, and include the link exactly.',
    `The candidate can work: ${where}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export type StartupDrafter = {
  model: string;
  compose: (
    startup: Startup,
    role: StartupRole | null,
    profile: Profile,
    contactName: string | null,
    where: string,
    latest: StartupUpdate | null,
    signal?: AbortSignal,
  ) => Promise<DraftResult>;
};

export const groqStartupDrafter: StartupDrafter = {
  model: modelFor('draft').id,
  compose: async (startup, role, profile, contactName, where, latest, signal) => {
    const greeting = greetingFor(contactName, startup.name);
    const prompt = [
      profileForPrompt(profile),
      '',
      '---',
      '',
      startupForPrompt(startup, role, where, latest),
      '',
      '---',
      '',
      `Greet them exactly as: ${greeting}`,
      `Sign the email as: ${profile.name}`,
    ].join('\n');

    let complaints = '';
    let lastProblems: string[] = ['the model never returned a parseable email'];

    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await chat({
        job: 'draft',
        signal,
        system: SYSTEM,
        messages: [{ role: 'user', content: complaints === '' ? prompt : `${prompt}\n\n---\n\n${complaints}` }],
        maxTokens: 1200,
        reasoningEffort: 'low',
        temperature: 0.6,
      });

      let draft: DraftResult;
      try {
        draft = parseDraft(raw);
      } catch (err) {
        complaints = `Your previous attempt was unusable: ${err instanceof Error ? err.message : String(err)}. Reply in the required format.`;
        continue;
      }

      const problems = problemsWith(draft, profile, startup.name);
      if (!draft.body.trim().startsWith(greeting)) problems.push(`does not open with the greeting "${greeting}"`);
      if (/[₹$£€]\s?\d|\b(salary|stipend|compensation|lpa)\b/i.test(draft.body)) problems.push('mentions pay');
      // The whole point of building it. An email that forgets the link wasted his day.
      if (startup.demo_url !== null && !draft.body.includes(startup.demo_url)) problems.push(`does not include the demo link ${startup.demo_url}`);
      if (problems.length === 0) return draft;

      lastProblems = problems;
      complaints = `Your previous attempt was rejected for: ${problems.join('; ')}. Rewrite it, fixing exactly those.`;
    }

    throw new Error(`draft never came back usable — ${lastProblems.join('; ')}`);
  },
};
