import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import type { ApiError } from '@supadoc/models';
import { apiErrorCode, apiErrorFields, apiErrorMessage } from './api-error.util';
import { LOGGER } from './logger';

/**
 * 401 codes that mean "this session is over (or never was)" — an expected
 * event the auth layer already handles (sign-in page with a notice), not a bug:
 * logged as a warning, never as an error.
 */
const SESSION_ENDED = /^(session_|account_)|^(refresh_invalid|token_missing|signed_out)$/;

/**
 * The client's own "sign-in could not be confirmed right now" (offline, 5xx,
 * 429 on the refresh): the user is still signed in — a warning, never logged
 * as a session that ended.
 */
const REFRESH_UNAVAILABLE = 'refresh_unavailable';

/** The session endpoints: a 401 there is the session ending, whatever the API version. */
const SESSION_ENDPOINT = /\/auth\/(refresh|logout)(\?|$)/;

/** `Retry-After` (seconds, or an HTTP date) as milliseconds from now, or undefined. */
function retryAfterMs(error: HttpErrorResponse): number | undefined {
  const raw = error.headers?.get?.('Retry-After')?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Normalises backend errors into the shared `ApiError` shape and logs them.
 * `message` is resolved to the most specific text available — a field-level
 * validation error wins over the generic top-level message ("Validation
 * failed") — so any screen that shows `apiError.message` gets the useful one.
 * The full field map stays on `errors` for inline, per-field display (and
 * `errors.code`, the machine-readable reason, for the auth layer).
 *
 * Register it OUTSIDE the auth interceptor (`[httpErrorInterceptor,
 * staffAuthInterceptor]`): the auth layer then refreshes an expired token and
 * retries before anything reaches this one, so a handled 401 is never logged.
 * A session that really ended is logged as a warning, and so — told apart from
 * it — is a sign-in that could not be confirmed for now (the user is still
 * signed in); anything else as an error. Request bodies are never logged (refresh / logout bodies carry the
 * refresh token), and call links are redacted.
 */
export const httpErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const logger = inject(LOGGER);
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      const fields = apiErrorFields(error);
      const apiError: ApiError = {
        statusCode: error.status,
        // apiErrorMessage already resolves offline / 5xx / transport-noise to a
        // clear human message, so no generic technical string ever reaches the UI.
        message: apiErrorMessage(error),
        errors: Object.keys(fields).length > 0 ? fields : undefined,
      };
      const wait = retryAfterMs(error);
      if (wait !== undefined) apiError.retryAfterMs = wait;
      // Call links carry a bearer token in the path — never put it in the console.
      const safeUrl = req.url.replace(/(\/public\/call\/)[^/?]+/, '$1[redacted]');
      const code = apiErrorCode(error);
      if (apiError.statusCode === 401 && code === REFRESH_UNAVAILABLE) {
        logger.warn(`[API 401] ${req.method} ${safeUrl} sign-in not confirmed (transient)`);
      } else if (apiError.statusCode === 401 && ((code !== null && SESSION_ENDED.test(code)) || SESSION_ENDPOINT.test(req.url))) {
        logger.warn(`[API 401] ${req.method} ${safeUrl} session ended (${code ?? 'refresh refused'})`);
      } else {
        logger.error(`[API ${apiError.statusCode}] ${req.method} ${safeUrl}`, apiError);
      }
      return throwError(() => apiError);
    }),
  );
};
