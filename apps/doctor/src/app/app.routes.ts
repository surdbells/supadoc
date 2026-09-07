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
        loadComponent: () =>
          import('./patients/patient-detail').then((m) => m.DoctorPatientDetail),
      },
      {
        path: 'availability',
        loadComponent: () =>
          import('./availability/availability').then((m) => m.DoctorAvailability),
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
        path: 'profile',
        loadComponent: () =>
          import('./profile/doctor-profile').then((m) => m.DoctorProfile),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
