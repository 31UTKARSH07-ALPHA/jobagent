/**
 * Cheap filters applied at ingest, before anything costs money.
 *
 * These exist purely to stop obvious non-candidates from reaching the embedding and
 * scoring stages. They are *not* the judge — the scorer is. So both filters are
 * deliberately generous: when a title or location is ambiguous, the row is kept and the
 * scorer decides.
 *
 * Everything they drop is counted into `runs.stats.ingest`, so if a filter is throwing
 * away good postings that shows up as a number rather than as silence.
 */

/**
 * Roles a final-year student can actually take. Kept broad on purpose: "SDE-1" and
 * "Graduate Engineer" are entry-level in Indian postings even though neither says
 * "intern".
 */
export const EARLY_CAREER_TITLE =
  /\b(intern(ship)?s?|trainee|apprentice|graduate|new[\s-]?grad|campus|fresher|entry[\s-]?level|junior|sde[\s-]?1|sde[\s-]?i\b|software engineer i\b|associate engineer)\b/i;

/**
 * Senior signals that override the above — "Senior Engineer, University Recruiting" is
 * a real posting and is not for a student.
 */
export const SENIOR_TITLE =
  /\b(senior|staff|principal|lead|head|director|vp|manager|architect|sde[\s-]?(2|3|ii|iii)|l[4-7]\b)\b/i;

/** Roles this agent is for. Non-technical postings are dropped outright. */
export const TECHNICAL_TITLE =
  /\b(software|engineer(ing)?|developer|programmer|sde|swe|data|machine learning|ml|ai\b|deep learning|nlp|computer vision|research|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack|platform|infrastructure|devops|sre|mobile|android|ios|qa|test)\b/i;

/**
 * Business functions that borrow engineering words. "AI Innovation Intern – Service
 * Sales" and "Ubuntu Sales Engineer (Entry-Level)" both matched `TECHNICAL_TITLE` on the
 * first real ingest; neither is a software role.
 */
export const NON_ENGINEERING_TITLE =
  /\b(sales|policy|marketing|recruit(ing|er)?|talent|legal|counsel|finance|accounting|hr|people ops|communications|content|copywrit\w*|customer (success|support|experience)|business development|partnerships|procurement|supply chain|advocate|evangelist)\b/i;

export function isEarlyCareerTechRole(title: string): boolean {
  if (!TECHNICAL_TITLE.test(title)) return false;
  if (NON_ENGINEERING_TITLE.test(title)) return false;
  if (SENIOR_TITLE.test(title)) return false;
  return EARLY_CAREER_TITLE.test(title);
}

/**
 * Utkarsh's target geography: India, plus anything genuinely remote-global.
 * (Decided 2026-08-09 — see `docs/decisions.md` 009.)
 */
export const INDIA_LOCATION =
  /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|bombay|delhi|gurgaon|gurugram|noida|chennai|madras|kolkata|calcutta|ahmedabad|jaipur|indore|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|chandigarh|bhubaneswar|nagpur|vizag|visakhapatnam|mysore|mysuru|ncr)\b/i;

/**
 * Locations that are clearly somewhere else and clearly not remote. Used only to reject —
 * an unrecognised location is kept.
 */
export const ELSEWHERE_LOCATION =
  /\b(united states|usa|u\.s\.?|canada|toronto|vancouver|london|uk|united kingdom|ireland|dublin|germany|berlin|munich|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|warsaw|sweden|stockholm|switzerland|zurich|australia|sydney|melbourne|singapore|japan|tokyo|china|beijing|shanghai|korea|seoul|brazil|sao paulo|mexico|israel|tel aviv|dubai|uae|new york|san francisco|seattle|austin|boston|chicago|denver|atlanta|los angeles|bay area|americas|latam|emea|europe|european union)\b/i;

/**
 * Keep a posting if it is in India, explicitly remote, or unlabelled. Reject only when
 * the location clearly names somewhere else and nothing suggests remote.
 */
export function matchesGeography(location: string): boolean {
  const loc = location.trim();
  if (loc === '') return true; // unknown — let the scorer look at the description
  if (INDIA_LOCATION.test(loc)) return true;

  // A named foreign location beats a remote flag. Boards mark US-only roles `isRemote`
  // constantly — "Software Engineer Internship, Android | New York, NY, San Francisco,
  // CA" arrived flagged remote, and it is not remote to someone in India.
  if (ELSEWHERE_LOCATION.test(loc)) return false;

  // Remote, worldwide, or an unrecognised place — all kept. The scorer is the judge;
  // this filter only exists to reject the obviously-impossible.
  return true;
}
