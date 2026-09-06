import { Route } from '@angular/router';
import { permissionGuard, staffAuthGuard } from '@supadoc/auth';

export const appRoutes: Route[] = [
  {
    path: 'auth/login',
    loadComponent: () => import('./auth/admin-login').then((m) => m.AdminLogin),
  },
  {
    path: '',
    canActivate: [staffAuthGuard],
    loadComponent: () => import('./admin-shell').then((m) => m.AdminShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        canActivate: [permissionGuard('monitoring.view')],
        loadComponent: () =>
          import('./dashboard/dashboard').then((m) => m.AdminDashboard),
      },
      {
        path: 'monitoring',
        canActivate: [permissionGuard('monitoring.view')],
        loadComponent: () =>
          import('./monitoring/monitoring').then((m) => m.AdminMonitoring),
      },
      {
        path: 'audit',
        canActivate: [permissionGuard('monitoring.view')],
        loadComponent: () => import('./audit/audit').then((m) => m.AdminAudit),
      },
      {
        path: 'appointments',
        canActivate: [permissionGuard('appointments.view')],
        loadComponent: () =>
          import('./appointments/appointments').then((m) => m.AdminAppointments),
      },
      {
        path: 'appointments/:id',
        canActivate: [permissionGuard('appointments.view')],
        loadComponent: () =>
          import('./appointments/appointment-detail').then(
            (m) => m.AdminAppointmentDetail,
          ),
      },
      {
        path: 'specialists',
        canActivate: [permissionGuard('specialists.manage')],
        loadComponent: () =>
          import('./specialists/specialists').then((m) => m.AdminSpecialists),
      },
      {
        path: 'pricing',
        canActivate: [permissionGuard('settings.manage')],
        loadComponent: () => import('./pricing/pricing').then((m) => m.AdminPricing),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
