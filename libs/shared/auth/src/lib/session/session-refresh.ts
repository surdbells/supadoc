/**
 * After a refresh that failed for a transient reason (offline, 5xx, 429, a CDN
 * error page), wait before trying again — the server's `Retry-After` when it
 * sent one, else 5 s, 10 s, 20 s, 40 s, then every 60 s — so a struggling API
 * isn't hammered by every request on every open tab.
 */
export class RefreshBackoff {
  private until = 0;
  private failures = 0;

  /** True while a new refresh attempt should wait. */
  blocked(now = Date.now()): boolean {
    return now < this.until;
  }

  fail(retryAfterMs: number | null, now = Date.now()): void {
    const wait = retryAfterMs ?? Math.min(60_000, 5_000 * 2 ** this.failures);
    this.failures = Math.min(this.failures + 1, 5);
    // At least a second, at most five minutes, whatever the header said.
    this.until = now + Math.min(Math.max(wait, 1_000), 300_000);
  }

  reset(): void {
    this.until = 0;
    this.failures = 0;
  }
}

/**
 * Run `fn` holding a cross-tab lock (Web Locks), so several tabs whose token
 * expires at the same moment refresh one at a time — the later ones then find
 * the token the first stored and skip the network. Without Web Locks (old
 * browsers, tests) `fn` simply runs. `fn` must not throw.
 */
export async function withRefreshLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  type Locks = {
    request?: (
      n: string,
      opts: { signal?: AbortSignal },
      cb: () => Promise<T>,
    ) => Promise<T>;
  };
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { locks?: Locks }).locks
      : undefined;
  if (!locks?.request) return fn();
  // Never wait long for another tab (e.g. one whose refresh hangs on a dead connection).
  const signal =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(LOCK_WAIT_MS)
      : undefined;
  let ran = false;
  try {
    return await locks.request(name, { signal }, () => {
      ran = true;
      return fn();
    });
  } catch (err) {
    // The lock was refused or not granted in time: refresh without it.
    if (!ran) return fn();
    throw err;
  }
}

/** How long a tab waits for another tab's refresh before refreshing itself. */
const LOCK_WAIT_MS = 10_000;

/**
 * How long the refresh request itself may take. Every guard and every request
 * waits on the one refresh in flight, so an API that accepts the connection
 * but never answers (a saturated PHP-FPM; a CDN that only gives up after
 * ~100 s) must not freeze the tab: past this, the attempt counts as a
 * transient failure — still signed in, backing off before the next one.
 */
export const REFRESH_TIMEOUT_MS = 15_000;
