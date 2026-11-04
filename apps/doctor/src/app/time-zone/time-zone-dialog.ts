import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  NgZone,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  DoctorApi,
  isValidTimeZone,
  zoneAbbr,
  zoneLongName,
} from '@supadoc/data-access';
import type { DoctorTimeZoneResultDto } from '@supadoc/models';
import { ButtonComponent, DialogComponent, IconComponent, TimeZonePickerComponent } from '@supadoc/ui';
import { DoctorClock } from '../doctor-clock';

/** How long the "Time zone changed…" note stays up. */
const TOAST_MS = 7_000;

/**
 * The note after a save: "Time zone changed to Central Time (CST)." plus how
 * many open times and blocks moved (and couldn't), only when non-zero.
 */
export function timeZoneSavedText(result: Pick<DoctorTimeZoneResultDto, 'timezone' | 'shifted'>, at: Date = new Date()): string {
  const tz = result.timezone;
  let text = `Time zone changed to ${zoneLongName(tz, at)} (${zoneAbbr(tz, at)}).`;
  const moved = result.shifted?.moved ?? 0;
  const skipped = result.shifted?.skipped ?? 0;
  if (moved > 0) text += ` Moved ${moved} open times and blocks.`;
  if (skipped > 0) text += ` ${skipped} couldn't be moved (booked, already passed, or another time is already there).`;
  return text;
}

/**
 * "Time zone" — the doctor chooses the zone their weekly hours, availability,
 * schedule and emails use (`PUT /doctor/timezone`, source `manual`). When the
 * choice differs, an opt-in checkbox also moves their future unbooked open
 * times and blocks so they keep the same clock times. Opened from My Profile,
 * the Availability caption and the time-zone banner; after a save it says so
 * in a short status note (rendered here, so every host shows it).
 */
@Component({
  selector: 'doc-time-zone-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogComponent, IconComponent, TimeZonePickerComponent],
  host: { class: 'contents' },
  template: `
    <sd-dialog [open]="open()" title="Time zone" size="md" [busy]="busy()" (closed)="close()">
      <div class="flex flex-col gap-4">
        <sd-time-zone-picker
          [id]="pickerId"
          label="Your time zone"
          menu="inline"
          [value]="choice()"
          [invalid]="fieldError()"
          (valueChange)="choose($event)"
        />
        @if (changing(); as tz) {
          <p class="font-sans text-body-sm text-ink">
            From now on your weekly hours, availability, schedule and emails use {{ tz.long }} ({{ tz.abbr }}).
            Booked consultations keep their times.
          </p>
          <label class="flex cursor-pointer items-start gap-3 rounded-field border border-haze bg-glacier px-3 py-3">
            <input
              type="checkbox"
              class="mt-0.5 size-4 shrink-0 accent-cerulean"
              [checked]="shift()"
              (change)="shift.set($any($event.target).checked)"
            />
            <span class="font-sans text-body-sm text-ink">
              Also move my unbooked open times and blocks so they keep the same clock times (9:00 AM stays 9:00 AM).
            </span>
          </label>
        }
        @if (error()) {
          <p class="flex items-start gap-2 rounded-field bg-alert/10 px-4 py-2 font-sans text-caption text-alert-ink" role="alert">
            <sd-icon name="circle-alert" [size]="16" class="mt-px shrink-0" />{{ error() }}
          </p>
        }
      </div>
      <div dialogFooter class="flex shrink-0 flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <sd-button variant="outline" [disabled]="busy()" (click)="close()">Cancel</sd-button>
        <sd-button [disabled]="busy() || !choice()" (click)="save()">{{ busy() ? 'Saving…' : 'Save time zone' }}</sd-button>
      </div>
    </sd-dialog>

    <!-- Always present, so the note is read out when its text arrives (a status
         region inserted together with its text is often missed). -->
    <p class="sr-only" role="status">{{ toast() }}</p>
    @if (toast()) {
      <!-- The visible note (read out by the status above). White on sage-ink is AA. -->
      <div
        class="fixed left-1/2 top-6 z-[70] flex w-[min(640px,92vw)] -translate-x-1/2 items-start gap-2.5 rounded-card bg-sage-ink px-5 py-3.5 shadow-[0_8px_30px_rgba(16,127,101,0.25)]"
        aria-hidden="true"
      >
        <sd-icon name="circle-check" [size]="20" class="mt-px shrink-0 text-white" />
        <span class="font-sans text-body-sm font-semibold text-white">{{ toast() }}</span>
      </div>
    }
  `,
})
export class DoctorTimeZoneDialog {
  private readonly api = inject(DoctorApi);
  private readonly clock = inject(DoctorClock);
  private readonly zone = inject(NgZone);

  /** Show the dialog. */
  readonly open = input(false);
  /** The zone to start on (the banner presets the device's); the current one when null. */
  readonly preset = input<string | null>(null);
  /** Closed (cancelled or saved). */
  readonly closed = output<void>();
  /** Saved: the API's answer (the clock has already taken it). */
  readonly saved = output<DoctorTimeZoneResultDto>();

  private static nextId = 0;
  protected readonly pickerId = `doc-tz-picker-${++DoctorTimeZoneDialog.nextId}`;
  protected readonly choice = signal<string | null>(null);
  protected readonly shift = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly fieldError = signal<string | null>(null);
  protected readonly toast = signal('');
  private toastTimer?: ReturnType<typeof setTimeout>;

  /** The new zone's names while it differs from the current one; null when unchanged. */
  protected readonly changing = computed(() => {
    const tz = this.choice();
    if (!tz || tz === this.current()) return null;
    return { long: zoneLongName(tz), abbr: zoneAbbr(tz) };
  });

  /** The zone the doctor has now (the profile's; never the device's for a write decision). */
  private readonly current = computed(() => this.clock.profileZone() ?? this.clock.zone());

  constructor() {
    // Each time it opens: start on the preset (or the current zone), unticked.
    effect(() => {
      if (!this.open()) return;
      const preset = this.preset();
      untracked(() => {
        this.choice.set(isValidTimeZone(preset) ? preset : this.current());
        this.shift.set(false);
        this.error.set('');
        this.fieldError.set(null);
      });
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.toastTimer));
  }

  protected choose(tz: string | null): void {
    this.choice.set(tz);
    this.fieldError.set(null);
    this.error.set('');
  }

  protected close(): void {
    if (this.busy()) return;
    this.closed.emit();
  }

  protected async save(): Promise<void> {
    const tz = this.choice();
    if (this.busy() || !tz) return;
    if (!isValidTimeZone(tz)) {
      this.fieldError.set('Choose a time zone from the list');
      return;
    }
    // Nothing to change: just close.
    if (tz === this.clock.profileZone()) {
      this.closed.emit();
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.fieldError.set(null);
    try {
      const res = await firstValueFrom(
        this.api.setTimeZone({ timezone: tz, source: 'manual', ...(this.shift() ? { shift_slots: true } : {}) }),
      );
      this.clock.apply(res.data);
      this.showToast(timeZoneSavedText(res.data));
      this.busy.set(false);
      this.saved.emit(res.data);
      this.closed.emit();
    } catch (err: unknown) {
      this.busy.set(false);
      const fields = apiErrorFields(err);
      if (fields['timezone']) this.fieldError.set(fields['timezone']);
      else this.error.set(fields['shift_slots'] || apiErrorMessage(err, 'Could not save your time zone. Try again.'));
    }
  }

  private showToast(text: string): void {
    this.toast.set(text);
    clearTimeout(this.toastTimer);
    // Outside the zone, so a showing note never holds the app "unstable".
    this.toastTimer = this.zone.runOutsideAngular(() => setTimeout(() => this.toast.set(''), TOAST_MS));
  }
}
