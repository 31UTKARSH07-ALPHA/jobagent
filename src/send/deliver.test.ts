/**
 * The ambiguous-failure question, which is the entire reason drafts are used instead of
 * `messages.send` (decision 007): the request failed, so did the mail go or not?
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, draftStatus } from './deliver.ts';

/** Just enough of the Gmail client for these paths. */
const client = (over: {
  send?: () => Promise<unknown>;
  get?: () => Promise<unknown>;
}): never =>
  ({
    users: {
      drafts: {
        send: over.send ?? (async () => ({ data: { id: 'm1', threadId: 't1' } })),
        // An unsent draft: 200, with the message labelled DRAFT.
        get: over.get ?? (async () => ({ data: { id: 'd1', message: { id: 'm1', labelIds: ['DRAFT'] } } })),
      },
    },
  }) as never;

/** What Gmail really returns for a draft that has already been sent: 200, labelled SENT. */
const alreadySent = async () => ({ data: { id: 'd1', message: { id: 'm1', labelIds: ['SENT'] } } });

const notFound = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 });

test('a clean send returns the ids', async () => {
  const out = await deliver('d1', client({}));
  assert.deepEqual(out, { messageId: 'm1', threadId: 't1', recovered: false });
});

test('a lost response with the draft gone means it sent', async () => {
  // The case that matters. Reporting this as failure would make the caller retry and mail
  // the person a second time.
  const out = await deliver(
    'd1',
    client({
      send: async () => {
        throw new Error('socket hang up');
      },
      get: async () => {
        throw notFound();
      },
    }),
  );

  assert.equal(out.recovered, true);
  assert.equal(out.messageId, null, 'it went; we simply never heard which id');
});

test('a sent draft still answers 200, and must not be retried', async () => {
  // Verified against the real account 2026-09-01: `drafts.get` returns 200 for a draft it
  // has already sent, labelled SENT rather than DRAFT. Asking "does it still exist" gets
  // "yes" for a message that has gone — and retrying mails the recruiter twice.
  const out = await deliver(
    'd1',
    client({
      send: async () => {
        throw new Error('socket hang up');
      },
      get: alreadySent,
    }),
  );

  assert.equal(out.recovered, true, 'read as sent, not as safe to retry');
});

test('a failure with the draft still there is a real failure', async () => {
  // Nothing left, so a retry is safe — and the caller must be told to retry.
  await assert.rejects(
    deliver(
      'd1',
      client({
        send: async () => {
          throw new Error('backend error');
        },
      }),
    ),
    /backend error/,
  );
});

test('when we cannot even ask, the original error stands', async () => {
  // Recording a send we cannot prove is worse than retrying one we already made: `sent_at`
  // stays null and the next run asks again.
  await assert.rejects(
    deliver(
      'd1',
      client({
        send: async () => {
          throw new Error('send failed');
        },
        get: async () => {
          throw new Error('and the check failed too');
        },
      }),
    ),
    /send failed/,
  );
});

test('the label is what says whether it has gone', async () => {
  assert.equal((await draftStatus('d1', client({}))).status, 'draft');
  assert.equal((await draftStatus('d1', client({ get: alreadySent }))).status, 'sent');
  assert.equal(
    (await draftStatus('d1', client({ get: async () => {
      throw notFound();
    } }))).status,
    'missing',
  );
});

test('a recovered send carries the ids a reply would arrive under', async () => {
  // Recording null for both left the recovery working and the thing it recovered
  // untrackable.
  const out = await deliver(
    'd1',
    client({
      send: async () => {
        throw new Error('socket hang up');
      },
      get: async () => ({
        data: { id: 'd1', message: { id: 'm7', threadId: 't7', labelIds: ['SENT'], internalDate: '1756276515000' } },
      }),
    }),
  );

  assert.equal(out.recovered, true);
  assert.equal(out.messageId, 'm7');
  assert.equal(out.threadId, 't7');
});

test('a draft with no labels at all is read as sent, not as safe', async () => {
  // When the answer is unclear, the conservative reading is the one that cannot produce a
  // second email.
  assert.equal(
    (await draftStatus('d1', client({ get: async () => ({ data: { id: 'd1', message: { id: 'm1' } } }) }))).status,
    'sent',
  );
});

test('any other error from the check is still an error', async () => {
  await assert.rejects(
    draftStatus('d1', client({ get: async () => {
      throw Object.assign(new Error('rate limited'), { code: 429 });
    } })),
    /rate limited/,
  );
});
