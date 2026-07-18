import { InjectionToken } from '@angular/core';

/** Runtime configuration for the backend API. Provided per app from its environment. */
export interface ApiConfig {
  /** Base URL of the backend API, e.g. `https://api.supadoc.com`. */
  baseUrl: string;
}

export const API_CONFIG = new InjectionToken<ApiConfig>('SUPADOC_API_CONFIG');
