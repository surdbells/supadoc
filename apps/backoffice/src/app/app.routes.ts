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
        path: 'analytics',
        canActivate: [permissionGuard('monitoring.view')],
        loadComponent: () =>
          import('./analytics/analytics').then((m) => m.AdminAnalytics),
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
        path: 'appointments/new',
        canActivate: [permissionGuard('appointments.create')],
        loadComponent: () =>
          import('./appointments/appointment-new').then((m) => m.AdminAppointmentNew),
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
        path: 'staff',
        canActivate: [permissionGuard('staff.manage')],
        loadComponent: () => import('./staff/staff').then((m) => m.AdminStaff),
      },
      {
        path: 'payouts',
        canActivate: [permissionGuard('payouts.manage')],
        loadComponent: () => import('./payouts/payouts').then((m) => m.AdminPayouts),
      },
      {
        path: 'support',
        canActivate: [permissionGuard('support.manage')],
        loadComponent: () => import('./support/support').then((m) => m.AdminSupport),
      },
      {
        path: 'pricing',
        canActivate: [permissionGuard('settings.manage')],
        loadComponent: () => import('./pricing/pricing').then((m) => m.AdminPricing),
      },
      {
        // Account settings — any signed-in staff user (no extra permission).
        path: 'settings',
        loadComponent: () => import('./settings/settings').then((m) => m.AdminSettings),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
