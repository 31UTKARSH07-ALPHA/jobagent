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
 *
 * **Reproducibility.** Groq's default temperature is 1.0. Measured on 2026-08-10: the same
 * posting scored 55 and 92 on two runs of the identical scoring prompt — the difference
 * between a terminal REJECTED and a MATCHED. Callers whose output is a judgement rather
 * than prose pass `temperature: 0` (decision 012).
 */
import { z } from 'zod';
import type { LlmJob } from './models.ts';
import { modelFor } from './models.ts';
import { estimateTokens, windowFor } from './rate-limit.ts';

const BASE_URL = process.env['GROQ_BASE_URL'] ?? 'https://api.groq.com/openai/v1';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;

/**
 * Minimum gap between calls to one model.
 *
 * A floor, not the actual pacing — the token budget in `./rate-limit.ts` does that work. This
 * only stops two calls leaving in the same millisecond.
 */
const MIN_INTERVAL_MS = 700;

/**
 * What a retry uses after the model failed to produce valid JSON at temperature 0.
 *
 * An identical request at temperature 0 tends to reproduce the same broken output — the
 * sampler is in the same place, so retrying is not a fresh roll of the dice. Measured on
 * 2026-08-10: one posting failed JSON validation four attempts in a row, then succeeded on
 * a later identical call. Just enough nudge to land somewhere else.
 */
const SCHEMA_RETRY_TEMPERATURE = 0.3;

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

/**
 * How long to wait after a 429.
 *
 * Groq does not always send a `retry-after` header, but its 429 body always names the wait:
 * "Please try again in 18.945s". Without reading that, the exponential fallback (1s, 2s, 4s)
 * is far shorter than a token-per-minute window, so all three retries burn inside the same
 * window and the job is lost for the day. Measured on 2026-08-10: scoring is ~3,500 tokens
 * a call against a free-tier limit of 8,000 TPM, so the third call in a minute always 429s.
 */
export function retryAfterMs(headerValue: string | null, message: string): number {
  const header = Number(headerValue);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);

  const fromBody = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message);
  if (fromBody) {
    const value = Number(fromBody[1]);
    const ms = fromBody[2]?.toLowerCase() === 'ms' ? value : value * 1000;
    // A second of headroom: the window boundary is theirs, not ours, and landing exactly on
    // it just earns another 429.
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms + 1_000, 60_000);
  }

  return 0;
}

/** The model produced something, and it was not valid against the schema. */
export const isGenerationFailure = (err: GroqError): boolean =>
  err.failedGeneration !== undefined || /failed to (generate|validate) json/i.test(err.message);

/** A schema failure is worth another roll of the dice; a bad request is not. */
const isRetryable = (err: GroqError): boolean =>
  err.status === 429 || err.status >= 500 || isGenerationFailure(err);

export type ChatOptions = {
  job: LlmJob;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /**
   * Groq defaults to 1.0. Rubric work wants 0 — see the note on reproducibility above.
   * Omitted from the request when unset, so the provider default is not silently changed
   * for jobs that want variety (drafting).
   */
  temperature?: number;
  /** JSON Schema for strict structured output. Set by `complete`; rarely passed directly. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  /**
   * How much of `max_tokens` the model may spend thinking before it answers.
   *
   * These are reasoning models and the thinking is billed inside the output budget, not
   * beside it. Measured 2026-08-25 on `gpt-oss-120b` with `max_tokens: 900`: the default
   * spent **774 tokens reasoning** and returned a truncated 583-character answer; the same
   * request at `'low'` spent **15** and finished cleanly. Drafting sets this because an
   * email is a long output that needs almost no deliberation — the judgement was already
   * made by the scorer.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  retries?: number;
  /**
   * The caller's deadline. Combined with `timeoutMs`, and checked before each attempt and
   * inside the pacer's wait.
   *
   * Without it the score stage's 75-minute budget cannot stop anything: on 2026-08-25 three
   * jobs took **2.9 hours** while that budget sat there unable to fire, because every network
   * call here goes through this file's own `fetch` (decision 029).
   */
  signal?: AbortSignal;
};

type GroqResponse = {
  choices: { message: { content: string }; finish_reason?: string }[];
  usage?: { total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
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

  if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
  if (opts.reasoningEffort !== undefined) body['reasoning_effort'] = opts.reasoningEffort;

  if (opts.responseSchema) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: opts.responseSchema.name, strict: true, schema: opts.responseSchema.schema },
    };
  }

  let lastError: unknown;
  let backoffMs = 0;
  /** Whether the previous attempt failed on JSON rather than on transport or rate limit. */
  let badGeneration = false;

  // What Groq will charge for this request: the prompt, plus the output budget, whether or not
  // the model uses it (decision 013).
  const cost =
    estimateTokens(messages.map((m) => m.content).join('\n')) + Number(body['max_tokens']);
  const budget = windowFor(model.id, model.tpm);

  // A function, not an inline check: `aborted` flips while this loop is sleeping, and
  // TypeScript would narrow a repeated inline test to `false` after the first one.
  const stop = (): void => {
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error('aborted');
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Out of budget: stop before spending another minute on a stage nobody is waiting on.
    stop();

    if (attempt > 0) await sleep(backoffMs || 1000 * 2 ** (attempt - 1));

    // Wait for room in the trailing minute rather than submitting and being refused. Loops
    // because one expiring entry may not free enough on its own.
    //
    // Checked inside the loop as well as outside it: this is where a run legitimately spends
    // most of its time — ~67s per job at two calls a minute — so it is exactly where a stage
    // that has run out of time will be sitting when it does.
    for (let waitMs = budget.waitMsFor(cost, Date.now()); waitMs > 0; waitMs = budget.waitMsFor(cost, Date.now())) {
      stop();
      await sleep(waitMs);
    }

    const reservation = budget.reserve(cost, Date.now());
    await pace(model.id);

    // Only after a JSON failure: a 429 says nothing about the sampling, so a rate-limited
    // call should be retried exactly as it was.
    if (badGeneration && body['temperature'] === 0) {
      body['temperature'] = SCHEMA_RETRY_TEMPERATURE;
    }

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal:
          opts.signal === undefined
            ? AbortSignal.timeout(timeoutMs)
            : AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal]),
      });

      const payload = (await res.json()) as GroqResponse;

      // Replace the character-count estimate with what was actually charged, so a long batch
      // does not drift. Absent on an error response, in which case the estimate stands.
      if (payload.usage?.total_tokens !== undefined) {
        budget.settle(reservation, payload.usage.total_tokens);
      }

      if (!res.ok || payload.error) {
        const message = payload.error?.message ?? res.statusText;
        backoffMs = retryAfterMs(res.headers.get('retry-after'), message);

        const err = new GroqError(res.status, message, payload.error?.failed_generation);
        if (!isRetryable(err)) throw err;
        badGeneration = isGenerationFailure(err);
        lastError = err;
        continue;
      }

      const content = payload.choices[0]?.message?.content;
      if (content === undefined) {
        lastError = new GroqError(res.status, 'response had no message content');
        continue;
      }

      // `finish_reason: 'length'` means the answer stops mid-sentence. Returning it would
      // hand the caller a half-written email or a JSON fragment and call it success — which
      // is how a 583-character stub reached the draft checker as "too short to say
      // anything" rather than as the truncation it was. Retried, because reasoning length
      // varies run to run and the next attempt may well fit.
      if (payload.choices[0]?.finish_reason === 'length') {
        lastError = new GroqError(
          res.status,
          `reply was cut off at max_tokens (${String(body['max_tokens'])}) — ` +
            `${payload.usage?.completion_tokens_details?.reasoning_tokens ?? '?'} of them spent reasoning`,
        );
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
    // The outer of the two retry layers needs the same guard — three schema attempts, each
    // of which is itself a retrying `chat`, is a long time to spend past a deadline.
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error('aborted');

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
