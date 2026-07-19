import { Route } from '@angular/router';

export const authRoutes: Route[] = [
  {
    path: 'login',
    loadComponent: () => import('./login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'login/email',
    loadComponent: () =>
      import('./login/sign-in-email.page').then((m) => m.SignInEmailPage),
  },
  {
    path: 'login/phone',
    loadComponent: () =>
      import('./login/sign-in-phone.page').then((m) => m.SignInPhonePage),
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./signup/signup.page').then((m) => m.SignupPage),
  },
  {
    path: 'recover/email',
    loadComponent: () =>
      import('./forgot-password/forgot-password.page').then(
        (m) => m.ForgotPasswordPage,
      ),
  },
  {
    path: 'recover/phone',
    loadComponent: () =>
      import('./forgot-password/forgot-password.page').then(
        (m) => m.ForgotPasswordPage,
      ),
  },
  { path: '', redirectTo: 'login', pathMatch: 'full' },
];
