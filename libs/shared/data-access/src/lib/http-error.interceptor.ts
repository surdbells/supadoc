import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import type { ApiError } from '@supadoc/models';
import { LOGGER } from './logger';

/**
 * Normalises backend errors into the shared `ApiError` shape and logs them.
 * Hook real error reporting / toasts in here as the app grows.
 */
export const httpErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const logger = inject(LOGGER);
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      const apiError: ApiError = {
        statusCode: error.status,
        message:
          error.error?.message ?? error.message ?? 'Unexpected server error',
        errors: error.error?.errors,
      };
      logger.error(
        `[API ${apiError.statusCode}] ${req.method} ${req.url}`,
        apiError,
      );
      return throwError(() => apiError);
    }),
  );
};
