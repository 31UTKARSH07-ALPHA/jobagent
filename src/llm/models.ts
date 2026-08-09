/**
 * Which Groq model does which job.
 *
 * These IDs are **verified against the live catalogue**, not remembered — Groq's model
 * list changes, and a stale ID here means the pipeline silently fails at 06:00. Re-check
 * with `node src/llm/verify-models.ts`, which also smoke-tests structured output.
 *
 * Everything runs on the free tier (decision 011).
 */
import { z } from 'zod';

/** The three things this project asks an LLM to do. */
export const LlmJob = z.enum(['score', 'draft', 'profile']);
export type LlmJob = z.infer<typeof LlmJob>;

export type ModelChoice = {
  id: string;
  /** Why this model, in terms of what the job needs. */
  why: string;
  /** Whether the model accepts `response_format: {type: 'json_schema'}`. */
  jsonSchema: boolean;
};

/** Verified 2026-08-09 against `https://api.groq.com/openai/v1/models`. */
export const MODELS: Record<LlmJob, ModelChoice> = {
  // ~30 calls a day. Cheapest model that passes strict JSON schema — measured at ~485
  // tokens for a full scoring call, and the 120b is not measurably better at rubrics.
  score: {
    id: 'openai/gpt-oss-20b',
    why: 'high volume, rubric task, needs reliable structured output',
    jsonSchema: true,
  },
  // ~5 calls a day, and the only output a recruiter reads. Largest model available.
  draft: {
    id: 'openai/gpt-oss-120b',
    why: 'quality-sensitive; this is the actual product',
    jsonSchema: true,
  },
  // Runs once, ever. Take the best model available; cost is irrelevant at one call.
  profile: {
    id: 'openai/gpt-oss-120b',
    why: 'one-time resume parse — accuracy matters, volume does not',
    jsonSchema: true,
  },
};

export const modelFor = (job: LlmJob): ModelChoice => MODELS[job];
