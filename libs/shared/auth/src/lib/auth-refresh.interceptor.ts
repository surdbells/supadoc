import { HttpContextToken, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { apiErrorMessage } from '@supadoc/data-access';
import { AuthService } from './auth.service';
import { SESSION_END_MESSAGES } from './session/session-notice';
import { errorStatus } from './session/session-utils';

/** Marks a request already retried after a refresh, so we never loop. */
const RETRIED = new HttpContextToken<boolean>(() => false);

/** Auth + public endpoints answer 401 for reasons that aren't "your session ended". */
const NOT_SESSION_BOUND = /\/(auth|public)\//;

/**
 * On a 401 from an authed API call, transparently refresh the access token
 * (using the stored refresh token) once and retry the original request. This is
 * what keeps a signed-in session alive across the short access-token TTL. When
 * the session is really over — the refresh is rejected, or there is nothing to
 * refresh with — the session is ended (AuthService.expire), which signs the
 * user out everywhere and sends them to sign in with an explanation.
 *
 * Handles both a raw HttpErrorResponse and an already-normalised ApiError, so
 * it works whichever side of `httpErrorInterceptor` it is registered on.
 */
export const refreshInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  // Never intercept the auth endpoints themselves (prevents refresh loops).
  if (/\/auth\/(refresh|login|logout)/.test(req.url)) {
    return next(req);
  }

  const hadToken = auth.token() !== null;

  return next(req).pipe(
    catchError((err: unknown) => {
      if (errorStatus(err) !== 401 || req.context.get(RETRIED) || !hadToken) {
        return throwError(() => err);
      }
      if (NOT_SESSION_BOUND.test(req.url)) return throwError(() => err);

      if (!auth.hasRefreshToken()) {
        auth.expire('expired', apiErrorMessage(err, SESSION_END_MESSAGES.expired));
        return throwError(() => err);
      }

      return from(auth.refresh()).pipe(
        switchMap((ok) => {
          // A failed refresh already ended the session (if it was definitive).
          if (!ok) return throwError(() => err);
          const token = auth.token();
          return next(
            req.clone({
              context: req.context.set(RETRIED, true),
              setHeaders: token ? { Authorization: `Bearer ${token}` } : {},
            }),
          );
        }),
      );
    }),
  );
};
