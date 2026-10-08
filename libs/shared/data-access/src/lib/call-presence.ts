import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import type { CallPresenceMap, SuccessResponse } from '@supadoc/models';

export type CallPresenceState = 'in' | 'out';

/** How often a call screen says "I'm still here" (the API forgets it after 40 s). */
export const CALL_PRESENCE_BEAT_MS = 15_000;
/** How often lists / pages refresh who is in the call. */
export const CALL_PRESENCE_POLL_MS = 15_000;

/**
 * POST one presence heartbeat. Never throws — presence is a nicety, it must
 * never disturb the call.
 *
 * The API is on another origin, so a JSON request is preflighted, and some
 * browsers refuse `keepalive` on preflighted requests. So: "in" beats are plain
 * requests; "out" without extra headers is a CORS-simple request (no body, the
 * state in the query — no preflight) with `keepalive`, so it still goes out
 * while the page is closing; "out" with headers (a bearer token) tries
 * `keepalive` and falls back to a plain request. A lost "out" only means the
 * person shows as present until the API forgets them (40 s).
 */
export function sendCallPresence(
  url: string,
  state: CallPresenceState,
  headers: Record<string, string> = {},
): void {
  const swallow = () => undefined;
  try {
    if (state === 'out' && Object.keys(headers).length === 0) {
      void fetch(`${url}${url.includes('?') ? '&' : '?'}state=out`, { method: 'POST', keepalive: true }).catch(swallow);
      return;
    }
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify({ state }),
    };
    if (state === 'out') {
      void fetch(url, { ...init, keepalive: true }).catch(() => fetch(url, init).catch(swallow));
    } else {
      void fetch(url, init).catch(swallow);
    }
  } catch {
    /* presence is best-effort */
  }
}

/**
 * Heartbeat for as long as the caller is in the call: "in" now and every
 * {@link CALL_PRESENCE_BEAT_MS}, "out" when the page is hidden for good
 * (pagehide) and again when the returned stop function runs (leaving / ending /
 * destroying the call screen). A page restored from the back/forward cache
 * says "in" again.
 */
export function startCallPresence(
  send: (state: CallPresenceState) => void,
  intervalMs = CALL_PRESENCE_BEAT_MS,
): () => void {
  let stopped = false;
  send('in');
  const timer = setInterval(() => send('in'), intervalMs);
  const onHide = () => send('out');
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted && !stopped) send('in');
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    send('out');
  };
}

/**
 * Who is in each appointment's call, kept fresh while the page is open: loads
 * now, every {@link CALL_PRESENCE_POLL_MS} while the tab is visible, and as soon
 * as it becomes visible again. Call in an injection context (a component's
 * field initialiser or constructor); polling stops with the component.
 */
export function injectCallPresence(
  load: () => Observable<SuccessResponse<CallPresenceMap>>,
  intervalMs = CALL_PRESENCE_POLL_MS,
): Signal<CallPresenceMap> {
  const destroyRef = inject(DestroyRef);
  const map = signal<CallPresenceMap>({});
  let sub: Subscription | null = null;
  const tick = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    sub?.unsubscribe();
    sub = load().subscribe({
      next: (res) => map.set(res?.data ?? {}),
      // Keep the last known state; the next tick tries again.
      error: () => undefined,
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  destroyRef.onDestroy(() => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    sub?.unsubscribe();
  });
  return map.asReadonly();
}
