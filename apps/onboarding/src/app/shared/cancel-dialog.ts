import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { WITHDRAW_REASON_LABELS, type WithdrawReason } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import { type SelectOption, SelectComponent } from './select';
import { onbModalButton } from './ui-classes';

export interface WithdrawChoice {
  reason: WithdrawReason | null;
}

const REASONS: SelectOption[] = (Object.entries(WITHDRAW_REASON_LABELS) as [WithdrawReason, string][]).map(
  ([value, label]) => ({ value, label }),
);

let nextId = 0;

/**
 * "Cancel application?" (a draft) and "Withdraw application?" (submitted),
 * Figma "Cancel Appointment" frames, 557px. Centred ban disc, title, subtitle,
 * the Snow "If you cancel" panel, then — for a submitted application — the
 * optional reason and the required "I understand" tick. "Yes, withdraw" keeps
 * the Alert/30 look until ticked but stays clickable: a click then focuses the
 * tick box and says why (D29).
 */
@Component({
  selector: 'onb-cancel-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, DialogComponent, IconComponent, ReactiveFormsModule, SelectComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      dialogRole="alertdialog"
      [maxWidth]="557"
      [busy]="busy()"
      [labelledBy]="id + '-title'"
      [describedBy]="id + '-subtitle'"
      (closed)="closed.emit()"
    >
      <div class="relative flex flex-col items-center p-6 text-center">
        <button
          type="button"
          class="absolute right-3.5 top-3.5 inline-flex size-10 items-center justify-center rounded-full text-slate transition-colors hover:bg-glacier hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-50"
          aria-label="Close"
          [disabled]="busy()"
          (click)="closed.emit()"
        >
          <sd-icon name="x" [size]="20" [strokeWidth]="1.5" />
        </button>
        <span class="mt-3 inline-flex size-[52px] items-center justify-center rounded-full bg-alert/10 text-alert" aria-hidden="true">
          <sd-icon name="ban" [size]="30" [strokeWidth]="1.5" />
        </span>
        <h2 [id]="id + '-title'" class="mt-6 font-sans text-[18px] font-medium leading-[22px] text-ink">{{ title() }}</h2>
        <p [id]="id + '-subtitle'" class="mt-2.5 font-sans text-caption text-slate">{{ subtitle() }}</p>

        <div class="mt-6 w-full rounded-field bg-snow p-4 text-left">
          <p class="font-sans text-[15px] font-medium text-ink">If you cancel</p>
          <ul class="mt-2 flex list-disc flex-col gap-1 pl-6 font-sans text-body-sm text-slate marker:text-slate">
            @for (b of bullets(); track b) {
              <li>{{ b }}</li>
            }
          </ul>
        </div>

        @if (mode() === 'submitted') {
          <div class="mt-6 w-full text-left">
            <label [for]="id + '-reason'" class="font-sans text-body-sm font-medium text-ink">Why are you withdrawing? (optional)</label>
            <onb-select
              class="mt-2"
              [inputId]="id + '-reason'"
              placeholder="Select a reason"
              [options]="reasons"
              [formControl]="reason"
            />
            <label class="mt-3 flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
              <input
                #tick
                type="checkbox"
                class="peer sr-only"
                [checked]="confirmed()"
                [attr.aria-invalid]="tickError() ? true : null"
                [attr.aria-describedby]="tickError() ? id + '-tick-error' : null"
                (change)="onTick($event)"
              />
              <span
                class="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[2px] border-[1.5px] peer-focus-visible:ring-2 peer-focus-visible:ring-cerulean/40"
                [class]="confirmed() ? 'border-cerulean bg-cerulean text-white' : 'border-slate bg-white'"
                aria-hidden="true"
              >
                @if (confirmed()) {
                  <sd-icon name="check" [size]="12" [strokeWidth]="3" />
                }
              </span>
              I understand this can't be undone.
            </label>
            @if (tickError()) {
              <p [id]="id + '-tick-error'" role="alert" class="mt-1 font-label text-caption text-alert">Tick the box to confirm.</p>
            }
          </div>
        }

        @if (error()) {
          <sd-alert tone="error" class="mt-4 w-full text-left">{{ error() }}</sd-alert>
        }

        <div class="mt-7 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          <button type="button" [class]="keepClass" [disabled]="busy()" (click)="closed.emit()">
            {{ keepLabel() }}
          </button>
          <button
            type="button"
            [class]="confirmClass()"
            [attr.aria-disabled]="inert() || null"
            [attr.aria-busy]="busy() || null"
            (click)="onConfirm()"
          >
            @if (busy()) {
              <sd-icon name="loader-circle" [size]="16" class="animate-spin" />
            }
            {{ confirmLabel() }}
          </button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class CancelDialogComponent {
  readonly open = input(false);
  readonly mode = input<'draft' | 'submitted'>('draft');
  /** "Submitted", "Under Review"… (submitted mode). */
  readonly statusLabel = input('');
  readonly busy = input(false);
  readonly error = input<string | null>(null);

  readonly confirm = output<WithdrawChoice>();
  readonly closed = output<void>();

  protected readonly id = `onb-cancel-${++nextId}`;
  protected readonly reasons = REASONS;
  protected readonly reason = new FormControl('', { nonNullable: true });
  protected readonly confirmed = signal(false);
  protected readonly tickError = signal(false);
  private readonly tick = viewChild<ElementRef<HTMLInputElement>>('tick');

  protected readonly title = computed(() => (this.mode() === 'draft' ? 'Cancel application?' : 'Withdraw application?'));
  protected readonly subtitle = computed(() =>
    this.mode() === 'draft' ? "You haven't submitted it yet." : `It's currently ${this.statusLabel()}.`,
  );
  protected readonly bullets = computed(() =>
    this.mode() === 'draft'
      ? [
          "Your saved answers and any documents you've uploaded will be deleted.",
          'Any resume link or draft code we emailed you will stop working.',
        ]
      : ["We'll stop reviewing your application straight away.", "This can't be undone. You can apply again at any time."],
  );
  protected readonly keepLabel = computed(() => (this.mode() === 'draft' ? 'Continue application' : 'Keep my application'));
  protected readonly confirmLabel = computed(() => (this.mode() === 'draft' ? 'Yes, cancel' : 'Yes, withdraw'));
  protected readonly inert = computed(() => this.mode() === 'submitted' && !this.confirmed());
  protected readonly keepClass = `${onbModalButton('neutral')} w-full disabled:opacity-60`;
  protected readonly confirmClass = computed(() => `${onbModalButton('danger', this.inert())} w-full`);

  protected onTick(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.confirmed.set(on);
    if (on) this.tickError.set(false);
  }

  protected onConfirm(): void {
    if (this.busy()) return;
    if (this.inert()) {
      this.tickError.set(true);
      this.tick()?.nativeElement.focus();
      return;
    }
    const r = this.reason.value as WithdrawReason | '';
    this.confirm.emit({ reason: r === '' ? null : r });
  }

  /** Back to the untouched state (call when reopening). */
  reset(): void {
    this.reason.setValue('');
    this.confirmed.set(false);
    this.tickError.set(false);
  }
}
