import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

/**
 * A small confirmation modal for guarding destructive or easily-mis-clicked
 * actions (logging out, cancelling, deleting). Render it always and toggle
 * `open`; it emits `confirm` / `cancel`.
 *
 * Usage:
 * `<sd-confirm-dialog [open]="ask()" title="Log out?" confirmLabel="Log out"
 *    (confirm)="logout()" (cancel)="ask.set(false)" />`
 */
@Component({
  selector: 'sd-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button
          type="button"
          class="absolute inset-0 cursor-default bg-abyss/40"
          aria-label="Cancel"
          (click)="cancel.emit()"
        ></button>
        <div
          class="relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-[16px] bg-white p-6 text-center shadow-[0_8px_40px_rgba(10,22,40,0.2)]"
          role="dialog"
          aria-modal="true"
        >
          <span
            class="mx-auto flex size-14 items-center justify-center rounded-full"
            [class]="danger() ? 'bg-alert/10 text-alert' : 'bg-frost text-cerulean'"
          >
            <sd-icon [name]="icon()" [size]="26" />
          </span>
          <div class="flex flex-col gap-1">
            <h3 class="font-heading text-h5 text-ink">{{ title() }}</h3>
            @if (message()) {
              <p class="font-sans text-body-sm text-slate">{{ message() }}</p>
            }
          </div>
          <div class="mt-1 flex gap-3">
            <button
              type="button"
              class="flex-1 rounded-field border border-cloud py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
              (click)="cancel.emit()"
            >
              {{ cancelLabel() }}
            </button>
            <button
              type="button"
              class="flex-1 rounded-field py-3 font-sans text-body font-semibold text-white transition-colors"
              [class]="danger() ? 'bg-alert hover:bg-alert/90' : 'bg-cerulean hover:bg-ocean'"
              (click)="confirm.emit()"
            >
              {{ confirmLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  readonly open = input(false);
  readonly title = input('Are you sure?');
  readonly message = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');
  readonly icon = input('triangle-alert');
  readonly danger = input(false);

  readonly confirm = output<void>();
  readonly cancel = output<void>();
}
