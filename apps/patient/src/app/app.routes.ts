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
    path: 'auth',
    loadChildren: () => import('./auth/auth.routes').then((m) => m.authRoutes),
  },
  {
    path: 'dashboard',
    loadChildren: () =>
      import('./dashboard/dashboard.routes').then((m) => m.dashboardRoutes),
  },
];
