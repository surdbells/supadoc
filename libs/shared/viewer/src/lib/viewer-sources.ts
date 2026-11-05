import { apiErrorCode, type PatientDocumentView } from '@supadoc/data-access';
import { catchError, defer, map, type Observable, switchMap, take, throwError } from 'rxjs';
import {
  GENERIC_ERROR,
  GONE_TEXT,
  LINK_EXPIRED,
  NETWORK_ERROR,
  UPDATE_RELOAD,
  VIEW_UNAVAILABLE,
} from './viewer-copy';
import { normalMime } from './viewer-kind';
import { isViewerPolicyId, markViewOnly, VIEWER_POLICIES } from './viewer-policy';
import type { ViewerErrorView, ViewerFile, ViewerSource } from './viewer-types';

const VIEW_ONLY_THROW = 'view_only sources are built with viewOnlySource';

/** The HTTP status of either error shape (`ApiError.statusCode` / `HttpErrorResponse.status`), else null. */
export function httpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return null;
}

/**
 * The default error state (§1.2.3). Blob error bodies are already parsed by
 * `httpErrorInterceptor`, so the API's `errors.code` is readable. The body
 * swaps the `reload` copy (and drops its button) during a live call.
 */
export function defaultErrorView(err: unknown, opts: { readonly notSharedText?: string } = {}): ViewerErrorView {
  const status = httpStatus(err);
  const code = apiErrorCode(err);
  if (status === 0) return { state: 'error', text: NETWORK_ERROR, retry: true };
  if (status === 404 && code === 'not_shared') return { state: 'gone', text: opts.notSharedText || GONE_TEXT, retry: false };
  if (status === 404) return { state: 'gone', text: GONE_TEXT, retry: false };
  if (status === 410) return { state: 'error', text: LINK_EXPIRED, retry: false };
  if (status === 415 || code === 'not_viewable') return { state: 'not_viewable', text: '', retry: false };
  if (status === 409 && code === 'update_required') return { state: 'reload', text: UPDATE_RELOAD, retry: false };
  if (status === 503 || code === 'view_unavailable') return { state: 'error', text: VIEW_UNAVAILABLE, retry: true };
  return { state: 'error', text: GENERIC_ERROR, retry: true };
}

/**
 * A download name: no `\/:*?"<>|`, control characters or trailing dots,
 * whitespace collapsed, at most 120 characters, ending in `.{ext}`
 * (`document.{ext}` when nothing is left).
 */
export function safeFilename(title: string | null | undefined, ext?: string | null): string {
  const e = (ext ?? '').replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  let name = String(title ?? '')
    // Tabs and line breaks are spaces; every other control character goes.
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.slice(0, 120).trim().replace(/[.\s]+$/, '');
  if (!name) name = 'document';
  if (!e) return name;
  return name.toLowerCase().endsWith(`.${e}`) ? name : `${name}.${e}`;
}

type SourceInit = Omit<ViewerSource, 'load'>;

/** Own files and authored PDFs fetched as a Blob (mime = blob.type). Throws (every build) when `policy` is 'view_only'. */
export function blobSource(init: SourceInit & { fetch: () => Observable<Blob> }): ViewerSource {
  if ((init.policy as string) === 'view_only') throw new Error(VIEW_ONLY_THROW);
  const { fetch, ...rest } = init;
  return {
    ...rest,
    load: () => defer(() => fetch()).pipe(map((blob): ViewerFile => ({ blob, mime: normalMime(blob.type) }))),
  };
}

/**
 * Doctor × patient document / lab result. Policy is fixed to 'view_only'; the
 * only builder that yields it. `view` sends `X-SD-Viewer: 1`; Print records
 * first through `recordPrint(viewRef)`; `not_shared` shows `notSharedText`
 * and calls `onGone`.
 */
export function viewOnlySource(
  init: Omit<ViewerSource, 'load' | 'policy' | 'recordPrint' | 'download'> & {
    view: () => Observable<PatientDocumentView>;
    recordPrint: (viewRef: string | null) => Observable<unknown>;
    notSharedText: string;
  },
): ViewerSource {
  const { view, recordPrint, notSharedText, mapError, ...rest } = init;
  const unsafe = rest as Partial<ViewerSource>;
  // A host can't smuggle a download in through the spread.
  delete unsafe.download;
  const source: ViewerSource = {
    ...rest,
    policy: 'view_only',
    load: () =>
      defer(() => view()).pipe(
        map((v): ViewerFile => ({ blob: v.blob, mime: normalMime(v.mime || v.blob.type), viewRef: v.viewRef, viewedAt: v.viewedAt })),
      ),
    recordPrint: (file: ViewerFile) => recordPrint(file.viewRef ?? null),
    mapError: (err: unknown) => mapError?.(err) ?? defaultErrorView(err, { notSharedText }),
  };
  return markViewOnly(Object.freeze(source));
}

/**
 * Signed short-lived PDF links (prescriptions, lab request PDFs). `link` runs
 * lazily inside `load()`: one `link(false)` and one `fetch(url)` per open (one
 * `…viewed` audit row); a 410 from the fetch re-links once. `download()` is
 * `link(true)` + one fetch (one `…downloaded` row), never the viewed blob.
 * Throws (every build) when `policy` is 'view_only'.
 */
export function signedLinkSource(
  init: Omit<ViewerSource, 'load' | 'download'> & {
    link: (download: boolean) => Observable<{ url: string; filename: string }>;
    fetch: (url: string) => Observable<Blob>;
    canDownload?: boolean;
  },
): ViewerSource {
  if ((init.policy as string) === 'view_only') throw new Error(VIEW_ONLY_THROW);
  const { link, fetch, canDownload, ...rest } = init;
  const once = (download: boolean) =>
    defer(() => link(download)).pipe(
      take(1),
      switchMap((l) => fetch(l.url).pipe(take(1), map((blob) => ({ blob, filename: l.filename })))),
    );
  const get = (download: boolean) =>
    once(download).pipe(catchError((err: unknown) => (httpStatus(err) === 410 ? once(download) : throwError(() => err))));
  const allowed = isViewerPolicyId(rest.policy) && VIEWER_POLICIES[rest.policy].download && canDownload !== false;
  const source: ViewerSource = {
    ...rest,
    load: () => get(false).pipe(map(({ blob }): ViewerFile => ({ blob, mime: normalMime(blob.type) }))),
  };
  return allowed ? { ...source, download: () => get(true) } : source;
}
