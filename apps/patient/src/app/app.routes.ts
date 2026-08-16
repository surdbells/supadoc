import { Route } from '@angular/router';

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
    // Preauthenticated join link from the invite email — no auth: the signed
    // token in the URL is the credential.
    path: 'call/join/:token',
    loadComponent: () => import('./call/call-join').then((m) => m.CallJoin),
  },
  {
    // Minimal doctor portal — self-contained sign-in (one login per specialist).
    path: 'doctor',
    loadComponent: () =>
      import('./doctor/doctor-portal').then((m) => m.DoctorPortal),
  },
  {
    // Minimal back-office — self-contained staff sign-in to edit specialists.
    path: 'admin',
    loadComponent: () =>
      import('./admin/admin-specialists').then((m) => m.AdminSpecialists),
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
