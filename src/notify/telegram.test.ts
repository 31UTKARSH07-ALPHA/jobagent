/**
 * The send retry.
 *
 * Four consecutive morning digests were lost between 2026-08-17 and 08-20 to a single
 * `fetch failed` — the run had a network when it started and not when it finished
 * (decision 022). The digest is the entire product in Phase 1, so a transient failure has to
 * be worth another attempt, and a *permanent* one must not be.
 *
 * `TELEGRAM_BACKOFF_MS=1` keeps the real 2s/8s/32s ladder out of the test run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, SEND_ATTEMPTS, TelegramError } from './telegram.ts';

const CONFIG = { token: 'test-token', chatId: '123' };
const ok = () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
const fail = (status: number, description: string) =>
  new Response(JSON.stringify({ ok: false, description }), { status });

/** Replaces fetch with a scripted sequence, restoring it afterwards. */
async function withFetch<T>(
  responses: (() => Response | Promise<Response>)[],
  fn: (calls: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    const next = responses[n++];
    if (next === undefined) throw new Error(`unexpected fetch call ${n}`);
    return next();
  };
  try {
    return await fn(() => n);
  } finally {
    globalThis.fetch = original;
  }
}

const boom = () => {
  throw Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
  });
};

test('a dead network on the first attempt is retried, and the digest still arrives', async () => {
  const retries: string[] = [];

  await withFetch([boom, ok], async (calls) => {
    const sent = await sendMessage(CONFIG, 'hello', (m) => retries.push(m));
    assert.equal(sent.length, 1);
    assert.equal(calls(), 2);
  });

  assert.equal(retries.length, 1);
  assert.match(retries[0]!, /attempt 1\/4 failed: fetch failed/);
});

test('a 400 is not retried — the message itself is wrong', async () => {
  // Bad HTML in a job title, a revoked token, a wrong chat id. Sending it again cannot help,
  // and burning three more attempts only delays the error reaching the log.
  await withFetch([() => fail(400, "can't parse entities")], async (calls) => {
    await assert.rejects(() => sendMessage(CONFIG, '<b>broken'), TelegramError);
    assert.equal(calls(), 1);
  });
});

test('a 429 and a 5xx are both retried', async () => {
  await withFetch([() => fail(429, 'Too Many Requests'), () => fail(503, 'nope'), ok], async (calls) => {
    await sendMessage(CONFIG, 'hello');
    assert.equal(calls(), 3);
  });
});

test('a network that never comes back throws after every attempt', async () => {
  const retries: string[] = [];

  await withFetch(Array(SEND_ATTEMPTS).fill(boom), async (calls) => {
    await assert.rejects(() => sendMessage(CONFIG, 'hello', (m) => retries.push(m)), /fetch failed/);
    assert.equal(calls(), SEND_ATTEMPTS);
  });

  // The digest stage leaves `digested_at` NULL when this throws, so nothing is lost —
  // tomorrow resends the whole thing. That is asserted in digest.test.ts.
  assert.equal(retries.length, SEND_ATTEMPTS);
});

test('a long digest sends every part, retrying only the part that failed', async () => {
  // `chunk` splits on blank lines, so two blocks that only fit separately.
  const long = `${'x'.repeat(3000)}\n\n${'y'.repeat(3000)}`;
  await withFetch([ok, boom, ok], async (calls) => {
    const sent = await sendMessage(CONFIG, long);
    assert.equal(sent.length, 2);
    assert.equal(calls(), 3);
  });
});

test('an abandoned stage stops the retry ladder', async () => {
  // Measured 2026-08-23: the digest stage was killed for overrunning its budget and two
  // more attempts still landed in the log afterwards, against a stage nobody was waiting
  // on (decision 025).
  const controller = new AbortController();
  const retries: string[] = [];

  await withFetch([boom, boom, boom, boom], async (calls) => {
    globalThis.fetch = async () => {
      controller.abort(); // the stage runs out of budget during the first attempt
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
      });
    };
    await assert.rejects(() =>
      sendMessage(CONFIG, 'hello', (m) => retries.push(m), controller.signal),
    );
    assert.equal(calls(), 0, 'the scripted responses are unused; the stub above replaced them');
  });

  assert.equal(retries.length, 1, 'one failure logged, then it stops rather than ladder on');
});
