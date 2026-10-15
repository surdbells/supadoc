import { effect, EffectRef, Injector, untracked } from '@angular/core';
import { DialogService } from '@supadoc/ui';

/**
 * Run `fn` once every `DialogService` prompt has finished closing (its exit
 * animation included) — e.g. to move focus to the page heading when the
 * control that opened the prompt is gone (a declined proposal's panel). While
 * a modal prompt is up the page behind it is inert, so focusing it any sooner
 * does nothing.
 */
export function afterDialogsClose(dialogs: DialogService, injector: Injector, fn: () => void): void {
  let done = false;
  const ref: EffectRef = effect(
    () => {
      if (dialogs.requests().length > 0 || done) return;
      done = true;
      untracked(() => {
        // The dialog puts focus back on its opener on a timer of its own; go after it.
        setTimeout(fn);
        queueMicrotask(() => ref.destroy());
      });
    },
    { injector },
  );
}
