import { isUnpaid } from './filter.ts';

export const INTERNSHIP_MONTHLY_MIN = 40_000;
export type CompensationPosting = { title: string; description?: string | null; location?: string | null };
const internship = /\bintern(?:ship)?s?\b/i;
const remote = /\b(?:fully remote|100\s*%\s*remote|remote[- ]only|work from home|wfh)\b/i;
const onsite = /\b(?:hybrid|on[- ]?site|in[- ]office|work from office|office days|not remote|no remote)\b/i;
const explicitUnpaid = /(?:^|[\n.;])\s*(?:(?:this (?:is|will be) an? )?un[ -]?paid (?:internship|role|position)\b|(?:stipend|compensation|pay)\s*[:–-]\s*(?:unpaid|none|(?:₹|INR\s*)?0\b)|(?:no|without) stipend\b)|\b(?:this|the) (?:internship|role|position) is unpaid\b/i;
const amount = '(\\d[\\d,]*(?:\\.\\d+)?)(?:\\s*([kK]))?';
const money = new RegExp(`(?:₹|\\bINR\\b|\\bRs\\.?)\\s*${amount}(?:\\s*(?:–|—|-|to)\\s*(?:₹|INR\\s*|Rs\\.?\\s*)?${amount})?\\s*(?:\\/(?:mo(?:nth)?\\b)|per\\s+month\\b|a\\s+month\\b|monthly\\b|p\\.?m\\.?\\b)`, 'gi');

/** Evidence only: no invented currency, pay period, or remote status. */
export function internshipRecommendationExclusion({ title, description = '', location = '' }: CompensationPosting): 'unpaid' | 'below-minimum' | null {
  const body = description ?? '', place = location ?? '';
  if (isUnpaid(title) || internship.test(title) && explicitUnpaid.test(body)) return 'unpaid';
  if (!internship.test(title)) return null;
  const fullyRemote = !onsite.test(`${place}\n${title}\n${body}`) && (remote.test(`${place}\n${title}\n${body}`) || /^remote(?:\s*\(india\)|\s*[,–-]\s*india)?$/i.test(place.trim()));
  for (const match of `${title}\n${body}`.matchAll(money)) {
    const first = Number(match[1]!.replaceAll(',', ''));
    const inheritsK = match[4] && first < 1000;
    const low = first * (match[2] || inheritsK ? 1000 : 1);
    if (low === 0 && !match[3]) return 'unpaid';
    if (!fullyRemote && low < INTERNSHIP_MONTHLY_MIN) return 'below-minimum';
  }
  return null;
}
