import { Route } from '@angular/router';
import { staffAuthGuard } from '@supadoc/auth';

export const appRoutes: Route[] = [
  {
    path: 'auth/login',
    loadComponent: () => import('./auth/doctor-login').then((m) => m.DoctorLogin),
  },
  {
    // In-call cockpit — reached via a preauthenticated join token, outside the shell.
    path: 'call/:token',
    loadComponent: () => import('./doctor-call').then((m) => m.DoctorCall),
  },
  {
    path: '',
    canActivate: [staffAuthGuard],
    loadComponent: () => import('./doctor-shell').then((m) => m.DoctorShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'schedule' },
      {
        path: 'schedule',
        loadComponent: () =>
          import('./schedule/schedule').then((m) => m.DoctorSchedule),
      },
      {
        path: 'appointments/:id',
        loadComponent: () =>
          import('./appointment/appointment-detail').then(
            (m) => m.DoctorAppointmentDetail,
          ),
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./profile/doctor-profile').then((m) => m.DoctorProfile),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
