// Resilient JSON fetch for long upstream-API sync loops (ADO, etc.).
//
// A single ADO intelligence sync of a large project (50+ repos, tens of
// thousands of PRs) issues many thousands of sequential HTTP requests.
// Over that volume a bare `fetch` will, with near-certainty, hit a transient
// socket drop/reset (surfacing as undici's generic `TypeError: fetch failed`)
// or a 429/5xx.
//
// Crucially, the timeout must cover the RESPONSE BODY read, not just the
// connection/headers. A stalled body stream on `await resp.json()` will hang
// forever if the abort timer was already cleared — which is exactly what wedged
// a real mega-repo sync (one worker await that never resolved, no error, no
// progress). So this helper keeps the AbortController armed until the body is
// fully parsed: a stalled body aborts and is retried like any other transient
// failure, and the worker never hangs.
//
// Non-retryable responses (e.g. 401/404) are reported as `{ ok: false, status }`
// for the caller to interpret — this helper only retries plausibly-transient
// failures.

export interface ResilientFetchOpts {
  /** Per-attempt timeout in ms covering connect + headers + body read. Default 30000. */
  timeoutMs?: number;
  /** Number of retries AFTER the first attempt. Default 3 (so 4 attempts max). */
  retries?: number;
  /** Base backoff in ms; attempt N waits backoffMs * 2^N. Default 500. */
  backoffMs?: number;
  /** Injectable delay (tests pass a no-op to avoid real waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the retryable classification. */
  isRetryable?: (resp: { status: number } | null, err: unknown) => boolean;
  /**
   * Upper bound on a server-supplied `Retry-After` wait, in ms. Default 120000.
   * A pathological header must not park a sync job for hours behind its lock.
   */
  maxRetryAfterMs?: number;
  /** Injectable clock, for resolving the HTTP-date form of `Retry-After`. */
  now?: () => number;
  /** Called whenever the server asked us to back off, before the wait. */
  onThrottled?: (info: { status: number; waitMs: number; url: string }) => void;
}

export interface ResilientJsonResult<T> {
  ok: boolean;
  status: number;
  statusText: string;
  data: T | null;
  /**
   * Response headers, when a response was received (absent when every attempt
   * threw). Some ADO endpoints paginate through a header rather than the body —
   * the Release API returns `x-ms-continuationtoken`.
   */
  headers?: Headers;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A response is retryable on rate-limit (429) or any server error (5xx).
// A thrown error (network failure / timeout abort / aborted body read) is always retryable.
function defaultIsRetryable(resp: { status: number } | null, _err: unknown): boolean {
  if (resp === null) return true;
  return resp.status === 429 || resp.status >= 500;
}

const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

/**
 * Resolve a `Retry-After` header to a wait in ms, or null when absent/unparseable.
 *
 * Both RFC forms are accepted: delta-seconds ("30") and HTTP-date
 * ("Wed, 12 Aug 2026 09:00:00 GMT"). Azure DevOps sends delta-seconds when it
 * starts delaying a caller that has exceeded its throughput limit.
 */
function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  // delta-seconds — a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - nowMs);
}

export async function resilientFetchJson<T>(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit = {},
  opts: ResilientFetchOpts = {},
): Promise<ResilientJsonResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const now = opts.now ?? Date.now;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await doFetch(url, { ...init, signal: controller.signal });
      if (!resp.ok) {
        if (attempt < retries && isRetryable(resp, null)) {
          // A server-supplied Retry-After always wins over our own ramp: when
          // the upstream is already throttling us, retrying sooner than it asked
          // spends more of the budget we have just exhausted.
          const retryAfterMs = parseRetryAfter(resp.headers.get('Retry-After'), now());
          if (retryAfterMs !== null) {
            const waitMs = Math.min(retryAfterMs, maxRetryAfterMs);
            opts.onThrottled?.({ status: resp.status, waitMs, url });
            await sleep(waitMs);
          } else {
            await sleep(backoffMs * 2 ** attempt);
          }
          continue;
        }
        return {
          ok: false,
          status: resp.status,
          statusText: resp.statusText,
          data: null,
          headers: resp.headers,
        };
      }
      // Body read stays inside the same timeout window: a stalled body stream
      // aborts here (throwing) instead of hanging the worker forever.
      const data = (await resp.json()) as T;
      return { ok: true, status: resp.status, statusText: resp.statusText, data, headers: resp.headers };
    } catch (err) {
      lastError = err;
      if (attempt < retries && isRetryable(null, err)) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable in practice: the loop either returns or throws above.
  throw lastError instanceof Error ? lastError : new Error('resilientFetchJson: exhausted retries');
}
