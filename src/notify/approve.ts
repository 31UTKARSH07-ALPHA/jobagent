/**
 * The approval loop: show him a draft, wait for a tap, act on it.
 *
 * This is where a person is required. Auto-send covers one narrow case — an address published
 * on the company's own site *and* a score above the band a description-less posting can reach
 * (decision 006). Everything else lands here, because an email to a stranger cannot be
 * unsent and the machine is not confident enough to make that call alone.
 *
 * It is also the only feedback this system ever gets. Nothing else says whether the scoring
 * and the writing are any good; a run of rejections means something upstream is wrong.
 *
 * **No daemon and no bot framework.** Telegram delivers taps by webhook — needing a public
 * HTTPS endpoint this laptop does not have — or by `getUpdates`, a cursor you poll. The send
 * agent already runs every ten minutes, so polling fits what is here and a tap is acted on
 * within ten minutes of being made (decision 042).
 */
import type { StageContext } from '../stage.ts';
import { nowIso } from '../store/schema.ts';
import { tryTransition } from '../store/state.ts';
import {
  answerTap,
  getTaps,
  sendWithButtons,
  settleButtons,
  telegramConfig,
  escapeHtml,
  type TelegramConfig,
  type Tap,
} from './telegram.ts';

/** Drafts to ask about in one run. A phone full of decisions is a phone put down. */
export const MAX_ASKS_PER_RUN = 3;

const OFFSET_KEY = 'telegram_update_offset';

export function readOffset(ctx: StageContext): number {
  const row = ctx.db.prepare('SELECT value FROM app_state WHERE key = ?').get(OFFSET_KEY) as
    | { value: string }
    | undefined;
  return row === undefined ? 0 : Number(row.value);
}

export function writeOffset(ctx: StageContext, offset: number): void {
  ctx.db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(OFFSET_KEY, String(offset), nowIso());
}

type Askable = {
  outreach_id: number;
  job_id: number;
  company: string;
  title: string;
  url: string;
  email: string;
  confidence: string;
  subject: string;
  body: string;
};

/** Waiting on a tap, and not asked about yet. */
function unasked(ctx: StageContext, limit: number): Askable[] {
  return ctx.db
    .prepare(
      `SELECT o.id AS outreach_id, o.job_id, c.name AS company, j.title, j.url,
              k.email, k.confidence, o.subject, o.body
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE j.state = 'PENDING_APPROVAL'
          AND o.approved_at IS NULL
          AND o.approval_asked_at IS NULL
          AND o.sent_at IS NULL
        ORDER BY o.id
        LIMIT ?`,
    )
    .all(limit) as Askable[];
}

/**
 * The whole email, because that is what is being approved.
 *
 * A summary would make this a rubber stamp — the entire point is that a human reads the words
 * before a stranger does. The address gets its own line, marked when it was guessed, because
 * "is this the right person" is the other half of the decision.
 */
export function formatAsk(item: Askable): string {
  const trust = item.confidence === 'high' ? 'published on their site' : 'guessed';
  return [
    `📤 <b>${escapeHtml(item.company)}</b> · <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`,
    `To: ${escapeHtml(item.email)} <i>(${trust})</i>`,
    `<b>${escapeHtml(item.subject)}</b>`,
    '',
    escapeHtml(item.body),
  ].join('\n');
}

export type ApproveDeps = {
  config?: TelegramConfig;
  ask?: typeof sendWithButtons;
  taps?: typeof getTaps;
  answer?: typeof answerTap;
  settle?: typeof settleButtons;
};

export async function runApprove(ctx: StageContext, deps: ApproveDeps = {}): Promise<void> {
  let config = deps.config;
  if (config === undefined) {
    const found = telegramConfig();
    if ('problem' in found) {
      ctx.log(found.problem);
      return;
    }
    config = found.config;
  }

  const ask = deps.ask ?? sendWithButtons;
  const taps = deps.taps ?? getTaps;
  const answer = deps.answer ?? answerTap;
  const settle = deps.settle ?? settleButtons;

  // ── Ask about anything new ─────────────────────────────────────────────────
  for (const item of unasked(ctx, MAX_ASKS_PER_RUN)) {
    if (ctx.dryRun) {
      ctx.count('would_ask');
      ctx.log(`would ask about ${item.company} → ${item.email}`);
      continue;
    }

    try {
      const sent = await ask(
        config,
        formatAsk(item),
        [
          { label: '✅ Send it', data: { action: 'approve', outreachId: item.outreach_id } },
          { label: '🗑 Skip', data: { action: 'reject', outreachId: item.outreach_id } },
        ],
        ctx.signal,
      );
      // Recorded only after Telegram accepted it, so a failed ask is retried rather than
      // silently swallowed — the same rule the digest follows.
      ctx.db
        .prepare('UPDATE outreach SET approval_asked_at = ? WHERE id = ?')
        .run(nowIso(), item.outreach_id);
      ctx.db
        .prepare(
          `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`ask_message_${item.outreach_id}`, String(sent.message_id), nowIso());

      ctx.count('asked');
      ctx.log(`asked about ${item.company} → ${item.email}`);
    } catch (err) {
      ctx.count('ask_failed');
      ctx.log(`could not ask about ${item.company}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Act on taps ────────────────────────────────────────────────────────────
  let pending: Tap[];
  try {
    pending = await taps(config, readOffset(ctx), ctx.signal);
  } catch (err) {
    ctx.log(`could not read taps: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const tap of pending) {
    // Advance the cursor for every update we have looked at, including ones we refuse to act
    // on — otherwise a single bad update is replayed forever and blocks every tap behind it.
    writeOffset(ctx, tap.updateId + 1);

    // A tap from anywhere but the configured chat is somebody else pressing this bot's
    // buttons. The token is a secret, but a leaked one must not be able to send mail.
    if (tap.chatId !== '' && tap.chatId !== config.chatId) {
      ctx.count('tap_rejected');
      ctx.fault(`ignored a button tap from chat ${tap.chatId}, which is not the configured one`);
      continue;
    }

    const row = ctx.db
      .prepare(
        `SELECT o.id, o.job_id, o.approved_at, o.sent_at, j.state, k.email, c.name AS company
           FROM outreach o
           JOIN jobs j ON j.id = o.job_id
           JOIN companies c ON c.id = j.company_id
           JOIN contacts k ON k.id = o.contact_id
          WHERE o.id = ?`,
      )
      .get(tap.data.outreachId) as
      | { id: number; job_id: number; approved_at: string | null; sent_at: string | null; state: string; email: string; company: string }
      | undefined;

    if (row === undefined) {
      await answer(config, tap.callbackId, 'That draft is gone.', ctx.signal);
      continue;
    }

    // Already decided, or already gone. A second tap must never send a second email.
    if (row.sent_at !== null || row.state !== 'PENDING_APPROVAL') {
      await answer(config, tap.callbackId, `Already ${row.sent_at === null ? row.state.toLowerCase() : 'sent'}.`, ctx.signal);
      continue;
    }

    if (tap.data.action === 'approve') {
      // Approval is not sending. The row joins the 09:00 queue and leaves at its jittered
      // slot through the same code path as an auto-send (decision 007).
      ctx.db.prepare('UPDATE outreach SET approved_at = ? WHERE id = ?').run(nowIso(), row.id);
      ctx.count('approved');
      ctx.log(`approved: ${row.company} → ${row.email}`);
      await answer(config, tap.callbackId, 'Approved — it will go out in the next send window.', ctx.signal);
      if (tap.messageId !== null) await settle(config, tap.messageId, '✅ approved', ctx.signal);
      continue;
    }

    tryTransition(ctx.db, row.job_id, 'PENDING_APPROVAL', 'REJECTED_BY_USER');
    ctx.count('rejected');
    ctx.log(`rejected: ${row.company} → ${row.email}`);
    await answer(config, tap.callbackId, 'Skipped. The draft stays in Gmail if you want it.', ctx.signal);
    if (tap.messageId !== null) await settle(config, tap.messageId, '🗑 skipped', ctx.signal);
  }

  // Logged even at zero. A poller that has silently stopped receiving taps looks exactly
  // like a poller with nothing to do, and this project's characteristic failure is the one
  // that produces no output at all.
  ctx.log(`polled from offset ${readOffset(ctx)} — ${pending.length} tap(s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — watch taps arrive, without touching the database
//
//   node src/notify/approve.ts --watch
//
// For answering "did my tap actually reach the bot?" on its own, which is a different
// question from "did the stage act on it" and needs separating when one of them breaks.
// ─────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    options: {
      watch: { type: 'boolean', default: false },
      seconds: { type: 'string', default: '120' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || !values.watch) {
    console.log('usage: node src/notify/approve.ts --watch [--seconds=120]');
    process.exit(values.help ? 0 : 2);
  }

  const found = telegramConfig();
  if ('problem' in found) {
    console.error(found.problem);
    process.exit(1);
  }

  const until = Date.now() + Number(values.seconds) * 1000;
  console.log(`watching for taps for ${values.seconds}s — go and press a button\n`);

  let seen = 0;
  while (Date.now() < until) {
    const taps = await getTaps(found.config, 0).catch((err: unknown) => {
      console.error(`getUpdates failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });

    for (const tap of taps) {
      seen++;
      console.log(
        `TAP  update=${tap.updateId}  ${tap.data.action} outreach ${tap.data.outreachId}  ` +
          `chat=${tap.chatId}${tap.chatId === found.config.chatId ? '' : '  ← NOT the configured chat'}`,
      );
    }
    // Deliberately does not advance the cursor: this is a diagnostic, and consuming a tap
    // here would hide it from the stage that is supposed to act on it.
    if (seen > 0) break;
  }

  console.log(seen === 0 ? '\nno taps seen — the button press is not reaching the bot' : '\nthe read path works');
  process.exit(0);
}
