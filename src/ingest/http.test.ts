/**
 * The offline check, and the retry behaviour that hangs off it.
 *
 * Written after 2026-08-14, when a run that started before Wi-Fi came up spent 55 minutes
 * retrying 51 boards against a dead DNS resolver. The distinction being tested is the whole
 * point: a board having a bad minute is worth retrying, a machine with no network is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJson, isOffline } from './http.ts';

/** How Node reports a DNS failure: a TypeError whose `cause` carries the errno code. */
const fetchFailed = (code: string): TypeError =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

test('DNS and routing failures read as offline', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH']) {
    assert.equal(isOffline(fetchFailed(code)), true, code);
  }
});

test('a board being slow or rude is not offline', () => {
  // These are exactly the cases retrying does fix, so they must not short-circuit.
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET']) {
    assert.equal(isOffline(fetchFailed(code)), false, code);
  }
  assert.equal(isOffline(new Error('boom')), false);
  assert.equal(isOffline(undefined), false);
  assert.equal(isOffline({ cause: null }), false);
});

test('an offline error is thrown on the first attempt, not the third', async () => {
  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    throw fetchFailed('ENOTFOUND');
  };

  try {
    await assert.rejects(() => getJson('https://boards-api.greenhouse.io/x', { retries: 2 }));
    // 51 boards × 2 saved attempts × a DNS timeout each is the 55 minutes.
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a transient error still gets its retries', async () => {
  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) throw fetchFailed('ECONNRESET');
    return new Response('{"ok":true}', { status: 200 });
  };

  try {
    assert.deepEqual(await getJson('https://boards-api.greenhouse.io/x', { retries: 2 }), {
      ok: true,
    });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = original;
  }
});
