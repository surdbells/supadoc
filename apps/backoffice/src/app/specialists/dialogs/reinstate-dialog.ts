import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorFields, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDetailDto } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { BoDialog } from '../../shared/dialog';
import {
  BTN_GHOST,
  BTN_SECONDARY,
  BTN_SUCCESS,
  calendarDay,
  clinicTodayYmd,
  type DoctorTab,
  FIELD,
  FIELD_INVALID,
  LABEL,
} from '../specialist-ui';

/**
 * Lift a suspension: needs a verified, unexpired practising licence and a
 * note saying why. Bookings the suspension cancelled are not restored.
 */
@Component({
  selector: 'bo-reinstate-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, BoDialog],
  template: `
    <bo-dialog
      [open]="open()"
      [title]="'Reinstate ' + detail().profile.name"
      subtitle="They are listed and bookable again straight away, and emailed."
      [busy]="saving()"
      (closed)="closed.emit()"
    >
      <form id="bo-reinstate-form" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); submit()">
        @if (licence(); as l) {
          <sd-alert tone="success">Current practising licence verified{{ l.number ? ' (' + l.number + ')' : '' }}, valid to {{ day(l.expires_at) }}.</sd-alert>
        } @else {
          <div class="flex flex-col gap-3 rounded-field bg-alert/10 p-4" role="alert">
            <p class="flex items-start gap-2 font-sans text-body-sm text-ink">
              <sd-icon name="shield-alert" [size]="18" class="mt-0.5 shrink-0 text-alert" />
              There's no verified, unexpired practising licence. Ask the doctor to upload their current licence, then verify it on the Credentials tab.
            </p>
            <button type="button" class="${BTN_SECONDARY} w-fit" (click)="openTab.emit('credentials')">Go to Credentials<sd-icon name="chevron-right" [size]="16" /></button>
          </div>
        }
        <sd-alert tone="info">Bookings cancelled by the suspension stay cancelled — patients were refunded and can book again.</sd-alert>
        <label class="flex flex-col gap-1.5">
          <span class="${LABEL}">Why the suspension is lifted (required)</span>
          <textarea rows="3" maxlength="2000" class="${FIELD}" [class]="err('note') ? '${FIELD_INVALID}' : ''" [disabled]="!licence()" [value]="note()" (input)="note.set($any($event.target).value); clearErr('note')" placeholder="e.g. Renewed licence verified on the MDCN register." [attr.aria-invalid]="err('note') ? 'true' : null" [attr.aria-describedby]="err('note') ? 'bo-reinstate-note-err' : null"></textarea>
          @if (err('note'); as e) { <span id="bo-reinstate-note-err" class="font-sans text-caption text-alert">{{ e }}</span> }
        </label>
        <div aria-live="assertive">
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
        </div>
      </form>
      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="closed.emit()">Cancel</button>
        <button type="submit" form="bo-reinstate-form" class="${BTN_SUCCESS}" [disabled]="saving() || !licence()">
          <sd-icon [name]="saving() ? 'loader-circle' : 'user-check'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Reinstating…' : 'Reinstate doctor' }}
        </button>
      </div>
    </bo-dialog>
  `,
})
export class ReinstateDialog {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = input(false);
  readonly detail = input.required<SpecialistDetailDto>();
  readonly closed = output<void>();
  readonly reinstated = output<Partial<SpecialistDetailDto>>();
  readonly openTab = output<DoctorTab>();

  protected readonly note = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly errors = signal<Record<string, string>>({});

  /** The verified licence that hasn't expired (the API checks the same). */
  protected readonly licence = computed(() => {
    const today = clinicTodayYmd();
    return (
      this.detail().credentials.find(
        (c) => c.type === 'annual_practising_licence' && c.status === 'verified' && !!c.expires_at && c.expires_at >= today,
      ) ?? null
    );
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.note.set('');
        this.error.set('');
        this.errors.set({});
      });
    });
  }

  protected err(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected clearErr(key: string): void {
    if (!this.errors()[key]) return;
    this.errors.update((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  protected submit(): void {
    if (this.saving() || !this.licence()) return;
    const note = this.note().trim();
    if (!note) {
      this.errors.set({ note: 'Add a note saying why the suspension is lifted.' });
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.api
      .reinstate(this.detail().profile.id, note)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.reinstated.emit(res.data);
          this.closed.emit();
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.errors.set(apiErrorFields(err));
          this.error.set(apiErrorMessage(err, 'Could not reinstate this doctor.'));
        },
      });
  }

  protected day(ymd: string | null): string {
    return calendarDay(ymd);
  }
}
