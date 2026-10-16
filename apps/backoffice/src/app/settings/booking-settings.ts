import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { tap } from 'rxjs';
import { apiErrorFields, apiErrorMessage, SettingsApi } from '@supadoc/data-access';
import type { BookingSettingsDto } from '@supadoc/models';
import type { ConfirmDetail } from '@supadoc/ui';
import { AlertComponent, DialogService, IconComponent } from '@supadoc/ui';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_ERROR,
  FIELD_GROUP_INPUT,
  FIELD_STACK,
  HINT,
  LABEL,
  SECTION,
  SECTION_SUBTITLE,
  SECTION_TITLE,
  SUBSECTION_TITLE,
} from '../shared/layout';

type Key = keyof BookingSettingsDto;

interface Rule {
  readonly key: Key;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly hint: string;
}

interface RuleGroup {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly intro: string;
  readonly rules: readonly Rule[];
}

/** Mirrors the API's BookingSettings ranges and defaults (enforced server-side too). */
const GROUPS: readonly RuleGroup[] = [
  {
    id: 'calendar',
    title: 'Booking calendar',
    icon: 'calendar-days',
    intro: 'When patients can book a consultation. Existing bookings are not affected.',
    rules: [
      {
        key: 'horizon_days',
        label: 'How far ahead patients can book',
        unit: 'days',
        min: 7,
        max: 180,
        fallback: 60,
        hint: 'The booking calendar ends here. Staff and doctors can still book or reschedule further out.',
      },
      {
        key: 'lead_minutes',
        label: 'Minimum notice',
        unit: 'minutes',
        min: 15,
        max: 1440,
        fallback: 60,
        hint: 'The earliest a new booking can start, counted from now (1,440 minutes is 24 hours).',
      },
      {
        key: 'few_left',
        label: '“Few left” at',
        unit: 'open times or fewer',
        min: 1,
        max: 10,
        fallback: 3,
        hint: 'A day with this many open times or fewer is marked “few left” on the calendar.',
      },
    ],
  },
  {
    id: 'closing',
    title: 'Closing past consultations',
    icon: 'history',
    intro: 'An automatic check closes consultations that have ended, so none stays open — or holds the patient’s money — forever.',
    rules: [
      {
        key: 'missed_after_hours',
        label: 'Close a consultation after',
        unit: 'hours after its end',
        min: 1,
        max: 168,
        fallback: 12,
        hint: 'It closes as completed when there is proof it took place; otherwise a confirmed one is marked missed, unless both sides joined but nothing proves it took place; those wait for staff. The wait gives the doctor time to finish their notes.',
      },
      {
        key: 'unconfirmed_expiry_minutes_after_end',
        label: 'Cancel unconfirmed requests',
        unit: 'minutes after the end',
        min: 0,
        max: 1440,
        fallback: 0,
        hint: "A request the doctor never confirmed is cancelled this long after its end, and anything paid is refunded in full. It's never sooner than 30 minutes, while the doctor can still confirm it, so 0–30 all mean 30 minutes. A request both sides joined is left for staff.",
      },
    ],
  },
  {
    id: 'noshow',
    title: 'Missed consultations',
    icon: 'calendar-x',
    intro: 'Refunds when someone didn’t come. A doctor no-show always refunds the patient in full, and guest fees always go back.',
    rules: [
      {
        key: 'noshow_patient_refund_pct',
        label: 'Patient didn’t join — refund',
        unit: '%',
        min: 0,
        max: 100,
        fallback: 0,
        hint: 'The doctor was there. The share of the consultation fee that goes back to the patient; the doctor earns the rest.',
      },
      {
        key: 'noshow_both_refund_pct',
        label: 'Neither joined — refund',
        unit: '%',
        min: 0,
        max: 100,
        fallback: 0,
        hint: 'The share of the consultation fee that goes back to the patient. The doctor earns nothing.',
      },
      {
        key: 'doctor_noshow_alert_threshold',
        label: 'Alert staff when a doctor misses',
        unit: 'consultations in 30 days',
        min: 1,
        max: 20,
        fallback: 2,
        hint: 'Staff who manage specialists are alerted when a doctor has missed this many consultations within 30 days.',
      },
    ],
  },
  {
    id: 'late',
    title: 'Late cancellation',
    icon: 'clock',
    intro: 'Patients can cancel until the start. Pending requests always refund in full — the doctor hadn’t committed.',
    rules: [
      {
        key: 'late_cancel_hours',
        label: 'Late window',
        unit: 'hours before the start',
        min: 0,
        max: 168,
        fallback: 0,
        hint: 'Cancelling a confirmed consultation within this many hours of its start refunds the share below. 0 turns it off: a full refund until the start.',
      },
      {
        key: 'late_cancel_refund_pct',
        label: 'Late cancellation — refund',
        unit: '%',
        min: 0,
        max: 100,
        fallback: 100,
        hint: 'The share of the consultation fee refunded inside the late window (guest fees always go back).',
      },
    ],
  },
];

const RULES: readonly Rule[] = GROUPS.flatMap((g) => g.rules);

type FormValues = Record<Key, string>;

function toForm(s: Partial<BookingSettingsDto>): FormValues {
  const out = {} as FormValues;
  for (const r of RULES) out[r.key] = String(s[r.key] ?? r.fallback);
  return out;
}

const FIELD_ID = (key: Key) => `bo-booking-${key}`;

/** "12 hours after its end", "30%". */
function withUnit(n: number | string, unit: string): string {
  const v = typeof n === 'number' ? n.toLocaleString('en-GB') : n;
  return unit === '%' ? `${v}%` : `${v} ${unit}`;
}

/**
 * Booking rules on the Settings page (needs `settings.manage`): the booking
 * calendar (how far ahead, minimum notice, "few left"), how past
 * consultations close, the no-show refunds and the late-cancellation window.
 * Saving shows what changes and asks first — these rules move money.
 */
@Component({
  selector: 'bo-booking-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent],
  template: `
    <section class="${SECTION}" aria-labelledby="bo-booking-title">
      <div class="flex flex-col gap-1">
        <h2 id="bo-booking-title" class="${SECTION_TITLE}">
          <sd-icon name="calendar-days" [size]="20" class="text-cerulean" />Booking rules
        </h2>
        <p class="${SECTION_SUBTITLE}">Rules for booking, cancelling and closing consultations. Changes apply from now on.</p>
      </div>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-field" aria-hidden="true"></div>
      } @else if (loadError()) {
        <div class="flex flex-col items-start gap-3">
          <sd-alert tone="error">{{ loadError() }}</sd-alert>
          <button type="button" class="${BTN_SECONDARY}" (click)="load()">
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </button>
        </div>
      } @else {
        <form class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); save()">
          @for (g of groups; track g.id; let first = $first) {
            <div role="group" [attr.aria-labelledby]="'bo-booking-group-' + g.id" class="flex flex-col gap-4" [class.border-t]="!first" [class.border-cloud]="!first" [class.pt-5]="!first">
              <div class="flex flex-col gap-1">
                <h3 [id]="'bo-booking-group-' + g.id" class="${SUBSECTION_TITLE}">
                  <sd-icon [name]="g.icon" [size]="18" class="text-cerulean" />{{ g.title }}
                </h3>
                <p class="font-sans text-caption text-slate">{{ g.intro }}</p>
              </div>
              <div class="grid grid-cols-1 items-start gap-5 sm:grid-cols-2">
                @for (r of g.rules; track r.key) {
                  <div class="${FIELD_STACK}">
                    <label [for]="fieldId(r.key)" class="${LABEL}">{{ r.label }}</label>
                    <div
                      class="flex items-stretch overflow-hidden rounded-field border bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-colors focus-within:ring-2"
                      [class]="errorFor(r.key) ? 'border-alert focus-within:ring-alert/20' : 'border-[#b8c6d4] focus-within:border-cerulean focus-within:ring-cerulean/20'"
                    >
                      <input
                        [id]="fieldId(r.key)"
                        type="number"
                        inputmode="numeric"
                        step="1"
                        [min]="r.min"
                        [max]="r.max"
                        [value]="values()[r.key]"
                        [attr.aria-invalid]="errorFor(r.key) ? 'true' : null"
                        [attr.aria-describedby]="fieldId(r.key) + '-hint' + (errorFor(r.key) ? ' ' + fieldId(r.key) + '-error' : '')"
                        class="${FIELD_GROUP_INPUT}"
                        (input)="setValue(r.key, $any($event.target).value)"
                      />
                      <span class="flex max-w-[55%] shrink-0 items-center border-l border-cloud bg-glacier px-3 font-sans text-caption text-slate">{{ r.unit }}</span>
                    </div>
                    @if (errorFor(r.key); as msg) {
                      <p [id]="fieldId(r.key) + '-error'" class="${FIELD_ERROR}">
                        <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
                      </p>
                    }
                    <p [id]="fieldId(r.key) + '-hint'" class="${HINT}">
                      {{ r.hint }}
                      <span class="block text-slate/80">Allowed {{ range(r) }}. Standard: {{ standard(r) }}.</span>
                    </p>
                  </div>
                }
              </div>
            </div>
          }

          <div aria-live="polite">
            @if (notice(); as n) {
              <sd-alert [tone]="noticeOk() ? 'success' : 'error'">{{ n }}</sd-alert>
            }
          </div>

          <div class="flex flex-col-reverse gap-3 border-t border-cloud pt-5 sm:flex-row sm:items-center sm:justify-end">
            @if (dirty()) {
              <button type="button" class="${BTN_SECONDARY}" [disabled]="saving()" (click)="discard()">
                <sd-icon name="undo-2" [size]="18" />Undo changes
              </button>
            }
            <button type="submit" class="${BTN_PRIMARY}" [disabled]="saving() || !dirty()">
              @if (saving()) {
                <sd-icon name="loader-circle" [size]="18" class="animate-spin" />Saving…
              } @else {
                <sd-icon name="save" [size]="18" />Save booking rules
              }
            </button>
          </div>
        </form>
      }
    </section>
  `,
})
export class BookingSettingsSection implements OnInit {
  private readonly api = inject(SettingsApi);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly groups = GROUPS;
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);
  private readonly saved = signal<FormValues | null>(null);
  protected readonly values = signal<FormValues>(toForm({}));
  protected readonly fieldErrors = signal<Record<string, string>>({});

  protected readonly dirty = computed(() => {
    const saved = this.saved();
    if (!saved) return false;
    const now = this.values();
    return RULES.some((r) => now[r.key].trim() !== saved[r.key]);
  });

  /** For the Settings page's leave guard: edits that aren't saved yet. */
  hasUnsavedChanges(): boolean {
    return this.dirty();
  }

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.notice.set('');
    this.api
      .getBookingSettings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.accept(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          // Never fall back to a form of standard values — saving it would overwrite the real rules.
          this.loadError.set(apiErrorMessage(err, 'Could not load the booking rules.'));
          this.loading.set(false);
        },
      });
  }

  protected fieldId(key: Key): string {
    return FIELD_ID(key);
  }

  protected errorFor(key: Key): string {
    return this.fieldErrors()[key] ?? '';
  }

  protected range(r: Rule): string {
    return r.unit === '%' ? `${r.min}–${r.max}%` : `${r.min.toLocaleString('en-GB')}–${withUnit(r.max, r.unit)}`;
  }

  protected standard(r: Rule): string {
    return withUnit(r.fallback, r.unit);
  }

  protected setValue(key: Key, raw: string): void {
    this.values.update((v) => ({ ...v, [key]: raw }));
    this.notice.set('');
    if (this.fieldErrors()[key]) {
      this.fieldErrors.update((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
    }
  }

  protected async discard(): Promise<void> {
    const saved = this.saved();
    if (!saved) return;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'undo-2',
      title: 'Discard changes?',
      message: 'Your edits to the booking rules will be lost.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
    if (!confirmed) return;
    this.values.set({ ...saved });
    this.fieldErrors.set({});
    this.notice.set('');
  }

  protected async save(): Promise<void> {
    const saved = this.saved();
    if (this.saving() || !saved) return;
    this.notice.set('');
    const errors: Record<string, string> = {};
    const patch: Partial<BookingSettingsDto> = {};
    const changes: ConfirmDetail[] = [];
    const now = this.values();
    for (const r of RULES) {
      const raw = now[r.key].trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < r.min || n > r.max) {
        errors[r.key] = `Enter a whole number from ${this.range(r)}.`;
      } else if (raw !== saved[r.key]) {
        patch[r.key] = n;
        changes.push({ label: r.label, value: `${withUnit(saved[r.key], r.unit)} → ${withUnit(n, r.unit)}` });
      }
    }
    this.fieldErrors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.noticeOk.set(false);
      this.notice.set('Please fix the highlighted boxes, then save again.');
      return;
    }
    if (changes.length === 0) return;
    const request = this.api.updateBookingSettings(patch).pipe(
      tap({
        next: (res) => this.accept(res.data),
        // Highlight the boxes the API refused; the dialog shows the message.
        error: (err: unknown) => this.fieldErrors.set(apiErrorFields(err)),
      }),
      takeUntilDestroyed(this.destroyRef),
    );
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'save',
      title: 'Save the booking rules?',
      message: 'They apply from now on — to every booking calendar, to cancellations, and to consultations the automatic check closes from now on. Consultations already closed keep their outcome.',
      details: changes,
      confirmLabel: 'Save rules',
      cancelLabel: 'Keep editing',
      size: 'md',
      busyLabel: 'Saving…',
      errorMessage: (err) => apiErrorMessage(err, 'Could not save the booking rules.'),
      action: () => request,
    });
    if (confirmed) {
      this.noticeOk.set(true);
      this.notice.set('Booking rules saved. They apply from now on.');
    }
  }

  private accept(data: BookingSettingsDto): void {
    const form = toForm(data);
    this.saved.set(form);
    this.values.set({ ...form });
    this.fieldErrors.set({});
  }
}
