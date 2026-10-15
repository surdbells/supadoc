import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { DoctorStandingStore } from './doctor-standing.store';
import { pageAllowed, sectionOf } from './standing-rules';

/**
 * Keeps a suspended doctor, or one not approved yet, out of the clinical pages
 * (schedule, consultations, patients, prescriptions, reviews — and
 * availability once suspended): they land on `/account-status`, which says
 * why and what to do next, instead of a page whose every request is refused.
 * Fails open when the standing can't be read — the API enforces it anyway.
 */
export const doctorStandingGuard: CanActivateFn = async (_route, state) => {
  const store = inject(DoctorStandingStore);
  const router = inject(Router);
  await store.load();
  if (pageAllowed(store.code(), state.url)) return true;
  return router.createUrlTree(['/account-status'], { queryParams: { page: sectionOf(state.url) } });
};
