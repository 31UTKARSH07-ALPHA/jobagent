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
import { markDigested, pendingDigestItems, type DigestItem } from '../store/digest.ts';
import { PROMPT_VERSION, factorLine } from '../match/score.ts';
import { escapeHtml, sendMessage, telegramConfig, type TelegramConfig } from './telegram.ts';

/**
 * Most jobs in one digest. Not a rate limit — a reading limit. Anything past ten is not
 * getting read at 6am, and the rest keep until tomorrow, still marked undigested.
 */
export const MAX_ITEMS_PER_DIGEST = 10;

/** Above this a match is worth a second look; the badge just makes the list scannable. */
const STRONG_MATCH = 85;

/** `10 Aug` — Telegram already shows the time, so the digest only needs the day. */
const shortDate = (at: Date): string =>
  `${at.getDate()} ${at.toLocaleString('en-GB', { month: 'short' })}`;

/** One job, as five short lines. Ordering is by score, so nothing needs numbering. */
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
  ].join('\n');
}

/**
 * The whole message. Blocks are separated by blank lines so `chunk()` can split a long
 * digest between jobs rather than inside one.
 */
export function formatDigest(
  items: DigestItem[],
  opts: { now?: Date; waiting?: number } = {},
): string {
  const now = opts.now ?? new Date();
  const header =
    `☀️ <b>${items.length} new match${items.length === 1 ? '' : 'es'}</b> · ${shortDate(now)}`;

  const parts = [header, ...items.map((item) => formatItem(item))];

  if (opts.waiting !== undefined && opts.waiting > 0) {
    parts.push(`<i>${opts.waiting} more waiting — they will be in tomorrow's digest.</i>`);
  }

  return parts.join('\n\n');
}

/** Injectable so the stage can be tested without a bot token or a network. */
export type DigestDeps = {
  send?: (config: TelegramConfig, text: string) => Promise<unknown>;
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

  const all = pendingDigestItems(ctx.db, PROMPT_VERSION);
  if (all.length === 0) {
    // Deliberately silent. A daily "nothing today" trains you to ignore the bot, and it
    // would break idempotency — a second run in the same morning would send it again.
    // Noticing a *dead* cron is the launchd layer's job (Phase 3), not this message's.
    ctx.log('no new matches to report');
    return;
  }

  const items = all.slice(0, MAX_ITEMS_PER_DIGEST);
  const text = formatDigest(items, { waiting: all.length - items.length });

  if (ctx.dryRun) {
    ctx.log(`would send ${items.length} match(es), ${text.length} chars:\n\n${text}\n`);
    ctx.count('would_send', items.length);
    return;
  }

  const send = deps.send ?? sendMessage;
  await send(config, text);

  // Only after Telegram has accepted it. A send that throws leaves every job undigested,
  // which is the safe direction: a repeated digest is annoying, a silently dropped job is
  // the whole point of the tool failing.
  markDigested(
    ctx.db,
    items.map((i) => i.job.id),
  );

  ctx.count('reported', items.length);
  ctx.log(`sent ${items.length} match(es)${all.length > items.length ? `, ${all.length - items.length} held over` : ''}`);
}
