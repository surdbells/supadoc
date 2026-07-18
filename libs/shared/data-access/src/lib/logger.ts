import { InjectionToken } from '@angular/core';

/** Minimal logging surface, injectable so apps can swap in Sentry, etc. */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Defaults to the browser console; override the token to redirect logs. */
export const LOGGER = new InjectionToken<Logger>('SUPADOC_LOGGER', {
  providedIn: 'root',
  factory: () => ({
    info: (m, ...a) => console.info(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
  }),
});
