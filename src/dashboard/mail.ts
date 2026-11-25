import type { gmail_v1 } from '@googleapis/gmail';
import { gmailClient } from '../gmail/auth.ts';
import { toEmail } from '../gmail/messages.ts';
import { draftStatus } from '../send/deliver.ts';
import { transaction, type Db } from '../store/db.ts';
import { transition } from '../store/state.ts';
import { isBounce } from '../track/replies.ts';

export async function deleteDraft(db: Db, id: number, client?: gmail_v1.Gmail) {
  const row = db.prepare(`SELECT o.job_id, o.gmail_draft_id, j.state, o.delete_requested_at
    FROM outreach o JOIN jobs j ON j.id = o.job_id
    WHERE o.id = ? AND o.sent_at IS NULL AND o.approved_at IS NULL AND o.gmail_draft_id IS NOT NULL
      AND (j.state IN ('DRAFTED', 'PENDING_APPROVAL') OR
           (j.state = 'REJECTED_BY_USER' AND o.delete_requested_at IS NOT NULL))`).get(id) as
    { job_id: number; gmail_draft_id: string; state: 'DRAFTED' | 'PENDING_APPROVAL' | 'REJECTED_BY_USER'; delete_requested_at: string | null } | undefined;
  if (!row) return { status: 409, message: 'This draft cannot be deleted here. Queued or sent emails are protected.' };
  // Check Gmail first. A draft the user sent by hand must never be deleted.
  const gmail = client ?? gmailClient();
  const signal = AbortSignal.timeout(12_000);
  const facts = await draftStatus(row.gmail_draft_id, gmail, signal);
  if (facts.status === 'sent') {
    // If it was sent manually while deletion was in progress, let tracking reconcile it.
    db.prepare('UPDATE outreach SET delete_requested_at = NULL WHERE id = ?').run(id);
    return { status: 409, message: 'Gmail no longer identifies this as a draft. Nothing was deleted.' };
  }
  const claimed = transaction(db, () => {
    const { changes } = db.prepare(`UPDATE outreach SET delete_requested_at = COALESCE(delete_requested_at, ?)
      WHERE id = ? AND sent_at IS NULL AND approved_at IS NULL AND gmail_draft_id = ?
        AND EXISTS (SELECT 1 FROM jobs WHERE id = outreach.job_id AND state = ?)`)
      .run(new Date().toISOString(), id, row.gmail_draft_id, row.state);
    if (!changes) return false;
    if (row.state !== 'REJECTED_BY_USER') transition(db, row.job_id, row.state, 'REJECTED_BY_USER');
    return true;
  });
  if (!claimed) return { status: 409, message: 'Draft status changed. Refresh and review it before trying again.' };
  if (facts.status === 'draft') {
    try {
      await gmail.users.drafts.delete({ userId: 'me', id: row.gmail_draft_id }, { signal });
    } catch (err) {
      if ((err as { code?: number }).code !== 404 && (err as { status?: number }).status !== 404) {
        return { status: 502, message: 'Gmail did not confirm deletion. The draft is blocked from sending; you can retry Delete.' };
      }
      const current = await draftStatus(row.gmail_draft_id, gmail, signal);
      if (current.status === 'sent') {
        db.prepare('UPDATE outreach SET delete_requested_at = NULL WHERE id = ?').run(id);
        return { status: 409, message: 'Gmail reports this was sent already. Nothing was deleted.' };
      }
      if (current.status !== 'missing') return { status: 502, message: 'Deletion is not confirmed. You can retry Delete.' };
    }
  }
  db.prepare('UPDATE outreach SET gmail_draft_id = NULL WHERE id = ? AND delete_requested_at IS NOT NULL').run(id);
  return { status: 200, message: 'Draft removed from Gmail and JobAgent.' };
}

export function threadReplies(messages: gmail_v1.Schema$Message[], sentAt: string, messageId: string | null) {
  return messages.filter((m) => m.id && m.id !== messageId && Number(m.internalDate) >= Date.parse(sentAt)
    && !m.labelIds?.some((label) => ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(label)))
    .flatMap((message) => { try { return [toEmail(message)]; } catch { return []; } }).filter((mail) => mail.fromAddress && !isBounce(mail))
    .map(({ id, from, subject, receivedAt, text }) => ({ id, from, subject, receivedAt, text: text.trim().slice(0, 15_000) }));
}

export async function readReplies(db: Db, client?: gmail_v1.Gmail) {
  const outreach = db.prepare(`SELECT o.gmail_thread_id AS thread, min(o.sent_at) AS sent_at,
      o.gmail_message_id AS message_id, c.name AS company, j.title
    FROM outreach o JOIN jobs j ON j.id = o.job_id JOIN companies c ON c.id = j.company_id
    WHERE o.sent_at IS NOT NULL AND o.gmail_thread_id IS NOT NULL
    GROUP BY o.gmail_thread_id ORDER BY sent_at DESC`).all() as
    { thread: string; sent_at: string; message_id: string | null; company: string; title: string }[];
  if (!outreach.length) return { replies: [], checked: 0, unavailable: 0 };
  const gmail = client ?? gmailClient();
  const replyLists = [];
  let unavailable = 0;
  const signal = AbortSignal.timeout(20_000);
  for (let i = 0; i < outreach.length; i += 4) {
    if (signal.aborted) { unavailable += outreach.length - i; break; }
    replyLists.push(...await Promise.all(outreach.slice(i, i + 4).map(async (row) => {
      try {
        const { data } = await gmail.users.threads.get({ userId: 'me', id: row.thread, format: 'full' }, { signal, retry: false });
        return threadReplies(data.messages ?? [], row.sent_at, row.message_id)
          .map((reply) => ({ ...reply, company: row.company, title: row.title, thread: row.thread }));
      } catch (err) {
        const code = (err as { response?: { status?: number } }).response?.status;
        const detail = String((err as { message?: string }).message ?? '');
        if (code === 401 || detail.includes('invalid_grant')) throw err;
        unavailable++;
        return [];
      }
    })));
  }
  return { replies: replyLists.flat().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), checked: outreach.length - unavailable, unavailable };
}
