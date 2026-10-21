import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { StaffAuthService } from './staff-auth.service';
import { handleSessionRequest } from './session/session-http';

/**
 * Staff/doctor/admin request interceptor: attaches the staff bearer token,
 * makes sure it is fresh before a request leaves (refreshing first when it is
 * about to expire), and on a 401 refreshes once and retries — or, when the
 * server says the session is over, ends it (StaffAuthService.expire): signed
 * out everywhere and sent to sign in with the server's explanation. See
 * {@link handleSessionRequest}.
 *
 * Register it INNERMOST — `[httpErrorInterceptor, staffAuthInterceptor]` — so
 * it sees the raw 401 and a handled expiry is never logged as an error.
 */
export const staffAuthInterceptor: HttpInterceptorFn = (req, next) =>
  handleSessionRequest(inject(StaffAuthService), req, next);
