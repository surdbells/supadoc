import { Route } from '@angular/router';
import { staffAuthGuard } from '@supadoc/auth';
import { unsavedChangesGuard } from './prescriptions/unsaved-changes.guard';
import { doctorStandingGuard } from './standing/doctor-standing.guard';

export const appRoutes: Route[] = [
  {
    path: 'auth/login',
    loadComponent: () => import('./auth/doctor-login').then((m) => m.DoctorLogin),
  },
  // Public one-time-link pages: the invite's first password, and forgot / reset.
  {
    path: 'auth/set-password',
    data: { mode: 'invite' },
    loadComponent: () => import('./auth/choose-password').then((m) => m.DoctorChoosePassword),
  },
  {
    path: 'auth/forgot-password',
    loadComponent: () => import('./auth/forgot-password').then((m) => m.DoctorForgotPassword),
  },
  {
    path: 'auth/reset-password',
    data: { mode: 'reset' },
    loadComponent: () => import('./auth/choose-password').then((m) => m.DoctorChoosePassword),
  },
  {
    // In-call cockpit — reached via a preauthenticated join token, outside the shell.
    // (No standing guard: the link works without a portal session, and the API's
    // refusal of a suspended / unapproved doctor is explained on the page.)
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
        // First-login checklist + "Submit for review"; after approval, the account's status.
        path: 'onboarding',
        loadComponent: () =>
          import('./onboarding/onboarding').then((m) => m.DoctorOnboarding),
      },
      {
        // Licensing documents (MDCN certificate, practising licence) — open whatever the standing.
        path: 'onboarding/credentials',
        loadComponent: () =>
          import('./onboarding/credentials').then((m) => m.DoctorCredentials),
      },
      {
        // The practitioner terms in force: read + accept (again, when a new version comes in).
        path: 'onboarding/terms',
        loadComponent: () =>
          import('./onboarding/terms').then((m) => m.DoctorPractitionerTerms),
      },
      {
        // Where the standing guard sends a suspended / unapproved doctor: why, and what next.
        path: 'account-status',
        loadComponent: () =>
          import('./standing/account-status').then((m) => m.DoctorAccountStatus),
      },
      {
        path: 'schedule',
        canActivate: [doctorStandingGuard],
        loadComponent: () =>
          import('./schedule/schedule').then((m) => m.DoctorSchedule),
      },
      {
        path: 'appointments/history',
        canActivate: [doctorStandingGuard],
        loadComponent: () =>
          import('./appointment/history').then((m) => m.DoctorAppointmentHistory),
      },
      {
        path: 'appointments/:id',
        canActivate: [doctorStandingGuard],
        // Hosts <doc-rx-panel>: a no-op until the page implements canLeave().
        canDeactivate: [unsavedChangesGuard],
        // Follow-ups link record to record; the page loads its id once.
        data: { remountOnParamChange: true },
        loadComponent: () =>
          import('./appointment/appointment-detail').then(
            (m) => m.DoctorAppointmentDetail,
          ),
      },
      {
        path: 'patients',
        canActivate: [doctorStandingGuard],
        loadComponent: () =>
          import('./patients/patients').then((m) => m.DoctorPatients),
      },
      {
        path: 'patients/:id',
        canActivate: [doctorStandingGuard],
        // Hosts <doc-rx-panel>: a no-op until the page implements canLeave().
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./patients/patient-detail').then((m) => m.DoctorPatientDetail),
      },
      {
        path: 'prescriptions',
        canActivate: [doctorStandingGuard],
        loadComponent: () =>
          import('./prescriptions/prescriptions-page').then((m) => m.PrescriptionsPage),
      },
      {
        // Must stay before 'prescriptions/:id'.
        path: 'prescriptions/new',
        canActivate: [doctorStandingGuard],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./prescriptions/new-prescription-page').then((m) => m.NewPrescriptionPage),
      },
      {
        path: 'prescriptions/:id',
        canActivate: [doctorStandingGuard],
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./prescriptions/prescription-page').then((m) => m.PrescriptionPage),
      },
      {
        // Open while onboarding (a checklist step); closed while suspended.
        path: 'availability',
        canActivate: [doctorStandingGuard],
        loadComponent: () =>
          import('./availability/availability').then((m) => m.DoctorAvailability),
      },
      {
        path: 'reviews',
        canActivate: [doctorStandingGuard],
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
