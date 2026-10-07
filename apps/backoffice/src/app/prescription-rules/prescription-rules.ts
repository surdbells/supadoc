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
import {
  apiErrorFields,
  apiErrorMessage,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type { PrescriptionSettingsDto } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';

type RuleKey = keyof PrescriptionSettingsDto;

interface RuleField {
  readonly key: RuleKey;
  readonly label: string;
  /** Shown beside the box, e.g. "days". */
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly hint: string;
}

interface RuleGroup {
  readonly title: string;
  readonly icon: string;
  readonly fields: readonly RuleField[];
}

/** Mirrors the API's PrescriptionSettings::RULES (ranges are enforced server-side too). */
const GROUPS: readonly RuleGroup[] = [
  {
    title: 'Validity and reminders',
    icon: 'calendar-days',
    fields: [
      {
        key: 'valid_days',
        label: 'Default validity',
        unit: 'days',
        min: 1,
        max: 365,
        fallback: 30,
        hint: 'How long a new prescription stays valid. Doctors can still change the date on each prescription.',
      },
      {
        key: 'reminder_days',
        label: 'Expiry reminder',
        unit: 'days before expiry',
        min: 1,
        max: 30,
        fallback: 3,
        hint: 'When we remind the patient that a prescription is about to expire.',
      },
    ],
  },
  {
    title: 'Pharmacist check page',
    icon: 'search-check',
    fields: [
      {
        key: 'check_max_attempts',
        label: 'Wrong tries before lock',
        unit: 'tries',
        min: 3,
        max: 20,
        fallback: 5,
        hint: 'How many wrong number or date-of-birth entries are allowed before the check page locks.',
      },
      {
        key: 'check_lock_minutes',
        label: 'Lock length',
        unit: 'minutes',
        min: 1,
        max: 1440,
        fallback: 15,
        hint: 'How long the check page stays locked after too many wrong tries (1,440 minutes is 24 hours).',
      },
    ],
  },
  {
    title: 'Prescription files',
    icon: 'file-down',
    fields: [
      {
        key: 'link_minutes',
        label: 'Download link lifetime',
        unit: 'minutes',
        min: 1,
        max: 60,
        fallback: 15,
        hint: 'How long a link to view or download a prescription PDF keeps working.',
      },
    ],
  },
];

const ALL_FIELDS: readonly RuleField[] = GROUPS.flatMap((g) => g.fields);

type FormValues = Record<RuleKey, string>;

function toForm(s: PrescriptionSettingsDto): FormValues {
  const out = {} as FormValues;
  for (const f of ALL_FIELDS) out[f.key] = String(s[f.key] ?? f.fallback);
  return out;
}

/**
 * Prescription rules (route `/prescription-rules`, needs `settings.manage`) —
 * the GVM-RX-02 ground rules a Platform Admin can change without a release.
 */
@Component({
  selector: 'bo-prescription-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Prescription rules</h1>
        <p class="font-sans text-body text-slate">
          Platform-wide rules for every prescription doctors send. Changes apply straight away — no release needed.
        </p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-96 max-w-3xl rounded-card"></div>
      } @else if (loadError()) {
        <div class="flex max-w-3xl flex-col items-center gap-3 rounded-card border border-cloud bg-white px-6 py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
          <button
            type="button"
            class="flex items-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
            (click)="load()"
          >
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </button>
        </div>
      } @else {
        <form
          class="flex max-w-3xl flex-col gap-6 rounded-card border border-cloud bg-white p-5 sm:p-6"
          novalidate
          (submit)="$event.preventDefault(); save()"
        >
          <div class="flex flex-col gap-1">
            <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
              <sd-icon name="scroll-text" [size]="20" />Current rules
            </h2>
            <p class="font-sans text-body-sm text-slate">
              Each box shows the allowed range and the standard setting. Prescriptions already sent keep their own dates.
            </p>
          </div>

          @for (g of groups; track g.title; let gi = $index) {
            <div role="group" [attr.aria-labelledby]="'rx-rule-group-' + gi" class="flex flex-col gap-4 border-t border-cloud pt-5">
              <h3 [id]="'rx-rule-group-' + gi" class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
                <sd-icon [name]="g.icon" [size]="18" class="text-slate" />{{ g.title }}
              </h3>
              <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
                @for (f of g.fields; track f.key) {
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <label [for]="'rx-rule-' + f.key" class="font-sans text-caption font-semibold text-slate">
                      {{ f.label }}
                    </label>
                    <div
                      class="flex items-stretch overflow-hidden rounded-field border bg-white transition-colors focus-within:ring-2"
                      [class]="errorFor(f.key) ? 'border-alert focus-within:ring-alert/20' : 'border-cloud focus-within:border-cerulean focus-within:ring-cerulean/20'"
                    >
                      <input
                        [id]="'rx-rule-' + f.key"
                        type="number"
                        inputmode="numeric"
                        step="1"
                        [min]="f.min"
                        [max]="f.max"
                        [value]="values()[f.key]"
                        [attr.aria-invalid]="errorFor(f.key) ? 'true' : null"
                        [attr.aria-describedby]="'rx-rule-' + f.key + '-hint' + (errorFor(f.key) ? ' rx-rule-' + f.key + '-error' : '')"
                        class="w-full min-w-0 flex-1 bg-transparent px-4 py-3 font-sans text-body-sm text-ink focus:outline-none"
                        (input)="setValue(f.key, $any($event.target).value)"
                      />
                      <span class="flex shrink-0 items-center border-l border-cloud bg-glacier px-3 font-sans text-caption text-slate">
                        {{ f.unit }}
                      </span>
                    </div>
                    @if (errorFor(f.key); as msg) {
                      <p [id]="'rx-rule-' + f.key + '-error'" class="flex items-start gap-1.5 font-sans text-caption text-alert">
                        <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}
                      </p>
                    }
                    <p [id]="'rx-rule-' + f.key + '-hint'" class="font-sans text-caption text-slate">
                      {{ f.hint }}
                      <span class="block text-slate/80">
                        Allowed {{ range(f) }}. Standard: {{ f.fallback }} {{ f.unit }}.
                      </span>
                    </p>
                  </div>
                }
              </div>
            </div>
          }

          @if (notice(); as n) {
            <sd-alert [tone]="noticeOk() ? 'success' : 'error'">{{ n }}</sd-alert>
          }

          <div class="flex flex-col-reverse gap-3 border-t border-cloud pt-5 sm:flex-row sm:items-center sm:justify-end">
            @if (dirty()) {
              <button
                type="button"
                class="flex items-center justify-center gap-2 rounded-field border border-cloud px-5 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:border-cerulean hover:text-cerulean disabled:opacity-60"
                [disabled]="saving()"
                (click)="discard()"
              >
                <sd-icon name="undo-2" [size]="18" />Undo changes
              </button>
            }
            <button
              type="submit"
              class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
              [disabled]="saving() || !dirty()"
            >
              @if (saving()) {
                <sd-icon name="loader-circle" [size]="18" class="animate-spin" />Saving…
              } @else {
                <sd-icon name="save" [size]="18" />Save rules
              }
            </button>
          </div>
        </form>
      }
    </div>
  `,
})
export class AdminPrescriptionRules implements OnInit {
  private readonly api = inject(PrescriptionsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly groups = GROUPS;

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);

  /** The values last confirmed by the server (null until loaded). */
  private readonly saved = signal<FormValues | null>(null);
  protected readonly values = signal<FormValues>(
    toForm({} as PrescriptionSettingsDto),
  );
  /** Field errors: the server's (by key) merged with the local range check. */
  protected readonly fieldErrors = signal<Record<string, string>>({});

  protected readonly dirty = computed(() => {
    const saved = this.saved();
    if (!saved) return false;
    const now = this.values();
    return ALL_FIELDS.some((f) => now[f.key].trim() !== saved[f.key]);
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.notice.set('');
    this.api
      .settings()
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
          // Never fall through to a form pre-filled with the standard values —
          // saving that would silently overwrite the real rules.
          this.loadError.set(apiErrorMessage(err, 'Could not load the prescription rules.'));
          this.loading.set(false);
        },
      });
  }

  protected errorFor(key: RuleKey): string {
    return this.fieldErrors()[key] ?? '';
  }

  protected range(f: RuleField): string {
    const fmt = (n: number) => n.toLocaleString('en-GB');
    return `${fmt(f.min)}–${fmt(f.max)} ${f.unit}`;
  }

  protected setValue(key: RuleKey, raw: string): void {
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
    if (this.saving() || !this.saved()) return;
    this.notice.set('');

    const errors: Record<string, string> = {};
    const patch: Partial<PrescriptionSettingsDto> = {};
    const now = this.values();
    for (const f of ALL_FIELDS) {
      const raw = now[f.key].trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
        errors[f.key] = `Enter a whole number from ${this.range(f)}.`;
      } else {
        patch[f.key] = n;
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
      .updateSettings(patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const form = toForm(res.data);
          this.saved.set(form);
          this.values.set({ ...form });
          this.fieldErrors.set({});
          this.noticeOk.set(true);
          this.notice.set('Prescription rules saved. They apply to new prescriptions and links from now on.');
          this.saving.set(false);
        },
        error: (err: unknown) => {
          this.fieldErrors.set(apiErrorFields(err));
          this.noticeOk.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not save the prescription rules.'));
          this.saving.set(false);
        },
      });
  }
}
