/**
 * The Telegram client. Sending only — this is Phase 1.
 *
 * Plain `fetch`, no SDK, for the same reason `src/llm/groq.ts` is plain fetch: sending a
 * message is one POST. `grammy` arrives with Phase 3, which needs the other half — a long
 * poll listening for approve/reject taps — and that is genuinely worth a library.
 *
 * Messages are sent as HTML, not MarkdownV2. Telegram's MarkdownV2 requires escaping
 * fifteen characters including `.` `-` `(` `)`, and job titles are full of them; HTML needs
 * three. One escaping bug in a digest means a 400 at 06:05 and no digest at all.
 */

const API = process.env['TELEGRAM_API'] ?? 'https://api.telegram.org';

/** Telegram's hard limit on one message. Longer digests are split across messages. */
export const MAX_MESSAGE_CHARS = 4096;

export class TelegramError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`telegram ${status}: ${message}`);
    this.name = 'TelegramError';
    this.status = status;
  }
}

export type TelegramConfig = { token: string; chatId: string };

/**
 * Reads the bot token and chat id. Returns null with a note rather than throwing: a missing
 * token is a setup step, and the rest of the pipeline still has work to do without it.
 */
export function telegramConfig(): { config: TelegramConfig } | { problem: string } {
  const token = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
  const chatId = process.env['TELEGRAM_CHAT_ID'] ?? '';

  if (token === '') {
    return {
      problem:
        'TELEGRAM_BOT_TOKEN is not set — talk to @BotFather, /newbot, and put the token in .env',
    };
  }
  if (chatId === '') {
    return {
      problem:
        'TELEGRAM_CHAT_ID is not set — send your bot a message, then run: ' +
        'node src/notify/telegram.ts --chat-id',
    };
  }
  return { config: { token, chatId } };
}

/** The three characters Telegram's HTML mode cares about. */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Split text into Telegram-sized messages on paragraph boundaries.
 *
 * Never mid-tag and never mid-entity: a message cut inside `<a href="…">` is a 400, and one
 * cut inside `&amp;` renders as garbage. Blocks are separated by blank lines, so splitting
 * there is always safe. A single block longer than the limit is passed through whole —
 * losing one over-long job is better than corrupting the markup of the whole digest.
 */
export function chunk(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let current = '';

  for (const block of text.split('\n\n')) {
    const candidate = current === '' ? block : `${current}\n\n${block}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== '') out.push(current);
    current = block;
  }
  if (current !== '') out.push(current);
  return out;
}

type SendResult = { message_id: number };

/**
 * Send one message, splitting it if Telegram would refuse it.
 *
 * `disable_web_page_preview` matters more than it looks: without it, a digest of five jobs
 * renders as five link cards and the actual text scrolls off the screen.
 */
export async function sendMessage(
  config: TelegramConfig,
  text: string,
): Promise<SendResult[]> {
  const sent: SendResult[] = [];

  for (const part of chunk(text)) {
    const res = await fetch(`${API}/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: part,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const payload = (await res.json()) as {
      ok: boolean;
      result?: SendResult;
      description?: string;
    };

    if (!res.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramError(res.status, payload.description ?? res.statusText);
    }
    sent.push(payload.result);
  }

  return sent;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — the one-time setup step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chat ids are not in the bot token; Telegram only reveals one once the human has messaged
 * the bot. This prints whatever `getUpdates` knows about.
 */
async function printChatId(token: string): Promise<number> {
  const res = await fetch(`${API}/bot${token}/getUpdates`);
  const payload = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { message?: { chat?: { id: number; type: string; first_name?: string } } }[];
  };

  if (!payload.ok) {
    console.error(`telegram said: ${payload.description ?? 'not ok'}`);
    return 1;
  }

  const chats = new Map<number, string>();
  for (const update of payload.result ?? []) {
    const chat = update.message?.chat;
    if (chat) chats.set(chat.id, `${chat.type}${chat.first_name ? ` — ${chat.first_name}` : ''}`);
  }

  if (chats.size === 0) {
    console.log('no messages yet. Open Telegram, send your bot any message, then re-run this.');
    return 1;
  }

  for (const [id, who] of chats) console.log(`TELEGRAM_CHAT_ID=${id}    (${who})`);
  console.log('\nPut that line in .env.');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const token = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
  if (token === '') {
    console.error('TELEGRAM_BOT_TOKEN is not set in .env');
    return 2;
  }

  if (argv.includes('--chat-id')) return printChatId(token);

  if (argv.includes('--test')) {
    const found = telegramConfig();
    if ('problem' in found) {
      console.error(found.problem);
      return 2;
    }
    await sendMessage(found.config, '<b>jobagent</b> is wired up. 🎯');
    console.log('sent. Check Telegram.');
    return 0;
  }

  console.error('usage: node src/notify/telegram.ts --chat-id | --test');
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
