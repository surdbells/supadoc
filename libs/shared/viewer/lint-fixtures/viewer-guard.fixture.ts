/**
 * Lint fixture for the shared viewer's guard (libs/shared/viewer/eslint.config.mjs).
 * Not library code: nothing imports it and no tsconfig includes it.
 *
 * Every "flagged" line MUST be reported by `no-restricted-syntax`, which its
 * disable comment then silences. If the rule ever stopped flagging one, that
 * comment would be unused — an error in this folder — so lint fails.
 */
// eslint-disable-next-line no-restricted-syntax -- flagged: trusting HTML
import { bypassSecurityTrustHtml } from './not-a-module';

declare const url: string;
declare const blob: Blob;
declare const el: HTMLElement;
declare const sanitizer: { bypassSecurityTrustResourceUrl(v: string): unknown };
declare const host: { doc: Document };
declare function open(u: string): void;

export function flagged(): void {
  // eslint-disable-next-line no-restricted-syntax -- flagged: an object URL outside the three allowed files
  URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: an object URL through window
  window.URL.createObjectURL(blob);
  // eslint-disable-next-line no-restricted-syntax -- flagged: window.open
  window.open(url, '_blank');
  // eslint-disable-next-line no-restricted-syntax -- flagged: globalThis.open
  globalThis.open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: self.open
  self.open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: a bare open(…)
  open(url);
  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-non-null-assertion -- flagged: defaultView!.open
  host.doc.defaultView!.open(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: the optional-chain defaultView?.open
  host.doc.defaultView?.open('');
  // eslint-disable-next-line no-restricted-syntax -- flagged: innerHTML
  el.innerHTML = url;
  // eslint-disable-next-line no-restricted-syntax -- flagged: outerHTML
  el.outerHTML = url;
  // eslint-disable-next-line no-restricted-syntax -- flagged: insertAdjacentHTML
  el.insertAdjacentHTML('beforeend', url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: document.write
  document.write(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: window.document.write
  window.document.write(url);
  // eslint-disable-next-line no-restricted-syntax -- flagged: bypassSecurityTrust*
  sanitizer.bypassSecurityTrustResourceUrl(url);
  void bypassSecurityTrustHtml;
}

export function allowed(): void {
  el.textContent = url;
  el.append(document.createElement('span'));
}
