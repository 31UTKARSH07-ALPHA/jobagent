/**
 * Actually sending — the only irreversible act in this project.
 *
 * `drafts.send(id)`, never `messages.send` (invariant 1, decision 007). The draft id is what
 * makes an ambiguous failure answerable: if the call times out or the socket drops, we cannot
 * know from the error whether Google accepted the message — but we can **ask afterwards**.
 *
 * The question is *not* "does the draft still exist" — Gmail answers yes for a draft it has
 * already sent. It is "is it still a **draft**", read off the message's labels. See
 * {@link draftStatus}; getting this backwards mails somebody twice.
 *
 * That question is the whole reason this file is separate from a one-line API call.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import { gmailClient } from '../gmail/auth.ts';

export type Delivered = {
  /** Null when the send was recovered after an ambiguous failure — it went, id unknown. */
  messageId: string | null;
  threadId: string | null;
  /** True when we learned it had sent by asking, rather than from a successful response. */
  recovered: boolean;
};

/**
 * What Gmail says about a draft id.
 *
 * - `draft`  — still unsent. Safe to send, and safe to retry.
 * - `sent`   — it has gone. Sending again would mail the person twice.
 * - `missing` — Gmail has no such id. Deleted, or sent long enough ago to be forgotten.
 */
export type DraftStatus = 'draft' | 'sent' | 'missing';

/**
 * What Gmail knows about a draft id, including the ids a reply would be threaded under.
 *
 * The ids matter more than they look. A send recovered after a lost response used to record
 * `null` for both, which left the tracker unable to match a reply to that outreach at all —
 * the recovery worked and the thing it was recovering became untrackable.
 */
export type DraftFacts = {
  status: DraftStatus;
  messageId: string | null;
  threadId: string | null;
  /** When Gmail accepted it, as UTC ISO. Only meaningful once `status` is `sent`. */
  sentAt: string | null;
};

/**
 * **`drafts.get` does not 404 for a draft that was sent.** It returns 200, and the message it
 * hands back carries the label `SENT` instead of `DRAFT`.
 *
 * This is the entire correctness of decision 007 and it was very nearly wrong. The recovery
 * check used to ask "does the draft still exist?", and for an already-sent message Gmail
 * answers *yes* — so an ambiguous failure would have been read as "not sent", retried, and
 * delivered a second copy to a recruiter. Verified against the real account on 2026-09-01:
 * an unsent draft reports `["DRAFT"]`, one sent by hand four days earlier reports `["SENT"]`,
 * and both return 200 (decision 044).
 *
 * Only `draft` means it is safe to send.
 */
export async function draftStatus(
  draftId: string,
  client?: gmail_v1.Gmail,
  signal?: AbortSignal,
): Promise<DraftFacts> {
  const gmail = client ?? gmailClient();
  try {
    const res = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'minimal' }, { signal });
    const message = res.data.message;
    const labels = message?.labelIds ?? [];
    // Absent labels are treated as sent, not as safe: when the answer is unclear the
    // conservative reading is the one that cannot produce a second email.
    const status: DraftStatus = labels.includes('DRAFT') ? 'draft' : 'sent';

    return {
      status,
      messageId: message?.id ?? null,
      threadId: message?.threadId ?? null,
      // `internalDate` is epoch milliseconds as a string, and it is when Google accepted the
      // message — which is the only honest answer to "how long has this been waiting".
      sentAt:
        status === 'sent' && message?.internalDate != null
          ? new Date(Number(message.internalDate)).toISOString()
          : null,
    };
  } catch (err) {
    if ((err as { code?: number }).code === 404 || (err as { status?: number }).status === 404) {
      return { status: 'missing', messageId: null, threadId: null, sentAt: null };
    }
    throw err;
  }
}

/**
 * Send an existing draft.
 *
 * On a clean response the ids come back and there is nothing to reason about. On any other
 * failure the draft is checked: **gone means it sent**, and reporting that as an error would
 * cause the caller to try again and mail the person twice — the one bug in this project with
 * real-world consequences.
 *
 * If the draft is still there, the error is rethrown unchanged. Nothing left, so retrying is
 * safe and the next run will.
 */
export async function deliver(
  draftId: string,
  client?: gmail_v1.Gmail,
  signal?: AbortSignal,
): Promise<Delivered> {
  const gmail = client ?? gmailClient();

  try {
    const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } }, { signal });
    return {
      messageId: res.data.id ?? null,
      threadId: res.data.threadId ?? null,
      recovered: false,
    };
  } catch (err) {
    let facts: DraftFacts;
    try {
      facts = await draftStatus(draftId, gmail, signal);
    } catch {
      // We could not even ask. Rethrowing the original is right: the caller must not record a
      // send it cannot prove, and `sent_at` staying null means the next run asks again.
      throw err;
    }

    // Still a draft is the *only* answer that permits a retry.
    if (facts.status === 'draft') throw err;
    // Carry the ids back: without them a reply to this message could never be matched.
    return { messageId: facts.messageId, threadId: facts.threadId, recovered: true };
  }
}
