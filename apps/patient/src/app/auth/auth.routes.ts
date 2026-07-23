import { Route } from '@angular/router';
import { AuthLayout } from './auth-layout';

export const authRoutes: Route[] = [
  // ----- Full-screen result pages (no split layout) -----
  {
    path: 'register/success',
    loadComponent: () =>
      import('./status/auth-status').then((m) => m.AuthStatus),
    data: {
      variant: 'success',
      title: 'Account created successfully',
      subtitle: 'Welcome to VideoMed',
      actionLabel: 'Go to dashboard',
      actionLink: '/',
    },
  },
  {
    path: 'register/failure',
    loadComponent: () =>
      import('./status/auth-status').then((m) => m.AuthStatus),
    data: {
      variant: 'error',
      title: 'Something went wrong',
      subtitle: "We couldn't create your account. Please try again.",
      actionLabel: 'Try again',
      actionLink: '/auth/register',
    },
  },
  {
    path: 'recover/success',
    loadComponent: () =>
      import('./status/auth-status').then((m) => m.AuthStatus),
    data: {
      variant: 'success',
      title: 'Password changed successfully',
      subtitle: 'You can now log in with your new password.',
      actionLabel: 'Back to log in',
      actionLink: '/auth/login',
    },
  },

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

      // ----- Register -----
      {
        path: 'register',
        loadComponent: () =>
          import('./register/register-method').then((m) => m.RegisterMethod),
      },
      {
        path: 'register/email',
        loadComponent: () =>
          import('./register/register-email').then((m) => m.RegisterEmail),
      },
      {
        path: 'register/phone',
        loadComponent: () =>
          import('./register/register-phone').then((m) => m.RegisterPhone),
      },
      {
        path: 'register/google',
        loadComponent: () =>
          import('./login/sign-in-google').then((m) => m.SignInGoogle),
      },
      {
        path: 'register/verify-email',
        loadComponent: () =>
          import('./register/verify-otp').then((m) => m.VerifyOtp),
        data: { channel: 'email', mode: 'register' },
      },
      {
        path: 'register/verify-phone',
        loadComponent: () =>
          import('./register/verify-otp').then((m) => m.VerifyOtp),
        data: { channel: 'phone', mode: 'register' },
      },
      {
        path: 'register/setup',
        loadComponent: () =>
          import('./register/setup').then((m) => m.RegisterSetup),
      },

      // ----- Password recovery -----
      {
        path: 'recover/email',
        loadComponent: () =>
          import('./recover/recover-email').then((m) => m.RecoverEmail),
      },
      {
        path: 'recover/phone',
        loadComponent: () =>
          import('./recover/recover-phone').then((m) => m.RecoverPhone),
      },
      {
        path: 'recover/verify-email',
        loadComponent: () =>
          import('./register/verify-otp').then((m) => m.VerifyOtp),
        data: {
          channel: 'email',
          mode: 'recover',
          next: '/auth/recover/new-password',
        },
      },
      {
        path: 'recover/verify-phone',
        loadComponent: () =>
          import('./register/verify-otp').then((m) => m.VerifyOtp),
        data: {
          channel: 'phone',
          mode: 'recover',
          next: '/auth/recover/new-password',
        },
      },
      {
        path: 'recover/new-password',
        loadComponent: () =>
          import('./recover/new-password').then((m) => m.NewPassword),
      },

      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },
];
