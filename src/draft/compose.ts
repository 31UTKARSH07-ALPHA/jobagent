/**
 * The cold email itself — the only output of this project a human being reads.
 *
 * Everything upstream is judged by whether the numbers look right. This is judged by whether
 * a recruiter replies, so it is written to a much narrower brief than the scorer's:
 *
 * - **Nothing may be invented.** The model is handed the parsed resume and told, in the
 *   system prompt and again by a checker that runs on its output, that a claim not in that
 *   text is a fabrication. It is a student's first outreach; an invented internship is the
 *   one mistake that cannot be walked back.
 * - **The hook is already chosen.** `job_scores.hook` was written when the posting was
 *   scored, against the full description — which for an alert-sourced job is the *only* time
 *   anything read more than a title. Re-deriving it here would throw that away.
 * - **Short.** 120 words of specifics beats 300 words of enthusiasm, and a recruiter reading
 *   on a phone sees roughly the first two lines.
 *
 * The output is validated after generation, not just schema-checked — see {@link problemsWith}.
 * A model that returns `[Your Name]` has produced valid JSON and an unusable email.
 */
import { chat } from '../llm/groq.ts';
import { modelFor } from '../llm/models.ts';
import { profileForPrompt } from '../match/score.ts';
import type { Job, JobScore, Profile } from '../store/schema.ts';

/**
 * What the model returns. Plain text — never HTML, never Markdown.
 *
 * **Not a Zod schema, and not structured output.** Asked for `{subject, body}` under
 * `response_format: json_schema`, Groq returned `400 Failed to generate JSON` on two of the
 * first three real postings: an email body is a long multi-line string, which is the hardest
 * thing for strict mode to emit and the easiest to get wrong. The same trap as decision 030's
 * domain lookup, and the same answer — a shape a text format handles natively costs one
 * `split` to parse and cannot 400.
 */
export type DraftResult = { subject: string; body: string };

/** The only structure the model has to produce: a subject line, a blank line, the email. */
const SUBJECT_LINE = /^\s*subject:\s*(.+)$/im;

/**
 * `Subject: …\n\n<body>` → the two parts.
 *
 * Throws rather than guessing when the subject line is missing: an email sent with a
 * mangled subject is worse than one that waits for tomorrow's run.
 */
export function parseDraft(raw: string): DraftResult {
  const match = SUBJECT_LINE.exec(raw);
  if (match === null) throw new Error('no "Subject:" line in the reply');

  const subject = (match[1] ?? '').trim();
  const body = raw.slice(match.index + match[0].length).trim();
  if (subject === '' || body === '') throw new Error('subject or body came back empty');

  return { subject, body };
}

/**
 * Counted rather than asked for, because models ignore word limits.
 *
 * The floor is low on purpose. It used to be 70, guarding against a model that stopped
 * mid-sentence — but truncation is now caught where it happens, by `finish_reason: 'length'`
 * in `src/llm/groq.ts`, and a floor set near the target length rejects a genuinely tight
 * email for being short. 45 words is "the model returned nothing usable", not "the model was
 * brief".
 */
export const MIN_BODY_WORDS = 45;
export const MAX_BODY_WORDS = 220;

const SYSTEM = [
  'You write short cold emails from a student to a company that is hiring, in plain text.',
  '',
  'Rules, in order of importance:',
  '1. Every factual claim must come from the candidate profile you are given. Do not invent',
  '   employers, job titles, dates, degrees, metrics or technologies. If the profile lists no',
  '   work experience, the email must not imply any.',
  '2. Open with the specific hook you are given, in the candidate\'s own words, not with',
  '   "I am writing to express my interest".',
  '3. Say why this company and this role, using something concrete from the posting.',
  '4. 90 to 150 words in the body. Three short paragraphs at most.',
  '5. End with one clear, low-friction ask — a short call, or whether they are taking',
  '   applications for the role — then the candidate\'s name on its own line.',
  '6. No placeholders of any kind. No square brackets. You have every fact you need; if you',
  '   do not have something, leave it out rather than marking it to fill in later.',
  '7. No flattery ("I am incredibly passionate"), no self-deprecation, no exclamation marks.',
  '',
  '8. Do not state which year of study the candidate is in, when they graduate, or how many',
  '   years of anything they have. Those are not in the profile and guessing them is a lie',
  '   in the first sentence a stranger reads.',
  '',
  'The subject line names the role and one specific thing about the candidate. Under 70',
  'characters. Do not start it with "Application for".',
  '',
  'Reply in exactly this format, with no preamble and no markdown:',
  'Subject: <the subject line>',
  '',
  '<the email body, greeting through sign-off>',
].join('\n');

/** The posting, as much of it as is worth spending tokens on. */
function postingForPrompt(job: Job, company: string): string {
  const description = job.description.trim();
  return [
    `Company: ${company}`,
    `Role: ${job.title}`,
    `Location: ${job.location || '(not stated)'}`,
    '',
    description === ''
      ? 'The posting text was not available — it came from a job-alert email, so write from ' +
        'the role title and the company alone. Do not invent details about the team, the ' +
        'product or the stack.'
      : `Posting:\n${description.slice(0, 2500)}`,
  ].join('\n');
}

/**
 * Anything that makes a draft unusable, in plain words.
 *
 * This exists because schema-valid and send-worthy are different questions. A model that
 * returns `Dear [Hiring Manager]` has satisfied every type in `DraftResult`.
 */
export function problemsWith(draft: DraftResult, profile: Profile, company: string): string[] {
  const problems: string[] = [];
  const words = draft.body.trim().split(/\s+/).length;

  // Bounds the schema used to enforce, before structured output turned out to 400 on a
  // multi-line body. A subject longer than this is truncated by every mail client anyway.
  if (draft.subject.length > 90) problems.push(`subject is ${draft.subject.length} characters`);

  if (/\[[^\]]{2,}\]|\{\{|<[A-Z_]{3,}>|\bYour Name\b|\bXX+\b/.test(`${draft.subject} ${draft.body}`)) {
    problems.push('contains a placeholder to fill in');
  }
  if (words < MIN_BODY_WORDS) problems.push(`body is ${words} words, too short to say anything`);
  if (words > MAX_BODY_WORDS) problems.push(`body is ${words} words, too long to be read`);
  if (!draft.body.includes(profile.name)) problems.push('the candidate never signs their name');
  if (!`${draft.subject} ${draft.body}`.toLowerCase().includes(company.toLowerCase().split(' ')[0] ?? '')) {
    problems.push('the company is never named');
  }
  // The resume lists no employment, so any claim of it is invented. Checked literally
  // because this is the single most damaging thing the model could write.
  if (profile.experience.length === 0 && /\b(years? of (professional )?experience|at my (last|previous|current) (job|company|role)|when I worked at)\b/i.test(draft.body)) {
    problems.push('claims work experience the resume does not have');
  }
  if (/^(subject|re):/i.test(draft.body.trim())) problems.push('the body repeats the subject line');

  // Measured on the first real draft: the model wrote "As a final-year computer science
  // student at BITS Pilani", which the resume does not say — his education runs 2024–2027.
  // It came from the scorer's `reasoning`, which is written in the rubric's voice ("a
  // final-year student can take this role") and was being passed into the prompt as context.
  // The reasoning is no longer sent, and the claim is checked for anyway.
  const claimsYear = /\b(final[- ]year|first[- ]year|second[- ]year|third[- ]year|freshman|sophomore|senior year|graduating (in|this)|class of 20\d\d)\b/i;
  const inProfile = claimsYear.test(profileForPrompt(profile));
  if (!inProfile && claimsYear.test(draft.body)) {
    problems.push('states a year of study or graduation the resume never claims');
  }

  return problems;
}

export type Drafter = {
  model: string;
  compose: (
    job: Job,
    company: string,
    score: JobScore,
    profile: Profile,
    signal?: AbortSignal,
  ) => Promise<DraftResult>;
};

/**
 * Compose, then check, then compose again once with the complaints attached.
 *
 * The retry carries the specific problems back to the model rather than simply asking again:
 * Groq has no seed and is not reproducible even at temperature 0 (decision 012), so a blind
 * retry is a coin flip, while a named fault is something to correct.
 */
export const groqDrafter: Drafter = {
  model: modelFor('draft').id,
  compose: async (job, company, score, profile, signal) => {
    const prompt = [
      profileForPrompt(profile),
      '',
      '---',
      '',
      postingForPrompt(job, company),
      '',
      '---',
      '',
      `Open with this hook, rephrased naturally: ${score.hook}`,
      // `score.reasoning` is deliberately NOT sent. It is written in the rubric's voice and
      // asserts things the resume does not — "a final-year student" among them, which went
      // straight into the first real draft as fact.
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
        // An email is a long answer that needs almost no deliberation — the judgement was
        // made by the scorer. Left at the default, this model spent 774 of 900 tokens
        // thinking and returned a truncated draft.
        reasoningEffort: 'low',
        // Unlike the scorer, some variety is wanted here: every email this model writes in a
        // week goes to a different company, and four identical openings is a tell.
        temperature: 0.6,
      });

      let draft: DraftResult;
      try {
        draft = parseDraft(raw);
      } catch (err) {
        complaints = `Your previous attempt was unusable: ${err instanceof Error ? err.message : String(err)}. Reply in the required format.`;
        continue;
      }

      const problems = problemsWith(draft, profile, company);
      if (problems.length === 0) return draft;

      lastProblems = problems;
      complaints = `Your previous attempt was rejected for: ${problems.join('; ')}. Rewrite it, fixing exactly those.`;
    }

    throw new Error(`draft never came back usable — ${lastProblems.join('; ')}`);
  },
};
