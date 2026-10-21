import { Route } from '@angular/router';
import { permissionGuard, staffAuthGuard, unsavedChangesGuard } from '@supadoc/auth';
import { dashboardGuard, landingGuard } from './nav';

export const appRoutes: Route[] = [
  {
    path: 'auth/login',
    loadComponent: () => import('./auth/admin-login').then((m) => m.AdminLogin),
  },
  {
    path: '',
    // Every page, not just the shell: a token about to expire is refreshed
    // first, and a signed-out user never sees one.
    canActivate: [staffAuthGuard],
    canActivateChild: [staffAuthGuard],
    loadComponent: () => import('./admin-shell').then((m) => m.AdminShell),
    children: [
      // Each user lands on the first page their role may open.
      { path: '', pathMatch: 'full', canActivate: [landingGuard], children: [] },
      {
        path: 'dashboard',
        canActivate: [dashboardGuard],
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
        path: 'patients',
        canActivate: [permissionGuard('monitoring.view')],
        loadComponent: () =>
          import('./patients/patients').then((m) => m.AdminPatients),
      },
      {
        path: 'patients/:id',
        canActivate: [permissionGuard('monitoring.view')],
        loadComponent: () =>
          import('./patients/patient-detail').then((m) => m.AdminPatientDetail),
      },
      {
        path: 'specialists',
        canActivate: [permissionGuard('specialists.manage')],
        loadComponent: () =>
          import('./specialists/specialists').then((m) => m.AdminSpecialists),
      },
      {
        // The doctor page: overview, documents, review, appointments, earnings, reviews, history.
        path: 'specialists/:id',
        canActivate: [permissionGuard('specialists.manage')],
        // Unsaved Overview (profile) edits ask before leaving.
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./specialists/specialist-detail').then((m) => m.AdminSpecialistDetail),
      },
      {
        path: 'staff',
        canActivate: [permissionGuard('staff.manage')],
        // Asks before leaving with the account editor open and edited.
        canDeactivate: [unsavedChangesGuard],
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
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./pricing/pricing').then((m) => m.AdminPricing),
      },
      {
        // GVM-RX-02 ground rules the Platform Admin can change without a release.
        path: 'prescription-rules',
        canActivate: [permissionGuard('settings.manage')],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./prescription-rules/prescription-rules').then(
            (m) => m.AdminPrescriptionRules,
          ),
      },
      {
        // Back-office-managed pick lists (specialties first). Asks before
        // leaving with a name typed but not saved.
        path: 'reference-data',
        canActivate: [permissionGuard('settings.manage')],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./reference-data/reference-data').then((m) => m.AdminReferenceData),
      },
      {
        // Account settings — any signed-in staff user (no extra permission).
        path: 'settings',
        // Unsaved booking-rule edits ask before leaving.
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./settings/settings').then((m) => m.AdminSettings),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
