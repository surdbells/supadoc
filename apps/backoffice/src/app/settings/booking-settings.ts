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
import { apiErrorFields, apiErrorMessage, SettingsApi } from '@supadoc/data-access';
import type { BookingSettingsDto } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';

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

/** Mirrors the API's BookingSettings ranges (enforced server-side too). */
const RULES: readonly Rule[] = [
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
];

type FormValues = Record<Key, string>;

function toForm(s: Partial<BookingSettingsDto>): FormValues {
  const out = {} as FormValues;
  for (const r of RULES) out[r.key] = String(s[r.key] ?? r.fallback);
  return out;
}

const FIELD_ID = (key: Key) => `bo-booking-${key}`;

/**
 * Booking rules on the Settings page (needs `settings.manage`): how far ahead
 * patients may book, the minimum notice, and when a calendar day shows
 * "few left". Changes apply to every booking calendar straight away.
 */
@Component({
  selector: 'bo-booking-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent],
  template: `
    <section class="flex max-w-3xl flex-col gap-5 rounded-card border border-cloud bg-white p-5 sm:p-6" aria-labelledby="bo-booking-title">
      <div class="flex flex-col gap-1">
        <h2 id="bo-booking-title" class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
          <sd-icon name="calendar-days" [size]="20" />Booking calendar
        </h2>
        <p class="font-sans text-body-sm text-slate">Rules for when patients can book a consultation. Existing bookings are not affected.</p>
      </div>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-field" aria-hidden="true"></div>
      } @else if (loadError()) {
        <div class="flex flex-col items-start gap-3">
          <sd-alert tone="error">{{ loadError() }}</sd-alert>
          <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="load()">
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </button>
        </div>
      } @else {
        <form class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); save()">
          <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
            @for (r of rules; track r.key) {
              <div class="flex min-w-0 flex-col gap-1.5">
                <label [for]="fieldId(r.key)" class="font-sans text-caption font-semibold text-slate">{{ r.label }}</label>
                <div
                  class="flex items-stretch overflow-hidden rounded-field border bg-white transition-colors focus-within:ring-2"
                  [class]="errorFor(r.key) ? 'border-alert focus-within:ring-alert/20' : 'border-cloud focus-within:border-cerulean focus-within:ring-cerulean/20'"
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
                    class="min-h-11 w-full min-w-0 flex-1 bg-transparent px-4 py-2.5 font-sans text-body-sm text-ink focus:outline-none"
                    (input)="setValue(r.key, $any($event.target).value)"
                  />
                  <span class="flex shrink-0 items-center border-l border-cloud bg-glacier px-3 font-sans text-caption text-slate">{{ r.unit }}</span>
                </div>
                @if (errorFor(r.key); as msg) {
                  <p [id]="fieldId(r.key) + '-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
                    <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
                  </p>
                }
                <p [id]="fieldId(r.key) + '-hint'" class="font-sans text-caption text-slate">
                  {{ r.hint }}
                  <span class="block text-slate/80">Allowed {{ range(r) }}. Standard: {{ r.fallback }} {{ r.unit }}.</span>
                </p>
              </div>
            }
          </div>

          <div aria-live="polite">
            @if (notice(); as n) {
              <sd-alert [tone]="noticeOk() ? 'success' : 'error'">{{ n }}</sd-alert>
            }
          </div>

          <div class="flex flex-col-reverse gap-3 border-t border-cloud pt-5 sm:flex-row sm:items-center sm:justify-end">
            @if (dirty()) {
              <button type="button" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-cloud px-5 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:border-cerulean hover:text-cerulean disabled:opacity-60" [disabled]="saving()" (click)="discard()">
                <sd-icon name="undo-2" [size]="18" />Undo changes
              </button>
            }
            <button type="submit" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="saving() || !dirty()">
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
  private readonly destroyRef = inject(DestroyRef);

  protected readonly rules = RULES;
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
          const form = toForm(res.data);
          this.saved.set(form);
          this.values.set({ ...form });
          this.fieldErrors.set({});
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
    return `${r.min.toLocaleString('en-GB')}–${r.max.toLocaleString('en-GB')} ${r.unit}`;
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

  protected discard(): void {
    const saved = this.saved();
    if (!saved) return;
    this.values.set({ ...saved });
    this.fieldErrors.set({});
    this.notice.set('');
  }

  protected save(): void {
    const saved = this.saved();
    if (this.saving() || !saved) return;
    this.notice.set('');
    const errors: Record<string, string> = {};
    const patch: Partial<BookingSettingsDto> = {};
    const now = this.values();
    for (const r of RULES) {
      const raw = now[r.key].trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < r.min || n > r.max) {
        errors[r.key] = `Enter a whole number from ${this.range(r)}.`;
      } else if (raw !== saved[r.key]) {
        patch[r.key] = n;
      }
    }
    this.fieldErrors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.noticeOk.set(false);
      this.notice.set('Please fix the highlighted boxes, then save again.');
      return;
    }
    this.saving.set(true);
    this.api
      .updateBookingSettings(patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const form = toForm(res.data);
          this.saved.set(form);
          this.values.set({ ...form });
          this.fieldErrors.set({});
          this.noticeOk.set(true);
          this.notice.set('Booking rules saved. Every booking calendar uses them from now on.');
          this.saving.set(false);
        },
        error: (err: unknown) => {
          this.fieldErrors.set(apiErrorFields(err));
          this.noticeOk.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not save the booking rules.'));
          this.saving.set(false);
        },
      });
  }
}
