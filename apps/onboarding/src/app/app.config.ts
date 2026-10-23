import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { httpErrorInterceptor, provideSupadocDataAccess } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { appRoutes } from './app.routes';
import { applicantTokenInterceptor } from './core/applicant-token.interceptor';
import { environment } from '../environments/environment';

/** No sign-in or session providers: applicants use short-lived draft / track tokens. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes, withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    // httpErrorInterceptor outermost (normalises errors); the token interceptor
    // innermost, so it sees the raw response to drop a dead token.
    provideHttpClient(withInterceptors([httpErrorInterceptor, applicantTokenInterceptor])),
    provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl }),
    provideSupadocIcons(),
  ],
};
