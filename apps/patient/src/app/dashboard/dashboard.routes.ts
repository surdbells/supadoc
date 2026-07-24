import { Route } from '@angular/router';
import { DashboardShell } from './dashboard-shell';

/**
 * Signed-in patient area. The shell (side nav + header) wraps every section;
 * only the dashboard home is built so far — other nav destinations land back on
 * it until their screens are designed.
 */
export const dashboardRoutes: Route[] = [
  {
    path: '',
    component: DashboardShell,
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./dashboard-home').then((m) => m.DashboardHome),
      },
      { path: '**', redirectTo: '' },
    ],
  },
];
