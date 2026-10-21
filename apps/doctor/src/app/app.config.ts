import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
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
    ),
    provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl }),
    // Doctor silo: its own token key, and only `doctor` accounts may sign in.
    provideStaffAuth({
      storageKey: 'videomed.doctor.token',
      requiredRole: 'doctor',
    }),
    // Idle timeout + session-expiry sign-out (warning dialog: <sd-session-timeout />).
    provideSessionTimeout(StaffAuthService, environment.session),
    provideSupadocIcons(),
  ],
};
