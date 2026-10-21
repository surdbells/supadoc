import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  httpErrorInterceptor,
  provideSupadocDataAccess,
} from '@supadoc/data-access';
import {
  provideSessionTimeout,
  provideStaffAuth,
  StaffAuthService,
  staffAuthInterceptor,
} from '@supadoc/auth';
import { provideSupadocIcons } from '@supadoc/ui';
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes),
    provideHttpClient(
      // staffAuthInterceptor is innermost: it sees the raw 401 to refresh + retry,
      // so httpErrorInterceptor never logs a handled token expiry.
      withInterceptors([httpErrorInterceptor, staffAuthInterceptor]),
    ),
    provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl }),
    // Back-office silo: its own token key; nav/routes gate on RBAC permissions.
    provideStaffAuth({ storageKey: 'videomed.admin.token' }),
    // Idle timeout + session-expiry sign-out (warning dialog: <sd-session-timeout />).
    provideSessionTimeout(StaffAuthService, environment.session),
    provideSupadocIcons(),
  ],
};
