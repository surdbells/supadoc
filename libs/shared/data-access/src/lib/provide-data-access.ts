import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { API_CONFIG, ApiConfig } from './api-config';

/**
 * Registers the shared data-access layer for an app.
 *
 * Usage in an app's `app.config.ts`:
 * ```ts
 * provideSupadocDataAccess({ baseUrl: environment.apiBaseUrl })
 * ```
 * Requires `provideHttpClient()` to also be present in the app config.
 */
export function provideSupadocDataAccess(
  config: ApiConfig,
): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: API_CONFIG, useValue: config }]);
}
