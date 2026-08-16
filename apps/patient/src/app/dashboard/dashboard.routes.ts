import { Route } from '@angular/router';
import { DashboardShell } from './dashboard-shell';

const placeholder = () =>
  import('./placeholder-page').then((m) => m.DashboardPlaceholder);

/**
 * Signed-in patient area. The shell (side nav + header) wraps every section.
 * Only the dashboard home is built out; the remaining nav destinations render a
 * shared "coming soon" placeholder driven by their route `data`.
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
        path: 'notifications',
        loadComponent: () =>
          import('./notification').then((m) => m.Notification),
      },
      {
        path: 'profile',
        loadComponent: () => import('./my-profile').then((m) => m.MyProfile),
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
        path: 'wallet',
        loadComponent: placeholder,
        data: {
          title: 'Wallet',
          icon: 'wallet',
          description: 'Manage your balance, funds and transactions.',
        },
      },
      { path: '**', redirectTo: '' },
    ],
  },
];
