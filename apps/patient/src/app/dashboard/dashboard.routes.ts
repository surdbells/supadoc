import { Route } from '@angular/router';
import { authGuard, unsavedChangesGuard } from '@supadoc/auth';
import { DashboardShell } from './dashboard-shell';

/**
 * Signed-in patient area. The shell (side nav + header) wraps every section;
 * every destination below is a real, fully-wired page.
 *
 * `unsavedChangesGuard` asks "Leave …?" (the in-app dialog) before leaving a
 * page that would lose something — a live call, unsaved medical edits, queued
 * uploads, a booking with attachments or a payment not used yet. Each of those
 * pages says when (`canLeave()` / `hasUnsavedChanges()`); signing out always wins.
 */
export const dashboardRoutes: Route[] = [
  {
    path: '',
    component: DashboardShell,
    // Every page, not just the shell: a token about to expire is refreshed
    // before the page's first requests, and a signed-out visitor never sees one.
    canActivate: [authGuard],
    canActivateChild: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./dashboard-home').then((m) => m.DashboardHome),
      },
      {
        path: 'specialists',
        loadComponent: () =>
          import('./find-specialist').then((m) => m.FindSpecialist),
      },
      {
        path: 'appointments',
        loadComponent: () =>
          import('./appointments').then((m) => m.Appointments),
      },
      {
        path: 'appointments/book/:id',
        loadComponent: () =>
          import('./book-consultation').then((m) => m.BookConsultation),
        canDeactivate: [unsavedChangesGuard],
      },
      {
        path: 'appointments/:id',
        loadComponent: () =>
          import('./appointment-details').then((m) => m.AppointmentDetails),
      },
      {
        path: 'call/:id',
        loadComponent: () =>
          import('./consultation-call').then((m) => m.ConsultationCall),
        canDeactivate: [unsavedChangesGuard],
      },
      {
        // Static before any `documents/:x` route.
        path: 'documents/sharing',
        loadComponent: () =>
          import('./manage-sharing').then((m) => m.ManageSharing),
      },
      {
        path: 'documents',
        loadComponent: () =>
          import('./documents').then((m) => m.PatientDocuments),
        canDeactivate: [unsavedChangesGuard],
      },
      {
        path: 'history',
        loadComponent: () => import('./history').then((m) => m.History),
      },
      {
        path: 'history/:id',
        loadComponent: () =>
          import('./history-details').then((m) => m.HistoryDetails),
      },
      {
        path: 'prescriptions',
        loadComponent: () =>
          import('./prescriptions').then((m) => m.Prescriptions),
      },
      {
        path: 'prescriptions/:id',
        loadComponent: () =>
          import('./prescription-details').then((m) => m.PrescriptionDetails),
      },
      {
        path: 'notifications',
        loadComponent: () =>
          import('./notification').then((m) => m.Notification),
      },
      {
        path: 'profile',
        loadComponent: () => import('./my-profile').then((m) => m.MyProfile),
        canDeactivate: [unsavedChangesGuard],
      },
      {
        path: 'settings',
        loadComponent: () => import('./settings').then((m) => m.Settings),
      },
      {
        path: 'settings/password',
        loadComponent: () =>
          import('./settings-password').then((m) => m.SettingsPassword),
      },
      {
        path: 'settings/notifications',
        loadComponent: () =>
          import('./settings-notifications').then(
            (m) => m.SettingsNotifications,
          ),
      },
      {
        path: 'settings/privacy',
        loadComponent: () =>
          import('./settings-privacy').then((m) => m.SettingsPrivacy),
      },
      {
        path: 'settings/privacy/login-activity',
        loadComponent: () =>
          import('./settings-login-activity').then(
            (m) => m.SettingsLoginActivity,
          ),
      },
      {
        path: 'settings/privacy/devices',
        loadComponent: () =>
          import('./settings-devices').then((m) => m.SettingsDevices),
      },
      {
        path: 'settings/help',
        loadComponent: () =>
          import('./settings-help').then((m) => m.SettingsHelp),
      },
      {
        path: 'settings/help/faqs',
        loadComponent: () =>
          import('./settings-faqs').then((m) => m.SettingsFaqs),
      },
      {
        path: 'settings/help/support',
        loadComponent: () =>
          import('./settings-support').then((m) => m.SettingsSupport),
      },
      {
        path: 'wallet',
        loadComponent: () => import('./wallet').then((m) => m.Wallet),
      },
      {
        path: 'wallet/transactions',
        loadComponent: () =>
          import('./wallet-transactions').then((m) => m.WalletTransactions),
      },
      { path: '**', redirectTo: '' },
    ],
  },
];
