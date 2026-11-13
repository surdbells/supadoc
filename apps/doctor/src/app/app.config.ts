import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
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
import { DoctorRouteReuseStrategy } from './route-reuse';
import { doctorStandingInterceptor } from './standing/doctor-standing.interceptor';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes),
    // `/appointments/A` → `/appointments/B` re-creates the record page (see the route's data).
    { provide: RouteReuseStrategy, useClass: DoctorRouteReuseStrategy },
    provideHttpClient(
      // Outermost: sees a standing refusal (403) after any token refresh, already normalised.
      // staffAuthInterceptor is innermost: it sees the raw 401 to refresh + retry,
      // so httpErrorInterceptor never logs a handled token expiry.
      withInterceptors([doctorStandingInterceptor, httpErrorInterceptor, staffAuthInterceptor]),
      // XHR, not the default fetch backend: only XHR reports upload progress, so
      // any upload bar (the shared <sd-upload-progress>) fills as the file goes up
      // instead of sitting at 0%. Nothing here uploads with a bar yet; this keeps
      // every web app on the same transport.
      withXhr(),
    ),
    provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl }),
    // Doctor silo: its own token key, and only `doctor` accounts may sign in.
    provideStaffAuth({
      storageKey: 'videomed.doctor.token',
      requiredRole: 'doctor',
      // The public homepage may then offer "Go to Dashboard" (a non-secret hint cookie).
      portalHint: 'doctor',
    }),
    // Idle timeout + session-expiry sign-out (warning dialog: <sd-session-timeout />).
    provideSessionTimeout(StaffAuthService, environment.session),
    provideSupadocIcons(),
  ],
};
