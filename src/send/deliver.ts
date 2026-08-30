/**
 * Actually sending — the only irreversible act in this project.
 *
 * `drafts.send(id)`, never `messages.send` (invariant 1, decision 007). The draft id is what
 * makes an ambiguous failure answerable: if the call times out or the socket drops, we cannot
 * know from the error whether Google accepted the message — but we can **ask afterwards**.
 * A draft that no longer exists was sent. A draft still sitting there was not.
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

/** Does this draft still exist? `false` means Gmail no longer has it — it was sent. */
export async function draftExists(
  draftId: string,
  client?: gmail_v1.Gmail,
  signal?: AbortSignal,
): Promise<boolean> {
  const gmail = client ?? gmailClient();
  try {
    await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'minimal' }, { signal });
    return true;
  } catch (err) {
    // 404 is the answer we are looking for, and it is data rather than failure.
    if ((err as { code?: number; status?: number }).code === 404 || (err as { status?: number }).status === 404) {
      return false;
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
    let stillThere: boolean;
    try {
      stillThere = await draftExists(draftId, gmail, signal);
    } catch {
      // We could not even ask. Rethrowing the original is right: the caller must not record a
      // send it cannot prove, and `sent_at` staying null means the next run asks again.
      throw err;
    }

    if (stillThere) throw err;
    return { messageId: null, threadId: null, recovered: true };
  }
}
