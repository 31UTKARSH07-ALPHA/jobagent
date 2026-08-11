/**
 * A tokens-per-minute budget.
 *
 * The free tier's binding limit is **tokens** per minute, not requests, and Groq charges a
 * request as `prompt + max_tokens` at submission time — a scoring call with a 2,500-token
 * prompt and `max_tokens: 1024` is billed 3,570 whether or not the model uses that budget
 * (decision 013). Against 8,000 TPM that is two calls a minute.
 *
 * The old pacing was a flat 700ms gap between calls, which knows nothing about token cost, so
 * it kept submitting a third call into an exhausted window. Measured on 2026-08-11 across nine
 * scorings: two failed, one of them by **19 tokens** — "Limit 8000, Used 4015, Requested 4004".
 *
 * This class is deliberately pure and clock-injected: every decision is arithmetic on a
 * timestamp, so the awkward cases are unit-testable without a single `sleep`.
 */

export const WINDOW_MS = 60_000;

type Entry = { at: number; tokens: number; id: number };

export class TokenWindow {
  readonly limit: number;
  readonly windowMs: number;
  #entries: Entry[] = [];
  #nextId = 1;

  constructor(limit: number, windowMs: number = WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Drop entries that have aged out of the trailing window. */
  #prune(now: number): void {
    this.#entries = this.#entries.filter((e) => now - e.at < this.windowMs);
  }

  /** Tokens charged inside the trailing window. */
  used(now: number): number {
    this.#prune(now);
    return this.#entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  /**
   * How long to wait before `tokens` more would fit. `0` means go now.
   *
   * Waits only until the *oldest* entry expires, not for the whole window to drain — after
   * that the caller asks again. That keeps the wait as short as it can be while still being
   * correct if several entries have to age out.
   */
  waitMsFor(tokens: number, now: number): number {
    const used = this.used(now);
    if (used + tokens <= this.limit) return 0;

    // A single request larger than the entire per-minute budget can never fit. Waiting is
    // pointless — let it go and let the 429 handler deal with it, rather than hanging until
    // the process is killed.
    if (tokens > this.limit) return 0;

    const oldest = this.#entries[0];
    if (oldest === undefined) return 0;
    // +1ms so the entry is strictly outside the window when we re-check.
    return this.windowMs - (now - oldest.at) + 1;
  }

  /**
   * Charge `tokens` to the window and return a handle for {@link settle}.
   *
   * Reserved *before* the request, on the estimate, because Groq counts the request when it is
   * submitted. Reserving afterwards would let a second call slip through against a budget the
   * first has already spent.
   */
  reserve(tokens: number, now: number): number {
    this.#prune(now);
    const id = this.#nextId++;
    this.#entries.push({ at: now, tokens, id });
    return id;
  }

  /**
   * Replace a reservation with what the provider actually charged.
   *
   * The estimate is a character-count heuristic and will be wrong by some margin either way;
   * reconciling keeps a long batch from drifting. A reservation that has already aged out is
   * simply ignored.
   */
  settle(id: number, actualTokens: number): void {
    const entry = this.#entries.find((e) => e.id === id);
    if (entry !== undefined) entry.tokens = actualTokens;
  }

  /** Test/diagnostic view. */
  get size(): number {
    return this.#entries.length;
  }
}

/**
 * Characters → tokens, erring high.
 *
 * There is no tokenizer here on purpose: shipping one for a budget estimate is not worth the
 * dependency, and the consequence of being wrong is a 429 that is already handled. ~3.5
 * chars/token is conservative for English prose (the usual rule of thumb is 4), and the
 * over-estimate is the safe direction — it makes the pacer wait slightly too long rather than
 * slightly too little.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);

/** One window per model: the free tier's limits are per-model, not per-account. */
const windows = new Map<string, TokenWindow>();

export function windowFor(model: string, limit: number): TokenWindow {
  const existing = windows.get(model);
  if (existing !== undefined && existing.limit === limit) return existing;
  const fresh = new TokenWindow(limit);
  windows.set(model, fresh);
  return fresh;
}

/** Tests only: forget every window so one test's spending cannot fail another. */
export const resetWindows = (): void => void windows.clear();
