import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
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
    provideHttpClient(
      // httpErrorInterceptor outermost (normalises errors); the token interceptor
      // innermost, so it sees the raw response to drop a dead token.
      withInterceptors([httpErrorInterceptor, applicantTokenInterceptor]),
      // XHR, not the default fetch backend: only XHR reports upload progress,
      // so upload bars fill as the file goes up instead of sitting at 0%.
      withXhr(),
    ),
    provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl }),
    provideSupadocIcons(),
  ],
};
