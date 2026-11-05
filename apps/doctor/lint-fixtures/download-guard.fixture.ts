/**
 * Lint fixture for the doctor app's download guard (apps/doctor/eslint.config.mjs).
 * Not app code: nothing imports it and no tsconfig includes it.
 *
 * Every "flagged" line MUST be reported by `no-restricted-syntax`, which its
 * disable comment then silences. If the rule ever stopped flagging one, that
 * comment would be unused — an error in this folder — so lint fails. The
 * "allowed" calls carry no comment, so lint fails if the rule ever flags them.
 */
import {
  // eslint-disable-next-line no-restricted-syntax -- flagged: importing the old open-in-a-tab helper
  openBlobDocument,
  // eslint-disable-next-line no-restricted-syntax -- flagged: importing the old clinical-document tab
  openClinicalDocument,
  // eslint-disable-next-line no-restricted-syntax -- flagged: importing the old placeholder-tab helper
  openPendingTab,
} from '@supadoc/data-access';
import {
  blobSource,
  // eslint-disable-next-line no-restricted-syntax -- flagged: hosts never save blobs (saveSignedLink only)
  saveBlob,
  viewOnlySource,
} from '@supadoc/viewer';
// eslint-disable-next-line no-restricted-syntax -- flagged: the doctor app never embeds the viewer
import { DocumentViewerComponent } from '@supadoc/viewer/embed';
import { map, type Observable } from 'rxjs';
// eslint-disable-next-line no-restricted-syntax -- flagged: re-exporting the embedded viewer (another file could then render it)
export { DocumentViewerComponent as EmbeddedViewer } from '@supadoc/viewer/embed';
// eslint-disable-next-line no-restricted-syntax -- flagged: re-exporting the whole embed entry point
export * from '@supadoc/viewer/embed';

declare const id: string;
declare const url: string;
declare const blob: Blob;
declare const a: string;
declare const d: string;
declare const doc: { defaultView: Window | null };
declare const frame: { defaultView: Window };
declare const api: {
  patientDocumentBlob(appointmentId: string, docId: string): unknown;
  patientDocumentView(appointmentId: string, docId: string): Observable<{ blob: Blob; mime: string; viewRef: string | null; viewedAt: string }>;
};
declare const labApi: { viewResult(labId: string, resultId: string): unknown };

export function flagged(): void {
  // eslint-disable-next-line no-restricted-syntax -- flagged: a blank tab to write a document into
  window.open('', '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: an arbitrary URL
  window.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a cross-origin URL
  window.open('https://example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a protocol-relative URL (another origin)
  window.open('//example.test/file.pdf', '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a protocol-relative template
  window.open(`//${url}/x`);
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/' + a value that may itself start with '/'
  window.open('/' + url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/\\' (browsers read it as '//')
  window.open('/\\example.test/x');
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/' + a tab (browsers drop it, leaving '//')
  globalThis.open('/\t/example.test/x');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a bare open(…) with a protocol-relative URL
  open('//example.test/x');
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView?.open with a protocol-relative template
  doc.defaultView?.open(`//${url}`);
  // eslint-disable-next-line no-restricted-syntax -- flagged: globalThis.open with a URL
  globalThis.open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: self.open with a blank tab
  self.open('');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a bare open(…)
  open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView.open with a URL
  frame.defaultView.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView?.open (an optional call, inside a ChainExpression)
  doc.defaultView?.open('');
  // eslint-disable-next-line no-restricted-syntax -- flagged: object URLs
  URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: object URLs through window
  window.URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old document download
  api.patientDocumentBlob('ap-1', 'doc-1');
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old open-in-a-tab helper
  openBlobDocument(null as never);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old placeholder tab
  openPendingTab();
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old clinical-document tab
  openClinicalDocument(null as never);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the view-only route outside the source builders
  api.patientDocumentView(a, d);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the lab result's view-only route outside the source builders
  labApi.viewResult(a, d);
  // eslint-disable-next-line no-restricted-syntax -- flagged: a host wrapping the view-only route in a downloadable source
  blobSource({ key: 'x', title: 'x', typeLabel: 'x', policy: 'owner', fetch: () => api.patientDocumentView(a, d).pipe(map((v) => v.blob)) });
  void saveBlob;
  void DocumentViewerComponent;
}

export function allowed(): void {
  window.open('/auth/login', '_blank', 'noopener');
  window.open('/patients/' + encodeURIComponent(id), '_blank', 'noopener');
  window.open(`/patients/${encodeURIComponent(id)}`, '_blank', 'noopener');
  globalThis.open('/auth/login', '_blank', 'noopener');
  doc.defaultView?.open('/auth/login', '_blank', 'noopener');
  // Not a window: any other object's open().
  ({ open: (x: string) => x }).open(url);
  // Building a view-only source is the source builders' business; naming the builder is fine.
  void viewOnlySource;
}
