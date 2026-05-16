// Retry helper for read-side fetches (chapter/book summary). Mirrors the
// outbox's transient-error classification so a blipping connection auto-
// recovers without the user seeing an error screen.
//
// Retries on: network errors, timeouts, 5xx, 408/425/429, 401 (once — paired
// with the silent refresh in api.ts).
// Aborts (no retry) on: caller's signal, 4xx other than 401.
// While `!navigator.onLine` we wait for the `online` event instead of burning
// the attempt count.

import { ApiError } from "./api";
import { backoffMs } from "./backoff";

export interface FetchWithRetryOptions {
  signal: AbortSignal;
  /** Called once after each failed attempt so the UI can show "retrying…". */
  onAttempt?: (attempts: number, err: unknown) => void;
  /** Max attempts before giving up. Default: Infinity (give up only on abort). */
  maxAttempts?: number;
}

function isTransient(e: unknown): boolean {
  if (e instanceof ApiError) {
    if (e.status === 401) return true; // refresh ran once already; if it 401s again the next pass will surface emitAuthError
    if (e.status === 408 || e.status === 425 || e.status === 429) return true;
    if (e.status >= 500) return true;
    return false;
  }
  return true; // network / timeout / unknown → transient
}

function waitOnline(signal: AbortSignal): Promise<void> {
  if (typeof window === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      window.removeEventListener("online", onOnline);
      signal.removeEventListener("abort", onAbort);
    };
    const onOnline = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); resolve(); };
    window.addEventListener("online", onOnline);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: FetchWithRetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? Infinity;
  let attempts = 0;
  while (true) {
    if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
    attempts++;
    try {
      return await fn(opts.signal);
    } catch (e) {
      if (opts.signal.aborted) throw e;
      if (!isTransient(e) || attempts >= maxAttempts) throw e;
      opts.onAttempt?.(attempts, e);
      // Offline → wait for the `online` event rather than churning. Once the
      // browser fires it, fall through to backoff so a flapping connection
      // doesn't hammer the server immediately on every brief reconnect.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await waitOnline(opts.signal);
      }
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
      await delay(backoffMs(attempts), opts.signal);
    }
  }
}
