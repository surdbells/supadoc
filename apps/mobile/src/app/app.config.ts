import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideIonicAngular } from '@ionic/angular/standalone';
import {
  httpErrorInterceptor,
  provideSupadocDataAccess,
} from '@supadoc/data-access';
import { authInterceptor, provideSupadocAuth } from '@supadoc/auth';
import { provideSupadocIcons } from '@supadoc/ui';
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIonicAngular(),
    provideRouter(appRoutes),
    provideHttpClient(
      withInterceptors([authInterceptor, httpErrorInterceptor]),
    ),
    provideSupadocDataAccess({
      baseUrl: environment.apiBaseUrl,
      appId: environment.appId,
    }),
    provideSupadocAuth(),
    provideSupadocIcons(),
  ],
};
