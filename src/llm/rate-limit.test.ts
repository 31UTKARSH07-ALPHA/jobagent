/**
 * No network and no sleeping. The clock is a parameter, so the cases that matter — a window
 * that has partly drained, a request bigger than the whole budget, an estimate that was wrong
 * — are ordinary arithmetic rather than a flaky timing test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenWindow, WINDOW_MS, estimateTokens, resetWindows, windowFor } from './rate-limit.ts';

const T0 = 1_786_000_000_000;

test('a request fits until the budget is spent', () => {
  const w = new TokenWindow(8_000);

  assert.equal(w.waitMsFor(4_000, T0), 0, 'first call goes immediately');
  w.reserve(4_000, T0);
  assert.equal(w.used(T0), 4_000);

  assert.equal(w.waitMsFor(4_000, T0), 0, 'the second exactly fills the budget');
  w.reserve(4_000, T0);

  assert.ok(w.waitMsFor(1, T0) > 0, 'and then even one token has to wait');
});

test('the exact failure this exists for: short by 19 tokens', () => {
  // The real 429 on 2026-08-11 — "Limit 8000, Used 4015, Requested 4004". 4015 + 4004 = 8019,
  // over by 19. The old flat 700ms gap submitted it anyway; this waits instead.
  const w = new TokenWindow(8_000);
  w.reserve(4_015, T0);

  assert.ok(w.waitMsFor(4_004, T0) > 0, 'it must wait, not submit and be refused');
  // It waits for the window to clear, then goes.
  assert.equal(w.waitMsFor(4_004, T0 + WINDOW_MS), 0);
});

test('the wait is only as long as the oldest entry needs, not a whole minute', () => {
  const w = new TokenWindow(8_000);
  w.reserve(5_000, T0);

  // 30s later, asking for something that does not fit yet.
  const waited = w.waitMsFor(5_000, T0 + 30_000);
  assert.ok(waited > 0);
  assert.equal(waited, WINDOW_MS - 30_000 + 1, 'exactly until that entry ages out');
});

test('entries age out of the trailing window', () => {
  const w = new TokenWindow(8_000);
  w.reserve(8_000, T0);
  assert.equal(w.used(T0 + WINDOW_MS - 1), 8_000, 'still inside the window');
  assert.equal(w.used(T0 + WINDOW_MS), 0, 'and gone at the boundary');
  assert.equal(w.size, 0, 'pruned, not merely ignored');
});

test('a partly-drained window admits what now fits', () => {
  const w = new TokenWindow(8_000);
  w.reserve(3_000, T0);
  w.reserve(3_000, T0 + 40_000);

  // The first entry expires at T0+60s, leaving only the second charged.
  assert.equal(w.used(T0 + WINDOW_MS + 1), 3_000);
  assert.equal(w.waitMsFor(5_000, T0 + WINDOW_MS + 1), 0);
});

test('a request larger than the entire budget is not waited on forever', () => {
  // Nothing can make it fit, so hanging would be worse than letting the 429 handler see it.
  const w = new TokenWindow(8_000);
  assert.equal(w.waitMsFor(9_000, T0), 0);

  w.reserve(1_000, T0);
  assert.equal(w.waitMsFor(9_000, T0), 0, 'still refuses to hang');
});

test('a reservation is reconciled with what was actually charged', () => {
  // The estimate is a character count; the real figure comes back in `usage`. Without this a
  // long batch drifts steadily in whichever direction the heuristic is wrong.
  const w = new TokenWindow(8_000);
  const id = w.reserve(4_000, T0);
  assert.equal(w.used(T0), 4_000);

  w.settle(id, 2_500);
  assert.equal(w.used(T0), 2_500, 'freed the difference');
  assert.equal(w.waitMsFor(5_000, T0), 0, 'which lets the next call through');
});

test('settling an expired reservation is harmless', () => {
  const w = new TokenWindow(8_000);
  const id = w.reserve(4_000, T0);
  w.used(T0 + WINDOW_MS); // prunes it
  w.settle(id, 9_999);
  assert.equal(w.used(T0 + WINDOW_MS), 0, 'no resurrection');
});

test('the estimate errs high, which is the safe direction', () => {
  // Being wrong low means a 429; being wrong high means waiting slightly too long.
  const prose = 'a'.repeat(3_500);
  assert.equal(estimateTokens(prose), 1_000);
  assert.ok(estimateTokens(prose) >= prose.length / 4, 'above the usual 4-chars-per-token rule');

  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('x'), 1, 'never rounds down to zero');
});

test('budgets are per model, because the limits are', () => {
  resetWindows();
  const score = windowFor('openai/gpt-oss-20b', 8_000);
  const draft = windowFor('openai/gpt-oss-120b', 8_000);

  score.reserve(8_000, T0);
  assert.ok(score.waitMsFor(1_000, T0) > 0, 'the scoring model is exhausted');
  assert.equal(draft.waitMsFor(1_000, T0), 0, 'which says nothing about the drafting model');

  assert.equal(windowFor('openai/gpt-oss-20b', 8_000), score, 'same model, same window');
  resetWindows();
});
