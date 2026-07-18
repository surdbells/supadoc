import { Route } from '@angular/router';
import { AuthLayout } from './auth-layout';

export const authRoutes: Route[] = [
  {
    path: '',
    component: AuthLayout,
    children: [
      {
        path: 'login',
        loadComponent: () => import('./login/login').then((m) => m.Login),
      },
      {
        path: 'signup',
        loadComponent: () => import('./signup/signup').then((m) => m.Signup),
      },
      {
        path: 'forgot-password',
        loadComponent: () =>
          import('./forgot-password/forgot-password').then(
            (m) => m.ForgotPassword,
          ),
      },
      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },
];
