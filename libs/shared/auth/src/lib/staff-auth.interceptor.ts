import { HttpContextToken, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { apiErrorMessage } from '@supadoc/data-access';
import { StaffAuthService } from './staff-auth.service';
import { SESSION_END_MESSAGES } from './session/session-notice';
import { errorStatus } from './session/session-utils';

/** Marks a request already retried after a refresh, so we never loop. */
const RETRIED = new HttpContextToken<boolean>(() => false);

/** Auth + public endpoints answer 401 for reasons that aren't "your session ended". */
const NOT_SESSION_BOUND = /\/(auth|public)\//;

/**
 * Staff/doctor/admin request interceptor: attaches the staff bearer token, and
 * on a 401 transparently refreshes once and retries (keeping the session alive
 * across the short access-token TTL). When the session is really over — the
 * refresh is rejected or impossible — it is ended (StaffAuthService.expire):
 * signed out everywhere and sent to sign in with an explanation.
 *
 * It runs OUTSIDE `httpErrorInterceptor` in the staff apps, so it usually sees
 * a normalised ApiError (`statusCode`) rather than an HttpErrorResponse
 * (`status`); `errorStatus` reads either.
 */
export const staffAuthInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(StaffAuthService);
  const token = auth.token();
  const authed = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  // Never intercept the auth endpoints themselves (prevents refresh loops).
  if (/\/auth\/(refresh|login|logout)/.test(req.url)) {
    return next(authed);
  }

  return next(authed).pipe(
    catchError((err: unknown) => {
      if (errorStatus(err) !== 401 || req.context.get(RETRIED) || token === null) {
        return throwError(() => err);
      }
      if (NOT_SESSION_BOUND.test(req.url)) return throwError(() => err);

      if (!auth.hasRefreshToken()) {
        auth.expire('expired', apiErrorMessage(err, SESSION_END_MESSAGES.expired));
        return throwError(() => err);
      }
      return from(auth.refresh()).pipe(
        switchMap((ok) => {
          if (!ok) return throwError(() => err);
          const fresh = auth.token();
          return next(
            req.clone({
              context: req.context.set(RETRIED, true),
              setHeaders: fresh ? { Authorization: `Bearer ${fresh}` } : {},
            }),
          );
        }),
      );
    }),
  );
};
