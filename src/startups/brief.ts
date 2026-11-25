/**
 * The brief: what Utkarsh reads about a startup **before** any email to it is drafted.
 *
 * His ask, 2026-10-05: the role's full description, and the most recent thing the company has
 * shipped. Both exist because an email written from a one-line company summary reads like one,
 * and a founder can tell. Decision 057.
 *
 * - **The role** comes from the job's own YC page, which carries what the company page's
 *   listing leaves out: the full description, the interview process and the hiring manager.
 * - **What they are working on now** is every dated thing found, newest first: YC launch
 *   posts (the company announcing its own product), the press YC links, and Hacker News
 *   stories pointing at the company's site. **Always shown with its date**, because the newest
 *   launch can still be years old — Rivet's only launch (2023) describes a product it has since
 *   moved away from. The brief says how old the newest item is rather than letting a stale one
 *   pass as current.
 *
 * Nothing here costs a Groq call.
 */
import { decodeEntities, htmlToText } from '../ingest/html.ts';
import { getJson, getText } from '../ingest/http.ts';
import { apexOf } from '../contacts/domain.ts';
import { normaliseDomain } from '../store/companies.ts';
import type { Db } from '../store/db.ts';
import { transaction } from '../store/db.ts';
import {
  StartupUpdate,
  YcJobPage,
  nowIso,
  type StartupRole,
  type StartupUpdateKind,
  type YcCompanyPage,
} from '../store/schema.ts';
import { decodePageProps } from './yc.ts';

/** A role's page is re-read after this long — descriptions get edited. */
export const ROLE_REFRESH_DAYS = 7;
/** Hacker News is asked again after this long. */
export const UPDATES_REFRESH_DAYS = 3;
/**
 * The newest update is offered to the drafter only if it is this recent. Older, and "I saw your
 * launch of X" is about a product the company may no longer make.
 */
export const FRESH_UPDATE_DAYS = 180;

/** Markdown → readable text: links keep their words, images and bare video links go. */
export function cleanMarkdown(md: string): string {
  return decodeEntities(md)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*https?:\/\/\S+\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A launch post's tagline plus its first real paragraph — not the phone numbers and video
 * links that launch posts open with.
 */
export function launchSummary(tagline: string | null, body: string | null): string {
  const paragraphs = cleanMarkdown(body ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 60 && !/^(call|book|try|watch|sign up|join)\b/i.test(p));
  return [tagline ?? '', paragraphs[0] ?? ''].filter((s) => s.trim() !== '').join(' — ').slice(0, 500);
}

/** "Jan 20, 2026" or an ISO string → ISO. Null when it will not parse. */
export function toIso(date: string | null | undefined): string | null {
  if (date === null || date === undefined || date.trim() === '') return null;
  // "Jan 20, 2026" has no time or zone, and Date.parse reads it in local time — on this laptop
  // that stored it as the 19th. A bare date is a calendar day, so read it as UTC midnight.
  const bare = !/\d:\d|T\d|Z$|[+-]\d\d:?\d\d$/.test(date.trim());
  const ms = Date.parse(bare ? `${date.trim()} 00:00 UTC` : date);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type NewUpdate = { kind: StartupUpdateKind; title: string; summary: string; url: string; published_at: string | null };

/** Launches and press, as the company page lists them. */
export function updatesFromCompanyPage(page: YcCompanyPage): NewUpdate[] {
  return [
    ...page.launches.map((l) => ({
      kind: 'launch' as const,
      title: decodeEntities(l.title),
      summary: launchSummary(l.tagline, l.body),
      url: l.ycdc_launch_url ?? (l.slug !== null ? `https://www.ycombinator.com/launches/${l.slug}` : ''),
      published_at: toIso(l.created_at),
    })),
    ...page.newsItems.map((n) => ({
      kind: 'news' as const,
      title: decodeEntities(n.title),
      summary: '',
      url: n.url,
      published_at: toIso(n.date),
    })),
  ].filter((u) => u.url !== '' && u.title.trim() !== '');
}

export function saveUpdates(db: Db, startupId: number, updates: readonly NewUpdate[]): void {
  const insert = db.prepare(
    `INSERT INTO startup_updates (startup_id, kind, title, summary, url, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (startup_id, url) DO UPDATE SET title = excluded.title, summary = excluded.summary,
       published_at = COALESCE(excluded.published_at, startup_updates.published_at)`,
  );
  const now = nowIso();
  for (const u of updates) insert.run(startupId, u.kind, u.title, u.summary, u.url, u.published_at, now);
}

/** Newest first; undated items last. */
export function updatesOf(db: Db, startupId: number): StartupUpdate[] {
  return (
    db
      .prepare(
        `SELECT * FROM startup_updates WHERE startup_id = ?
          ORDER BY published_at IS NULL, published_at DESC, id DESC`,
      )
      .all(startupId) as Record<string, unknown>[]
  ).map((r) => StartupUpdate.parse(r));
}

type HnHit = { title?: string | null; url?: string | null; created_at?: string; objectID: string; points?: number | null };

/**
 * Hacker News stories about the company: a story linking to its site, or a Show/Launch HN that
 * names it. Algolia's public API, no key.
 *
 * Matching on the *link* is what makes this safe for short names: "Rivet" in a title is a
 * thousand things, a link to `rivet.dev` is one.
 */
export function hnStoriesFor(hits: readonly HnHit[], name: string, domain: string): NewUpdate[] {
  const apex = apexOf(normaliseDomain(domain));
  const named = new RegExp(`\\b${name.replace(/[^a-z0-9 ]/gi, '').trim().replace(/\s+/g, '\\s+')}\\b`, 'i');

  return hits.flatMap((h) => {
    const title = decodeEntities(h.title ?? '').trim();
    if (title === '') return [];
    const host = URL.parse(h.url ?? '')?.hostname;
    const linksHome = host !== undefined && apexOf(normaliseDomain(host)) === apex;
    const announces = /^(show|launch) hn\b/i.test(title) && named.test(title);
    if (!linksHome && !announces) return [];
    return [
      {
        kind: 'hn' as const,
        title,
        summary: '',
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        published_at: toIso(h.created_at),
      },
    ];
  });
}

export async function fetchHnStories(name: string, domain: string, signal?: AbortSignal): Promise<NewUpdate[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=30&query=${encodeURIComponent(domain)}`;
  const res = await getJson<{ hits?: HnHit[] }>(url, { timeoutMs: 15_000, retries: 1, signal });
  return hnStoriesFor(res?.hits ?? [], name, domain);
}

/** The parts of a job page the listing leaves out. Null for a page that is gone. */
export async function fetchJobPage(url: string, signal?: AbortSignal): Promise<YcJobPage | null> {
  const page = await getText(url, { timeoutMs: 20_000, retries: 1, signal, maxBytes: 1024 * 1024 });
  if (page === null) return null;
  const parsed = YcJobPage.safeParse(decodePageProps(page.html));
  if (parsed.success) return parsed.data;

  // Not a YC page: a Peak XV company's own careers site, on whatever ATS it uses. The page's
  // text is the best description there is. A site that renders everything in the browser gives
  // almost nothing, and under 200 characters is reported as no description, not a short one.
  const text = htmlToText(page.html).slice(0, 6000);
  return text.length < 200 ? null : { job: { description: text, interview_process: null, hiringManager: null } };
}

export function saveRoleDetail(db: Db, roleId: number, page: YcJobPage): void {
  const manager = page.job.hiringManager;
  const name = [manager?.first_name ?? '', manager?.last_name ?? ''].join(' ').trim();
  db.prepare(
    `UPDATE startup_roles SET description = ?, interview_process = ?, hiring_manager = ?, detail_fetched_at = ?
      WHERE id = ?`,
  ).run(cleanMarkdown(page.job.description ?? ''), cleanMarkdown(page.job.interview_process ?? ''), name === '' ? null : name, nowIso(), roleId);
}

const olderThan = (iso: string | null, days: number): boolean =>
  iso === null || Date.parse(iso) < Date.now() - days * 86_400_000;

export type BriefDeps = { fetchJobPage?: typeof fetchJobPage; fetchHnStories?: typeof fetchHnStories };

/**
 * Bring a startup's brief up to date: the role's page if it has not been read this week, and
 * Hacker News if it has not been asked in three days. Every failure is logged and survivable —
 * a brief with no HN section is still a brief.
 */
export async function refreshBrief(
  db: Db,
  startup: { id: number; name: string; domain: string | null; updates_fetched_at: string | null },
  role: StartupRole | null,
  log: (msg: string) => void,
  opts: { signal?: AbortSignal } = {},
  deps: BriefDeps = {},
): Promise<void> {
  if (role !== null && olderThan(role.detail_fetched_at, ROLE_REFRESH_DAYS)) {
    try {
      const page = await (deps.fetchJobPage ?? fetchJobPage)(role.url, opts.signal);
      if (page !== null) saveRoleDetail(db, role.id, page);
      else log(`  ${startup.name}: the role page has no data — it may have closed`);
    } catch (err) {
      log(`  ${startup.name}: role page: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (startup.domain !== null && olderThan(startup.updates_fetched_at, UPDATES_REFRESH_DAYS)) {
    try {
      const stories = await (deps.fetchHnStories ?? fetchHnStories)(startup.name, startup.domain, opts.signal);
      transaction(db, () => {
        saveUpdates(db, startup.id, stories);
        db.prepare('UPDATE startups SET updates_fetched_at = ? WHERE id = ?').run(nowIso(), startup.id);
      });
    } catch (err) {
      log(`  ${startup.name}: hacker news: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** "3 months ago", for a reader deciding whether something is current. */
export function ageOf(iso: string | null, now = Date.now()): string {
  if (iso === null) return 'undated';
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 45) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 548) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
}

/** The newest update recent enough to mention in an email, or null. */
export function freshUpdate(updates: readonly StartupUpdate[], now = Date.now()): StartupUpdate | null {
  return (
    updates.find((u) => u.published_at !== null && now - Date.parse(u.published_at) <= FRESH_UPDATE_DAYS * 86_400_000) ??
    null
  );
}

/**
 * A sentence asking for office time, if the description has one. TraceRoot's listing reads
 * "San Francisco / Remote" and ranked high as a remote role; its description says "in person
 * with the founders at least 3 days a week". The listing's location field cannot be trusted
 * alone, and this is the cheapest place to say so.
 */
export function inPersonClause(description: string): string | null {
  const sentence = description
    .split(/(?<=[.!?])\s+|\n+/)
    .find((s) => /\b(in[- ]person|on[- ]?site|in[- ]office|in the office|\d\s*days? (a|per) week)\b/i.test(s) && !/\bremote[- ]first\b/i.test(s));
  return sentence === undefined ? null : sentence.trim().slice(0, 160);
}

const KIND_LABEL: Record<StartupUpdateKind, string> = { launch: 'YC launch', news: 'press', hn: 'Hacker News' };

/** The brief as text, in the order he reads it: the role, then what they are building. */
export function formatBrief(input: {
  name: string;
  one_liner: string;
  source_url: string;
  role: StartupRole | null;
  updates: readonly StartupUpdate[];
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const lines: string[] = [];
  const rule = '─'.repeat(78);

  lines.push(rule, `${input.name} — ${input.one_liner}`, input.source_url, '');

  const r = input.role;
  if (r === null) {
    lines.push('THE ROLE', '  No junior role is listed. This would be an open application.', '');
  } else {
    lines.push(
      `THE ROLE: ${r.title}`,
      `  ${[r.location, r.job_type, r.min_experience || null, r.salary || 'pay not stated'].filter(Boolean).join(' · ')}`,
      `  ${r.url}`,
    );
    if (r.hiring_manager !== null) lines.push(`  Hiring manager on YC: ${r.hiring_manager}`);
    lines.push('');
    lines.push(
      r.description === ''
        ? r.detail_fetched_at === null
          ? '  (description not fetched yet)'
          : '  (the role page has no description)'
        : r.description.split('\n').map((l) => `  ${l}`).join('\n'),
    );
    const inPerson = inPersonClause(r.description);
    if (inPerson !== null && !/\b(bengaluru|bangalore|india)\b/i.test(r.location)) {
      lines.push('', `  ⚠ The listing says remote, but the description says: "${inPerson}"`);
    }
    if (r.interview_process !== '') {
      lines.push('', '  Interview process:', r.interview_process.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    lines.push('');
  }

  lines.push('WHAT THEY ARE WORKING ON — newest first');
  if (input.updates.length === 0) {
    lines.push('  Nothing dated found: no YC launch, no press, no Hacker News story. Check their site.');
  } else {
    for (const u of input.updates.slice(0, 5)) {
      lines.push(`  ${u.published_at?.slice(0, 10) ?? '   undated'}  (${ageOf(u.published_at, now)}, ${KIND_LABEL[u.kind]})  ${u.title}`);
      if (u.summary !== '') lines.push(`      ${u.summary}`);
      lines.push(`      ${u.url}`);
    }
    const fresh = freshUpdate(input.updates, now);
    if (fresh === null) {
      lines.push(
        `  ⚠ Nothing in the last ${Math.round(FRESH_UPDATE_DAYS / 30)} months. The newest item may describe an old product,`,
        '    so the email will not mention it. Look at their site before sending.',
      );
    }
  }
  lines.push(rule);
  return lines.join('\n');
}
