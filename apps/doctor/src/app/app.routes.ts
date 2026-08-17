import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    loadComponent: () =>
      import('./doctor-portal').then((m) => m.DoctorPortal),
  },
  { path: '**', redirectTo: '' },
];
