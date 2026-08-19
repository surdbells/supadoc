import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Route guard that allows navigation only when the user is authenticated.
 * Otherwise it remembers the attempted URL (so the auth flow can return there,
 * keeping the user's selection) and redirects to the sign-in screen.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  auth.rememberRedirect(state.url);
  return router.parseUrl('/auth/login');
};
