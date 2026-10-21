import {
  HttpContextToken,
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import {
  catchError,
  defer,
  finalize,
  from,
  type Observable,
  switchMap,
  throwError,
} from 'rxjs';
import {
  apiErrorCode,
  apiErrorMessage,
  apiErrorReason,
} from '@supadoc/data-access';
import type { TokenSession } from './session-auth';
import { peekSessionNotice, SESSION_END_MESSAGES } from './session-notice';
import {
  SESSION_TIMEOUT_CONFIG,
  SessionTimeoutService,
  UPLOAD_HOLD_PREFIX,
} from './session-timeout.service';
import { classifyAuth401, endReasonFor, errorStatus } from './session-utils';

/** Marks a request already retried after a refresh, so it is never retried twice. */
const RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * The sign-in / refresh / logout / invite endpoints: never wait for a refresh
 * before them (the refresh would wait on itself), never refresh on their 401s
 * (a wrong password is not an expired session).
 */
const AUTH_ENDPOINT = /\/auth\//;
/** Public endpoints (call links, published lists): the token, if any, is optional. */
const PUBLIC_ENDPOINT = /\/public\//;

/** How much life an access token must have left before a request is sent with it. */
export const REQUEST_TOKEN_MARGIN_MS = 60_000;
/** …and before an upload, which can take minutes and is only checked once its body has arrived. */
export const UPLOAD_TOKEN_MARGIN_MS = 600_000;

/** Shown when the sign-in could not be confirmed for a transient reason (the user is still signed in). */
export const REFRESH_UNAVAILABLE_MESSAGE =
  "We couldn't confirm your sign-in just now. Please check your connection and try again.";

let uploadSeq = 0;

function isUpload(req: HttpRequest<unknown>): boolean {
  return typeof FormData !== 'undefined' && req.body instanceof FormData;
}

function withBearer(
  req: HttpRequest<unknown>,
  token: string | null,
): HttpRequest<unknown> {
  return token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;
}

/** A 401 in the API's envelope (`errors.auth` first, then the machine code). */
function authError(
  req: HttpRequest<unknown>,
  message: string,
  code: string,
): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 401,
    statusText: 'Unauthorized',
    url: req.urlWithParams,
    error: { status: 'error', message, errors: { auth: message, code } },
  });
}

/** The request could not be made because the session ended — with the notice the sign-in page shows. */
function signedOutError(req: HttpRequest<unknown>): HttpErrorResponse {
  return authError(
    req,
    peekSessionNotice() ?? SESSION_END_MESSAGES.expired,
    'signed_out',
  );
}

/** The sign-in could not be confirmed right now (offline, 5xx, rate limited) — still signed in. */
function refreshUnavailableError(req: HttpRequest<unknown>): HttpErrorResponse {
  return authError(req, REFRESH_UNAVAILABLE_MESSAGE, 'refresh_unavailable');
}

/**
 * The shared session-aware request handler behind `refreshInterceptor`
 * (patient) and `staffAuthInterceptor` (doctor, back office). In order:
 *
 * 1. Auth endpoints and `/public/` URLs: the bearer (if any) is attached and
 *    the request sent as it is — no waiting, no 401 handling.
 * 2. Everything else waits until the access token is good for another minute
 *    (ten for an upload) — joining a refresh already running, or starting
 *    one — so no request leaves with a token about to expire, and none races a
 *    refresh. An upload also holds the idle timer while it runs.
 * 3. A 401 is read by its `errors.code` (see `classifyAuth401`):
 *    - token expired / invalid, or no code (an API without codes): another
 *      refresh already replaced the token → retried with it; else refreshed
 *      once and retried once (never again; a retry met by a session-ending
 *      401 ends the session). A refresh that failed for now gives a friendly
 *      `refresh_unavailable` error (still signed in); one that ended the
 *      session gives `signed_out`, with the sign-in notice as its message;
 *    - session / account codes: the session is ended at once with the
 *      server's message (no refresh that is bound to fail);
 *    - anything else (a token for the wrong portal): passed on untouched.
 *
 * It sees raw `HttpErrorResponse`s, so register its interceptor INNERMOST
 * (after `httpErrorInterceptor`), which then never sees — or logs — a 401
 * that was handled here.
 */
export function handleSessionRequest(
  auth: TokenSession,
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  if (AUTH_ENDPOINT.test(req.url) || PUBLIC_ENDPOINT.test(req.url)) {
    return next(withBearer(req, auth.token()));
  }

  const upload = isUpload(req);
  // Only apps with an idle timeout (not mobile) hold it for uploads.
  const timeout =
    upload && inject(SESSION_TIMEOUT_CONFIG, { optional: true })
      ? inject(SessionTimeoutService)
      : null;

  const send$ = defer(() => {
    const hadToken = auth.token() !== null;
    const ready = hadToken
      ? auth
          .ensureFreshToken(
            upload ? UPLOAD_TOKEN_MARGIN_MS : REQUEST_TOKEN_MARGIN_MS,
          )
          .catch(() => undefined)
      : Promise.resolve();
    return from(ready).pipe(
      switchMap(() => {
        const sent = auth.token();
        // The session ended while we waited (the refresh was refused): don't send a request bound to fail.
        if (hadToken && sent === null)
          return throwError(() => signedOutError(req));
        return next(withBearer(req, sent)).pipe(
          catchError((err: unknown) => on401(err, sent)),
        );
      }),
    );
  });

  // The one retry is never retried again — but a 401 saying the session is
  // over (e.g. `session_revoked` after the token was swapped) still ends it,
  // so the page is not left waiting for some later request to notice.
  const retry = (token: string | null): Observable<HttpEvent<unknown>> =>
    next(
      withBearer(req.clone({ context: req.context.set(RETRIED, true) }), token),
    ).pipe(
      catchError((err: unknown) => {
        const code = apiErrorCode(err);
        if (
          errorStatus(err) === 401 &&
          classifyAuth401(code, true) === 'end' &&
          token !== null &&
          auth.token() === token
        ) {
          auth.expire(
            endReasonFor(code, apiErrorReason(err)),
            apiErrorMessage(err, SESSION_END_MESSAGES.expired),
          );
        }
        return throwError(() => err);
      }),
    );

  const on401 = (
    err: unknown,
    sent: string | null,
  ): Observable<HttpEvent<unknown>> => {
    if (errorStatus(err) !== 401 || req.context.get(RETRIED))
      return throwError(() => err);
    const hasRefresh = auth.hasRefreshToken();
    // Sent signed out, and nothing to sign in with: not ours to handle.
    if (sent === null && !hasRefresh) return throwError(() => err);
    const code = apiErrorCode(err);
    const action = classifyAuth401(code, hasRefresh);
    if (action === 'pass') return throwError(() => err);

    // Another refresh (or a new sign-in) replaced the token while this one was out.
    const current = auth.token();
    if (current !== null && current !== sent) return retry(current);

    if (action === 'end') {
      if (current !== null) {
        auth.expire(
          endReasonFor(code, apiErrorReason(err)),
          apiErrorMessage(err, SESSION_END_MESSAGES.expired),
        );
      }
      return throwError(() => err);
    }

    if (!hasRefresh) {
      // "Invalid or expired token" is no notice for a person: the standard one is.
      auth.expire('expired');
      return throwError(() => signedOutError(req));
    }
    return from(auth.refresh().catch(() => false)).pipe(
      switchMap((ok) => {
        const fresh = auth.token();
        if (ok && fresh !== null) return retry(fresh);
        if (!auth.isAuthenticated())
          return throwError(() => signedOutError(req));
        return throwError(() => refreshUnavailableError(req));
      }),
    );
  };

  if (!timeout) return send$;
  return defer(() => {
    const key = `${UPLOAD_HOLD_PREFIX}${++uploadSeq}`;
    timeout.hold(key);
    return send$.pipe(finalize(() => timeout.release(key)));
  });
}
