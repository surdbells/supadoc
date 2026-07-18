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
      // TODO login/phone (Figma 361:4760), login/google (365:5218)

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

      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },
];
