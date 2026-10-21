import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';
import { handleSessionRequest } from './session/session-http';

/**
 * Patient request interceptor: attaches the bearer token, makes sure it is
 * fresh before a request leaves (refreshing first when it is about to expire),
 * and on a 401 refreshes once and retries — keeping a signed-in session alive
 * across the short access-token TTL. When the session is really over (the
 * server says so, or the refresh is refused) it is ended (AuthService.expire):
 * signed out everywhere and sent to sign in with an explanation. See
 * {@link handleSessionRequest}.
 *
 * Register it INNERMOST — `[httpErrorInterceptor, refreshInterceptor]` — so it
 * sees the raw 401 and a handled expiry is never logged as an error. It
 * attaches the bearer itself (no `authInterceptor` needed beside it).
 */
export const refreshInterceptor: HttpInterceptorFn = (req, next) =>
  handleSessionRequest(inject(AuthService), req, next);
