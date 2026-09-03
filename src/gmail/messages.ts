/**
 * Reading the mailbox: search, fetch, and turn Gmail's MIME tree into something flat.
 *
 *   node src/gmail/messages.ts --query="from:linkedin.com" --limit=3
 *   node src/gmail/messages.ts --query="from:naukri.com" --limit=3 --links
 *
 * That CLI is not a toy — it is how the alert parsers get written against what LinkedIn and
 * Naukri *actually* send rather than against a guess (same rule as the ATS slugs,
 * decision 010).
 *
 * Two things here are less obvious than they look:
 *
 * - **`internalDate`, not the `Date` header.** The header is written by the sender and is
 *   routinely wrong or missing a timezone; `internalDate` is when Google accepted the mail.
 * - **Bodies are base64url, not base64.** Gmail uses `-` and `_`, and strips padding. Node's
 *   `base64url` decoder handles both, which is why nothing here does string surgery.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import { htmlToText } from '../ingest/html.ts';

/** A message, flattened into the four fields a parser actually wants. */
export type Email = {
  id: string;
  threadId: string;
  /** The raw `From` header, e.g. `LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>`. */
  from: string;
  /** Just the address, lowercased — what sender matching should use. */
  fromAddress: string;
  subject: string;
  /** When Google accepted it, as UTC ISO. */
  receivedAt: string;
  /** `text/plain` if the message had one, otherwise the HTML rendered down to text. */
  text: string;
  /** The raw `text/html` part, when there is one. Links live here. */
  html: string;
  labelIds: string[];
};

/** Pull one header out of a message, case-insensitively. */
export const headerValue = (part: gmail_v1.Schema$MessagePart | undefined, name: string): string => {
  const wanted = name.toLowerCase();
  const found = part?.headers?.find((h) => (h.name ?? '').toLowerCase() === wanted);
  return found?.value ?? '';
};

/** `Name <a@b.com>` → `a@b.com`. A bare address passes through. */
export function addressOf(header: string): string {
  const angled = /<([^>]+)>/.exec(header);
  return (angled?.[1] ?? header).trim().toLowerCase();
}

/** Depth-first walk of the MIME tree, container parts included. */
export function walkParts(part: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(walkParts)];
}

/** Turn Gmail’s base64url body data back into text. */
export const decodeBody = (data: string | null | undefined): string =>
  data ? Buffer.from(data, 'base64url').toString('utf8') : '';

/**
 * The text and HTML bodies, whatever shape the message is.
 *
 * Alert mail is usually `multipart/alternative` with both; some senders ship HTML only. The
 * first part of each type wins — later same-type parts in these emails are footers and
 * tracking pixels, not more content.
 *
 * **`text/plain` does not automatically win.** Measured against a real Naukri Campus alert on
 * 2026-08-11: its `text/plain` part is the 54-character stub "Job recommendations based on
 * your Naukri.com profile" while all three job listings live in 45KB of HTML. Preferring the
 * declared plain-text part would have read that email as empty and reported no jobs, forever,
 * with nothing in the logs to show why. So both are rendered and the longer one wins — a
 * genuine plain-text body always beats its own markup, and a stub never beats real content.
 */
export function bodyOf(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  html: string;
} {
  let plain = '';
  let html = '';

  for (const part of walkParts(payload)) {
    // Attachments can be text/*; they are not the body.
    if (part.filename) continue;
    const mime = (part.mimeType ?? '').toLowerCase();
    if (plain === '' && mime === 'text/plain') plain = decodeBody(part.body?.data);
    else if (html === '' && mime === 'text/html') html = decodeBody(part.body?.data);
  }

  const rendered = htmlToText(html);
  return { text: rendered.length > plain.trim().length ? rendered : plain, html };
}

/** Flatten Gmail’s nested message shape into the four fields the parsers want. */
export function toEmail(message: gmail_v1.Schema$Message): Email {
  const { text, html } = bodyOf(message.payload);
  const from = headerValue(message.payload, 'from');
  const internal = Number(message.internalDate);

  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    from,
    fromAddress: addressOf(from),
    subject: headerValue(message.payload, 'subject'),
    receivedAt: new Date(Number.isFinite(internal) ? internal : Date.now()).toISOString(),
    text,
    html,
    labelIds: message.labelIds ?? [],
  };
}

export type Link = { href: string; text: string };

/**
 * Anchors, in document order, deduped by href.
 *
 * `htmlToText` throws links away — reasonable for a job description, useless for an alert
 * email, where the only copy of the posting URL is an anchor. Duplicates are everywhere in
 * these emails (the title, a logo, and a "view job" button all point at the same posting), so
 * first sighting wins and keeps its link text.
 */
export function extractLinks(html: string): Link[] {
  const seen = new Map<string, string>();

  for (const match of html.matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = htmlToText(match[2] ?? '').trim();
    if (href === '' || href.startsWith('mailto:') || href.startsWith('#')) continue;
    if (!seen.has(href)) seen.set(href, htmlToText(match[3] ?? '').trim());
  }

  return [...seen].map(([href, text]) => ({ href, text }));
}

/** Gmail's `q` wants whole seconds. */
export const afterClause = (since: Date): string =>
  `after:${Math.floor(since.getTime() / 1000)}`;

export type SearchOptions = {
  /** Gmail search syntax, e.g. `from:linkedin.com`. */
  query: string;
  since?: Date;
  /** Stop after this many messages. Alert mail is small but there is no reason to fetch 500. */
  limit?: number;
  onError?: (message: string) => void;
  /**
   * The caller's deadline, passed to every Google request and checked between them.
   *
   * Without it a hung Gmail call has nothing to stop it. On 2026-08-24 that took the whole
   * 12-minute ingest budget and, because alert email is polled first (025), every source
   * behind it as well — ingest logged not one line (decision 028).
   */
  signal?: AbortSignal;
};

/**
 * Message ids matching a query, newest first, following `nextPageToken`.
 *
 * A generator rather than an array so the caller can stop early — `messages.list` is one
 * quota unit but `messages.get` is five apiece, and there is no point fetching page two if
 * page one already covered the window.
 */
export async function* searchIds(
  gmail: gmail_v1.Gmail,
  opts: SearchOptions,
): AsyncGenerator<string> {
  const q = opts.since ? `${opts.query} ${afterClause(opts.since)}` : opts.query;
  const limit = opts.limit ?? 100;

  let pageToken: string | undefined;
  let yielded = 0;

  do {
    if (opts.signal?.aborted === true) return;

    const res = await gmail.users.messages.list(
      {
        userId: 'me',
        q,
        maxResults: Math.min(limit - yielded, 100),
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      { signal: opts.signal },
    );

    for (const message of res.data.messages ?? []) {
      if (message.id) {
        yield message.id;
        if (++yielded >= limit) return;
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
}

/** Fetch one message by id and flatten it. */
export async function getEmail(
  gmail: gmail_v1.Gmail,
  id: string,
  signal?: AbortSignal,
): Promise<Email> {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' }, { signal });
  return toEmail(res.data);
}

/**
 * Search and fetch in one pass.
 *
 * One unreadable message must not cost the run the rest of the mailbox — it is reported
 * through `onError` and skipped, the same contract every `JobSource` follows.
 */
export async function* searchEmails(
  gmail: gmail_v1.Gmail,
  opts: SearchOptions,
): AsyncGenerator<Email> {
  for await (const id of searchIds(gmail, opts)) {
    if (opts.signal?.aborted === true) return;
    try {
      yield await getEmail(gmail, id, opts.signal);
    } catch (err) {
      opts.onError?.(`message ${id} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — how the alert parsers get written against reality
// ─────────────────────────────────────────────────────────────────────────────

/** CLI entry: search the real mailbox, for writing parsers against actual mail. */
async function main(argv: string[]): Promise<number> {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    args: argv,
    options: {
      query: { type: 'string' },
      limit: { type: 'string', default: '3' },
      days: { type: 'string', default: '30' },
      links: { type: 'boolean', default: false },
      body: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
    },
  });

  if (values.query === undefined) {
    console.error('usage: node src/gmail/messages.ts --query="from:linkedin.com" [--limit=3]');
    console.error('       [--links]  list the anchors   [--body] print the text body');
    console.error('       [--full]   print the whole body rather than the first 600 chars');
    return 2;
  }

  const { gmailClient, describeAuthError } = await import('./auth.ts');
  let gmail;
  try {
    gmail = gmailClient();
  } catch (err) {
    console.error(describeAuthError(err));
    return 1;
  }

  const since = new Date(Date.now() - Number(values.days) * 86_400_000);
  let seen = 0;

  try {
    for await (const email of searchEmails(gmail, {
      query: values.query,
      since,
      limit: Number(values.limit),
      onError: (m) => console.error(`  warn: ${m}`),
    })) {
      seen++;
      console.log(`\n${'─'.repeat(78)}`);
      console.log(`from     ${email.from}`);
      console.log(`subject  ${email.subject}`);
      console.log(`received ${email.receivedAt}`);
      console.log(`id       ${email.id}   (${email.text.length} chars text, ${email.html.length} html)`);

      if (values.body) {
        console.log(`\n${values.full ? email.text : email.text.slice(0, 600)}`);
      }
      if (values.links) {
        const links = extractLinks(email.html);
        console.log(`\n${links.length} link(s):`);
        for (const l of links.slice(0, values.full ? links.length : 25)) {
          console.log(`  ${l.text.slice(0, 60).padEnd(60)} → ${l.href.slice(0, 110)}`);
        }
      }
    }
  } catch (err) {
    console.error(`\n${describeAuthError(err)}`);
    return 1;
  }

  console.log(`\n${seen} message(s) matched "${values.query}" in the last ${values.days} days.`);
  return 0;
}

if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('../env.ts')).loadEnv();

  process.exitCode = await main(process.argv.slice(2));
}
