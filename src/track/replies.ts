/**
 * What happened to the mail we sent: replies, bounces, and the difference between two kinds
 * of bounce.
 *
 * This runs on its own cadence rather than inside the daily pipeline, because replies and
 * bounces arrive continuously and checking once a day wastes a day
 * (`docs/architecture.md`). It rides the hourly fast lane.
 *
 * **It is a prerequisite for sending, not a follow-up to it** (decision 037). Without it,
 * three completely different failures produce the identical observation — silence:
 *
 * | What happened | Evidence | What to fix |
 * |---|---|---|
 * | the address does not exist | `550 5.1.1`, an NDR | the contact cascade |
 * | the message was refused as spam | `550 5.7.1`, "blocked" | reputation, content, volume |
 * | it arrived and nobody cared | nothing at all | the email, the hook, the targeting |
 *
 * That middle row is the only spam signal a sender can obtain at all. **Spam-*foldering* is
 * undetectable from here** — when Gmail files a message as spam the SMTP transaction has
 * already succeeded, and nothing is sent back. A rejection is different: the receiving server
 * refused the message and said why. Distinguishing the two is most of the value of this file.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import type { StageContext } from '../stage.ts';
import { gmailClient } from '../gmail/auth.ts';
import { searchEmails, type Email } from '../gmail/messages.ts';
import { nowIso, type JobState } from '../store/schema.ts';
import { canTransition, tryTransition } from '../store/state.ts';
import { draftStatus, type DraftFacts } from '../send/deliver.ts';

/**
 * How a delivery failed.
 *
 * - `unknown-mailbox` — the address is wrong. The cascade guessed, or the company retired it.
 * - `blocked` — the address is fine and *we* were refused. Reputation, content or volume.
 * - `temporary` — a 4.x.x deferral. Not a failure yet; the server asked us to come back.
 * - `other` — a bounce we could not classify. Counted so an unfamiliar pattern is visible.
 */
export type BounceReason = 'unknown-mailbox' | 'blocked' | 'temporary' | 'other';

/** Who sends non-delivery reports. Google's own uses the first two. */
const NDR_SENDERS = /^(mailer-daemon|postmaster|mail-daemon|noreply-dmarc|bounce)/i;

/**
 * Classify a non-delivery report from its text.
 *
 * Enhanced status codes (RFC 3463) are checked before prose, because they are the part
 * mail servers agree on. `5.1.1` and `5.1.10` are "no such mailbox"; `5.7.x` is a policy
 * refusal, which is where "we think you are spam" lives. Only then does it fall back to the
 * human-readable sentence, which every provider words differently.
 */
export function classifyBounce(text: string): BounceReason {
  const body = text.toLowerCase();

  // A 4.x.x code anywhere means the server is asking us to retry, not refusing.
  if (/\b4\.\d\.\d\b/.test(body) && !/\b5\.\d\.\d\b/.test(body)) return 'temporary';

  if (/\b5\.1\.(1|0|10)\b/.test(body)) return 'unknown-mailbox';
  if (/\b5\.7\.\d+\b/.test(body)) return 'blocked';

  if (/address not found|user unknown|no such user|recipient .{0,20}not exist|mailbox (unavailable|not found)|does not exist/i.test(body)) {
    return 'unknown-mailbox';
  }
  if (/\b(spam|blocked|blacklist|blocklist|reputation|policy reasons|not authorized|rejected due to|content filter|abuse)\b/i.test(body)) {
    return 'blocked';
  }
  if (/\btry again later|temporar|deferred|greylist|rate limit|too many/i.test(body)) return 'temporary';

  return 'other';
}

/** Is this message a bounce report rather than a human reply? */
export const isBounce = (email: Pick<Email, 'fromAddress' | 'subject'>): boolean =>
  NDR_SENDERS.test(email.fromAddress.split('@')[0] ?? '') ||
  /^(undeliverable|delivery status notification|returned mail|mail delivery (failed|subsystem)|failure notice)/i.test(
    email.subject,
  );

/**
 * Does this NDR concern `recipient`?
 *
 * Gmail does not reliably thread a bounce with the message that caused it — a report from
 * the far side arrives as its own conversation — so the recipient address in the body is
 * what ties them together.
 */
export const bounceMentions = (email: Pick<Email, 'text' | 'html'>, recipient: string): boolean =>
  `${email.text}\n${email.html}`.toLowerCase().includes(recipient.toLowerCase());

/** An outreach row the tracker still needs an answer about. */
type Tracked = {
  id: number;
  job_id: number;
  thread_id: string | null;
  recipient: string;
  sent_at: string;
};

export function trackable(ctx: StageContext): Tracked[] {
  return ctx.db
    .prepare(
      `SELECT o.id, o.job_id, o.gmail_thread_id AS thread_id, k.email AS recipient, o.sent_at
         FROM outreach o
         JOIN contacts k ON k.id = o.contact_id
        WHERE o.sent_at IS NOT NULL
          AND o.replied_at IS NULL
          AND o.bounced_at IS NULL
          AND o.closed_at IS NULL
        ORDER BY o.sent_at`,
    )
    .all() as Tracked[];
}

/**
 * Drafts that left without the pipeline sending them.
 *
 * A draft is a real object in a real Gmail account, and he can send one himself — on
 * 2026-08-27 he did, to `careers@yourfriendlyhr.in`, from the Gmail interface. The pipeline
 * had never been armed and knew nothing about it, which quietly broke three things: the
 * tracker was not watching that thread for a reply or a bounce, the daily cap was not
 * counting it, and suppression would have let a second role at that company be written to.
 *
 * The check is the one `deliver.ts` already uses for an ambiguous failure: **a draft that is
 * no longer in Gmail was sent**. Same question, different reason for asking (decision 044).
 */
async function reconcileHandSent(
  ctx: StageContext,
  gmail: gmail_v1.Gmail,
  status: (draftId: string, client?: gmail_v1.Gmail, signal?: AbortSignal) => Promise<DraftFacts>,
): Promise<void> {
  const unsent = ctx.db
    .prepare(
      `SELECT o.id, o.job_id, o.gmail_draft_id AS draft_id, j.state, k.email, c.name AS company
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE o.sent_at IS NULL AND o.gmail_draft_id IS NOT NULL`,
    )
    .all() as { id: number; job_id: number; draft_id: string; state: JobState; email: string; company: string }[];

  for (const row of unsent) {
    if (ctx.signal.aborted) return;

    let facts: DraftFacts;
    try {
      facts = await status(row.draft_id, gmail, ctx.signal);
    } catch (err) {
      // Logged, not swallowed: a check that silently fails every hour is indistinguishable
      // from one that keeps finding nothing.
      ctx.log(`could not check the draft for ${row.company}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (facts.status === 'draft') continue;

    // Gmail's own timestamp, not now. It matters: the message he sent by hand had been out
    // for five days, and recording it as this minute would have told the ledger it had been
    // waiting zero — which is the number decision 039's whole experiment turns on.
    ctx.db
      .prepare(
        `UPDATE outreach
            SET sent_at = ?, tracked_at = ?,
                gmail_message_id = COALESCE(?, gmail_message_id),
                gmail_thread_id = COALESCE(?, gmail_thread_id)
          WHERE id = ?`,
      )
      .run(facts.sentAt ?? nowIso(), nowIso(), facts.messageId, facts.threadId, row.id);

    // A terminal state cannot be walked forward, and that is the honest record: the mail
    // went, and he later said no to it. Reported rather than papered over.
    // `tryTransition` throws on an illegal edge rather than returning false — a terminal
    // state is not a race, it is a different situation, and it has to be asked about first.
    const moved = canTransition(row.state, 'SENT') && tryTransition(ctx.db, row.job_id, row.state, 'SENT');
    ctx.count('hand_sent');
    ctx.fault(
      `${row.company} → ${row.email} was sent from Gmail by hand, not by the pipeline` +
        (moved ? '' : ` — and the job is ${row.state}, so its state is left as it is`),
    );
  }
}

export type TrackDeps = {
  /** Injected so tests never touch a real mailbox. */
  client?: gmail_v1.Gmail;
  search?: typeof searchEmails;
  /** The account's own address, so its own messages are not mistaken for replies. */
  self?: string;
  /** Injected for tests; the real one asks Gmail whether the id is still a *draft*. */
  draftStatus?: (draftId: string, client?: gmail_v1.Gmail, signal?: AbortSignal) => Promise<DraftFacts>;
};

/** How far back to read. Wider than any follow-up window, and bounded so it stays cheap. */
const LOOKBACK_DAYS = 30;

export async function runTrack(ctx: StageContext, deps: TrackDeps = {}): Promise<void> {
  // Before asking what happened to what we sent, find out what left without us.
  const client = deps.client;
  if (client !== undefined || !ctx.dryRun) {
    try {
      const gmail = client ?? gmailClient();
      await reconcileHandSent(ctx, gmail, deps.draftStatus ?? draftStatus);
    } catch (err) {
      ctx.log(`could not reconcile drafts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const pending = trackable(ctx);
  if (pending.length === 0) {
    ctx.log('nothing sent is waiting on an answer');
    return;
  }

  const oldest = new Date(
    Math.max(
      Date.parse(pending[0]!.sent_at),
      Date.now() - LOOKBACK_DAYS * 86_400_000,
    ),
  );

  let gmail: gmail_v1.Gmail;
  try {
    gmail = deps.client ?? gmailClient();
  } catch (err) {
    // No credentials is not a tracking failure worth a fault every hour — the rows keep
    // their state and the next run tries again.
    ctx.log(err instanceof Error ? err.message : String(err));
    return;
  }

  const search = deps.search ?? searchEmails;
  const self = (deps.self ?? '').toLowerCase();

  // One pass over the mailbox rather than one search per outreach row: at 8 sends a day the
  // inbox is small, and `messages.get` costs five quota units apiece.
  const inbox: Email[] = [];
  try {
    for await (const email of search(gmail, {
      query: 'in:anywhere -in:sent',
      since: oldest,
      limit: 200,
      signal: ctx.signal,
      onError: (m) => ctx.log(m),
    })) {
      inbox.push(email);
    }
  } catch (err) {
    ctx.fault(`could not read the mailbox: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = nowIso();

  for (const row of pending) {
    const sentAt = Date.parse(row.sent_at);
    const after = inbox.filter((e) => Date.parse(e.receivedAt) >= sentAt);

    const bounce = after.find((e) => isBounce(e) && bounceMentions(e, row.recipient));
    if (bounce) {
      const reason = classifyBounce(`${bounce.subject}\n${bounce.text}`);

      if (reason === 'temporary') {
        // Not terminal, and deliberately not recorded as a bounce: the server asked us to
        // come back. Noted so a run of deferrals is visible rather than invisible.
        ctx.db.prepare('UPDATE outreach SET bounce_reason = ?, tracked_at = ? WHERE id = ?')
          .run(reason, now, row.id);
        ctx.count('deferred');
        ctx.log(`${row.recipient}: deferred, not counted as a bounce`);
        continue;
      }

      ctx.db
        .prepare('UPDATE outreach SET bounced_at = ?, bounce_reason = ?, tracked_at = ? WHERE id = ?')
        .run(bounce.receivedAt, reason, now, row.id);
      tryTransition(ctx.db, row.job_id, 'SENT', 'BOUNCED');

      ctx.count(`bounced_${reason}`);
      // A `blocked` bounce is a different emergency from a wrong address: it says the
      // account's standing is the problem, which affects every future send.
      if (reason === 'blocked') {
        ctx.fault(`${row.recipient} refused us on policy grounds — check sending reputation`);
      } else {
        ctx.log(`${row.recipient}: bounced (${reason})`);
      }
      continue;
    }

    const reply = after.find(
      (e) =>
        e.threadId === row.thread_id &&
        !isBounce(e) &&
        e.fromAddress.toLowerCase() !== self,
    );
    if (reply) {
      ctx.db.prepare('UPDATE outreach SET replied_at = ?, tracked_at = ? WHERE id = ?')
        .run(reply.receivedAt, now, row.id);
      tryTransition(ctx.db, row.job_id, 'SENT', 'REPLIED');
      ctx.count('replied');
      ctx.log(`${row.recipient} replied — "${reply.subject}"`);
      continue;
    }

    ctx.db.prepare('UPDATE outreach SET tracked_at = ? WHERE id = ?').run(now, row.id);
  }

  ctx.log(`checked ${pending.length} sent message(s) against ${inbox.length} since ${oldest.toISOString().slice(0, 10)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — the outreach ledger
//
//   node src/track/replies.ts --status
//
// This exists because of decision 039. "Ship without follow-ups and see whether replies
// arrive within four or five working days" is an experiment, and an experiment needs a
// number rather than an impression. Without this it would be judged by whether the inbox
// *felt* quiet.
// ─────────────────────────────────────────────────────────────────────────────

/** Whole days since an ISO timestamp. */
const daysSince = (at: string): number => Math.floor((Date.now() - Date.parse(at)) / 86_400_000);

/** Working days, counting Mon–Fri only — which is how a recruiter's clock actually runs. */
export function workingDaysSince(at: string, now: Date = new Date()): number {
  let count = 0;
  const cursor = new Date(Date.parse(at));
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);

  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('../env.ts')).loadEnv();

  const { parseArgs } = await import('node:util');
  const { openDb, DEFAULT_DB_PATH } = await import('../store/db.ts');

  const { values } = parseArgs({
    options: {
      status: { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || !values.status) {
    console.log('usage: node src/track/replies.ts --status [--db=<path>]');
    process.exit(values.help ? 0 : 2);
  }

  const db = openDb(values.db);
  const rows = db
    .prepare(
      `SELECT c.name AS company, k.email, k.confidence, o.sent_at, o.replied_at,
              o.bounced_at, o.bounce_reason
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE o.sent_at IS NOT NULL
        ORDER BY o.sent_at`,
    )
    .all() as {
    company: string;
    email: string;
    confidence: string;
    sent_at: string;
    replied_at: string | null;
    bounced_at: string | null;
    bounce_reason: string | null;
  }[];

  const drafted = (db.prepare('SELECT COUNT(*) AS n FROM outreach').get() as { n: number }).n;

  if (rows.length === 0) {
    console.log(`nothing sent yet — ${drafted} draft(s) waiting in Gmail`);
    process.exit(0);
  }

  for (const r of rows) {
    const outcome = r.replied_at
      ? `replied after ${workingDaysSince(r.sent_at, new Date(r.replied_at))} working day(s)`
      : r.bounced_at
        ? `bounced (${r.bounce_reason ?? 'unknown'})`
        : `waiting — ${workingDaysSince(r.sent_at)} working day(s), ${daysSince(r.sent_at)} calendar`;
    console.log(`  ${r.company.padEnd(24).slice(0, 24)} ${r.email.padEnd(30).slice(0, 30)} ${outcome}`);
  }

  const replied = rows.filter((r) => r.replied_at !== null).length;
  const bounced = rows.filter((r) => r.bounced_at !== null).length;
  const published = rows.filter((r) => r.confidence === 'high').length;
  const repliedPublished = rows.filter((r) => r.replied_at !== null && r.confidence === 'high').length;

  console.log(`\n${rows.length} sent · ${replied} replied · ${bounced} bounced · ${drafted - rows.length} still drafts`);
  console.log(`published addresses: ${repliedPublished}/${published} replied`);

  // The two numbers decision 039 turns on, and the caveat that stops them being over-read.
  const waited = rows.filter((r) => r.replied_at === null && r.bounced_at === null);
  const ripe = waited.filter((r) => workingDaysSince(r.sent_at) >= 5).length;
  if (ripe > 0) console.log(`${ripe} past the five-working-day mark with no answer`);
  if (rows.length < 50) {
    console.log(
      `\nToo few to conclude anything: cold outreach runs 1–10%, so ${rows.length} sends can` +
        ` produce zero replies with nothing wrong. ~50 is where a rate starts to mean something.`,
    );
  }
  process.exit(0);
}
