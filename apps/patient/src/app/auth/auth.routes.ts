import { Route } from '@angular/router';
import { AuthLayout } from './auth-layout';

export const authRoutes: Route[] = [
  {
    path: '',
    component: AuthLayout,
    children: [
      // ----- Login -----
      {
        path: 'login',
        loadComponent: () =>
          import('./login/login-method').then((m) => m.LoginMethod),
      },
      {
        path: 'login/email',
        loadComponent: () =>
          import('./login/sign-in-email').then((m) => m.SignInEmail),
      },
      {
        path: 'login/phone',
        loadComponent: () =>
          import('./login/sign-in-phone').then((m) => m.SignInPhone),
      },
      {
        path: 'login/google',
        loadComponent: () =>
          import('./login/sign-in-google').then((m) => m.SignInGoogle),
      },

      // ----- Register (TODO: real multi-step flow 254:3640 …) -----
      {
        path: 'register',
        loadComponent: () => import('./signup/signup').then((m) => m.Signup),
      },

      // ----- Password recovery (TODO: full flow 376:5405 …) -----
      {
        path: 'recover/email',
        loadComponent: () =>
          import('./forgot-password/forgot-password').then(
            (m) => m.ForgotPassword,
          ),
      },
      {
        path: 'recover/phone',
        loadComponent: () =>
          import('./forgot-password/forgot-password').then(
            (m) => m.ForgotPassword,
          ),
      },

      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },
];
