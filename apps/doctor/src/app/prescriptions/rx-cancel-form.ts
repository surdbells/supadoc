import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorFields, apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { CancelPrescriptionResult } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { RX_BAD, RX_FIELD, RX_OK } from './rx-shared';

let nextId = 0;
const REASON_MAX = 300;

/**
 * Inline "Cancel…" form for an ACTIVE prescription: a required reason and the
 * choice to cancel only or cancel and start a replacement draft.
 * Emits `done` with the API result (`replacement` is the new draft, if any).
 */
@Component({
  selector: 'doc-rx-cancel-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <form
      class="flex flex-col gap-4 rounded-card border border-alert/30 bg-alert/5 p-4"
      [attr.aria-labelledby]="uid + '-title'"
      (submit)="$event.preventDefault(); submit()"
      (keydown.escape)="dismissed.emit()"
    >
      <div class="flex items-start gap-2">
        <sd-icon name="circle-x" [size]="18" class="mt-0.5 shrink-0 text-alert" />
        <div class="flex flex-col gap-0.5">
          <h3 class="font-heading text-body font-semibold text-ink" [id]="uid + '-title'">
            Cancel {{ number() || 'this prescription' }}?
          </h3>
          <p class="font-sans text-caption text-slate">
            The patient and pharmacy will see it as cancelled. This cannot be undone.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="font-sans text-caption font-semibold text-ink" [for]="uid + '-reason'">
          Why are you cancelling it? <span class="text-alert">*</span>
        </label>
        <textarea
          rows="2"
          class="${RX_FIELD}"
          [class]="reasonError() ? '${RX_BAD}' : '${RX_OK}'"
          [id]="uid + '-reason'"
          [attr.maxlength]="max"
          [attr.aria-invalid]="reasonError() ? 'true' : null"
          [attr.aria-describedby]="uid + '-reason-help'"
          placeholder="For example: wrong dose entered"
          [value]="reason()"
          (input)="setReason($any($event.target).value)"
        ></textarea>
        <div class="flex items-start justify-between gap-3" [id]="uid + '-reason-help'">
          <span class="font-sans text-caption text-alert">{{ reasonError() }}</span>
          <span class="shrink-0 font-sans text-caption text-slate">{{ reason().length }}/{{ max }}</span>
        </div>
      </div>

      <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend class="mb-1 font-sans text-caption font-semibold text-ink">What happens next?</legend>
        <label class="flex cursor-pointer items-start gap-2.5 rounded-field border border-cloud bg-white px-3 py-2.5">
          <input
            type="radio"
            class="mt-1 size-4 accent-cerulean"
            [name]="uid + '-mode'"
            [checked]="!replace()"
            (change)="replace.set(false)"
          />
          <span class="flex flex-col">
            <span class="font-sans text-body-sm font-semibold text-ink">Cancel only</span>
            <span class="font-sans text-caption text-slate">Stop this prescription. Nothing new is written.</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-2.5 rounded-field border border-cloud bg-white px-3 py-2.5">
          <input
            type="radio"
            class="mt-1 size-4 accent-cerulean"
            [name]="uid + '-mode'"
            [checked]="replace()"
            (change)="replace.set(true)"
          />
          <span class="flex flex-col">
            <span class="font-sans text-body-sm font-semibold text-ink">Cancel and write a replacement</span>
            <span class="font-sans text-caption text-slate">
              Opens a new draft with the same details for you to correct and send.
            </span>
          </span>
        </label>
      </fieldset>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <sd-button variant="secondary" size="sm" [disabled]="busy()" (click)="dismissed.emit()">
          Keep it
        </sd-button>
        <sd-button variant="danger" size="sm" type="submit" [disabled]="busy()">
          {{ busy() ? 'Cancelling…' : submitLabel() }}
        </sd-button>
      </div>
    </form>
  `,
})
export class RxCancelForm {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly prescriptionId = input.required<string>();
  readonly number = input<string>('');

  /** The prescription was cancelled (`replacement` holds the new draft when asked for). */
  readonly done = output<CancelPrescriptionResult>();
  /** "Keep it" — close the form without cancelling. */
  readonly dismissed = output<void>();

  protected readonly uid = `rxc${++nextId}`;
  protected readonly max = REASON_MAX;
  protected readonly reason = signal('');
  protected readonly replace = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly reasonError = signal('');
  protected readonly submitLabel = computed(() =>
    this.replace() ? 'Cancel and replace' : 'Cancel prescription',
  );

  protected setReason(value: string): void {
    this.reason.set(value);
    if (this.reasonError() && value.trim().length >= 3) this.reasonError.set('');
  }

  protected submit(): void {
    if (this.busy()) return;
    const reason = this.reason().trim();
    this.error.set('');
    if (reason.length < 3) {
      this.reasonError.set('Say why you are cancelling it (at least 3 characters).');
      return;
    }
    this.busy.set(true);
    this.api
      .cancelPrescription(this.prescriptionId(), reason, this.replace())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.done.emit(res.data);
        },
        error: (err: unknown) => {
          this.busy.set(false);
          const fields = apiErrorFields(err);
          if (fields['reason']) this.reasonError.set(fields['reason']);
          this.error.set(apiErrorMessage(err, 'Could not cancel the prescription. Please try again.'));
        },
      });
  }
}
