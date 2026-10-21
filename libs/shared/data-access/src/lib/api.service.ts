import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { API_CONFIG } from './api-config';

type ParamValue = string | number | boolean;
export type QueryParams = Record<string, ParamValue | undefined>;

/**
 * Request header marking a background poll (`X-SD-Passive: 1`). The API still
 * checks the session on such a request (an ended session is refused as usual)
 * but never counts it as activity, so a page left polling cannot keep an idle
 * session alive. It also never records a "list viewed" audit row.
 */
export const PASSIVE_REQUEST_HEADER = 'X-SD-Passive';

export interface ApiRequestOptions {
  /** Background poll: never extends the session idle clock. */
  passive?: boolean;
}

/**
 * Thin, strongly-typed wrapper around `HttpClient` that every feature service
 * builds on. It prefixes requests with the configured API base URL so callers
 * only pass resource paths (e.g. `api.get<Patient[]>('patients')`).
 *
 * As the backend team ships endpoints, add feature-specific services (e.g.
 * `AppointmentsService`) that inject `ApiService` and expose typed methods.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /**
   * GET a JSON resource. `{ passive: true }` marks a background poll (adds
   * `X-SD-Passive: 1`, see {@link PASSIVE_REQUEST_HEADER}); user-initiated
   * loads leave it off.
   */
  get<T>(path: string, params?: QueryParams, options?: ApiRequestOptions): Observable<T> {
    const headers = this.headersFor(options);
    return this.http.get<T>(this.url(path), {
      params: this.toParams(params),
      ...(headers ? { headers } : {}),
    });
  }

  /**
   * GET a resource as raw text (e.g. a rendered HTML document). The auth
   * interceptor still attaches the bearer token, unlike a plain `<a href>`.
   */
  getText(path: string, params?: QueryParams): Observable<string> {
    return this.http.get(this.url(path), {
      params: this.toParams(params),
      responseType: 'text',
    });
  }

  /**
   * GET a resource as a binary Blob (e.g. a streamed file). Authenticated via the
   * interceptor, so it works for access-controlled files a public URL can't reach.
   */
  getBlob(path: string, params?: QueryParams): Observable<Blob> {
    return this.http.get(this.url(path), {
      params: this.toParams(params),
      responseType: 'blob',
    });
  }

  /**
   * POST a JSON body. `{ passive: true }` marks it as started by a background
   * poll (e.g. the token refresh a poll needed), so it is no activity either.
   */
  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Observable<T> {
    const headers = this.headersFor(options);
    return headers
      ? this.http.post<T>(this.url(path), body, { headers })
      : this.http.post<T>(this.url(path), body);
  }

  put<T>(path: string, body?: unknown): Observable<T> {
    return this.http.put<T>(this.url(path), body);
  }

  patch<T>(path: string, body?: unknown): Observable<T> {
    return this.http.patch<T>(this.url(path), body);
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path));
  }

  /**
   * Any method (e.g. `'PUT'`) with an optional JSON body — for callers that
   * pick the method at run time. Goes through the interceptors like the rest.
   */
  request<T>(method: string, path: string, body?: unknown): Observable<T> {
    return this.http.request<T>(method.toUpperCase(), this.url(path), {
      body,
      responseType: 'json',
    });
  }

  /** The absolute URL of an API path (for requests made outside HttpClient). */
  absoluteUrl(path: string): string {
    return this.url(path);
  }

  private headersFor(options?: ApiRequestOptions): HttpHeaders | undefined {
    return options?.passive
      ? new HttpHeaders({ [PASSIVE_REQUEST_HEADER]: '1' })
      : undefined;
  }

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const suffix = path.replace(/^\/+/, '');
    return `${base}/${suffix}`;
  }

  private toParams(params?: QueryParams): HttpParams {
    let httpParams = new HttpParams();
    if (!params) return httpParams;
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        httpParams = httpParams.set(key, String(value));
      }
    }
    return httpParams;
  }
}
