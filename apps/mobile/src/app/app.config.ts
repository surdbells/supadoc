import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  IonicRouteStrategy,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import {
  httpErrorInterceptor,
  provideSupadocDataAccess,
} from '@supadoc/data-access';
import { authInterceptor, provideSupadocAuth } from '@supadoc/auth';
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular(),
    provideRouter(appRoutes),
    provideHttpClient(
      withInterceptors([authInterceptor, httpErrorInterceptor]),
    ),
    provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl }),
    provideSupadocAuth(),
  ],
};
