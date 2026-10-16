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
import type { HasUnsavedChanges } from '@supadoc/auth';
import { apiErrorFields, apiErrorMessage, SettingsApi } from '@supadoc/data-access';
import type { FollowUpFeeMode, PricingDto } from '@supadoc/models';
import type { ConfirmDetail, LeaveCopy } from '@supadoc/ui';
import { AlertComponent, DialogService, IconComponent } from '@supadoc/ui';
import {
  BTN_PRIMARY,
  FIELD,
  FIELD_ERROR,
  FIELD_GROUP,
  FIELD_GROUP_INPUT,
  FIELD_INVALID,
  FIELD_STACK,
  FIELD_SUFFIX,
  HINT,
  LABEL,
  PAGE_ERROR,
  PAGE_HEADER_TEXT,
  PAGE_NARROW,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SECTION,
  SECTION_TITLE,
  SUBSECTION_TITLE,
} from '../shared/layout';

/** The form as text, to tell what changed since it was loaded or saved. */
interface PricingForm {
  currency: string;
  guestFee: string;
  platformFee: string;
  mode: FollowUpFeeMode;
  discount: string;
  windowDays: string;
}

/** The follow-up fee modes, as the API spells them. */
const FEE_MODES: { value: FollowUpFeeMode; label: string; hint: string }[] = [
  { value: 'percent', label: 'Discounted', hint: "The doctor's fee less the discount below." },
  { value: 'full', label: 'Full fee', hint: "The doctor's usual consultation fee." },
  { value: 'free', label: 'Free', hint: 'No charge — no payment step for the patient.' },
];

/** The API's defaults when a setting has never been saved. */
const DEFAULTS = { mode: 'percent' as FollowUpFeeMode, discount: 50, windowDays: 14 };
const MAX_WINDOW_DAYS = 365;

/**
 * Pricing settings (route `/pricing`) — currency, guest/platform fees, and how
 * follow-up consultations are priced: a follow-up starting within the window
 * after the consultation it follows costs the full fee, a discounted fee or
 * nothing; after the window it is the full fee. A doctor can still waive it.
 */
@Component({
  selector: 'bo-pricing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE_NARROW}">
      <header class="${PAGE_HEADER_TEXT}">
        <h1 class="${PAGE_TITLE}">Pricing</h1>
        <p class="${PAGE_SUBTITLE}">Platform-wide currency and fees.</p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-96 rounded-card" aria-hidden="true"></div>
      } @else if (loadError()) {
        <div class="${PAGE_ERROR}" role="alert">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
        </div>
      } @else {
        <section class="${SECTION}" aria-labelledby="bo-pricing-fees-title">
          <h2 id="bo-pricing-fees-title" class="${SECTION_TITLE}"><sd-icon name="banknote" [size]="20" class="text-cerulean" />Fees</h2>
          <div class="grid gap-4 sm:grid-cols-3">
            <label class="${FIELD_STACK}">
              <span class="${LABEL}">Currency</span>
              <input [value]="currency()" (input)="currency.set($any($event.target).value.toUpperCase())" maxlength="3" placeholder="NGN" class="${FIELD} uppercase" />
            </label>
            <label class="${FIELD_STACK}">
              <span class="${LABEL}">Guest fee (per invited guest)</span>
              <input type="number" min="0" step="500" [value]="guestFee()" (input)="guestFee.set($any($event.target).value)" class="${FIELD}" />
            </label>
            <label class="${FIELD_STACK}">
              <span class="${LABEL}">Platform fee</span>
              <input type="number" min="0" step="100" [value]="platformFee()" (input)="platformFee.set($any($event.target).value)" class="${FIELD}" />
            </label>
          </div>

          <!-- Follow-up consultations -->
          <div role="group" aria-labelledby="fu-pricing-title" class="flex flex-col gap-4 border-t border-cloud pt-5">
            <div class="flex flex-col gap-1">
              <h3 id="fu-pricing-title" class="${SUBSECTION_TITLE}">
                <sd-icon name="refresh-cw" [size]="18" class="text-cerulean" />Follow-up consultations
              </h3>
              <p class="font-sans text-caption text-slate">
                Applies to follow-ups a doctor proposes and ones patients book from a
                completed consultation. A doctor can always waive the fee.
              </p>
            </div>

            <div class="grid items-start gap-4 sm:grid-cols-2">
              <label class="${FIELD_STACK} sm:col-span-2">
                <span class="${LABEL}">Follow-up fee</span>
                <select
                  class="${FIELD}"
                  [class]="fieldError('follow_up_fee_mode') ? '${FIELD_INVALID}' : ''"
                  [value]="mode()"
                  [attr.aria-invalid]="fieldError('follow_up_fee_mode') ? 'true' : null"
                  aria-describedby="fu-mode-hint"
                  (change)="setMode($any($event.target).value)"
                >
                  @for (m of modes; track m.value) {
                    <option [value]="m.value" [selected]="m.value === mode()">{{ m.label }}</option>
                  }
                </select>
                @if (fieldError('follow_up_fee_mode'); as msg) {
                  <span class="${FIELD_ERROR}"><sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}</span>
                }
                <span id="fu-mode-hint" class="${HINT}">{{ modeHint() }}</span>
              </label>

              @if (mode() === 'percent') {
                <label class="${FIELD_STACK}">
                  <span class="${LABEL}">Discount</span>
                  <div class="${FIELD_GROUP}" [class]="fieldError('follow_up_discount_percent') ? '!border-alert' : ''">
                    <input
                      type="number"
                      inputmode="numeric"
                      min="0"
                      max="100"
                      step="1"
                      class="${FIELD_GROUP_INPUT}"
                      [value]="discount()"
                      [attr.aria-invalid]="fieldError('follow_up_discount_percent') ? 'true' : null"
                      aria-describedby="fu-discount-hint"
                      (input)="setField('follow_up_discount_percent', discount, $any($event.target).value)"
                    />
                    <span class="${FIELD_SUFFIX}">%</span>
                  </div>
                  @if (fieldError('follow_up_discount_percent'); as msg) {
                    <span class="${FIELD_ERROR}"><sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}</span>
                  }
                  <span id="fu-discount-hint" class="${HINT}">
                    A whole number from 0 to 100 — 50 halves the doctor's fee. Rounded down to the kobo.
                  </span>
                </label>
              }

              <label class="${FIELD_STACK}">
                <span class="${LABEL}">Follow-up window</span>
                <div class="${FIELD_GROUP}" [class]="fieldError('follow_up_window_days') ? '!border-alert' : ''">
                  <input
                    type="number"
                    inputmode="numeric"
                    min="1"
                    [max]="maxWindowDays"
                    step="1"
                    class="${FIELD_GROUP_INPUT}"
                    [value]="windowDays()"
                    [attr.aria-invalid]="fieldError('follow_up_window_days') ? 'true' : null"
                    aria-describedby="fu-window-hint"
                    (input)="setField('follow_up_window_days', windowDays, $any($event.target).value)"
                  />
                  <span class="${FIELD_SUFFIX}">days</span>
                </div>
                @if (fieldError('follow_up_window_days'); as msg) {
                  <span class="${FIELD_ERROR}"><sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ msg }}</span>
                }
                <span id="fu-window-hint" class="${HINT}">
                  Follow-up pricing applies when the follow-up starts within this many days
                  of the original consultation's start (1–{{ maxWindowDays }}); after that
                  it is the full fee.
                </span>
              </label>
            </div>

            <p class="rounded-field bg-glacier px-4 py-3 font-sans text-caption text-ink" aria-live="polite">
              <span class="font-semibold">Example:</span> {{ example() }}
            </p>
          </div>

          @if (notice()) {
            <sd-alert [tone]="noticeOk() ? 'success' : 'error'">{{ notice() }}</sd-alert>
          }

          <div class="flex flex-col gap-2 border-t border-cloud pt-5 sm:flex-row sm:items-center sm:justify-end sm:gap-4">
            @if (!dirty() && !saving()) {
              <p class="font-sans text-caption text-slate">Change a value to save.</p>
            }
            <button type="button" class="${BTN_PRIMARY} w-full sm:w-fit" [disabled]="saving() || !dirty()" (click)="save()">
              <sd-icon name="check" [size]="18" />{{ saving() ? 'Saving…' : 'Save pricing' }}
            </button>
          </div>
        </section>
      }
    </div>
  `,
})
export class AdminPricing implements OnInit, HasUnsavedChanges {
  private readonly api = inject(SettingsApi);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);

  protected readonly currency = signal('NGN');
  protected readonly guestFee = signal('0');
  protected readonly platformFee = signal('0');

  // Follow-up pricing.
  protected readonly modes = FEE_MODES;
  protected readonly maxWindowDays = MAX_WINDOW_DAYS;
  protected readonly mode = signal<FollowUpFeeMode>(DEFAULTS.mode);
  protected readonly discount = signal(String(DEFAULTS.discount));
  protected readonly windowDays = signal(String(DEFAULTS.windowDays));
  /** Field-level problems: the form's own checks, then the API's 422 `errors`. */
  private readonly errors = signal<Record<string, string>>({});
  /** The pricing as last loaded or saved (null until loaded). */
  private readonly saved = signal<PricingForm | null>(null);
  private readonly form = computed<PricingForm>(() => ({
    currency: this.currency().trim().toUpperCase(),
    guestFee: String(this.guestFee()).trim(),
    platformFee: String(this.platformFee()).trim(),
    mode: this.mode(),
    discount: String(this.discount()).trim(),
    windowDays: String(this.windowDays()).trim(),
  }));
  /** Edits that aren't saved yet. */
  protected readonly dirty = computed(() => this.changes().length > 0);
  /** What changed, old → new, for the save confirmation. */
  private readonly changes = computed<ConfirmDetail[]>(() => {
    const before = this.saved();
    if (!before) return [];
    const now = this.form();
    const out: ConfirmDetail[] = [];
    const num = (v: string) => (v === '' || isNaN(Number(v)) ? v || '—' : Number(v).toLocaleString('en-NG'));
    if (now.currency !== before.currency) out.push({ label: 'Currency', value: `${before.currency} → ${now.currency}` });
    if (Number(now.guestFee) !== Number(before.guestFee)) out.push({ label: 'Guest fee', value: `${num(before.guestFee)} → ${num(now.guestFee)}` });
    if (Number(now.platformFee) !== Number(before.platformFee)) out.push({ label: 'Platform fee', value: `${num(before.platformFee)} → ${num(now.platformFee)}` });
    if (now.mode !== before.mode) out.push({ label: 'Follow-up fee', value: `${modeLabel(before.mode)} → ${modeLabel(now.mode)}` });
    if (now.mode === 'percent' && now.discount !== before.discount) out.push({ label: 'Follow-up discount', value: `${before.discount}% → ${now.discount}%` });
    if (now.windowDays !== before.windowDays) out.push({ label: 'Follow-up window', value: `${before.windowDays} → ${now.windowDays} days` });
    return out;
  });

  /** For the route's unsavedChangesGuard. */
  hasUnsavedChanges(): boolean {
    return this.dirty() && !this.saving();
  }
  readonly leaveCopy: LeaveCopy = {
    title: 'Leave without saving the pricing?',
    message: "Your pricing changes haven't been saved. If you leave now, they'll be lost.",
  };

  protected readonly modeHint = computed(
    () => FEE_MODES.find((m) => m.value === this.mode())?.hint ?? '',
  );

  /** What a follow-up of a ₦10,000 consultation would cost under these settings. */
  protected readonly example = computed(() => {
    const days = wholeNumber(this.windowDays());
    const within = days !== null ? `within ${days} day${days === 1 ? '' : 's'}` : 'within the window';
    switch (this.mode()) {
      case 'free':
        return `a follow-up ${within} of a ₦10,000 consultation is free; later, ₦10,000.`;
      case 'full':
        return `a follow-up ${within} of a ₦10,000 consultation costs ₦10,000, the same as later.`;
      default: {
        const pct = wholeNumber(this.discount());
        if (pct === null || pct > 100) return 'enter a discount from 0 to 100.';
        const price = Math.floor(10000 * (100 - pct)) / 100;
        return `a follow-up ${within} of a ₦10,000 consultation costs ₦${price.toLocaleString('en-NG')}; later, ₦10,000.`;
      }
    }
  });

  ngOnInit(): void {
    this.api
      .getPricing()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.apply(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          // Don't fall through to a form pre-filled with defaults — saving that
          // would silently overwrite the real pricing.
          this.loadError.set(apiErrorMessage(err, 'Could not load pricing settings.'));
          this.loading.set(false);
        },
      });
  }

  protected fieldError(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected setMode(value: string): void {
    const mode = FEE_MODES.find((m) => m.value === value)?.value;
    if (mode) this.mode.set(mode);
    this.clearError('follow_up_fee_mode');
  }

  protected setField(key: string, target: { set(v: string): void }, value: string): void {
    target.set(value);
    this.clearError(key);
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const discount = wholeNumber(this.discount());
    const windowDays = wholeNumber(this.windowDays());
    // The API's rules, checked first so a typo never reaches it.
    const problems: Record<string, string> = {};
    if (this.mode() === 'percent' && (discount === null || discount > 100)) {
      problems['follow_up_discount_percent'] = 'Must be a whole number from 0 to 100';
    }
    if (windowDays === null || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
      problems['follow_up_window_days'] = `Must be a whole number of days from 1 to ${MAX_WINDOW_DAYS}`;
    }
    this.errors.set(problems);
    if (Object.keys(problems).length > 0) {
      this.noticeOk.set(false);
      this.notice.set('Fix the highlighted fields, then save again.');
      return;
    }

    this.notice.set('');
    const changes = this.changes();
    if (changes.length === 0) return;
    const request = this.api
      .updatePricing({
        currency: this.currency().trim() || 'NGN',
        guest_fee: this.guestFee(),
        platform_fee: this.platformFee(),
        follow_up_fee_mode: this.mode(),
        // Kept as it was when another mode is chosen (it only applies to percent).
        ...(discount !== null && discount <= 100 ? { follow_up_discount_percent: discount } : {}),
        follow_up_window_days: windowDays as number,
      })
      .pipe(
        tap({
          next: (res) => this.apply(res.data),
          // Highlight the fields the API refused; the dialog shows the message.
          error: (err: unknown) => this.errors.set(apiErrorFields(err)),
        }),
        takeUntilDestroyed(this.destroyRef),
      );
    // Prices are money for every new booking: show exactly what changes.
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'banknote',
      title: 'Save the new pricing?',
      message: 'New bookings and follow-up proposals use it straight away. Bookings already made keep their price.',
      details: changes,
      confirmLabel: 'Save pricing',
      cancelLabel: 'Keep editing',
      size: 'md',
      busyLabel: 'Saving…',
      errorMessage: (err) => apiErrorMessage(err, 'Could not update pricing.'),
      action: () => request,
    });
    if (confirmed) {
      this.noticeOk.set(true);
      this.notice.set('Pricing updated.');
    }
  }

  /** Fill the form from the API (an older API without the follow-up keys keeps the defaults). */
  private apply(p: PricingDto): void {
    this.currency.set(p.currency ?? this.currency() ?? 'NGN');
    this.guestFee.set(String(p.guest_fee ?? this.guestFee()));
    this.platformFee.set(String(p.platform_fee ?? this.platformFee()));
    if (p.follow_up_fee_mode) this.mode.set(p.follow_up_fee_mode);
    if (p.follow_up_discount_percent !== undefined) this.discount.set(String(p.follow_up_discount_percent));
    if (p.follow_up_window_days !== undefined) this.windowDays.set(String(p.follow_up_window_days));
    this.errors.set({});
    this.saved.set(this.form());
  }

  private clearError(key: string): void {
    if (!this.errors()[key]) return;
    this.errors.update((all) => {
      const rest = { ...all };
      delete rest[key];
      return rest;
    });
  }
}

function modeLabel(mode: FollowUpFeeMode): string {
  return FEE_MODES.find((m) => m.value === mode)?.label ?? mode;
}

/** A whole number typed into a field, or null. */
function wholeNumber(raw: string): number | null {
  const s = String(raw ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}
