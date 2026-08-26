import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    loadComponent: () =>
      import('./doctor-portal').then((m) => m.DoctorPortal),
  },
  {
    path: 'call/:token',
    loadComponent: () => import('./doctor-call').then((m) => m.DoctorCall),
  },
  { path: '**', redirectTo: '' },
];
