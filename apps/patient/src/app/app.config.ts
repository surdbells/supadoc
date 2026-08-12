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
  authInterceptor,
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
      // refreshInterceptor is last so it runs innermost and sees the raw 401
      // (before httpErrorInterceptor maps it) to refresh + retry.
      withInterceptors([
        authInterceptor,
        httpErrorInterceptor,
        refreshInterceptor,
      ]),
    ),
    provideSupadocDataAccess({
      baseUrl: environment.apiBaseUrl,
      loginPath: environment.loginPath,
    }),
    provideSupadocAuth(),
    provideSupadocIcons(),
  ],
};
