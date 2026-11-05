import type { Route } from '@angular/router';
import { unsavedChangesGuard } from '@supadoc/auth';
import { doctorStandingGuard } from '../standing/doctor-standing.guard';

/**
 * Laboratory & Diagnostics, under `/prescriptions/labs` (lazy: the app's route
 * table holds only the one `loadChildren` entry, keeping the initial bundle
 * as it was).
 */
export const LAB_ROUTES: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [doctorStandingGuard],
    loadComponent: () => import('./lab-requests-page').then((m) => m.LabRequestsPage),
  },
  {
    path: 'new',
    canActivate: [doctorStandingGuard],
    canDeactivate: [unsavedChangesGuard],
    // Picker ↔ composer is a query-param-only navigation (?patientId=): without this the
    // default ('paramsChange') skips canDeactivate and browser Back silently drops the form.
    runGuardsAndResolvers: 'paramsOrQueryParamsChange',
    loadComponent: () => import('./new-lab-request-page').then((m) => m.NewLabRequestPage),
  },
  {
    path: ':labId',
    canActivate: [doctorStandingGuard],
    loadComponent: () => import('./lab-request-page').then((m) => m.LabRequestPage),
  },
];
