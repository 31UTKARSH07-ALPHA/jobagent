/**
 * Startup prospecting: early-stage startups → their founders → a Gmail draft he sends himself.
 *
 * A separate feature from the job pipeline, on purpose (decision 056). It is not a stage, it is
 * not scheduled, and it does not use the Telegram approval queue. Every step is a command he
 * runs, and the last one leaves drafts in Gmail for him to read and send by hand — so the
 * "disarmed" and "tap every email" rules of the pipeline are satisfied by construction: this
 * module has no send path at all.
 *
 *     node src/startups/index.ts --discover          # YC + Peak XV → shortlist → briefs/ for all → new roles to Telegram
 *     node src/startups/index.ts --briefs            # just rewrite briefs/ (+ ideas for the top 3 without)
 *     node src/startups/index.ts --contacts          # founders → addresses (published, GitHub, guessed)
 *     node src/startups/index.ts --list [--top=25]   # the shortlist, best first, with why
 *     node src/startups/index.ts --brief=ressl       # the role in full + what they shipped last
 *     node src/startups/index.ts --ideas=ressl       # + three one-day demo ideas (one Groq call)
 *     node src/startups/index.ts --demo=ressl --url=https://…   # the demo you built; the email links it
 *     node src/startups/index.ts --draft [--limit=3] [--dry-run]   # brief, then email, for the best few
 *     node src/startups/index.ts --status            # which drafts have been sent
 *     node src/startups/index.ts --dead=<email>      # an address bounced: never use it again
 *
 * No Groq call anywhere except `--draft`, which costs one or two per email. Ranking is rules
 * (`./fit.ts`), because the daily pipeline already needs every scoring token there is (055).
 */
import { parseArgs } from 'node:util';
import { transaction, type Db } from '../store/db.ts';
import { escapeHtml } from '../notify/telegram.ts';
import { nowIso, type Profile, type Startup, type StartupRole } from '../store/schema.ts';
import { mapPool } from '../ingest/http.ts';
import { fitOf, type Fit } from './fit.ts';
import { fetchCompanyPage, fetchIndex, isCandidate, ycCompanyUrl } from './yc.ts';
import { fetchPeakXvJobs, toStartups } from './peakxv.ts';
import { findFounderContacts, githubOrg, type FounderDeps } from './people.ts';
import { groqStartupDrafter, type StartupDrafter } from './draft.ts';
import {
  allStartups,
  bestContactOf,
  deadContactsOf,
  hasOutreach,
  needingDetails,
  openRoles,
  peopleOf,
  pipelineAlreadyWrote,
  pipelineDeadEmails,
  saveContacts,
  saveDetails,
  startupById,
  upsertStartup,
} from './store.ts';
import type { DraftWriter } from '../draft/gmail-draft.ts';
import { formatBrief, freshUpdate, refreshBrief, updatesOf, type BriefDeps } from './brief.ts';
import { formatIdeas, groqIdeaWriter, ideasOf, saveIdeas, type IdeaWriter } from './ideas.ts';
import { githubOrg as orgOf } from './people.ts';
import { layoutBriefs, type LayoutEntry } from './layout.ts';

/** A company page is re-read after this long, to catch new roles and closed ones. */
export const REFRESH_DAYS = 7;

/** Company pages per `--discover`. 150 took 19s on 2026-10-05, three at a time, so one run covers the whole list. */
export const MAX_PAGES_PER_RUN = 500;

/**
 * Startups allowed to ask GitHub per `--contacts`. Three requests each against an
 * unauthenticated 60 an hour; a `GITHUB_TOKEN` lifts the hourly limit but not this.
 */
export const MAX_GITHUB_PER_RUN = 15;

/** Re-search a startup with no address after this long — sites change. */
export const CONTACT_RETRY_DAYS = 14;

/**
 * Drafts per `--draft`, and the most that may sit unsent in Gmail at once.
 *
 * The second number is the one that matters. These go out from the same personal account as
 * everything else, so the pace is his sending, not this tool's drafting: if ten are waiting
 * unsent, writing more only buries the good ones.
 */
export const MAX_DRAFTS_PER_RUN = 5;
export const MAX_UNSENT_DRAFTS = 10;

export type Log = (msg: string) => void;

// ─────────────────────────────────────────────────────────────────────────────
// --discover
// ─────────────────────────────────────────────────────────────────────────────

export type DiscoverDeps = {
  fetchIndex?: typeof fetchIndex;
  fetchCompanyPage?: typeof fetchCompanyPage;
  /** Pass `async () => []` to leave Peak XV out — tests do. */
  fetchPeakXvJobs?: typeof fetchPeakXvJobs;
};

export async function discover(
  db: Db,
  log: Log,
  opts: { maxPages?: number; signal?: AbortSignal } = {},
  deps: DiscoverDeps = {},
): Promise<{ candidates: number; fetched: number; failed: number }> {
  const index = await (deps.fetchIndex ?? fetchIndex)(opts.signal);
  const candidates = index.filter(isCandidate);
  log(`YC directory: ${index.length} hiring, ${candidates.length} early-stage in India or open to remote`);

  for (const c of candidates) {
    upsertStartup(db, {
      source: 'yc',
      source_id: c.slug,
      name: c.name,
      website: c.website,
      location: c.all_locations ?? '',
      batch: c.batch ?? '',
      team_size: c.team_size,
      one_liner: c.one_liner ?? '',
      description: c.long_description ?? '',
      tags: [...c.tags, ...c.industries],
      source_url: ycCompanyUrl(c.slug),
    });
  }

  const due = needingDetails(db, REFRESH_DAYS, opts.maxPages ?? MAX_PAGES_PER_RUN);
  const fetchPage = deps.fetchCompanyPage ?? fetchCompanyPage;
  let fetched = 0;
  let failed = 0;

  // Three at a time: polite to one host, and fast enough that 150 pages take about a minute.
  await mapPool(due, 3, async (s) => {
    if (opts.signal?.aborted === true) return;
    try {
      const page = await fetchPage(s.source_id, opts.signal);
      if (page === null) {
        failed++;
        log(`  ${s.name}: no data on the company page`);
        return;
      }
      saveDetails(db, s.id, page);
      fetched++;
    } catch (err) {
      failed++;
      log(`  ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Peak XV's board gives the roles in the same read as the companies, so there are no pages to
  // fetch afterwards. A failure here costs only this source (058).
  try {
    const jobs = await (deps.fetchPeakXvJobs ?? fetchPeakXvJobs)(opts.signal);
    const early = toStartups(jobs);
    for (const { startup, page } of early) saveDetails(db, upsertStartup(db, startup), page);
    log(`Peak XV board: ${jobs.length} jobs, ${early.length} early-stage companies`);
  } catch (err) {
    failed++;
    log(`Peak XV board: ${err instanceof Error ? err.message : String(err)}`);
  }

  const remaining = needingDetails(db, REFRESH_DAYS, 10_000).length;
  log(`company pages: ${fetched} read, ${failed} failed${remaining > 0 ? `, ${remaining} still to read — run --discover again` : ''}`);
  return { candidates: candidates.length, fetched, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// The shortlist
// ─────────────────────────────────────────────────────────────────────────────

export type Shortlisted = { startup: Startup; roles: StartupRole[]; fit: Fit };

/** Every startup worth writing to, best first. */
export function shortlist(db: Db): Shortlisted[] {
  return allStartups(db)
    .flatMap((startup) => {
      const roles = openRoles(db, startup.id);
      const fit = fitOf({ ...startup, roles });
      return fit === null ? [] : [{ startup, roles, fit }];
    })
    .sort((a, b) => b.fit.rank - a.fit.rank || a.startup.id - b.startup.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram: the short list of new startup roles (059)
// ─────────────────────────────────────────────────────────────────────────────

/** Lines per message. The first run has a backlog; the rest arrive on the next `--discover`. */
export const MAX_ROLES_PER_MESSAGE = 15;

/**
 * The new roles as one Telegram message, best first. Plain lines and links, no buttons: this is
 * a list to read, and it must never be confused with the job pipeline's approve/reject taps.
 */
export function rolesMessage(items: readonly { startup: Startup; role: StartupRole; fit: Fit }[]): string {
  const lines = items.map(({ startup, role, fit }) =>
    [
      `<b>${escapeHtml(startup.name)}</b> — <a href="${escapeHtml(role.url)}">${escapeHtml(role.title)}</a>`,
      `${escapeHtml(fit.why)} · rank ${fit.rank}`,
    ].join('\n'),
  );
  return [
    `🚀 <b>${items.length} new startup role${items.length === 1 ? '' : 's'}</b> (YC / Peak XV)`,
    '',
    lines.join('\n\n'),
    '',
    '<i>Briefs and demo ideas: ~/jobagent/briefs/_index.md</i>',
  ].join('\n');
}

/**
 * Announce roles not announced before. Marked only after Telegram accepts the message, so a
 * failed send is retried by the next run rather than lost — the digest's rule (014).
 */
export async function notifyNewRoles(
  db: Db,
  log: Log,
  deps: { send?: (text: string) => Promise<void> } = {},
): Promise<number> {
  const fresh = shortlist(db)
    .flatMap(({ startup, roles, fit }) => {
      const role = fit.best === null ? null : roles[fit.best.index];
      return role === undefined || role === null || role.notified_at !== null ? [] : [{ startup, role, fit }];
    })
    .slice(0, MAX_ROLES_PER_MESSAGE);
  if (fresh.length === 0) {
    log('Telegram: no new startup roles to announce');
    return 0;
  }

  let send = deps.send;
  if (send === undefined) {
    const { telegramConfig, sendMessage } = await import('../notify/telegram.ts');
    const cfg = telegramConfig();
    if ('problem' in cfg) {
      log(`Telegram: not sent — ${cfg.problem}`);
      return 0;
    }
    send = async (text) => {
      await sendMessage(cfg.config, text);
    };
  }

  await send(rolesMessage(fresh));
  const mark = db.prepare('UPDATE startup_roles SET notified_at = ? WHERE id = ?');
  const now = nowIso();
  transaction(db, () => {
    for (const { role } of fresh) mark.run(now, role.id);
  });
  log(`Telegram: announced ${fresh.length} startup role(s)`);
  return fresh.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// --contacts
// ─────────────────────────────────────────────────────────────────────────────

export async function findContactsForShortlist(
  db: Db,
  log: Log,
  opts: { limit?: number; signal?: AbortSignal } = {},
  deps: FounderDeps = {},
): Promise<{ searched: number; found: number }> {
  const retryBefore = new Date(Date.now() - CONTACT_RETRY_DAYS * 86_400_000).toISOString();
  const dead = pipelineDeadEmails(db);

  const due = shortlist(db).filter(
    ({ startup }) =>
      startup.domain !== null &&
      bestContactOf(db, startup.id) === null &&
      (startup.contacts_checked_at === null || startup.contacts_checked_at < retryBefore),
  );
  const batch = due.slice(0, opts.limit ?? 30);
  log(`${due.length} shortlisted startup(s) with no address yet; searching ${batch.length}`);

  let github = MAX_GITHUB_PER_RUN;
  let found = 0;
  for (const { startup } of batch) {
    if (opts.signal?.aborted === true) break;
    const people = peopleOf(db, startup.id);
    // `githubOrg`, not `github_url !== null`: YC stores an empty string for most companies, and
    // the null check let 15 of them spend the whole GitHub budget on the first live run before
    // a single startup with a real org was reached.
    const allowGithub = github > 0 && githubOrg(startup.github_url) !== null;
    if (allowGithub) github--;

    // One startup cannot hold up the rest — the same 45s the pipeline gives a company (025).
    const signal = AbortSignal.any([
      ...(opts.signal === undefined ? [] : [opts.signal]),
      AbortSignal.timeout(45_000),
    ]);
    try {
      const candidates = await findFounderContacts(
        { name: startup.name, domain: startup.domain!, github_url: startup.github_url },
        people,
        { signal, allowGithub, exclude: [...dead, ...deadContactsOf(db, startup.id)], log: (m) => log(`  ${startup.name}: ${m}`) },
        deps,
      );
      saveContacts(db, startup.id, candidates);
      const best = candidates[0];
      if (best !== undefined) {
        found++;
        log(`  ${startup.name}: ${best.email} (${best.source}, ${best.confidence})${best.name ? ` — ${best.name}` : ''}`);
      } else {
        log(
          people.length === 0
            ? `  ${startup.name}: no address published at ${startup.domain}, and no founder names to guess from`
            : `  ${startup.name}: nothing that takes mail at ${startup.domain}`,
        );
      }
    } catch (err) {
      log(`  ${startup.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { searched: batch.length, found };
}

// ─────────────────────────────────────────────────────────────────────────────
// --draft
// ─────────────────────────────────────────────────────────────────────────────

/** How the email describes where he can work, from where the role is. */
export function whereFor(fit: Fit): string {
  if (fit.reach === 'remote') return 'remotely, from Bengaluru, India';
  if (fit.reach === 'bengaluru') return 'in Bengaluru, on site or remotely';
  return 'remotely from Bengaluru, or on site in India';
}

export function unsentDrafts(db: Db): number {
  return (db.prepare('SELECT count(*) AS n FROM startup_outreach WHERE sent_at IS NULL').get() as { n: number }).n;
}

export type DraftDeps = { drafter?: StartupDrafter; writeDraft?: DraftWriter; profile?: Profile; brief?: BriefDeps };

/**
 * Refresh one startup's brief and return it with what the drafter needs from it.
 *
 * The role is re-read after the refresh: its description is written by `refreshBrief`, and the
 * copy the shortlist holds was loaded before that.
 */
export async function briefFor(
  db: Db,
  item: Shortlisted,
  log: Log,
  opts: { signal?: AbortSignal } = {},
  deps: BriefDeps = {},
): Promise<{ text: string; role: StartupRole | null; latest: ReturnType<typeof freshUpdate> }> {
  const listed = item.fit.best === null ? null : (item.roles[item.fit.best.index] ?? null);
  await refreshBrief(db, item.startup, listed, log, opts, deps);
  return briefText(db, item);
}

/**
 * The brief from what is already stored: no network, so the whole `briefs/` tree can be
 * re-laid out in a moment after any one startup changes (060).
 */
export function briefText(db: Db, item: Shortlisted): { text: string; role: StartupRole | null; latest: ReturnType<typeof freshUpdate> } {
  const listed = item.fit.best === null ? null : (item.roles[item.fit.best.index] ?? null);
  const role = listed === null ? null : (openRoles(db, item.startup.id).find((r) => r.id === listed.id) ?? listed);
  const updates = updatesOf(db, item.startup.id);
  const brief = formatBrief({ name: item.startup.name, one_liner: item.startup.one_liner, source_url: item.startup.source_url, role, updates });
  const demo = item.startup.demo_url === null ? '' : `\nYOUR DEMO FOR THEM: ${item.startup.demo_url} — the email will link it.`;
  return {
    // Ideas from the cache only — generating them costs a Groq call and is `--ideas`' job.
    text: `${brief}\n${formatIdeas(ideasOf(db, item.startup.id))}${demo}\n${'─'.repeat(78)}`,
    role,
    latest: freshUpdate(updates),
  };
}

/** Where briefs go: a folder tree regenerated every run, gitignored (060). */
export const briefsDir = (): string => process.env['JOBAGENT_BRIEFS'] ?? 'briefs';

/** Lay out every shortlisted startup's brief in `briefs/`, from stored data only. */
export function layoutAll(db: Db): { index: string; files: Map<number, string> } {
  const entries: LayoutEntry[] = shortlist(db).map((item) => {
    const contact = bestContactOf(db, item.startup.id);
    const { text, role } = briefText(db, item);
    return {
      startup: item.startup,
      fit: item.fit,
      roleTitle: role?.title ?? null,
      email: contact === null ? null : `${contact.source}, ${contact.confidence}`,
      hasIdeas: ideasOf(db, item.startup.id) !== null,
      emailed: hasOutreach(db, item.startup.id),
      text,
    };
  });
  return layoutBriefs(briefsDir(), entries, nowIso());
}

/**
 * Demo ideas written per run, for the best startups that have none yet.
 *
 * One call is ~4,000 tokens. Ideas for all 49 startups on the first shortlist would be ~200k,
 * which is Groq's whole rolling daily allowance, the one the 18:00 pipeline needs (055). Three
 * per run fills the list over a couple of weeks of `--discover`, best first; `--ideas=<name>`
 * gets any one immediately.
 */
export const MAX_IDEAS_PER_RUN = 3;

/**
 * A brief file for every shortlisted startup, demo ideas for the best few that lack them, and
 * `_index.md` listing them all best first. His expectation, 2026-10-06: every startup found
 * should already have a brief waiting in `briefs/`, not only the ones asked about.
 *
 * Briefs are free (YC pages and Hacker News). A Groq failure stops the ideas for this run, never
 * the briefs; the rest are tried next time.
 */
export async function writeAllBriefs(
  db: Db,
  log: Log,
  opts: { ideas?: number; signal?: AbortSignal } = {},
  deps: { writer?: IdeaWriter; profile?: Profile; brief?: BriefDeps } = {},
): Promise<{ briefs: number; ideas: number; index: string }> {
  const list = shortlist(db);
  let ideasLeft = opts.ideas ?? MAX_IDEAS_PER_RUN;
  let ideas = 0;

  for (const item of list) {
    if (opts.signal?.aborted === true) break;
    try {
      if (ideasLeft > 0 && ideasOf(db, item.startup.id) === null) {
        try {
          await ideasFor(db, item, log, { signal: opts.signal }, deps);
          ideas++;
          ideasLeft--;
          continue;
        } catch (err) {
          log(`  ${item.startup.name}: demo ideas not written — ${err instanceof Error ? err.message : String(err)}; trying again next run`);
          ideasLeft = 0;
        }
      }
      await briefFor(db, item, log, opts, deps.brief);
    } catch (err) {
      log(`  ${item.startup.name}: brief not refreshed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { index, files } = layoutAll(db);
  log(`briefs: ${files.size} laid out, demo ideas for ${ideas} more — open ${index}`);
  return { briefs: files.size, ideas, index };
}

/**
 * Demo ideas for one startup: refresh its brief, then one Groq call unless ideas are cached.
 * `regenerate` replaces cached ideas — after a new launch, say.
 */
export async function ideasFor(
  db: Db,
  item: Shortlisted,
  log: Log,
  opts: { regenerate?: boolean; signal?: AbortSignal } = {},
  deps: { writer?: IdeaWriter; profile?: Profile; brief?: BriefDeps } = {},
): Promise<string> {
  const first = await briefFor(db, item, log, opts, deps.brief);
  if (ideasOf(db, item.startup.id) === null || opts.regenerate === true) {
    const writer = deps.writer ?? groqIdeaWriter;
    const profile = deps.profile ?? (await import('../match/profile.ts')).loadProfile();
    const org = orgOf(item.startup.github_url);
    const body = await writer.write(first.text, profile, org === null ? null : `https://github.com/${org}`, opts.signal);
    saveIdeas(db, item.startup.id, body, writer.model);
  }
  return (await briefFor(db, item, log, opts, deps.brief)).text;
}

/** Record the demo he built, so the email links it. Null clears it. */
export function setDemo(db: Db, startupId: number, url: string | null): void {
  db.prepare('UPDATE startups SET demo_url = ? WHERE id = ?').run(url, startupId);
}

export async function draftBest(
  db: Db,
  log: Log,
  opts: { limit?: number; dryRun?: boolean; signal?: AbortSignal } = {},
  deps: DraftDeps = {},
): Promise<{ drafted: number }> {
  const room = MAX_UNSENT_DRAFTS - unsentDrafts(db);
  const limit = Math.min(opts.limit ?? 3, MAX_DRAFTS_PER_RUN, opts.dryRun === true ? MAX_DRAFTS_PER_RUN : room);
  if (limit <= 0) {
    log(`${MAX_UNSENT_DRAFTS} startup drafts are waiting unsent in Gmail — send or delete some first (--status)`);
    return { drafted: 0 };
  }

  const dead = new Set(pipelineDeadEmails(db));
  const ready = shortlist(db)
    .map((item) => ({ ...item, contact: bestContactOf(db, item.startup.id) }))
    .filter(
      (item) =>
        item.contact !== null &&
        !dead.has(item.contact.email) &&
        !hasOutreach(db, item.startup.id) &&
        // Never a second cold email to a company the job pipeline is already writing to.
        !(item.startup.domain !== null && pipelineAlreadyWrote(db, item.startup.domain)),
    )
    .slice(0, limit);

  if (ready.length === 0) {
    log('nothing ready — run --discover, then --contacts');
    return { drafted: 0 };
  }

  const profile = deps.profile ?? (await import('../match/profile.ts')).loadProfile();
  const drafter = deps.drafter ?? groqStartupDrafter;
  const write = deps.writeDraft ?? (await import('../draft/gmail-draft.ts')).createGmailDraft;

  let drafted = 0;
  for (const item of ready) {
    if (opts.signal?.aborted === true) break;
    const contact = item.contact!;
    try {
      // His rule, 2026-10-05: the role in full and what they shipped last, *before* the email —
      // printed first so it is read first, and handed to the drafter so the email is built on it.
      const brief = await briefFor(db, item, log, opts, deps.brief);
      log('');
      log(brief.text);

      const draft = await drafter.compose(item.startup, brief.role, profile, contact.name, whereFor(item.fit), brief.latest, opts.signal);
      const role = brief.role;

      log(`── EMAIL · ${item.startup.name} · rank ${item.fit.rank} · ${item.fit.why}`);
      log(`   to ${contact.email} (${contact.source}, ${contact.confidence}${contact.confidence === 'low' ? ' — a GUESS, may bounce' : ''})`);
      log(`   Subject: ${draft.subject}`);
      log(draft.body.split('\n').map((l) => `   ${l}`).join('\n'));

      if (opts.dryRun === true) continue;

      // Draft first, row second — the job pipeline's order. A row with no draft would block
      // this startup for ever; a draft with no row is re-drafted next run and he deletes one.
      const created = await write({ to: contact.email, subject: draft.subject, body: draft.body }, opts.signal);
      db.prepare(
        `INSERT INTO startup_outreach (startup_id, contact_id, role_id, subject, body, gmail_draft_id, drafted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(item.startup.id, contact.id, role?.id ?? null, draft.subject, draft.body, created.draftId, nowIso());
      drafted++;
    } catch (err) {
      log(`  ${item.startup.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.dryRun !== true && drafted > 0) {
    log(`\n${drafted} draft(s) are in Gmail → Drafts. Read each one, then send it yourself.`);
    // Out of the to-do folders and into 4-emailed (060). Only when a real briefs folder exists,
    // so a test never writes one.
    const { existsSync } = await import('node:fs');
    if (existsSync(briefsDir())) layoutAll(db);
  }
  return { drafted };
}

// ─────────────────────────────────────────────────────────────────────────────
// --status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read back which drafts he has sent. By label, never by existence: `drafts.get` answers 200 for
 * a draft that has already gone, labelled `SENT` (decision 044).
 */
export async function syncStatus(db: Db, log: Log): Promise<void> {
  const { draftStatus } = await import('../send/deliver.ts');
  const rows = db
    .prepare(
      `SELECT o.id, o.gmail_draft_id, o.sent_at, o.drafted_at, s.name, k.email, k.confidence
         FROM startup_outreach o JOIN startups s ON s.id = o.startup_id JOIN startup_contacts k ON k.id = o.contact_id
        ORDER BY o.id`,
    )
    .all() as {
    id: number;
    gmail_draft_id: string;
    sent_at: string | null;
    drafted_at: string;
    name: string;
    email: string;
    confidence: string;
  }[];
  if (rows.length === 0) {
    log('no startup drafts yet');
    return;
  }

  for (const row of rows) {
    let state = row.sent_at === null ? 'waiting in Drafts' : `sent ${row.sent_at.slice(0, 10)}`;
    if (row.sent_at === null) {
      try {
        const facts = await draftStatus(row.gmail_draft_id);
        if (facts.status === 'sent') {
          const at = facts.sentAt ?? nowIso();
          db.prepare('UPDATE startup_outreach SET sent_at = ?, checked_at = ? WHERE id = ?').run(at, nowIso(), row.id);
          state = `sent ${at.slice(0, 10)}`;
        } else if (facts.status === 'missing') {
          state = 'deleted from Drafts';
          db.prepare('UPDATE startup_outreach SET checked_at = ? WHERE id = ?').run(nowIso(), row.id);
        } else {
          db.prepare('UPDATE startup_outreach SET checked_at = ? WHERE id = ?').run(nowIso(), row.id);
        }
      } catch (err) {
        state = `could not check: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    log(`  ${row.name.padEnd(28)} ${row.email.padEnd(36)} ${row.confidence.padEnd(6)} ${state}`);
  }
}

/** An address bounced: retire it, so the next `--contacts` finds the next best. */
export function markDead(db: Db, email: string): number {
  return Number(
    db
      .prepare('UPDATE startup_contacts SET dead_at = ? WHERE lower(email) = lower(?) AND dead_at IS NULL')
      .run(nowIso(), email.trim()).changes,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function printShortlist(db: Db, top: number, log: Log): void {
  const list = shortlist(db);
  log(`${list.length} startup(s) on the shortlist${list.length > top ? `, top ${top}` : ''}:\n`);
  for (const { startup, roles, fit } of list.slice(0, top)) {
    const contact = bestContactOf(db, startup.id);
    const role = fit.best === null ? null : roles[fit.best.index];
    log(`${String(fit.rank).padStart(3)}  [${startup.id}] ${startup.name} (${startup.batch || 'Peak XV portfolio'}, ${startup.team_size ?? '?'} people) — ${startup.one_liner}`);
    log(`     ${fit.why}${role ? ` · "${role.title}" — ${role.url}` : ` · ${startup.source_url}`}`);
    log(
      `     ${
        contact === null
          ? startup.contacts_checked_at === null
            ? 'no address yet — run --contacts'
            : 'no address found'
          : `${contact.email} (${contact.source}, ${contact.confidence})${contact.name ? ` — ${contact.name}` : ''}`
      }${hasOutreach(db, startup.id) ? ' · drafted' : ''}`,
    );
  }
}

if (import.meta.main) {
  (await import('../env.ts')).loadEnv();
  const { openDb, DEFAULT_DB_PATH } = await import('../store/db.ts');

  const { values } = parseArgs({
    options: {
      discover: { type: 'boolean', default: false },
      contacts: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      draft: { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      show: { type: 'string' },
      brief: { type: 'string' },
      ideas: { type: 'string' },
      regenerate: { type: 'boolean', default: false },
      demo: { type: 'string' },
      url: { type: 'string' },
      dead: { type: 'string' },
      top: { type: 'string', default: '25' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-telegram': { type: 'boolean', default: false },
      notify: { type: 'boolean', default: false },
      briefs: { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const db = openDb(values.db);
  const log: Log = (m) => console.log(m);
  const limit = values.limit === undefined ? undefined : Number(values.limit);

  if (values.discover) {
    await discover(db, log, { maxPages: limit });
    await writeAllBriefs(db, log);
    if (!values['no-telegram']) await notifyNewRoles(db, log);
  } else if (values.briefs) await writeAllBriefs(db, log);
  else if (values.notify) await notifyNewRoles(db, log);
  else if (values.contacts) await findContactsForShortlist(db, log, { limit });
  else if (values.list) printShortlist(db, Number(values.top), log);
  else if (values.draft) await draftBest(db, log, { limit, dryRun: values['dry-run'] });
  else if (values.status) await syncStatus(db, log);
  else if (values.dead !== undefined) log(`${markDead(db, values.dead)} address(es) retired`);
  else if (values.brief !== undefined || values.ideas !== undefined || values.demo !== undefined) {
    // By shortlist id or by name, because the name is what he reads in --list.
    const wanted = (values.brief ?? values.ideas ?? values.demo ?? '').trim().toLowerCase();
    const item = shortlist(db).find((x) => String(x.startup.id) === wanted || x.startup.name.toLowerCase().includes(wanted));
    if (item === undefined) log(`no shortlisted startup matches "${wanted}" — see --list`);
    else if (values.demo !== undefined) {
      setDemo(db, item.startup.id, values.url ?? null);
      log(values.url === undefined ? `${item.startup.name}: demo link cleared` : `${item.startup.name}: the email will link ${values.url}`);
    } else {
      const text =
        values.ideas !== undefined
          ? await ideasFor(db, item, log, { regenerate: values.regenerate })
          : (await briefFor(db, item, log)).text;
      log(text);
      const { files, index } = layoutAll(db);
      log(`\nsaved to ${files.get(item.startup.id) ?? index}\nall briefs: ${index}`);
    }
  }
  else if (values.show !== undefined) {
    const s = startupById(db, Number(values.show));
    if (s === null) log('no such startup');
    else {
      log(JSON.stringify({ ...s, description: `${s.description.slice(0, 300)}…` }, null, 2));
      log(`people: ${peopleOf(db, s.id).map((p) => `${p.name} (${p.title})`).join(', ')}`);
      log(`open roles:\n${openRoles(db, s.id).map((r) => `  ${r.title} · ${r.location} · ${r.min_experience} · ${r.salary}`).join('\n')}`);
      const contacts = db.prepare('SELECT email, source, confidence, rank, found_at, dead_at FROM startup_contacts WHERE startup_id = ? ORDER BY rank DESC').all(s.id);
      log(`addresses:\n${(contacts as Record<string, unknown>[]).map((c) => `  ${c['email']} · ${c['source']} · ${c['confidence']} · ${c['found_at']}${c['dead_at'] ? ' · DEAD' : ''}`).join('\n')}`);
    }
  } else {
    console.log(
      'usage: node src/startups/index.ts (--discover | --contacts | --list [--top=N] | --brief=<name|id> | --ideas=<name> [--regenerate] | --demo=<name> --url=<link> | --draft [--limit=N] [--dry-run] | --status | --show=<id> | --dead=<email>) [--limit=N]',
    );
    process.exit(values.help ? 0 : 2);
  }
}
