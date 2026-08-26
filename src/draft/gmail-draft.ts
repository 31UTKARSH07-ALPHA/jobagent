/**
 * Writing a draft into the real Gmail account. **The only Gmail write this project has.**
 *
 * Invariant 1: `gmail.messages.send` is never called, from anywhere, ever. Mail leaves by
 * `drafts.send(id)` in Phase 3 and by no other route. The reasons are in decision 007 and all
 * three matter:
 *
 * - **A double-send is the one bug here with real-world consequences.** A draft id is a
 *   durable handle, so an ambiguous failure is answerable after the fact: ask whether the
 *   draft still exists — gone means it sent.
 * - **One code path** for auto-sent and hand-approved mail. No second implementation to keep
 *   in step with the first.
 * - **A real audit trail**, in his own Sent folder, in a form he already knows how to read.
 *
 * Until Phase 3 exists, everything this file writes simply sits in the Drafts folder, which
 * is exactly the point: the drafts are reviewed by a human before anything can send them.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import { gmailClient } from '../gmail/auth.ts';

export type OutgoingDraft = {
  to: string;
  subject: string;
  /** Plain text. A student's cold email is not an HTML newsletter. */
  body: string;
  /**
   * Optional `From:` header. Normally omitted — Gmail sends as the authorised account, and
   * an address that is not a verified alias of it is ignored or rejected. Kept for the
   * later-phases move to an own domain, where it becomes meaningful.
   */
  from?: string;
};

export type CreatedDraft = {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
};

/** The stage takes this as a parameter so tests never touch a real inbox. */
export type DraftWriter = (draft: OutgoingDraft, signal?: AbortSignal) => Promise<CreatedDraft>;

/** Rewrites an existing draft in place, keeping its id. See {@link updateGmailDraft}. */
export type DraftUpdater = (
  draftId: string,
  draft: OutgoingDraft,
  signal?: AbortSignal,
) => Promise<void>;

/**
 * A subject line has to be ASCII on the wire, and job titles are full of what is not:
 * `–`, `’`, `·`, and the em dash the model likes. RFC 2047 encoded-word, base64 flavour,
 * because quoted-printable would need its own escaping rules for the same characters.
 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * The MIME message, as Gmail's API wants it: RFC 5322 text, base64url, no padding.
 *
 * Headers are `\r\n`-separated because RFC 5322 says so and because Gmail is one of the
 * services that notices. The body keeps its own newlines.
 */
export function toRawMessage(draft: OutgoingDraft): string {
  const headers = [
    `To: ${draft.to}`,
    ...(draft.from === undefined ? [] : [`From: ${draft.from}`]),
    `Subject: ${encodeHeader(draft.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];

  const mime = `${headers.join('\r\n')}\r\n\r\n${draft.body}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/**
 * Create the draft. Returns the ids that make the send recoverable later.
 *
 * No retry here on purpose. A failed create leaves no `outreach` row, so the job is drafted
 * again on the next run — self-healing in the way every other stage is (`docs/architecture.md`),
 * and a retry loop against a write API is how one draft becomes three.
 */
export async function createGmailDraft(
  draft: OutgoingDraft,
  signal?: AbortSignal,
  client?: gmail_v1.Gmail,
): Promise<CreatedDraft> {
  const gmail = client ?? gmailClient();

  const created = await gmail.users.drafts.create(
    {
      userId: 'me',
      requestBody: { message: { raw: toRawMessage(draft) } },
    },
    { signal },
  );

  const id = created.data.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('Gmail accepted the draft but returned no id — refusing to record it');
  }

  return {
    draftId: id,
    messageId: created.data.message?.id ?? null,
    threadId: created.data.message?.threadId ?? null,
  };
}

/**
 * Replace the contents of a draft that already exists, keeping its id.
 *
 * `drafts.update` rather than delete-then-create, because the id is stored in `outreach` and
 * is what makes an ambiguous send answerable later (decision 007). Deleting and recreating
 * would invalidate it and leave a window where the row points at nothing.
 *
 * Used by `--redraft` when the drafting prompt improves: the emails already written should
 * benefit from the fix, not sit in the folder as the worst ones in the account.
 */
export async function updateGmailDraft(
  draftId: string,
  draft: OutgoingDraft,
  signal?: AbortSignal,
  client?: gmail_v1.Gmail,
): Promise<void> {
  const gmail = client ?? gmailClient();

  await gmail.users.drafts.update(
    {
      userId: 'me',
      id: draftId,
      requestBody: { message: { raw: toRawMessage(draft) } },
    },
    { signal },
  );
}
