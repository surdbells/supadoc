import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { apiErrorMessage, doctorStandingCode } from '@supadoc/data-access';
import { DoctorStandingStore } from './doctor-standing.store';
import { pageAllowed, sectionOf } from './standing-rules';

/** The HTTP status off either error shape (normalised ApiError or HttpErrorResponse). */
function statusOf(err: unknown): number | undefined {
  const e = (err ?? {}) as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : undefined;
}

/**
 * The doctor-standing refusals, app-wide. Any request the API refuses with a
 * 403 `doctor_suspended` / `doctor_not_approved` / `terms_required` updates
 * the standing (so the banners and the guard catch up at once). A suspended or
 * unapproved doctor on a page that is closed to them — e.g. suspended while
 * the schedule was open — is taken to the friendly `/account-status` screen
 * instead of a page of errors. The error still reaches the caller, and the call
 * cockpit is never navigated away from (it explains a refusal itself).
 */
export const doctorStandingInterceptor: HttpInterceptorFn = (req, next) => {
  const store = inject(DoctorStandingStore);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: unknown) => {
      const code = statusOf(err) === 403 ? doctorStandingCode(err) : null;
      if (code) {
        store.noteRefusal(code, apiErrorMessage(err, ''));
        const url = router.url;
        if (!url.startsWith('/call/') && !pageAllowed(code, url)) {
          void router.navigate(['/account-status'], { queryParams: { page: sectionOf(url) } });
        }
      }
      return throwError(() => err);
    }),
  );
};
