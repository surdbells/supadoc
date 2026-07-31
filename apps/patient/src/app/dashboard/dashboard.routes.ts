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
        loadComponent: placeholder,
        data: {
          title: 'Find a Specialist',
          icon: 'stethoscope',
          description:
            'Search and connect with trusted, board-certified specialists.',
        },
      },
      {
        path: 'appointments',
        loadComponent: placeholder,
        data: {
          title: 'Appointments',
          icon: 'calendar-days',
          description: 'View, book and manage your consultations.',
        },
      },
      {
        path: 'history',
        loadComponent: placeholder,
        data: {
          title: 'History',
          icon: 'history',
          description: 'Review your past consultations and treatment plans.',
        },
      },
      {
        path: 'notifications',
        loadComponent: placeholder,
        data: {
          title: 'Notification',
          icon: 'bell',
          description: 'Your appointment, prescription and payment updates.',
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
      {
        path: 'profile',
        loadComponent: placeholder,
        data: {
          title: 'My Profile',
          icon: 'user',
          description: 'Manage your personal and medical information.',
        },
      },
      {
        path: 'settings',
        loadComponent: placeholder,
        data: {
          title: 'Settings',
          icon: 'settings',
          description: 'Update your preferences and account settings.',
        },
      },
      { path: '**', redirectTo: '' },
    ],
  },
];
