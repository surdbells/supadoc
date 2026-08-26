import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    loadComponent: () =>
      import('./admin-specialists').then((m) => m.AdminSpecialists),
  },
  {
    path: 'monitoring',
    loadComponent: () =>
      import('./admin-monitoring').then((m) => m.AdminMonitoring),
  },
  { path: '**', redirectTo: '' },
];
