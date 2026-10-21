import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorStandingStore } from './doctor-standing.store';
import { pageAllowed, sectionOf } from './standing-rules';

/**
 * Keeps a suspended doctor, or one not approved yet, out of the clinical pages
 * (schedule, consultations, patients, prescriptions, reviews — and
 * availability once suspended): they land on `/account-status`, which says
 * why and what to do next, instead of a page whose every request is refused.
 * Fails open when the standing can't be read while still signed in — the API
 * enforces it anyway — but never into a page once the session has ended (the
 * read found it over): that goes to the sign-in page, remembering the page.
 *
 * Runs after `staffAuthGuard` (the shell's `canActivateChild`), which has
 * already made sure the token is fresh — so the onboarding read never leaves
 * with an expired one.
 */
export const doctorStandingGuard: CanActivateFn = async (_route, state) => {
  const store = inject(DoctorStandingStore);
  const auth = inject(StaffAuthService);
  const router = inject(Router);
  await store.load();
  if (!auth.isAuthenticated()) {
    auth.rememberRedirect(state.url);
    return router.parseUrl('/auth/login');
  }
  if (pageAllowed(store.code(), state.url)) return true;
  return router.createUrlTree(['/account-status'], { queryParams: { page: sectionOf(state.url) } });
};
