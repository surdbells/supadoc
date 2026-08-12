import {
  HttpContextToken,
  HttpErrorResponse,
  HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** Marks a request already retried after a refresh, so we never loop. */
const RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * On a 401 from an authed API call, transparently refresh the access token
 * (using the stored refresh token) once and retry the original request. This is
 * what keeps a signed-in session alive across the short access-token TTL — and,
 * for a "remembered" session, across browser restarts. If the refresh fails the
 * original 401 propagates and the user is treated as signed out.
 *
 * Must run inner of `httpErrorInterceptor` so it sees the raw HttpErrorResponse.
 */
export const refreshInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  // Never intercept the auth endpoints themselves (prevents refresh loops).
  if (/\/auth\/(refresh|login)/.test(req.url)) {
    return next(req);
  }

  return next(req).pipe(
    catchError((err: unknown) => {
      const unauthorized = err instanceof HttpErrorResponse && err.status === 401;
      if (!unauthorized || req.context.get(RETRIED) || !auth.hasRefreshToken()) {
        return throwError(() => err);
      }

      return from(auth.refresh()).pipe(
        switchMap((ok) => {
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
