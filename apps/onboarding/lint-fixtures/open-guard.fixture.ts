/**
 * Lint fixture for the onboarding app's open guard (apps/onboarding/eslint.config.mjs).
 * Not app code: nothing imports it and no tsconfig includes it.
 *
 * Every "flagged" line MUST be reported by `no-restricted-syntax`, which its
 * disable comment then silences. If the rule ever stopped flagging one, that
 * comment would be unused — an error in this folder — so lint fails. The
 * "allowed" calls carry no comment, so lint fails if the rule ever flags them.
 */
// eslint-disable-next-line no-restricted-syntax -- flagged: importing the old open-in-a-tab helper
import { openBlobDocument } from '@supadoc/data-access';
// eslint-disable-next-line no-restricted-syntax -- flagged: importing the old clinical-document tab
import { openClinicalDocument } from '@supadoc/data-access';
// eslint-disable-next-line no-restricted-syntax -- flagged: importing the old placeholder tab
import { openPendingTab } from '@supadoc/data-access';

declare const id: string;
declare const url: string;
declare const blob: Blob;
declare const host: { doc: Document };
declare function open(u: string, target?: string): void;

export function flagged(): void {
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old open-in-a-tab helper
  openBlobDocument(null as never);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old clinical-document tab
  openClinicalDocument(null as never);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the old placeholder tab
  openPendingTab();
  // eslint-disable-next-line no-restricted-syntax -- flagged: a blank tab to write a document into
  window.open('', '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: an arbitrary URL
  window.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a cross-origin URL
  window.open('https://example.test/file.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a protocol-relative URL is cross-origin
  window.open('//cdn.example.test/x.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/\host' is protocol-relative too
  window.open('/\\cdn.example.test/x.pdf', '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: URL parsing drops the tab, leaving '//host'
  window.open('/\t/cdn.example.test/x.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: '//' + host
  window.open('//' + url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: '/' + x, where x may start with '/'
  window.open('/' + url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a template that starts with '//'
  window.open(`//${url}/x.pdf`);
  // eslint-disable-next-line no-restricted-syntax -- flagged: a template whose path is all expression
  self.open(`/${url}`);
  // eslint-disable-next-line no-restricted-syntax -- flagged: a bare open(…) on a protocol-relative URL
  open('//cdn.example.test/x.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView?.open on a protocol-relative URL
  host.doc.defaultView?.open('//cdn.example.test/x.pdf');
  // eslint-disable-next-line no-restricted-syntax -- flagged: globalThis.open
  globalThis.open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: self.open
  self.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: a bare open(…)
  open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the optional-chain defaultView?.open
  host.doc.defaultView?.open('');
  // eslint-disable-next-line no-restricted-syntax -- flagged: defaultView.open with a URL
  window.document.defaultView?.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-non-null-assertion -- flagged: defaultView!.open
  host.doc.defaultView!.open(url);
}

export function allowed(): void {
  window.open('/apply', '_blank', 'noopener');
  window.open('/status/' + encodeURIComponent(id), '_blank', 'noopener');
  window.open(`/status/${encodeURIComponent(id)}`, '_blank', 'noopener');
  host.doc.defaultView?.open('/status', '_blank');
  // The calendar download keeps its object URL.
  URL.revokeObjectURL(URL.createObjectURL(blob));
}
