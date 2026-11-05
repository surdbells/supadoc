/**
 * Lint fixture for the patient app's open guard (apps/patient/eslint.config.mjs, spec P-15).
 * Not app code: nothing imports it and no tsconfig includes it.
 *
 * Every "flagged" line MUST be reported by `no-restricted-syntax`, which its
 * disable comment then silences. If the rule ever stopped flagging one, that
 * comment would be unused — an error in this folder — so lint fails. The
 * "allowed" calls carry no comment, so lint fails if the rule ever flags them.
 */
// eslint-disable-next-line no-restricted-syntax -- flagged: importing the old open-in-a-tab helpers
import { openBlobDocument, openClinicalDocument, openPendingTab } from '@supadoc/data-access';

declare const url: string;
declare const id: string;
declare const blob: Blob;
declare const doc: Document;
declare const maybeDoc: Document | null;
declare function open(url?: string, target?: string): Window | null;

export function flagged(): void {
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old blob-in-a-tab helper
  openBlobDocument(null as never);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old HTML-in-a-tab helper
  openClinicalDocument(null as never);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old pending-tab helper
  openPendingTab({ allowSameTab: false });
  // eslint-disable-next-line no-restricted-syntax -- flagged: object URLs
  URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: object URLs through window
  window.URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: a blank tab to write a document into
  window.open('', '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: an arbitrary URL (the old legacy-attachment branch)
  window.open(url, '_blank', 'noopener');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a cross-origin URL
  window.open('https://api.example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a protocol-relative URL (another host)
  window.open('//api.example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a protocol-relative template
  window.open(`//${url}`, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/\' (a browser reads it as '//')
  window.open('/\\api.example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/' then an expression that may start with '/'
  window.open('/' + url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the template form of the same
  window.open(`/${url}`);
  // eslint-disable-next-line no-restricted-syntax -- flagged: a protocol-relative URL through defaultView
  doc.defaultView?.open('//api.example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: globalThis.open
  globalThis.open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: self.open
  self.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a bare open(…)
  open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView.open
  doc.defaultView?.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView.open behind a cast
  (doc.defaultView as Window).open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: the optional chain prescription-details.ts used (this.doc.defaultView?.open)
  maybeDoc?.defaultView?.open(url, '_blank');
}

export function allowed(callback: () => void): void {
  window.open('/dashboard/documents/sharing', '_blank', 'noopener');
  window.open('/dashboard/appointments/' + encodeURIComponent(id), '_blank', 'noopener');
  window.open(`/dashboard/appointments/${encodeURIComponent(id)}`, '_blank', 'noopener');
  doc.defaultView?.open('/dashboard/wallet', '_blank');
  // A local callback named open (no argument), as dashboard-home's whenNoOtherOverlay calls it.
  const open = callback;
  open();
}
