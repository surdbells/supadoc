import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog';
import { DialogService } from './dialog.service';

/**
 * Renders the prompts opened through {@link DialogService}. Place it once in
 * each app's root template:
 *
 * ```html
 * <router-outlet />
 * <sd-dialog-outlet />
 * <sd-session-timeout />
 * ```
 *
 * When a router navigation starts, open prompts are dismissed (resolved as not
 * confirmed) — except ones whose action is still running; a leave prompt asked
 * by a guard opens after that, so it is unaffected.
 */
@Component({
  selector: 'sd-dialog-outlet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialogComponent],
  template: `
    @for (req of dialogs.requests(); track req.id) {
      <sd-confirm-dialog
        [open]="req.open()"
        [title]="req.options.title"
        [message]="req.options.message ?? ''"
        [tone]="req.options.tone ?? 'info'"
        [icon]="req.options.icon ?? ''"
        [details]="req.options.details ?? []"
        [reason]="req.options.reason ?? null"
        [secondary]="req.options.secondary ?? null"
        [confirmLabel]="req.options.confirmLabel ?? 'Confirm'"
        [cancelLabel]="req.options.cancelLabel ?? 'Cancel'"
        [dismissible]="req.options.dismissible ?? true"
        [busyLabel]="req.options.busyLabel ?? 'Working…'"
        [autofocus]="req.options.autofocus ?? 'auto'"
        [size]="req.options.size ?? 'sm'"
        [busy]="req.busy()"
        [error]="req.error()"
        (confirm)="req.confirm($event)"
        (choice)="req.choose($event.reason)"
        (cancel)="req.cancel()"
        (afterClose)="req.release()"
      />
    }
  `,
})
export class DialogOutletComponent {
  protected readonly dialogs = inject(DialogService);

  constructor() {
    const unregister = this.dialogs.registerOutlet();
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(unregister);
    const sub = inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) this.dialogs.dismissAll({ keepBusy: true });
    });
    destroyRef.onDestroy(() => sub.unsubscribe());
  }
}
