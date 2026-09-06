import {
  EnvironmentProviders,
  InjectionToken,
  makeEnvironmentProviders,
} from '@angular/core';

/** Per-app configuration for the staff/doctor/admin auth silo. */
export interface StaffAuthConfig {
  /**
   * localStorage key the access token lives under. Each staff app uses its own
   * (e.g. `videomed.doctor.token`, `videomed.admin.token`) so they never share a
   * session even when served from the same origin in development.
   */
  storageKey: string;
  /**
   * If set, a signed-in account must carry this role or it's rejected at login
   * and blocked by `staffAuthGuard` (e.g. the doctor app requires `doctor`).
   */
  requiredRole?: string;
}

export const STAFF_AUTH_CONFIG = new InjectionToken<StaffAuthConfig>(
  'SUPADOC_STAFF_AUTH_CONFIG',
);

/**
 * Registers the staff auth silo for an app. Pair with `staffAuthInterceptor`
 * (in `provideHttpClient(withInterceptors([...]))`) and `provideSupadocDataAccess`.
 */
export function provideStaffAuth(config: StaffAuthConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: STAFF_AUTH_CONFIG, useValue: config },
  ]);
}
