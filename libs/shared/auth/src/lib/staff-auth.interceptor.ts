import {
  HttpContextToken,
  HttpErrorResponse,
  HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { StaffAuthService } from './staff-auth.service';

/** Marks a request already retried after a refresh, so we never loop. */
const RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * Staff/doctor/admin request interceptor: attaches the staff bearer token, and
 * on a 401 transparently refreshes once and retries (keeping the session alive
 * across the short access-token TTL). If the refresh fails the 401 propagates
 * and the guard treats the user as signed out.
 */
export const staffAuthInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(StaffAuthService);
  const token = auth.token();
  const authed = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  // Never intercept the auth endpoints themselves (prevents refresh loops).
  if (/\/auth\/(refresh|login)/.test(req.url)) {
    return next(authed);
  }

  return next(authed).pipe(
    catchError((err: unknown) => {
      const unauthorized = err instanceof HttpErrorResponse && err.status === 401;
      if (!unauthorized || req.context.get(RETRIED) || !auth.hasRefreshToken()) {
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
