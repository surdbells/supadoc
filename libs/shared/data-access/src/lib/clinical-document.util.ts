import { Observable } from 'rxjs';
import { apiErrorCode, apiErrorMessage } from './api-error.util';

/**
 * Replace the placeholder tab's content with an error message. The message can
 * come from the API, so it is set as text (never HTML) to rule out injection.
 */
function showTabError(tab: Window, message: string): void {
  const box = tab.document.createElement('div');
  box.setAttribute('style', 'padding:24px;font-family:sans-serif;color:#c62828');
  box.textContent = message;
  tab.document.body.replaceChildren(box);
}

/**
 * Opens a rendered clinical document (HTML from the API) in a new tab for
 * viewing / printing / "Save as PDF".
 *
 * The tab is opened **synchronously** on the user's click so it survives popup
 * blockers, shows a lightweight placeholder, then swaps in the fetched document
 * via a blob URL once the request resolves. One-shot: the HTTP GET completes and
 * the subscription ends on its own.
 */
export function openClinicalDocument(document$: Observable<string>): void {
  const tab = window.open('', '_blank');
  if (tab) {
    tab.document.write(
      '<!doctype html><meta charset="utf-8"><title>Preparing document…</title>' +
        '<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#546e7a;display:flex;align-items:center;justify-content:center;height:100vh">Preparing document…</body>',
    );
  }

  document$.subscribe({
    next: (html) => {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      if (tab) tab.location.href = url;
      else window.location.href = url;
      // Revoke after the tab has had time to load the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    error: (err: unknown) => {
      if (tab) {
        showTabError(tab, apiErrorMessage(err, 'Could not load the document. Please try again.'));
      }
    },
  });
}

export interface OpenBlobOptions {
  /**
   * Called instead of writing the error into the placeholder tab (which is
   * then closed): the host page shows its own message, e.g. for `code`
   * `not_shared` ("This document is no longer shared with you.") or
   * `view_unavailable`. `status` 0 = no response (offline).
   */
  onError?: (status: number, code: string | null) => void;
}

/** The HTTP status of either error shape (`ApiError.statusCode` / `HttpErrorResponse.status`), else 0. */
function errorStatus(err: unknown): number {
  if (!err || typeof err !== 'object') return 0;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return 0;
}

/**
 * Opens a fetched binary file (PDF, image, video, …) in a new tab for viewing.
 * Same popup-safe pattern as {@link openClinicalDocument}: open the tab on the
 * click, then point it at a blob URL once the bytes arrive.
 *
 * On failure, with `options.onError` the placeholder tab is closed and the
 * host is told the status and the API's `errors.code` (readable for blob
 * requests because the http-error interceptor parses JSON error bodies);
 * without it the error text is shown in the tab, as before.
 */
export function openBlobDocument(file$: Observable<Blob>, options?: OpenBlobOptions): void {
  const tab = window.open('', '_blank');
  if (tab) {
    tab.document.write(
      '<!doctype html><meta charset="utf-8"><title>Opening…</title>' +
        '<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#546e7a;display:flex;align-items:center;justify-content:center;height:100vh">Opening document…</body>',
    );
  }

  file$.subscribe({
    next: (blob) => {
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    },
    error: (err: unknown) => {
      const onError = options?.onError;
      if (onError) {
        if (tab) {
          try {
            tab.close();
          } catch {
            // A tab we can no longer reach — nothing to close.
          }
        }
        onError(errorStatus(err), apiErrorCode(err));
        return;
      }
      if (tab) {
        showTabError(tab, apiErrorMessage(err, 'Could not open the document. Please try again.'));
      }
    },
  });
}
