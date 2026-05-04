import { logger } from "@trigger.dev/sdk/v3";

/**
 * fetch with automatic retry on transient failures.
 *
 * Retries on:
 *   - 429 Too Many Requests   (uses Retry-After if present, else exp backoff)
 *   - 503 Service Unavailable (transient)
 *   - 502 / 504               (gateway transients)
 *   - network errors (TypeError from `fetch` itself)
 *
 * Does NOT retry on 4xx other than 429 — those are bugs, not transients.
 *
 * Usage: drop-in replacement for `fetch` in trigger task code that calls
 * Unipile / Microsoft Graph / RingCentral / Anthropic. Each of those
 * services has their own rate-limit semantics, but they all surface 429
 * with a Retry-After header, so a single helper fits all four.
 */

interface RetryOptions {
  /** Total attempts including the first try. Default 4. */
  maxAttempts?: number;
  /** Base delay (ms) for exponential backoff. Default 1000. */
  baseDelayMs?: number;
  /** Cap on delay (ms). Default 30s. */
  maxDelayMs?: number;
  /** Friendly label for log lines. */
  label?: string;
}

const DEFAULT_OPTS: Required<Omit<RetryOptions, "label">> = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  // Either an integer seconds count or an HTTP date.
  const asNum = Number(header);
  if (Number.isFinite(asNum)) return Math.max(0, asNum) * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function backoffDelay(attempt: number, base: number, cap: number): number {
  // Full-jitter exponential backoff (AWS Architecture blog pattern).
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTS, ...opts };
  const label = opts.label || new URL(url).host;

  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok || !TRANSIENT_STATUSES.has(resp.status)) {
        return resp;
      }

      // Transient — back off + retry, unless this was the last attempt.
      if (attempt === maxAttempts) {
        logger.warn(`${label}: gave up after ${attempt} attempts (status ${resp.status})`);
        return resp;
      }

      const retryAfter = parseRetryAfter(resp.headers.get("Retry-After"));
      const delay = retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs);
      logger.warn(`${label}: status ${resp.status}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(delay);
    } catch (err: any) {
      lastError = err;
      if (attempt === maxAttempts) throw err;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      logger.warn(`${label}: network error, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`, {
        error: err.message,
      });
      await sleep(delay);
    }
  }

  // Unreachable, but keeps TS happy.
  throw lastError ?? new Error(`${label}: exhausted retries`);
}
