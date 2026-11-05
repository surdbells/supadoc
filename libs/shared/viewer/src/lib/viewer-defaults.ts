import { InjectionToken, type Provider } from '@angular/core';
import type { ViewerTone } from './viewer-types';

export interface ViewerDefaults {
  readonly tone: ViewerTone;
}

/**
 * App-wide viewer defaults. The tone defaults to `'auto'`: it follows
 * `html[data-theme]`, which only the patient app ever sets to `dark`, so the
 * doctor, back-office and onboarding apps get `light` exactly as before — and
 * the patient app needs no provider in its eager `app.config.ts`, where any
 * import from `@supadoc/viewer` would pull the light entry (about 25 kB,
 * measured) into its initial bundle.
 */
export const VIEWER_DEFAULTS = new InjectionToken<ViewerDefaults>('VIEWER_DEFAULTS', {
  providedIn: 'root',
  factory: () => ({ tone: 'auto' }),
});

/**
 * Override the defaults in the root providers, e.g. `provideViewerDefaults({ tone: 'light' })`.
 * Mind the cost above: importing it into `app.config.ts` puts the light entry in the initial bundle.
 */
export function provideViewerDefaults(defaults: ViewerDefaults): Provider {
  return { provide: VIEWER_DEFAULTS, useValue: Object.freeze({ ...defaults }) };
}
