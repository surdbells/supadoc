import { map, type Observable, switchMap, take } from 'rxjs';

/** Safari needs the object URL a while after the click. */
export const SAVE_REVOKE_MS = 30_000;

/**
 * Save bytes to the device: a same-origin object URL on a hidden
 * `<a download rel="noopener">`, clicked, removed, and revoked after 30 s. The
 * browser never navigates, so a download can never replace the page (or drop
 * a call). Internal: not exported from the barrel; hosts use
 * {@link saveSignedLink}, the viewer its own Download (never for a policy
 * without `download`).
 */
export function saveBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), SAVE_REVOKE_MS);
  }
}

/**
 * A host's own Download button for a signed link (prescriptions, lab request
 * PDFs): mint the download link (one `…downloaded` audit row), fetch it with
 * `HttpClient` as a Blob, then save it with a same-origin object URL. Never a
 * cross-origin `<a href download>`: on another origin the browser ignores
 * `download` and navigates, and an error body would replace the page.
 *
 * ```ts
 * saveSignedLink(api.link(id, true).pipe(map((r) => r.data)), (url) => api.fileBlob({ url } as PrescriptionLinkDto)).subscribe(…);
 * ```
 */
export function saveSignedLink(
  link$: Observable<{ readonly url: string; readonly filename: string }>,
  fetch: (url: string) => Observable<Blob>,
): Observable<void> {
  return link$.pipe(
    take(1),
    switchMap((link) => fetch(link.url).pipe(take(1), map((blob) => saveBlob(blob, link.filename)))),
  );
}
