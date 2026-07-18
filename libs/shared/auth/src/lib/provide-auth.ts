import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Registers auth for an app. `AuthService` is tree-shakable (providedIn root),
 * this keeps app configs symmetrical with the other `provideSupadoc*` helpers
 * and gives a single place to add auth-related providers later.
 */
export function provideSupadocAuth(): EnvironmentProviders {
  return makeEnvironmentProviders([AuthService]);
}
