import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { apiErrorFields, apiErrorMessage, PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionCheckResult } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent, LogoComponent } from '@supadoc/ui';

type MatchResult = Extract<PrescriptionCheckResult, { result: 'match' }>;

/** Per-device id the API uses to lock out repeated misses from one device. */
const DEVICE_KEY = 'videomed.rxcheck.device';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** GVM-RX-YYYYMMDD-NNNNN */
const NUMBER_PATTERN = /^GVM-RX-\d{8}-\d{5}$/;

const MATCH_STATUS: Record<
  MatchResult['status'],
  { label: string; icon: string; card: string; badge: string }
> = {
  active: {
    label: 'Valid — can be dispensed',
    icon: 'circle-check',
    card: 'border-success/40 bg-white',
    badge: 'bg-success/10 text-success',
  },
  expired: {
    label: 'Expired — do not dispense',
    icon: 'hourglass',
    card: 'border-warning/60 bg-white',
    badge: 'bg-warning/15 text-ink',
  },
  cancelled: {
    label: 'Cancelled — do not dispense',
    icon: 'circle-x',
    card: 'border-alert/40 bg-white',
    badge: 'bg-alert/10 text-alert',
  },
};

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "4 Oct 2026" — `YYYY-MM-DD` read as a local calendar date (no UTC shift). */
function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return isNaN(d.getTime()) ? '—' : DATE_FMT.format(d);
}

/** Uppercase, no spaces — how the number is printed. */
function normaliseNumber(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '');
}

function newDeviceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }
}

/**
 * Public pharmacist check (GVM-RX-02 Part G) — printed at the bottom of every
 * prescription PDF. A pharmacist enters the prescription number and the
 * patient's date of birth; the page answers with the status, date sent, doctor
 * and MDCN number only — never the medicines or any patient details. No
 * sign-in. Repeated misses from one device lock it for a while (server-side).
 */
@Component({
  selector: 'pat-check-prescription',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AlertComponent, ButtonComponent, IconComponent, LogoComponent],
  host: { class: 'flex min-h-screen flex-col bg-glacier' },
  template: `
    <!-- Header -->
    <header class="sticky top-0 z-30 border-b border-cloud/70 bg-white/90 backdrop-blur">
      <div
        class="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-4 sm:px-5 md:px-8"
      >
        <a routerLink="/" aria-label="VideoMed home"><sd-logo [size]="30" /></a>
        <span class="flex items-center gap-1.5 font-sans text-body-sm text-slate">
          <sd-icon name="shield-check" [size]="16" class="text-teal" />
          For pharmacists
        </span>
      </div>
    </header>

    <main class="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-5 sm:py-12">
      <div class="flex flex-col items-center gap-3 text-center">
        <span
          class="flex size-14 items-center justify-center rounded-full bg-frost/60 text-cerulean"
          aria-hidden="true"
        >
          <sd-icon name="search-check" [size]="28" />
        </span>
        <h1 class="font-heading text-h2 text-abyss">Check a prescription</h1>
        <p class="font-sans text-body text-slate">
          Enter the prescription number and the patient’s date of birth. No sign-in
          is needed.
        </p>
      </div>

      <form
        class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-5 shadow-[0_4px_24px_rgba(10,22,40,0.06)] sm:p-6"
        novalidate
        (submit)="submit($event)"
      >
        <div class="flex flex-col gap-2">
          <label for="rx-check-number" class="font-sans text-body font-semibold text-ink">
            Prescription number
          </label>
          <input
            id="rx-check-number"
            name="number"
            type="text"
            inputmode="text"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            maxlength="40"
            placeholder="GVM-RX-20261004-00027"
            [value]="number()"
            [class]="fieldClass(!!numberError())"
            [attr.aria-invalid]="numberError() ? 'true' : null"
            [attr.aria-describedby]="numberError() ? 'rx-check-number-error' : 'rx-check-number-hint'"
            (input)="onNumberInput($event)"
          />
          @if (numberError()) {
            <p
              id="rx-check-number-error"
              class="flex items-center gap-1.5 font-sans text-caption text-alert"
            >
              <sd-icon name="circle-alert" [size]="14" class="shrink-0" />
              {{ numberError() }}
            </p>
          } @else {
            <p id="rx-check-number-hint" class="font-sans text-caption text-slate">
              Printed at the top of the prescription. It starts with GVM-RX.
            </p>
          }
        </div>

        <div class="flex flex-col gap-2">
          <label for="rx-check-dob" class="font-sans text-body font-semibold text-ink">
            Patient’s date of birth
          </label>
          <input
            id="rx-check-dob"
            name="date_of_birth"
            type="date"
            autocomplete="off"
            min="1900-01-01"
            [max]="today"
            [value]="dob()"
            [class]="fieldClass(!!dobError())"
            [attr.aria-invalid]="dobError() ? 'true' : null"
            [attr.aria-describedby]="dobError() ? 'rx-check-dob-error' : null"
            (input)="onDobInput($event)"
            (change)="onDobInput($event)"
          />
          @if (dobError()) {
            <p
              id="rx-check-dob-error"
              class="flex items-center gap-1.5 font-sans text-caption text-alert"
            >
              <sd-icon name="circle-alert" [size]="14" class="shrink-0" />
              {{ dobError() }}
            </p>
          }
        </div>

        @if (formError()) {
          <sd-alert tone="error">{{ formError() }}</sd-alert>
        }

        <sd-button type="submit" [full]="true" [disabled]="checking()">
          <sd-icon
            [name]="checking() ? 'loader-circle' : 'search-check'"
            [size]="18"
            class="inline-flex"
            [class.animate-spin]="checking()"
          />
          {{ checking() ? 'Checking…' : 'Check prescription' }}
        </sd-button>
      </form>

      <!-- Result -->
      <div aria-live="polite" aria-atomic="true">
        @if (result(); as r) {
          @switch (r.result) {
            @case ('match') {
              @if (match(); as m) {
                <section
                  class="flex flex-col gap-5 rounded-card border-2 p-5 sm:p-6"
                  [class]="matchStatus().card"
                  aria-labelledby="rx-check-result"
                >
                  <div class="flex flex-col gap-3">
                    <span class="font-sans text-caption text-slate">Result for {{ m.number }}</span>
                    <h2
                      id="rx-check-result"
                      class="inline-flex w-fit items-center gap-2 rounded-lg px-3 py-1.5 font-sans text-body-lg font-semibold"
                      [class]="matchStatus().badge"
                    >
                      <sd-icon [name]="matchStatus().icon" [size]="22" class="shrink-0" />
                      {{ matchStatus().label }}
                    </h2>
                  </div>
                  <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div class="flex flex-col gap-1">
                      <dt class="font-sans text-caption text-slate">Date sent</dt>
                      <dd class="font-sans text-body font-semibold text-ink">{{ date(m.sent_at) }}</dd>
                    </div>
                    <div class="flex flex-col gap-1">
                      <dt class="font-sans text-caption text-slate">Valid until</dt>
                      <dd class="font-sans text-body font-semibold text-ink">
                        {{ date(m.valid_until) }}
                      </dd>
                    </div>
                    <div class="flex flex-col gap-1">
                      <dt class="font-sans text-caption text-slate">Doctor’s name</dt>
                      <dd class="break-words font-sans text-body font-semibold text-ink">
                        {{ m.doctor || 'Not provided' }}
                      </dd>
                    </div>
                    <div class="flex flex-col gap-1">
                      <dt class="font-sans text-caption text-slate">MDCN number</dt>
                      <dd class="break-words font-sans text-body font-semibold text-ink">
                        {{ m.mdcn_number || 'Not provided' }}
                      </dd>
                    </div>
                  </dl>
                  <p
                    class="flex items-start gap-2 rounded-field bg-glacier px-3 py-2.5 font-sans text-body-sm text-ink"
                  >
                    <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
                    <span>
                      This page never shows the medicines or any patient details.
                      Record what you dispense in the pharmacy box on the paper copy.
                    </span>
                  </p>
                </section>
              }
            }
            @case ('no_match') {
              <sd-alert tone="warning">
                <span class="block font-semibold text-ink">
                  No matching prescription. Check the number and date of birth.
                </span>
                @if (attemptsLeft(); as left) {
                  <span class="mt-1 block text-ink">
                    {{ left }} {{ left === 1 ? 'try' : 'tries' }} left before this device
                    is locked for a while.
                  </span>
                }
              </sd-alert>
            }
            @case ('locked') {
              <sd-alert tone="error">
                Too many checks that did not match. You can try again at
                {{ retryAt() }}.
              </sd-alert>
            }
          }
        }
      </div>
    </main>

    <footer class="border-t border-cloud bg-white">
      <div
        class="mx-auto flex max-w-[1280px] flex-col items-center gap-1 px-4 py-5 text-center sm:px-5 md:px-8"
      >
        <p class="font-sans text-caption text-slate">
          VideoMed — trusted healthcare, wherever you are.
        </p>
        <p class="font-sans text-caption text-slate">
          Patients: <a routerLink="/auth/login" class="text-cerulean hover:underline">sign in</a>
          to see your prescriptions.
        </p>
      </div>
    </footer>
  `,
})
export class CheckPrescription {
  private readonly api = inject(PrescriptionsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** Latest selectable date of birth (local today). */
  protected readonly today = localIsoDate(new Date());

  protected readonly number = signal('');
  protected readonly dob = signal('');
  protected readonly numberError = signal('');
  protected readonly dobError = signal('');
  protected readonly formError = signal('');
  protected readonly checking = signal(false);
  protected readonly result = signal<PrescriptionCheckResult | null>(null);

  private deviceId: string | null = null;

  protected readonly match = computed<MatchResult | null>(() => {
    const r = this.result();
    return r && r.result === 'match' ? r : null;
  });

  protected readonly matchStatus = computed(() => {
    const m = this.match();
    return MATCH_STATUS[m?.status ?? 'cancelled'] ?? MATCH_STATUS.cancelled;
  });

  protected readonly attemptsLeft = computed(() => {
    const r = this.result();
    return r && r.result === 'no_match' && r.attempts_left > 0 ? r.attempts_left : 0;
  });

  /** Lock-out end in local time — "HH:MM", with the date when it isn't today. */
  protected readonly retryAt = computed(() => {
    const r = this.result();
    if (!r || r.result !== 'locked') return '';
    const at = new Date(r.retry_at);
    if (isNaN(at.getTime())) return 'a later time';
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return localIsoDate(at) === localIsoDate(new Date()) ? time : `${time} on ${DATE_FMT.format(at)}`;
  });

  constructor() {
    // Optional prefill (e.g. a scanned link): ?number=GVM-RX-…
    const pre = this.route.snapshot.queryParamMap.get('number');
    if (pre) this.number.set(normaliseNumber(pre).slice(0, 40));
  }

  protected date(value: string | null): string {
    return formatDate(value);
  }

  protected fieldClass(invalid: boolean): string {
    const border = invalid
      ? 'border-alert focus:border-alert focus:ring-alert/20'
      : 'border-[#b8c6d4] hover:border-slate/50 focus:border-cerulean focus:ring-cerulean/20';
    return (
      'w-full rounded-field border bg-white px-4 py-3.5 font-sans text-body text-ink ' +
      'placeholder:text-slate/60 shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 ' +
      'focus:outline-none focus:ring-2 ' +
      border
    );
  }

  /** Auto-uppercase and strip spaces as the pharmacist types, keeping the caret in place. */
  protected onNumberInput(event: Event): void {
    const el = event.target as HTMLInputElement;
    const raw = el.value;
    const cleaned = normaliseNumber(raw);
    if (cleaned !== raw) {
      const caret = el.selectionStart ?? raw.length;
      const pos = normaliseNumber(raw.slice(0, caret)).length;
      el.value = cleaned;
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        /* some input types don't support selection */
      }
    }
    this.number.set(cleaned);
    this.numberError.set('');
    this.formError.set('');
    this.result.set(null);
  }

  protected onDobInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (value === this.dob()) return;
    this.dob.set(value);
    this.dobError.set('');
    this.formError.set('');
    this.result.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.checking()) return;

    const number = normaliseNumber(this.number());
    const dob = this.dob().trim();
    this.number.set(number);
    this.formError.set('');
    this.result.set(null);

    let ok = true;
    if (!number) {
      this.numberError.set('Enter the prescription number.');
      ok = false;
    } else if (!NUMBER_PATTERN.test(number)) {
      this.numberError.set(
        'Enter the number exactly as printed, for example GVM-RX-20261004-00027.',
      );
      ok = false;
    } else {
      this.numberError.set('');
    }
    if (!dob) {
      this.dobError.set('Enter the patient’s date of birth.');
      ok = false;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      this.dobError.set('Enter a full date of birth (day, month and year).');
      ok = false;
    } else if (dob > this.today) {
      this.dobError.set('The date of birth can’t be in the future.');
      ok = false;
    } else {
      this.dobError.set('');
    }
    if (!ok) return;

    this.checking.set(true);
    this.api
      .check(number, dob, this.getDeviceId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.checking.set(false);
          const r = res.data;
          if (r && (r.result === 'match' || r.result === 'no_match' || r.result === 'locked')) {
            this.result.set(r);
          } else {
            this.formError.set("We couldn't check the prescription. Please try again.");
          }
        },
        error: (err: unknown) => {
          this.checking.set(false);
          const fields = apiErrorFields(err);
          if (fields['number']) this.numberError.set(fields['number']);
          if (fields['date_of_birth']) this.dobError.set(fields['date_of_birth']);
          if (!fields['number'] && !fields['date_of_birth']) {
            this.formError.set(
              apiErrorMessage(err, "We couldn't check the prescription. Please try again."),
            );
          }
        },
      });
  }

  /** Read (or create and remember) this device's id; storage may be unavailable. */
  private getDeviceId(): string {
    if (this.deviceId) return this.deviceId;
    let id: string | null = null;
    try {
      const stored = localStorage.getItem(DEVICE_KEY);
      if (stored && DEVICE_ID_PATTERN.test(stored)) id = stored;
    } catch {
      id = null;
    }
    if (!id) {
      id = newDeviceId();
      try {
        localStorage.setItem(DEVICE_KEY, id);
      } catch {
        /* private mode / blocked storage — the id lasts for this visit */
      }
    }
    this.deviceId = id;
    return id;
  }
}
