/**
 * The ambiguous-failure question, which is the entire reason drafts are used instead of
 * `messages.send` (decision 007): the request failed, so did the mail go or not?
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, draftExists } from './deliver.ts';

/** Just enough of the Gmail client for these paths. */
const client = (over: {
  send?: () => Promise<unknown>;
  get?: () => Promise<unknown>;
}): never =>
  ({
    users: {
      drafts: {
        send: over.send ?? (async () => ({ data: { id: 'm1', threadId: 't1' } })),
        get: over.get ?? (async () => ({ data: { id: 'd1' } })),
      },
    },
  }) as never;

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

test('draftExists reads a 404 as data, not as an error', async () => {
  assert.equal(await draftExists('d1', client({})), true);
  assert.equal(
    await draftExists('d1', client({ get: async () => {
      throw notFound();
    } })),
    false,
  );
});

test('any other error from the check is still an error', async () => {
  await assert.rejects(
    draftExists('d1', client({ get: async () => {
      throw Object.assign(new Error('rate limited'), { code: 429 });
    } })),
    /rate limited/,
  );
});
