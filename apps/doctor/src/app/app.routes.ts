import { Route } from '@angular/router';
import { staffAuthGuard } from '@supadoc/auth';
import { unsavedChangesGuard } from './prescriptions/unsaved-changes.guard';

export const appRoutes: Route[] = [
  {
    path: 'auth/login',
    loadComponent: () => import('./auth/doctor-login').then((m) => m.DoctorLogin),
  },
  {
    // In-call cockpit — reached via a preauthenticated join token, outside the shell.
    path: 'call/:token',
    // Asks before leaving with a half-written prescription (e.g. browser Back).
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./doctor-call').then((m) => m.DoctorCall),
  },
  {
    path: '',
    canActivate: [staffAuthGuard],
    loadComponent: () => import('./doctor-shell').then((m) => m.DoctorShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./dashboard/dashboard').then((m) => m.DoctorDashboard),
      },
      {
        path: 'schedule',
        loadComponent: () =>
          import('./schedule/schedule').then((m) => m.DoctorSchedule),
      },
      {
        path: 'appointments/history',
        loadComponent: () =>
          import('./appointment/history').then((m) => m.DoctorAppointmentHistory),
      },
      {
        path: 'appointments/:id',
        // Hosts <doc-rx-panel>: a no-op until the page implements canLeave().
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./appointment/appointment-detail').then(
            (m) => m.DoctorAppointmentDetail,
          ),
      },
      {
        path: 'patients',
        loadComponent: () =>
          import('./patients/patients').then((m) => m.DoctorPatients),
      },
      {
        path: 'patients/:id',
        // Hosts <doc-rx-panel>: a no-op until the page implements canLeave().
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./patients/patient-detail').then((m) => m.DoctorPatientDetail),
      },
      {
        path: 'prescriptions',
        loadComponent: () =>
          import('./prescriptions/prescriptions-page').then((m) => m.PrescriptionsPage),
      },
      {
        // Must stay before 'prescriptions/:id'.
        path: 'prescriptions/new',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./prescriptions/new-prescription-page').then((m) => m.NewPrescriptionPage),
      },
      {
        path: 'prescriptions/:id',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./prescriptions/prescription-page').then((m) => m.PrescriptionPage),
      },
      {
        path: 'availability',
        loadComponent: () =>
          import('./availability/availability').then((m) => m.DoctorAvailability),
      },
      {
        path: 'reviews',
        loadComponent: () =>
          import('./reviews/reviews').then((m) => m.DoctorReviews),
      },
      {
        path: 'earnings',
        loadComponent: () =>
          import('./earnings/earnings').then((m) => m.DoctorEarnings),
      },
      {
        path: 'payouts',
        loadComponent: () =>
          import('./payouts/payouts').then((m) => m.DoctorPayouts),
      },
      {
        path: 'notifications',
        loadComponent: () =>
          import('./notifications/notifications').then((m) => m.DoctorNotifications),
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./profile/doctor-profile').then((m) => m.DoctorProfile),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./settings/settings').then((m) => m.DoctorSettings),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
