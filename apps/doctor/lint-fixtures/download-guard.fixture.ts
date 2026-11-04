/**
 * Lint fixture for the doctor app's download guard (apps/doctor/eslint.config.mjs).
 * Not app code: nothing imports it and no tsconfig includes it.
 *
 * Every "flagged" line MUST be reported by `no-restricted-syntax`, which its
 * disable comment then silences. If the rule ever stopped flagging one, that
 * comment would be unused — an error in this folder — so lint fails. The
 * "allowed" calls carry no comment, so lint fails if the rule ever flags them.
 */
// eslint-disable-next-line no-restricted-syntax -- flagged: importing the old open-in-a-tab helper
import { openBlobDocument } from '@supadoc/data-access';

declare const id: string;
declare const url: string;
declare const blob: Blob;
declare const api: { patientDocumentBlob(appointmentId: string, docId: string): unknown };

export function flagged(): void {
  // eslint-disable-next-line no-restricted-syntax -- flagged: a blank tab to write a document into
  window.open('', '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: an arbitrary URL
  window.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a cross-origin URL
  window.open('https://example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: object URLs
  URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: object URLs through window
  window.URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old document download
  api.patientDocumentBlob('ap-1', 'doc-1');
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old open-in-a-tab helper
  openBlobDocument(null as never);
}

export function allowed(): void {
  window.open('/auth/login', '_blank', 'noopener');
  window.open('/patients/' + encodeURIComponent(id), '_blank', 'noopener');
  window.open(`/patients/${encodeURIComponent(id)}`, '_blank', 'noopener');
}
