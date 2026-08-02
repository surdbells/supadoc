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
        path: 'appointments/:id',
        loadComponent: () =>
          import('./appointment-details').then((m) => m.AppointmentDetails),
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
        loadComponent: placeholder,
        data: {
          title: 'Change Password',
          icon: 'lock',
          description: 'Update your account password.',
        },
      },
      {
        path: 'settings/notifications',
        loadComponent: placeholder,
        data: {
          title: 'Notification Preferences',
          icon: 'bell',
          description: 'Manage reminders and alerts.',
        },
      },
      {
        path: 'settings/privacy',
        loadComponent: placeholder,
        data: {
          title: 'Privacy & Security',
          icon: 'shield-check',
          description: 'Control your privacy and security settings.',
        },
      },
      {
        path: 'settings/help',
        loadComponent: placeholder,
        data: {
          title: 'Help & Support',
          icon: 'circle-help',
          description: 'Contact support & browse FAQs.',
        },
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
