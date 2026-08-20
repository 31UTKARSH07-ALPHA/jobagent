/**
 * The one HTTP client every source adapter uses.
 *
 * Ingest hits a few hundred public job boards each morning. The things that actually
 * matter at that scale: a timeout on every request (a hung board must not stall the
 * run), a bounded number of concurrent requests (politeness, and laptop file limits),
 * and treating 404 as data rather than an error — a dead ATS slug is normal.
 */

/** Sent on every request so board owners can see who we are. */
const USER_AGENT =
  'jobagent/0.1 (personal job-search agent; https://github.com/31UTKARSH07-ALPHA/jobagent)';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

export class HttpError extends Error {
  status: number;
  url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export type GetJsonOptions = {
  timeoutMs?: number;
  /** Retries on 429/5xx/network errors only. 4xx is never retried. */
  retries?: number;
  /** The stage's deadline. Combined with `timeoutMs`, whichever fires first. */
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retryable = transient. A 404 is a permanent answer, a 503 is not. */
const isRetryable = (status: number) => status === 429 || status >= 500;

/**
 * Errors that mean "this machine has no network", as opposed to "this board is having a
 * bad minute". Node reports them on `cause` of the `TypeError: fetch failed` it throws.
 */
const OFFLINE_CODES = new Set([
  'ENOTFOUND', // DNS said no such host — with no resolver, that is every host
  'EAI_AGAIN', // DNS lookup timed out
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/**
 * Retrying a DNS failure is retrying the network, not the board.
 *
 * Measured 2026-08-14: launchd started the run before Wi-Fi associated, and 51 boards ×
 * 3 attempts against a dead resolver took **55 minutes** to arrive at zero jobs. The real
 * fix is the network gate in `scripts/run-daily.sh`; this is what keeps the cost bounded
 * when the network drops *during* a run instead of before it.
 */
export function isOffline(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code !== undefined && OFFLINE_CODES.has(code);
}

/**
 * Minimum gap between requests to a given host.
 *
 * Workable's widget API starts returning 429 well before the others do — during the
 * first board-verification run it 429'd on essentially every request, which made 53
 * real companies look like they had no job board. Spacing its requests out fixes that.
 */
const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  // Measured: 1.2s spacing still drew sustained 429s during a full verification sweep.
  'apply.workable.com': 2500,
};

/** Per-host promise chain, so concurrent callers still queue behind each other. */
const hostChain = new Map<string, Promise<void>>();

function pace(host: string): Promise<void> {
  const interval = HOST_MIN_INTERVAL_MS[host];
  if (interval === undefined) return Promise.resolve();

  const prev = hostChain.get(host) ?? Promise.resolve();
  const next = prev.then(() => sleep(interval));
  hostChain.set(host, next);
  return next;
}

/** `Retry-After` in seconds, or an HTTP date. Capped so one hostile header cannot stall a run. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (header === null) return null;

  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 30_000) : null;
}

/**
 * GET and parse JSON.
 *
 * Returns `null` for 404 — for a job board that means "this slug is not (or is no
 * longer) a real board", which callers handle as data, not failure. Any other non-2xx
 * throws {@link HttpError} after retries are exhausted.
 */
export async function getJson<T>(url: string, opts: GetJsonOptions = {}): Promise<T | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = opts;
  const host = URL.parse(url)?.host ?? '';
  let lastError: unknown;
  let backoffMs = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Out of budget: stop retrying, and do not start another request.
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error('aborted');

    if (attempt > 0) await sleep(backoffMs || 500 * 2 ** (attempt - 1)); // 500ms, 1s
    await pace(host);

    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]),
        redirect: 'follow',
      });

      if (res.status === 404) return null;

      if (!res.ok) {
        const err = new HttpError(res.status, url);
        if (!isRetryable(res.status)) throw err;
        // A server telling us how long to wait beats our own guess.
        backoffMs = retryAfterMs(res) ?? 0;
        lastError = err;
        continue;
      }

      return (await res.json()) as T;
    } catch (err) {
      // A non-retryable HttpError is final; network errors and timeouts are not.
      if (err instanceof HttpError) throw err;
      // ...except being offline, which no amount of retrying this one URL will fix.
      if (isOffline(err)) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`request failed: ${url} (${String(lastError)})`);
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Results keep input order. A rejected `fn` rejects the whole call — adapters are
 * expected to catch their own per-board failures so one dead board does not kill a
 * whole source (see `docs/architecture.md`, failure semantics).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
