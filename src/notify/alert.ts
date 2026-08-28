/**
 * The instant alert: a strong match, the hour it is found, rather than at 06:00 tomorrow.
 *
 * This exists because of a measurement (decision 036). Alert-email postings reach us a median
 * of 3–12 hours after the email lands, and the email itself is a *daily digest* from LinkedIn
 * or Naukri — so by the time a posting arrives that way it has been open for a day and has a
 * hundred applicants. The part of that delay we own is the daily poll, and this is the half of
 * the fix that turns a fast poll into something he actually sees.
 *
 * **It is deliberately rare.** The bar is `ALERT_THRESHOLD`, and a posting with no description
 * can never clear it — decision 023 caps title-only scores at 84. So an alert means a fully
 * described posting that scored above the auto-send band, which under rubric v4 is 1 job in 91.
 * A ping that fires every hour is a ping he learns to swipe away (the same reasoning that
 * keeps the digest silent when nothing matched, decision 014).
 *
 * A job alerted here is marked digested, so the morning digest does not report it again. One
 * job, one message, whichever stage gets there first.
 */
import type { StageContext } from '../stage.ts';
import { markDigested, pendingDigestItems } from '../store/digest.ts';
import { formatItem } from './digest.ts';
import { sendMessage, telegramConfig, type TelegramConfig } from './telegram.ts';

/**
 * The score a posting must reach to interrupt him.
 *
 * 85 is not a new number: it is the auto-send band from decision 006 and the digest's own
 * "strong match" badge. It also sits one point above the title-only ceiling of 84 (decision
 * 023), which means this can only ever fire for a posting whose full description was read —
 * exactly the case where applying early is worth the interruption.
 */
export const ALERT_THRESHOLD = 85;

/** Most alerts in one run. A burst past this is a backlog, and the digest is for backlogs. */
export const MAX_ALERTS_PER_RUN = 3;

export type AlertDeps = {
  send?: (
    config: TelegramConfig,
    text: string,
    onRetry?: (message: string) => void,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  config?: TelegramConfig;
};

export async function runAlert(ctx: StageContext, deps: AlertDeps = {}): Promise<void> {
  const strong = pendingDigestItems(ctx.db, MAX_ALERTS_PER_RUN, ALERT_THRESHOLD);

  if (strong.length === 0) {
    // Silent, and silent is the normal case — see the note at the top of this file.
    ctx.log(`nothing at or above ${ALERT_THRESHOLD}`);
    return;
  }

  let config = deps.config;
  if (config === undefined) {
    const found = telegramConfig();
    if ('problem' in found) {
      // The jobs stay undigested, so the 06:00 digest still reports them. A missing token
      // costs promptness, never the job itself.
      ctx.log(found.problem);
      return;
    }
    config = found.config;
  }

  const text = [
    `🔥 <b>Strong match just in</b> — apply now, not tomorrow`,
    ...strong.map((item) => formatItem(item)),
  ].join('\n\n');

  if (ctx.dryRun) {
    ctx.log(`would alert on ${strong.length}:\n\n${text}\n`);
    ctx.count('would_alert', strong.length);
    return;
  }

  const send = deps.send ?? sendMessage;
  await send(
    config,
    text,
    (m) => {
      ctx.count('send_retry');
      ctx.log(m);
    },
    ctx.signal,
  );

  // Only after Telegram accepted it, and this is also what stops the morning digest
  // repeating the job (invariant 4).
  markDigested(
    ctx.db,
    strong.map((i) => i.job.id),
  );

  ctx.count('alerted', strong.length);
  ctx.log(`alerted on ${strong.length} strong match(es)`);
}
