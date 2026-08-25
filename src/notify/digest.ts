/**
 * The digest stage: one Telegram message each morning listing the new matches.
 *
 *   node src/main.ts --stage=digest              send it
 *   node src/main.ts --stage=digest --dry-run    print it, send nothing, mark nothing
 *
 * This is the whole interface in Phase 1 — no web UI, no email yet (`docs/architecture.md`).
 * So the message has to be readable on a phone at 6am: score first, then what to click, then
 * why, then the one line that would open a cold email about it.
 *
 * A job appears exactly once. `jobs.digested_at` is set only after Telegram has accepted the
 * message, so a failed send leaves everything unreported and tomorrow retries it.
 */
import type { StageContext } from '../stage.ts';
import {
  markDigested,
  markDraftsDigested,
  pendingDigestItems,
  pendingDraftItems,
  type DigestItem,
  type DraftItem,
} from '../store/digest.ts';
import { factorLine } from '../match/score.ts';
import { escapeHtml, sendMessage, telegramConfig, type TelegramConfig } from './telegram.ts';

/**
 * Most jobs in one digest. Not a rate limit — a reading limit. Anything past ten is not
 * getting read at 6am, and the rest keep until tomorrow, still marked undigested.
 */
export const MAX_ITEMS_PER_DIGEST = 10;

/**
 * Drafts listed in one digest. Deliberately smaller than the match limit — a match is a link
 * to skim, a draft is an email to read and decide on, and Phase 2 is done when about five of
 * those get read each morning.
 */
export const MAX_DRAFTS_PER_DIGEST = 5;

/** Above this a match is worth a second look; the badge just makes the list scannable. */
const STRONG_MATCH = 85;

/** `10 Aug` — Telegram already shows the time, so the digest only needs the day. */
const shortDate = (at: Date): string =>
  `${at.getDate()} ${at.toLocaleString('en-GB', { month: 'short' })}`;

/**
 * The one line that says what was done about this job, or why nothing was.
 *
 * From Phase 2 the digest is where drafts get reviewed, so this has to answer three
 * questions at a glance: is there a draft, who is it to, and can that address be trusted.
 * `✍️` means a draft is sitting in Gmail; `📮` means an address but no draft yet (the run's
 * draft budget, or a failure); `🔍` means the company's domain never verified, so no address
 * was even guessed at (decision 030).
 */
export function formatOutreach(outreach: DigestItem['outreach']): string | null {
  if (outreach === null) return null;
  if (outreach.unresolved) return '🔍 <i>no verified domain — nothing to write to yet</i>';

  // A guessed address is the common case and needs saying every time: it goes to the
  // approval queue in Phase 3 and can never send itself (invariant 3).
  const trust = outreach.confidence === 'high' ? '' : ' <i>(guessed)</i>';
  const who = `${escapeHtml(outreach.email)}${trust}`;

  return outreach.subject === null
    ? `📮 ${who}`
    : `✍️ ${who}\n<i>${escapeHtml(outreach.subject)}</i>`;
}

/** One job, as a few short lines. Ordering is by score, so nothing needs numbering. */
export function formatItem(item: DigestItem): string {
  const { job, company, score } = item;
  const badge = score.fit_score >= STRONG_MATCH ? '🟢' : '🔵';

  return [
    `${badge} <b>${score.fit_score}</b> · <a href="${escapeHtml(job.url)}">` +
      `${escapeHtml(job.title)}</a>`,
    `<b>${escapeHtml(company)}</b>${job.location ? ` · ${escapeHtml(job.location)}` : ''}`,
    `<code>${escapeHtml(factorLine(score))}</code>`,
    escapeHtml(score.reasoning),
    `↳ ${escapeHtml(score.hook)}`,
    ...(formatOutreach(item.outreach) === null ? [] : [formatOutreach(item.outreach)!]),
  ].join('\n');
}

/**
 * A draft for a job that was reported as a match some other morning.
 *
 * Shorter than a match block on purpose: the score and the reasoning were read when the job
 * was first reported, and what is new is that there is an email waiting in Gmail.
 */
export function formatDraft(draft: DraftItem): string {
  const trust = draft.confidence === 'high' ? '' : ' <i>(guessed)</i>';
  return [
    `✍️ <a href="${escapeHtml(draft.url)}">${escapeHtml(draft.title)}</a> · ` +
      `<b>${escapeHtml(draft.company)}</b>`,
    `→ ${escapeHtml(draft.email)}${trust}`,
    `<i>${escapeHtml(draft.subject)}</i>`,
  ].join('\n');
}

/**
 * The whole message. Blocks are separated by blank lines so `chunk()` can split a long
 * digest between jobs rather than inside one.
 */
export function formatDigest(
  items: DigestItem[],
  opts: { now?: Date; waiting?: number; drafts?: DraftItem[] } = {},
): string {
  const now = opts.now ?? new Date();
  // A draft shown inline under its own match must not be repeated in the drafts section.
  const inline = new Set(items.filter((i) => i.outreach?.subject != null).map((i) => i.job.id));
  const drafts = (opts.drafts ?? []).filter((d) => !inline.has(d.jobId));
  const draftCount = inline.size + drafts.length;

  const header =
    `☀️ <b>${items.length} new match${items.length === 1 ? '' : 'es'}</b> · ${shortDate(now)}` +
    // The drafts are the thing to act on, so the count goes where it is seen first.
    (draftCount === 0 ? '' : ` · ${draftCount} draft${draftCount === 1 ? '' : 's'} to review`);

  const parts = [header, ...items.map((item) => formatItem(item))];

  if (drafts.length > 0) {
    parts.push(`📬 <b>Drafts waiting in Gmail</b>`, ...drafts.map((d) => formatDraft(d)));
  }

  if (opts.waiting !== undefined && opts.waiting > 0) {
    parts.push(`<i>${opts.waiting} more waiting — they will be in tomorrow's digest.</i>`);
  }

  return parts.join('\n\n');
}

/** Injectable so the stage can be tested without a bot token or a network. */
export type DigestDeps = {
  send?: (
    config: TelegramConfig,
    text: string,
    onRetry?: (message: string) => void,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  config?: TelegramConfig;
};

export async function runDigest(ctx: StageContext, deps: DigestDeps = {}): Promise<void> {
  let config = deps.config;
  if (config === undefined) {
    const found = telegramConfig();
    if ('problem' in found) {
      // Not fatal: the jobs stay undigested and the next run reports them.
      ctx.log(found.problem);
      return;
    }
    config = found.config;
  }

  const all = pendingDigestItems(ctx.db);
  const drafts = pendingDraftItems(ctx.db, MAX_DRAFTS_PER_DIGEST);

  if (all.length === 0 && drafts.length === 0) {
    // Deliberately silent. A daily "nothing today" trains you to ignore the bot, and it
    // would break idempotency — a second run in the same morning would send it again.
    // Noticing a *dead* cron is the launchd layer's job (Phase 3), not this message's.
    ctx.log('no new matches to report');
    return;
  }

  const items = all.slice(0, MAX_ITEMS_PER_DIGEST);
  const text = formatDigest(items, { waiting: all.length - items.length, drafts });

  if (ctx.dryRun) {
    ctx.log(`would send ${items.length} match(es) and ${drafts.length} draft(s), ${text.length} chars:\n\n${text}\n`);
    ctx.count('would_send', items.length);
    ctx.count('would_send_drafts', drafts.length);
    return;
  }

  const send = deps.send ?? sendMessage;
  // Retries are logged rather than swallowed: a digest that needed three attempts still
  // arrived, but it says the 06:00 network is unreliable, and that belongs in the log.
  await send(
    config,
    text,
    (m) => {
      ctx.count('send_retry');
      ctx.log(m);
    },
    ctx.signal,
  );

  // Only after Telegram has accepted it. A send that throws leaves every job undigested,
  // which is the safe direction: a repeated digest is annoying, a silently dropped job is
  // the whole point of the tool failing.
  markDigested(
    ctx.db,
    items.map((i) => i.job.id),
  );
  // Every draft the message mentioned, inline under its match or in the drafts section.
  markDraftsDigested(ctx.db, [
    ...items.filter((i) => i.outreach?.subject != null).map((i) => i.job.id),
    ...drafts.map((d) => d.jobId),
  ]);

  ctx.count('reported', items.length);
  ctx.count('reported_drafts', drafts.length);
  ctx.log(
    `sent ${items.length} match(es)` +
      (drafts.length > 0 ? ` and ${drafts.length} draft(s)` : '') +
      (all.length > items.length ? `, ${all.length - items.length} held over` : ''),
  );
}
