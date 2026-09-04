import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import type { ApiError } from '@supadoc/models';
import { apiErrorFields, apiErrorMessage } from './api-error.util';
import { LOGGER } from './logger';

/**
 * Normalises backend errors into the shared `ApiError` shape and logs them.
 * `message` is resolved to the most specific text available — a field-level
 * validation error wins over the generic top-level message ("Validation
 * failed") — so any screen that shows `apiError.message` gets the useful one.
 * The full field map stays on `errors` for inline, per-field display.
 */
export const httpErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const logger = inject(LOGGER);
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      const fields = apiErrorFields(error);
      const apiError: ApiError = {
        statusCode: error.status,
        message: apiErrorMessage(error, 'Unexpected server error'),
        errors: Object.keys(fields).length > 0 ? fields : undefined,
      };
      logger.error(
        `[API ${apiError.statusCode}] ${req.method} ${req.url}`,
        apiError,
      );
      return throwError(() => apiError);
    }),
  );
};
