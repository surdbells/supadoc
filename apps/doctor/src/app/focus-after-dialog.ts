import { afterNextRender, effect, type Injector } from '@angular/core';
import { DialogService } from '@supadoc/ui';

/**
 * Move focus to `target()` once every `DialogService` prompt has fully closed
 * (its exit animation included).
 *
 * For a confirmed action that removed the control which opened the prompt
 * (a deleted row's Delete button, a cancelled visit's Cancel): the dialog only
 * gives focus back to an opener that still exists, and while a native modal
 * is still closing the page behind it is inert — an `afterNextRender` focus
 * right after `confirm()` resolves is silently ignored and focus falls to
 * `<body>`. Point it at a status message (`tabindex="-1"`) saying what
 * happened.
 */
export function focusAfterDialogs(injector: Injector, target: () => HTMLElement | null | undefined): void {
  const dialogs = injector.get(DialogService);
  let done = false;
  // Tied to `injector`'s lifetime: a page left meanwhile drops it.
  const watcher = effect(
    () => {
      if (done || dialogs.requests().length > 0) return;
      done = true;
      afterNextRender(
        () => {
          watcher.destroy();
          target()?.focus();
        },
        { injector },
      );
    },
    { injector },
  );
}
