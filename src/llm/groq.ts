/**
 * The Groq client. Everything that talks to an LLM goes through here.
 *
 * Groq speaks the OpenAI chat-completions shape, so this is plain `fetch` — no SDK.
 * Swapping a single stage to another provider means writing another module with the
 * same two exported functions and changing one import (decision 011).
 *
 * Two failure modes are handled that a naive client would not survive:
 *
 * 1. **Rate limits.** The free tier is per-model. 429s carry `retry-after`; we honour it.
 * 2. **Structured-output flakiness.** Measured on 2026-08-09: `gpt-oss-120b` failed to
 *    produce schema-valid JSON on roughly one call in four, then succeeded three times
 *    in a row on the identical prompt. It is a dice roll, not a capability gap — so a
 *    schema failure is retried rather than propagated.
 */
import { z } from 'zod';
import type { LlmJob } from './models.ts';
import { modelFor } from './models.ts';

const BASE_URL = process.env['GROQ_BASE_URL'] ?? 'https://api.groq.com/openai/v1';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;

/** Minimum gap between calls to one model, so a batch of scorings does not trip the limiter. */
const MIN_INTERVAL_MS = 700;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class GroqError extends Error {
  status: number;
  /** What the model actually produced, when it produced invalid JSON. */
  failedGeneration: string | undefined;

  constructor(status: number, message: string, failedGeneration?: string) {
    super(`groq ${status}: ${message}`);
    this.name = 'GroqError';
    this.status = status;
    this.failedGeneration = failedGeneration;
  }
}

/** Missing key is a setup problem, not a runtime one — fail with instructions. */
function apiKey(): string {
  const key = process.env['GROQ_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error(
      'GROQ_API_KEY is not set. Add it to .env (see .env.example) — get one free at ' +
        'https://console.groq.com/keys',
    );
  }
  return key;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Per-model promise chain, so concurrent callers space themselves out. */
const modelChain = new Map<string, Promise<void>>();

function pace(model: string): Promise<void> {
  const prev = modelChain.get(model) ?? Promise.resolve();
  const next = prev.then(() => sleep(MIN_INTERVAL_MS));
  modelChain.set(model, next);
  return next;
}

/** A schema failure is worth another roll of the dice; a bad request is not. */
const isRetryable = (err: GroqError): boolean =>
  err.status === 429 ||
  err.status >= 500 ||
  err.failedGeneration !== undefined ||
  /failed to (generate|validate) json/i.test(err.message);

export type ChatOptions = {
  job: LlmJob;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** JSON Schema for strict structured output. Set by `complete`; rarely passed directly. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  timeoutMs?: number;
  retries?: number;
};

type GroqResponse = {
  choices: { message: { content: string } }[];
  usage?: { total_tokens?: number };
  error?: { message: string; failed_generation?: string };
};

/** One chat completion. Returns the assistant's raw text. */
export async function chat(opts: ChatOptions): Promise<string> {
  const model = modelFor(opts.job);
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = opts;

  const messages: ChatMessage[] = opts.system
    ? [{ role: 'system', content: opts.system }, ...opts.messages]
    : opts.messages;

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    max_tokens: opts.maxTokens ?? 2048,
  };

  if (opts.responseSchema) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: opts.responseSchema.name, strict: true, schema: opts.responseSchema.schema },
    };
  }

  let lastError: unknown;
  let backoffMs = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs || 1000 * 2 ** (attempt - 1));
    await pace(model.id);

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await res.json()) as GroqResponse;

      if (!res.ok || payload.error) {
        const retryAfter = Number(res.headers.get('retry-after'));
        backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : 0;

        const err = new GroqError(
          res.status,
          payload.error?.message ?? res.statusText,
          payload.error?.failed_generation,
        );
        if (!isRetryable(err)) throw err;
        lastError = err;
        continue;
      }

      const content = payload.choices[0]?.message?.content;
      if (content === undefined) {
        lastError = new GroqError(res.status, 'response had no message content');
        continue;
      }
      return content;
    } catch (err) {
      if (err instanceof GroqError && !isRetryable(err)) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * A chat completion validated against a Zod schema.
 *
 * The same schema produces the JSON Schema sent to Groq *and* validates what comes back,
 * so there is exactly one definition of the shape. A response that parses as JSON but
 * fails the schema is retried — that is the flakiness described at the top of this file,
 * not a permanent failure.
 */
/**
 * Zod schema → the JSON Schema Groq's strict mode accepts.
 *
 * Zod emits a `$schema` dialect marker that strict mode rejects, so it is stripped.
 * Everything else Zod produces — `required`, `additionalProperties: false` — is already
 * what strict mode wants.
 */
export function toStrictJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

export async function complete<T>(
  schema: z.ZodType<T>,
  name: string,
  opts: Omit<ChatOptions, 'responseSchema'>,
): Promise<T> {
  const jsonSchema = toStrictJsonSchema(schema);

  // Two retry layers doing different jobs: `chat` retries transport, rate limits, and
  // Groq-side JSON generation failures; this loop retries output that parsed but did not
  // satisfy the schema.
  const SCHEMA_RETRIES = 2;
  let lastIssue = '';

  for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
    const raw = await chat({ ...opts, responseSchema: { name, schema: jsonSchema } });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastIssue = `not valid JSON: ${raw.slice(0, 120)}`;
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    lastIssue = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }

  throw new Error(`model never produced schema-valid output for "${name}" — last issue: ${lastIssue}`);
}
