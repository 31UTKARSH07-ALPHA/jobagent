/**
 * No network. These cover the piece most likely to break silently: the schema handed to
 * Groq's strict mode. A malformed one fails at request time, in the dark, at 06:00.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { GroqError, isGenerationFailure, retryAfterMs, toStrictJsonSchema } from './groq.ts';
import { MODELS, modelFor } from './models.ts';
import { ScoreResult, Profile } from '../store/schema.ts';

test('the dialect marker Groq rejects is stripped', () => {
  const json = toStrictJsonSchema(ScoreResult);
  assert.equal('$schema' in json, false);
  assert.equal(json['type'], 'object');
});

test('strict mode needs required + additionalProperties:false — Zod already emits both', () => {
  const json = toStrictJsonSchema(ScoreResult) as {
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(json.required.sort(), [
    'domain_fit',
    'hook',
    'level_fit',
    'location_fit',
    'reasoning',
    'stack_fit',
  ]);
  assert.equal(json.additionalProperties, false);
  assert.equal(
    json.required.includes('fit_score'),
    false,
    'the model rates factors; the score is arithmetic (decision 012)',
  );
});

test('constraints survive the conversion', () => {
  const json = toStrictJsonSchema(ScoreResult) as {
    properties: Record<string, { type: string; minimum: number; maximum: number }>;
  };
  for (const factor of ['level_fit', 'location_fit', 'stack_fit', 'domain_fit']) {
    assert.equal(json.properties[factor]?.type, 'integer', factor);
    assert.equal(json.properties[factor]?.minimum, 0, factor);
    assert.equal(json.properties[factor]?.maximum, 10, factor);
  }
});

test('the nested profile schema converts too', () => {
  const json = toStrictJsonSchema(Profile) as { properties: Record<string, unknown> };
  // education is an array of objects — a dual-degree resume must not be flattened
  assert.equal((json.properties['education'] as { type: string }).type, 'array');
  assert.equal((json.properties['skills'] as { type: string }).type, 'array');
});

test('every job maps to a model that supports structured output', () => {
  for (const job of ['score', 'draft', 'profile'] as const) {
    const m = modelFor(job);
    assert.ok(m.id.length > 0, `${job} has no model id`);
    assert.equal(m.jsonSchema, true, `${job} model must accept json_schema`);
  }
});

test('drafting is not silently downgraded to the cheap scoring model', () => {
  // Decision 011: drafting is the only output a human reads. If someone points it at the
  // small model to save rate limit, that should be a deliberate, visible change.
  assert.notEqual(MODELS.draft.id, MODELS.score.id);
});

test('a schema mismatch is caught rather than passed through', () => {
  // What complete() relies on: safeParse rejects a plausible-looking wrong shape.
  const right = {
    level_fit: 10,
    location_fit: 8,
    stack_fit: 6,
    domain_fit: 4,
    reasoning: 'x',
    hook: 'y',
  };
  assert.equal(ScoreResult.safeParse(right).success, true);
  // A factor rated out of 100 instead of out of 10 — the mistake most likely to survive
  // a glance, and it would double the score if it got through.
  assert.equal(ScoreResult.safeParse({ ...right, stack_fit: 85 }).success, false);
  const { hook: _hook, ...missing } = right;
  assert.equal(ScoreResult.safeParse(missing).success, false);
});

test('a 429 waits as long as Groq asked, even with no retry-after header', () => {
  // The real message, from a scoring run on 2026-08-10. Without reading the body the
  // backoff is 1s and all three retries land inside the same rate-limit window.
  const real =
    'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_01ks` service ' +
    'tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 6956, Requested 3570. ' +
    'Please try again in 18.945s.';
  assert.equal(retryAfterMs(null, real), 19_945, 'the stated wait plus a second of headroom');

  assert.equal(retryAfterMs('30', real), 30_000, 'an explicit header wins');
  assert.equal(retryAfterMs(null, 'try again in 250ms'), 1_250, 'milliseconds are not read as seconds');
  assert.equal(retryAfterMs(null, 'internal server error'), 0, 'no hint → caller backs off itself');
  assert.equal(retryAfterMs(null, 'try again in 3600s'), 60_000, 'capped, never an hour-long sleep');
});

test('a bad generation is told apart from a rate limit — only one earns a nudged retry', () => {
  // A 429 says nothing about the sampling, so it must be retried exactly as it was;
  // a broken generation at temperature 0 would otherwise repeat itself.
  assert.equal(
    isGenerationFailure(new GroqError(400, 'Failed to validate JSON. Please adjust your prompt.')),
    true,
  );
  assert.equal(
    isGenerationFailure(new GroqError(400, 'json_validate_failed', '{"level_fit":8,')),
    true,
    'a truncated failed_generation is the same problem, whatever the message says',
  );
  assert.equal(isGenerationFailure(new GroqError(429, 'Rate limit reached … TPM')), false);
  assert.equal(isGenerationFailure(new GroqError(503, 'service unavailable')), false);
});

test('an unset API key fails with instructions, not a stack trace', async () => {
  const saved = process.env['GROQ_API_KEY'];
  delete process.env['GROQ_API_KEY'];
  try {
    const { chat } = await import('./groq.ts');
    await assert.rejects(
      () => chat({ job: 'score', messages: [{ role: 'user', content: 'hi' }] }),
      /GROQ_API_KEY is not set.*console\.groq\.com/s,
    );
  } finally {
    if (saved !== undefined) process.env['GROQ_API_KEY'] = saved;
  }
});
