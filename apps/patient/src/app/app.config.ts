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
  AuthService,
  provideSessionTimeout,
  provideSupadocAuth,
  refreshInterceptor,
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
      // refreshInterceptor is innermost: it attaches the bearer, refreshes a
      // token about to expire before sending, and sees the raw 401 to refresh +
      // retry — so httpErrorInterceptor (outside) never logs a handled expiry.
      withInterceptors([httpErrorInterceptor, refreshInterceptor]),
    ),
    provideSupadocDataAccess({
      baseUrl: environment.apiBaseUrl,
      loginPath: environment.loginPath,
    }),
    provideSupadocAuth(),
    // Idle timeout + session-expiry sign-out (warning dialog: <sd-session-timeout />).
    provideSessionTimeout(AuthService, environment.session),
    provideSupadocIcons(),
  ],
};
