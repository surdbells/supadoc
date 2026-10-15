import { assertInInjectionContext, DestroyRef, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';

/**
 * The browser's own "Leave site?" prompt for closing or reloading the tab while
 * `when()` is true — the only thing that can stop a tab close, so keep it for
 * real loss (an active call, unsaved clinical or profile edits, queued uploads).
 * In-app navigation is covered by `unsavedChangesGuard` + the in-app dialog.
 * Call from an injection context (a constructor or field initialiser); the
 * listener is removed when the component is destroyed.
 *
 * ```ts
 * constructor() { warnBeforeUnload(() => this.inCall()); }
 * ```
 */
export function warnBeforeUnload(when: () => boolean): void {
  assertInInjectionContext(warnBeforeUnload);
  const view = inject(DOCUMENT).defaultView;
  if (!view) return;
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!when()) return;
    event.preventDefault();
    // Older browsers only prompt when returnValue is set.
    event.returnValue = '';
  };
  view.addEventListener('beforeunload', onBeforeUnload);
  inject(DestroyRef).onDestroy(() => view.removeEventListener('beforeunload', onBeforeUnload));
}
