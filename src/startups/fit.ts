/**
 * Which startups are worth writing to, and in what order — plain rules, no model.
 *
 * Deliberately not the job pipeline's scorer. That one rates a *posting* against the resume
 * and spends from a Groq budget the daily pipeline is already short of (decision 055). What
 * matters here is cheaper to read straight off the source: is there a role a student can take,
 * is it somewhere he can work from, does it say what it pays. Every input is a field YC
 * prints, so every number this file produces can be explained by pointing at the page.
 *
 * Utkarsh's brief (2026-10-05): seed or Series A, SWE or AI internships, in Bengaluru or
 * remote from abroad with good pay.
 */
import {
  EARLY_CAREER_TITLE,
  INDIA_LOCATION,
  NON_ENGINEERING_TITLE,
  SENIOR_TITLE,
  TECHNICAL_TITLE,
  isUnpaid,
} from '../ingest/filter.ts';

/** YC's own label for pre-Series-B companies. Its other value is `Growth`. */
export const EARLY_STAGE = 'Early';

/**
 * Batches older than this are past Series A in practice, whatever the stage label says —
 * `Early` still covers Wifi Dabba (W17). Five years is roughly seed → A → B.
 */
export const MIN_BATCH_YEAR = 2021;

/** A seed or Series A company is small. Larger than this and it hires through a process. */
export const MAX_TEAM_SIZE = 60;

const BENGALURU = /\b(bengaluru|bangalore|blr)\b/i;

/**
 * YC writes India as the country code: "Hyderabad, TS, IN". Case-sensitive, and not when a US
 * follows, because "Indianapolis, IN, US" is Indiana.
 */
const INDIA_CODE = /\bIN\b(?!\s*,\s*US)/;

/** `Winter 2024` → 2024, `W24` → 2024. Zero when the batch says neither. */
export function batchYear(batch: string | null | undefined): number {
  const text = batch ?? '';
  const full = /\b(20\d\d)\b/.exec(text);
  if (full) return Number(full[1]);
  const short = /\b[WSFX](\d\d)\b/i.exec(text);
  return short ? 2000 + Number(short[1]) : 0;
}

/**
 * Where a role can be done from, as far as someone in India is concerned.
 *
 * - `bengaluru` / `india` — on site, or remote within India.
 * - `remote` — remote with no country restriction he fails.
 * - `no` — on site abroad, or remote only for the US, the EU and so on.
 *
 * Stricter than `matchesGeography` in ingest, which keeps anything unclear for the scorer to
 * judge. There is no scorer here, so "Remote (US)" has to be refused by the rule itself — and
 * YC's job board says it constantly.
 */
export type Reach = 'bengaluru' | 'india' | 'remote' | 'no';

export function reachOf(location: string): Reach {
  const loc = location.trim();
  if (loc === '') return 'no';

  // "Bangalore / Remote (US)" is a Bengaluru office, whatever else it also offers.
  if (BENGALURU.test(loc)) return 'bengaluru';
  if (INDIA_LOCATION.test(loc) || /\bremote\s*\(\s*in(dia)?\s*\)/i.test(loc) || INDIA_CODE.test(loc)) return 'india';

  // Every "Remote" in the string, with whatever qualifier follows it. One unrestricted or
  // Asia-friendly mention is enough; a string that only ever says "Remote (US)" is not.
  const remotes = [...loc.matchAll(/\bremote\b\s*(\(([^)]*)\))?/gi)];
  for (const match of remotes) {
    const qualifier = (match[2] ?? '').trim();
    if (qualifier === '') return 'remote';
    if (/\b(worldwide|global|anywhere|apac|asia|international)\b/i.test(qualifier)) return 'remote';
  }
  if (/\b(worldwide|anywhere)\b/i.test(loc)) return 'remote';
  return 'no';
}

/** Can a student take this role? `intern`, `new_grad`, or null for no. */
export type Level = 'intern' | 'new_grad';

export function levelOf(role: { title: string; job_type: string; min_experience: string }): Level | null {
  if (/intern/i.test(role.job_type) || /\bintern(ship)?s?\b/i.test(role.title)) return 'intern';
  // A senior title overrides "new grads ok" — "Staff Engineer · Any (new grads ok)" is a real
  // YC listing and is not for a student.
  if (SENIOR_TITLE.test(role.title)) return null;
  if (/\b(any|new grads?|0\+?\s*years?|students?)\b/i.test(role.min_experience)) return 'new_grad';
  if (EARLY_CAREER_TITLE.test(role.title)) return 'new_grad';
  return null;
}

/** Engineering, AI or data — what he is applying for. */
export function isEngineeringRole(role: { title: string; role?: string | null }): boolean {
  if (NON_ENGINEERING_TITLE.test(role.title) || isUnpaid(role.title) || NOT_SOFTWARE.test(role.title)) return false;
  return role.role === 'eng' || TECHNICAL_TITLE.test(role.title);
}

/**
 * Titles YC files under engineering, or that borrow a technical word, that are not software
 * work — "Data Collection Specialist" at Asimov reached the first shortlist. And a listing the
 * company itself marked "[PAUSED]" is not open.
 */
const NOT_SOFTWARE = /\b(paused|data (collection|entry|annotation|label(l)?ing)|specialist|operator|technician|mechanic)\b/i;

/**
 * A role worth writing about, and why. Null when it is not one.
 *
 * The visa field is read only for roles outside India: YC marks Bengaluru postings "US
 * citizen/visa only" often enough that it cannot be trusted there (Inito, 2026-10-05).
 */
export function judgeRole(role: {
  title: string;
  role?: string | null;
  location: string;
  job_type: string;
  min_experience: string;
  visa?: string | null;
}): { level: Level; reach: Exclude<Reach, 'no'> } | null {
  if (!isEngineeringRole(role)) return null;
  const level = levelOf(role);
  if (level === null) return null;
  const reach = reachOf(role.location);
  if (reach === 'no') return null;
  if (reach === 'remote' && /\bUS citizen/i.test(role.visa ?? '') && !/not required/i.test(role.visa ?? '')) return null;
  return { level, reach };
}

/**
 * Rough annual pay in lakh rupees, for **ranking only** — the string is what gets shown.
 *
 * Fixed exchange rates, because the only question asked of this number is whether one
 * listing pays more than another. YC writes "$130 - $190" for $130K–$190K often enough that a
 * bare dollar figure under 1,000 is read as thousands.
 */
const RATES_TO_INR: Record<string, number> = { '$': 85, '₹': 1, '£': 108, '€': 92 };

export function parseSalary(text: string): number | null {
  const currency = /[$₹£€]/.exec(text)?.[0];
  if (currency === undefined) return null;

  const amounts = [...text.matchAll(/[$₹£€]\s*([\d.,]+)\s*([KkMm])?/g)].map((m) => {
    const n = Number((m[1] ?? '').replace(/,/g, ''));
    const unit = (m[2] ?? '').toUpperCase();
    if (unit === 'K') return n * 1_000;
    if (unit === 'M') return n * 1_000_000;
    // Hourly figures are genuinely small, so the "$130 means $130K" reading is for annual only.
    return currency === '$' && n < 1_000 && n >= 50 && !/hour/i.test(text) ? n * 1_000 : n;
  });
  const top = Math.max(...amounts.filter(Number.isFinite));
  if (!Number.isFinite(top) || top <= 0) return null;

  // Internships are mostly priced by the month, contracts by the hour: "$4K - $8K / monthly",
  // "$15 - $25 / hourly". Read the period, or a monthly stipend ranks below a modest salary.
  const perYear = /\bmonth(ly)?\b|\/\s*mo\b/i.test(text) ? 12 : /\bhour(ly)?\b|\/\s*hr\b/i.test(text) ? 2_000 : 1;
  const lakh = (top * perYear * (RATES_TO_INR[currency] ?? 1)) / 100_000;
  // "₹40 INR" and "$1" are both on real listings. Under half a lakh a year is a placeholder.
  return lakh < 0.5 ? null : Math.round(lakh * 10) / 10;
}

const AI = /\b(ai|artificial intelligence|machine learning|ml|llms?|generative|genai|nlp|computer vision|deep learning|agents?)\b/i;

export type FitInput = {
  location: string;
  batch: string;
  team_size: number | null;
  one_liner: string;
  tags: readonly string[];
  roles: readonly {
    title: string;
    location: string;
    job_type: string;
    min_experience: string;
    salary: string;
  }[];
};

export type Fit = {
  /** 0–100. Arithmetic over the parts below, never a judgement. */
  rank: number;
  /** The best role, or null for an open application to an Indian startup with none listed. */
  best: { index: number; level: Level; reach: Exclude<Reach, 'no'>; lakh: number | null } | null;
  /** Bengaluru, India or remote — for the company when no role says. */
  reach: Exclude<Reach, 'no'>;
  ai: boolean;
  /** One line a human can check against the YC page. */
  why: string;
};

/**
 * Is this startup worth writing to, and how much?
 *
 * Two ways in:
 *
 * - **A listed role he can take** — an internship or a "new grads ok" engineering role he can
 *   do from Bengaluru, India or remotely. This is the strong case: the company has said in
 *   public that it wants this person.
 * - **An open application** — an Indian startup that is hiring engineers but lists nothing
 *   junior. A ten-person company in Bengaluru takes interns it never advertised. Ranked well
 *   below the first case, and only for India: "remote, abroad, nothing junior listed" is
 *   exactly the company least likely to answer.
 */
export function fitOf(input: FitInput): Fit | null {
  const judged = input.roles
    .map((role, index) => {
      const verdict = judgeRole(role);
      return verdict === null ? null : { index, ...verdict, lakh: parseSalary(role.salary) };
    })
    .filter((r) => r !== null);

  const levelPoints = { intern: 40, new_grad: 30 } as const;
  const reachPoints = { bengaluru: 25, india: 18, remote: 18 } as const;
  const payPoints = (lakh: number | null): number => (lakh === null ? 0 : lakh >= 12 ? 10 : lakh >= 6 ? 6 : 2);

  const scored = judged
    .map((r) => ({ r, points: levelPoints[r.level] + reachPoints[r.reach] + payPoints(r.lakh) }))
    .sort((a, b) => b.points - a.points);
  const top = scored[0];

  const companyReach = reachOf(input.location);
  const ai = AI.test(input.one_liner) || input.tags.some((t) => AI.test(t));
  const year = batchYear(input.batch);
  const recency = year >= new Date().getFullYear() - 1 ? 10 : year >= new Date().getFullYear() - 3 ? 5 : 0;
  const small = input.team_size !== null && input.team_size <= 20 ? 5 : 0;

  if (top === undefined) {
    if (companyReach !== 'bengaluru' && companyReach !== 'india') return null;
    const rank = 10 + reachPoints[companyReach] + (ai ? 10 : 0) + recency + small;
    return {
      rank,
      best: null,
      reach: companyReach,
      ai,
      why: `open application · ${companyReach}${ai ? ' · AI' : ''}`,
    };
  }

  const rank = Math.min(100, top.points + (ai ? 10 : 0) + recency + small);
  const role = input.roles[top.r.index]!;
  return {
    rank,
    best: top.r,
    reach: top.r.reach,
    ai,
    why: [
      top.r.level === 'intern' ? 'internship listed' : 'new grads ok',
      top.r.reach,
      role.salary !== '' ? role.salary : 'pay not stated',
      ai ? 'AI' : '',
    ]
      .filter((s) => s !== '')
      .join(' · '),
  };
}
