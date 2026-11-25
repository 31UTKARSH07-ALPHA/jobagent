import { greetingName } from '../draft/compose.ts';
import { loadCorrections, loadProfile } from '../match/profile.ts';
import type { Db } from '../store/db.ts';
import { normaliseForKey } from '../store/jobs.ts';
import type { Profile } from '../store/schema.ts';

type Draft = { email: string; subject: string; body: string };
type Warning = { code: string; message: string };

const claims = {
  employment: /\b(?:work(?:ed|ing)? (?:at|for|as)|employed (?:at|by|as)|intern(?:ed|ing) (?:at|for|with)|(?:my|previous|completed an?) internship (?:at|with)|(?:at|during) my (?:last|previous|current) (?:job|company|role|internship)|years? of (?:[\w-]+ ){0,3}experience|was (?:an? )?(?:software engineer|developer|intern))\b/i,
  education: /\b(?:stud(?:y|ied|ying) at|student at|final[- ]year|first[- ]year|second[- ]year|third[- ]year|fourth[- ]year|freshman|sophomore|senior year|graduat(?:e|ed|ing|ion) (?:from|in|this|next)|class of \d{4}|gpa|cgpa|(?:hold|earned|completed) (?:an? |my )?(?:degree|bachelor|master|phd))\b/i,
  project: /\b(?:built|co-built|designed|engineered|implemented|developed|created|shipped|scaled|architected|deployed|led|optimized|maintained|expert in|proficient in|hands-on experience (?:with|in))\b/i,
  achievement: /\b(?:certified (?:by|in|as)|certification|won|awarded|recognized by|ranked|award|patent|published (?:a|my|in))\b/i,
  employer: /\b(?:your (?:[\w-]+ ){0,4}(?:team|company|product|platform|customers?|users?|stack|services?) (?:is|are|uses?|runs?|has|have|launched|serves?|handles?|built)|you(?:'ve| have)? (?:recently |just )?(?:launched|released|use|run|serve|raised|grew|migrated|announced)|(?:your|the) (?:recent |new )?(?:launch|migration|funding round|series [a-z] round)|your (?:use|adoption) of|your (?:[\w-]+ ){0,4}(?:team|product|platform|stack) (?:behind|powered by|built on))\b/i,
};
type ClaimKind = keyof typeof claims;

const folded = (text: string) => text.normalize('NFKC').replace(/[‘’]/g, "'").toLowerCase().trim().replace(/\s+/g, ' ');
const address = (text: string) => text.trim().toLowerCase();
const clauses = (text: string) => text.replace(/(?:https?:\/\/|www\.)\S+|[\w.+%-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
  .replace(/[‘’]/g, "'").split(/\r?\n|;|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const stopWords = new Set('a an and are as at be been built by created developed for from had has have i in is it its my of on or our that the their this to was we were with you your'.split(' '));
const terms = (text: string) => [...new Set((folded(text).match(/[a-z][\w-]*/g) ?? []).filter((t) => !stopWords.has(t)))];
const overlap = (a: string[], b: string[]) => a.filter((t) => b.includes(t)).length;
const includesPhrase = (text: string, phrase: string) => {
  const key = normaliseForKey(phrase);
  return key.length > 0 && ` ${normaliseForKey(text)} `.includes(` ${key} `);
};

function contentBigrams(text: string) {
  const words = text.split(' ');
  return new Set(words.slice(1).map((word, i) => `${words[i]} ${word}`));
}

function similarBody(body: Set<string>, other: string) {
  const comparison = contentBigrams(normaliseForKey(other));
  if (body.size < 20 || comparison.size < 20) return false;
  const shared = [...body].filter((phrase) => comparison.has(phrase)).length;
  return 2 * shared >= 0.9 * (body.size + comparison.size);
}

function profileEvidence(profile?: Profile): Record<Exclude<ClaimKind, 'employer'>, string[]> {
  return {
    employment: profile?.experience.map((e) => `${e.role} at ${e.company}. ${e.dates}. ${e.summary}`) ?? [],
    education: profile?.education.map((e) => `${e.degree} at ${e.institution}. ${e.dates}. ${e.score}`) ?? [],
    project: profile ? [profile.summary, ...profile.projects.flatMap((p) => [`${p.name}: ${p.summary}`, ...p.highlights]),
      ...profile.skills.map((g) => g.items.join(', ')), ...profile.domains] : [],
    achievement: profile?.achievements ?? [],
  };
}

// Preserve units and nearby context: a 95% score elsewhere does not support a 95% speedup.
const metricPattern = /(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:[kmb](?=\+|\s|\b)|%|[x×](?!\w)|ms\b|s(?:ec(?:onds?)?)?\b|minutes?\b|hours?\b|years?\b|ops\/s(?:ec)?\b|rps\b|requests(?:\/(?:s|sec))?\b|users?\b))?\+?/gi;
function numbers(text: string) {
  const normalized = folded(text);
  return [...normalized.matchAll(metricPattern)].map((m) => ({
    key: m[0].replace(/[\s,]/g, '').replace('×', 'x'),
    raw: m[0],
    context: terms(normalized.slice(Math.max(0, m.index - 45), m.index) + ' ' + normalized.slice(m.index + m[0].length, m.index + m[0].length + 45)),
  }));
}

/** Read-only advisory review; warnings (or their absence) do not verify any claim or mailbox. */
export async function assessDraft(db: Db, id: number, draft: Draft): Promise<{ warnings: Warning[]; mode: string }> {
  const warnings: Warning[] = [];
  const add = (code: string, message: string) => warnings.push({ code, message });
  const current = db.prepare(`
    SELECT company.id AS company_id, company.name AS company, j.title, j.description,
           COALESCE(o.recipient_override, c.email) AS email,
           c.email AS contact_email, c.name AS contact_name, c.source AS contact_source, c.dead_at
      FROM outreach o JOIN jobs j ON j.id = o.job_id
      JOIN companies company ON company.id = j.company_id JOIN contacts c ON c.id = o.contact_id
     WHERE o.id = ?
  `).get(id) as { company_id: number; company: string; title: string; description: string; email: string;
    contact_email: string; contact_name: string | null; contact_source: string; dead_at: string | null } | undefined;
  if (!current) {
    add('draft_not_found', 'No saved outreach record was found. The company, role and contact could not be checked.');
    return { warnings, mode: 'local' };
  }

  let profile: Profile | undefined;
  try {
    profile = loadProfile(process.env['JOBAGENT_PROFILE']);
  } catch {
    add('profile_unavailable', 'The saved candidate profile could not be read. Review candidate claims against your resume manually.');
  }
  if (!draft.email.trim()) add('missing_recipient', 'Add a recipient before approving this draft.');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) add('invalid_recipient', 'The recipient does not look like a valid email address.');
  if (!draft.subject.trim()) add('missing_subject', 'Add a subject that identifies the opportunity.');
  if (!draft.body.trim()) add('missing_body', 'Add a message before approving this draft.');
  const opening = draft.body.trim().replace(/^(?:(?:hi|hello|dear|hey)\b[^\n]*\n+)/i, '').slice(0, 300);
  if (/^(?:i hope this (?:email|message) finds you well|to whom it may concern|i (?:am|'m) reaching out to express my interest)/i.test(opening)) {
    add('generic_opening', 'Consider opening with a specific detail about the role and why it interests you.');
  }
  if (/\b(?:wtf|stfu|dumbass|idiot|fucking|bullshit)\b/i.test(`${draft.subject} ${draft.body}`)) {
    add('tone_review', 'Review language that may come across as unprofessional.');
  }
  const recipient = address(draft.email);
  if (recipient !== address(current.email)) {
    add('recipient_changed', 'The recipient differs from the saved draft. Check that the new address is appropriate for this role.');
  }
  if (current.dead_at && recipient === address(current.contact_email)) {
    add('recipient_retired', 'The selected address is marked as a retired contact. Review the recipient before sending.');
  }
  const salutation = /^(?:hi|hello|dear|hey)\s+([^,\n!:]+)[,!:]/i.exec(draft.body.trim())?.[1]?.trim();
  if (salutation && !/^(?:there|team|hiring team|hiring manager|recruiting team|recruiter)$/i.test(salutation)) {
    const named = current.contact_source === 'posting' && recipient === address(current.contact_email) && current.contact_name;
    if (!includesPhrase(salutation, greetingName(current.company)) && !(named && includesPhrase(salutation, named.trim().split(/\s+/)[0]!))) {
      add('greeting_review', 'The greeting does not match the saved company or a name supplied by the posting for this address. Check who it addresses.');
    }
  }
  if (/\[[^\]\n]{2,}\]|\{\{|<[A-Z_]{3,}>|\b(?:Your Name|Company Name|XX+)\b/.test(`${draft.subject}\n${draft.body}`)) {
    add('placeholder', 'The draft appears to contain an unfilled placeholder.');
  }

  const history = db.prepare(`
    SELECT j.company_id, j.title, COALESCE(o.recipient_override, c.email) AS email,
           COALESCE(o.local_subject, o.subject) AS subject, COALESCE(o.local_body, o.body) AS body
      FROM outreach o JOIN jobs j ON j.id = o.job_id JOIN contacts c ON c.id = o.contact_id
     WHERE o.id <> ?
  `).iterate(id) as Iterable<{ company_id: number; title: string; email: string; subject: string; body: string }>;
  let sameRole = false;
  let sameRecipient = false;
  let sameContent = false;
  let nearContent = false;
  const title = normaliseForKey(current.title);
  const subject = folded(draft.subject);
  const subjectKey = normaliseForKey(subject);
  const body = folded(draft.body);
  const bodyBigrams = contentBigrams(normaliseForKey(body));
  for (const row of history) {
    sameRole ||= !!title && row.company_id === current.company_id && normaliseForKey(row.title) === title;
    sameRecipient ||= !!recipient && address(row.email) === recipient;
    sameContent ||= !!subject && !!body && folded(row.subject) === subject && folded(row.body) === body;
    nearContent ||= !sameContent && !!subjectKey && bodyBigrams.size >= 20 &&
      normaliseForKey(row.subject) === subjectKey && similarBody(bodyBigrams, row.body);
    if (sameRole && sameRecipient && sameContent) break;
  }
  if (sameRole) add('duplicate_role', 'Another outreach record has the same company and a matching role title. Check whether this is a separate opening.');
  if (sameRecipient) add('duplicate_recipient', 'This address appears on another outreach record. Check whether contacting it again is appropriate.');
  if (sameContent) add('duplicate_content', 'Another outreach record has the same subject and body after normalizing case and whitespace. Check for a repeated message.');
  else if (nearContent) add('duplicate_content', 'Another outreach record has a matching subject and very similar body. Check for a repeated message.');

  const sources = profileEvidence(profile);
  const evidence: Record<ClaimKind, string[]> = { ...sources, employer: [current.title, ...clauses(current.description)] };
  const missingClaims = new Set<ClaimKind>();
  const metricFlags = new Set<string>();
  const candidateMetrics = Object.values(sources).flat().flatMap(numbers);
  const postingMetrics = evidence.employer.flatMap(numbers);
  const draftClauses = clauses(`${draft.subject}\n${draft.body}`);
  for (const claim of draftClauses) {
    const employer = claims.employer.test(claim);
    // Words like “built” inside a company claim are not automatically candidate claims.
    const kinds = (Object.keys(claims) as ClaimKind[]).filter((kind) => (employer ? kind === 'employer' : !!profile) && claims[kind].test(claim));
    const claimTerms = terms(claim);
    for (const kind of kinds) {
      if (!evidence[kind].some((line) => {
        const shared = overlap(claimTerms, terms(line));
        return includesPhrase(line, claim) || (shared >= 2 && shared >= claimTerms.length * 0.55);
      })) missingClaims.add(kind);
    }
    for (const metric of numbers(claim)) {
      if (!(employer ? postingMetrics : candidateMetrics).some((saved) => saved.key === metric.key && overlap(metric.context, saved.context) >= 1)) {
        metricFlags.add(metric.raw.trim());
      }
    }
  }
  for (const kind of missingClaims) {
    add(`unsupported_${kind}`, kind === 'employer'
      ? 'A company or role claim did not clearly match the saved posting. Check the details manually.'
      : `A possible ${kind} claim did not clearly match the saved profile. Check the wording and source manually.`);
  }
  if (metricFlags.size) {
    add('unsupported_metric', `Check these figures and their context against the saved source: ${[...metricFlags].slice(0, 8).join(', ')}${metricFlags.size > 8 ? ', …' : ''}.`);
  }
  try {
    const rules = loadCorrections(process.env['JOBAGENT_CORRECTIONS']).forbidden;
    if (rules.some((rule) => {
      const pattern = new RegExp(rule.pattern, 'i');
      return draftClauses.some((claim) => (rule.in === 'anywhere' || (claims.project.test(claim) && !claims.employer.test(claim))) && pattern.test(claim));
    })) add('profile_correction', 'The wording may reintroduce a corrected resume claim. Compare it with the saved profile corrections.');
  } catch {
    // Optional supporting evidence; the saved profile/posting checks still apply.
  }
  return { warnings, mode: 'local' };
}
