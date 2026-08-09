/**
 * No network. These cover the piece most likely to break silently: the schema handed to
 * Groq's strict mode. A malformed one fails at request time, in the dark, at 06:00.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toStrictJsonSchema } from './groq.ts';
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
  assert.deepEqual(json.required.sort(), ['fit_score', 'hook', 'reasoning']);
  assert.equal(json.additionalProperties, false);
});

test('constraints survive the conversion', () => {
  const json = toStrictJsonSchema(ScoreResult) as {
    properties: { fit_score: { type: string; minimum: number; maximum: number } };
  };
  assert.equal(json.properties.fit_score.type, 'integer');
  assert.equal(json.properties.fit_score.minimum, 0);
  assert.equal(json.properties.fit_score.maximum, 100);
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
  const wrong = { fit_score: 150, reasoning: 'x', hook: 'y' };
  assert.equal(ScoreResult.safeParse(wrong).success, false);
  const missing = { fit_score: 80, reasoning: 'x' };
  assert.equal(ScoreResult.safeParse(missing).success, false);
  const right = { fit_score: 80, reasoning: 'x', hook: 'y' };
  assert.equal(ScoreResult.safeParse(right).success, true);
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
