import { Route } from '@angular/router';
import { unsavedChangesGuard } from '@supadoc/auth';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home').then((m) => m.Home),
  },
  {
    path: 'specialists',
    loadComponent: () =>
      import('./home/public-specialists').then((m) => m.PublicSpecialists),
  },
  {
    // Public pharmacist check — printed on every prescription PDF. No sign-in.
    path: 'check-prescription',
    loadComponent: () =>
      import('./home/check-prescription').then((m) => m.CheckPrescription),
  },
  {
    // Preauthenticated join link from the invite email — no auth: the signed
    // token in the URL is the credential. Leaving mid-call asks first.
    path: 'call/join/:token',
    loadComponent: () => import('./call/call-join').then((m) => m.CallJoin),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: 'auth',
    loadChildren: () => import('./auth/auth.routes').then((m) => m.authRoutes),
  },
  {
    path: 'dashboard',
    loadChildren: () =>
      import('./dashboard/dashboard.routes').then((m) => m.dashboardRoutes),
  },
];
