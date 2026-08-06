import { InjectionToken } from '@angular/core';

/** Runtime configuration for the backend API. Provided per app from its environment. */
export interface ApiConfig {
  /** Base URL of the backend API, e.g. `https://vmapi.betacrest.com`. */
  baseUrl: string;
  /** Per-app identifier the VideoMed API requires on most requests. */
  appId?: string;
  /**
   * Path (relative to `baseUrl`) for the sign-in endpoint. Defaults to `login`
   * (the betacrest VideoMed API). Apps talking to a backend with a different
   * route — e.g. the local API's `api/portal/auth/login` — override it here.
   */
  loginPath?: string;
}

export const API_CONFIG = new InjectionToken<ApiConfig>('SUPADOC_API_CONFIG');
