import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  detectTimeZone,
  PatientApi,
  viewerTimeZone,
  zoneAbbr,
} from '@supadoc/data-access';
import type {
  PatientSettingsDto,
  PatientSettingsPatch,
  TimeZoneSource,
} from '@supadoc/models';
import { ButtonComponent, IconComponent, TimeZonePickerComponent, ToggleComponent } from '@supadoc/ui';

interface PrefRow {
  readonly key: string;
  readonly title: string;
  sub?: string;
  checked: boolean;
}

/** Settings › Notification Preferences (Figma 896:33868). Persisted via /portal/me/settings. */
@Component({
  selector: 'pat-settings-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, IconComponent, TimeZonePickerComponent, ToggleComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">
            Notification Preferences
          </h1>
          <p class="font-sans text-body text-slate">
            Choose what you're notified about, and how.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @if (loading()) {
        <div class="flex flex-col gap-4">
          @for (i of [1, 2, 3, 4]; track i) {
            <div class="h-[68px] animate-pulse rounded-2xl bg-cloud/70"></div>
          }
        </div>
      } @else if (loadError()) {
        <div
          class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-6 py-10 text-center shadow-card"
        >
          <sd-icon name="triangle-alert" [size]="28" class="text-alert" />
          <p class="font-sans text-body text-slate">
            {{ loadError() }}
          </p>
          <sd-button variant="outline" (click)="load()">Try again</sd-button>
        </div>
      } @else {
        <!-- The zone the patient's emails, texts and notices are written in (D7):
             the app itself always shows this device's time. -->
        <section
          class="flex flex-col gap-4 rounded-2xl border border-haze bg-white px-5 py-5 shadow-card"
          aria-labelledby="tz-card-title"
        >
          <h2 id="tz-card-title" class="flex items-center gap-2 font-sans text-body font-semibold text-ink">
            <sd-icon name="globe" [size]="18" class="shrink-0 text-cerulean" />Time zone
          </h2>
          <sd-time-zone-picker
            id="patient-time-zone"
            label="Time zone for emails and reminders"
            [hint]="tzHint()"
            [invalid]="tzInvalid()"
            [(value)]="tzValue"
          />
          @if (tzUndetected()) {
            <p class="flex items-start gap-2 font-sans text-caption text-slate" data-testid="tz-undetected">
              <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
              We couldn't detect your time zone; we're using West Africa Time (WAT) for now.
            </p>
          }
          <p class="sr-only" aria-live="polite" aria-atomic="true">{{ tzLive() }}</p>
          @if (tzError()) {
            <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert-ink" role="alert">
              {{ tzError() }}
            </p>
          }
          <div class="flex flex-wrap items-center justify-end gap-3">
            @if (tzSaved()) {
              <span class="flex items-center gap-1.5 font-sans text-body-sm text-success-ink">
                <sd-icon name="check" [size]="18" />
                Time zone saved.
              </span>
            }
            <sd-button [disabled]="tzSaving() || !tzDirty()" (click)="saveTimeZone()">
              {{ tzSaving() ? 'Saving…' : 'Save time zone' }}
            </sd-button>
          </div>
        </section>

        <section class="flex flex-col gap-4">
          <h2 class="font-sans text-body font-semibold text-ink">
            Notification Types
          </h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            @for (row of types(); track row.key) {
              <div
                class="flex items-center justify-between gap-4 rounded-2xl border border-haze bg-white px-5 py-4 shadow-card"
              >
                <div class="flex min-w-0 flex-col">
                  <span class="font-sans text-body text-ink">{{
                    row.title
                  }}</span>
                  @if (row.sub) {
                    <span class="font-sans text-caption text-slate">{{
                      row.sub
                    }}</span>
                  }
                </div>
                <sd-toggle
                  [checked]="row.checked"
                  (checkedChange)="onToggle(row, $event)"
                />
              </div>
            }
          </div>
        </section>

        <section class="flex flex-col gap-4">
          <h2 class="font-sans text-body font-semibold text-ink">
            Delivery Methods
          </h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            @for (row of delivery(); track row.key) {
              <div
                class="flex items-center justify-between gap-4 rounded-2xl border border-haze bg-white px-5 py-4 shadow-card"
              >
                <div class="flex min-w-0 flex-col">
                  <span class="font-sans text-body text-ink">{{
                    row.title
                  }}</span>
                  @if (row.sub) {
                    <span class="font-sans text-caption text-slate">{{
                      row.sub
                    }}</span>
                  }
                </div>
                <sd-toggle
                  [checked]="row.checked"
                  (checkedChange)="onToggle(row, $event)"
                />
              </div>
            }
          </div>
        </section>

        @if (saveError()) {
          <p
            class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert-ink"
          >
            {{ saveError() }}
          </p>
        }

        <div class="flex items-center justify-end gap-3">
          @if (saved()) {
            <span
              class="flex items-center gap-1.5 font-sans text-body-sm text-success-ink"
            >
              <sd-icon name="check" [size]="18" />
              Saved
            </span>
          }
          <sd-button
            variant="outline"
            [disabled]="saving() || !dirty()"
            (click)="load()"
            >Cancel</sd-button
          >
          <sd-button [disabled]="saving() || !dirty()" (click)="save()">
            {{ saving() ? 'Saving…' : 'Save Preferences' }}
          </sd-button>
        </div>
      }
    </div>
  `,
})
export class SettingsNotifications {
  private readonly patients = inject(PatientApi);

  protected readonly loading = signal(true);
  /** Why the preferences failed to load ('' when they didn't). */
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal('');
  protected readonly dirty = signal(false);

  protected readonly types = signal<PrefRow[]>([]);
  protected readonly delivery = signal<PrefRow[]>([]);

  // ----- Time zone (emails, texts and notices; D7) -----
  /** What the API has (the effective zone, and whether it was ever set). */
  private readonly tzSavedValue = signal<string | null>(null);
  private readonly tzSource = signal<TimeZoneSource | null | undefined>(undefined);
  /** The picker's choice. */
  protected readonly tzValue = signal<string | null>(null);
  protected readonly tzSaving = signal(false);
  protected readonly tzSaved = signal(false);
  protected readonly tzError = signal('');
  protected readonly tzInvalid = signal<string | null>(null);
  protected readonly tzLive = signal('');
  /**
   * Something to save: a different zone, or — never set (`timezone_source` null) —
   * confirming the one shown (Africa/Lagos, say) as the patient's own choice, so
   * detection on another device can never replace it (D8).
   */
  protected readonly tzDirty = computed(
    () => !!this.tzValue() && (this.tzValue() !== this.tzSavedValue() || this.tzSource() === null),
  );
  /** Never set, and this device's zone can't be detected (UTC behind a VPN, say). */
  protected readonly tzUndetected = computed(() => this.tzSource() === null && detectTimeZone() === null);
  protected readonly tzHint = computed(
    () =>
      `Used for the times in your emails, texts and notifications. The app always shows times in this device's time zone (${zoneAbbr(viewerTimeZone())}).`,
  );

  private static readonly TYPE_LABELS: Record<string, string> = {
    appointment_reminder: 'Appointment reminder',
    consultation_updates: 'Consultation updates',
    payment_notifications: 'Payment notifications',
    account_security_alerts: 'Account security alerts',
    marketing_announcements: 'Marketing announcements',
  };
  private static readonly DELIVERY_LABELS: Record<string, string> = {
    sms: 'SMS notifications',
    push: 'Push notifications',
    email: 'Email notifications',
  };

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    this.saveError.set('');
    this.saved.set(false);
    this.dirty.set(false);
    this.tzSaved.set(false);
    this.tzError.set('');
    this.tzInvalid.set(null);
    try {
      const [settingsRes, meRes] = await Promise.all([
        firstValueFrom(this.patients.settings()),
        firstValueFrom(this.patients.me()),
      ]);
      const s = settingsRes.data;
      this.types.set(
        this.rows(s.notifications, SettingsNotifications.TYPE_LABELS),
      );
      const delivery = this.rows(
        s.delivery,
        SettingsNotifications.DELIVERY_LABELS,
      );
      // Show the real address under the email row instead of a placeholder.
      const emailRow = delivery.find((r) => r.key === 'email');
      if (emailRow && meRes.data.email) emailRow.sub = meRes.data.email;
      this.delivery.set(delivery);
      this.applyTimeZone(meRes.data.timezone ?? null, meRes.data.timezone_source);
    } catch (err) {
      this.loadError.set(apiErrorMessage(err, "We couldn't load your preferences."));
    } finally {
      this.loading.set(false);
    }
  }

  private rows(
    group: Record<string, boolean>,
    labels: Record<string, string>,
  ): PrefRow[] {
    return Object.keys(labels).map((key) => ({
      key,
      title: labels[key],
      checked: !!group[key],
    }));
  }

  protected onToggle(row: PrefRow, checked: boolean): void {
    row.checked = checked;
    this.dirty.set(true);
    this.saved.set(false);
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.saveError.set('');
    const patch: PatientSettingsPatch = {
      notifications: this.toMap(
        this.types(),
      ) as PatientSettingsPatch['notifications'],
      delivery: this.toMap(
        this.delivery(),
      ) as PatientSettingsPatch['delivery'],
    };
    try {
      const res = await firstValueFrom(this.patients.updateSettings(patch));
      this.applyResult(res.data);
      this.dirty.set(false);
      this.saved.set(true);
    } catch (err) {
      this.saveError.set(apiErrorMessage(err, 'Could not save your preferences.'));
    } finally {
      this.saving.set(false);
    }
  }

  /** "Save time zone": the patient's own choice (`manual`), never overwritten by detection. */
  protected async saveTimeZone(): Promise<void> {
    const tz = this.tzValue();
    if (this.tzSaving() || !tz) return;
    this.tzSaving.set(true);
    this.tzError.set('');
    this.tzInvalid.set(null);
    this.tzSaved.set(false);
    this.tzLive.set('');
    try {
      const res = await firstValueFrom(this.patients.setTimeZone({ timezone: tz, source: 'manual' }));
      this.applyTimeZone(res.data.timezone, res.data.timezone_source);
      this.tzSaved.set(true);
      this.tzLive.set('Time zone saved.');
    } catch (err) {
      const field = apiErrorFields(err)['timezone'];
      if (field) this.tzInvalid.set(field);
      else this.tzError.set(apiErrorMessage(err, 'Could not save your time zone.'));
    } finally {
      this.tzSaving.set(false);
    }
  }

  private applyTimeZone(tz: string | null, source: TimeZoneSource | null | undefined): void {
    this.tzSavedValue.set(tz);
    this.tzSource.set(source);
    this.tzValue.set(tz);
  }

  private toMap(rows: PrefRow[]): Record<string, boolean> {
    return Object.fromEntries(rows.map((r) => [r.key, r.checked]));
  }

  /** Re-sync the toggles to the authoritative server response. */
  private applyResult(s: PatientSettingsDto): void {
    this.types.update((rows) =>
      rows.map((r) => ({ ...r, checked: !!s.notifications[r.key as keyof PatientSettingsDto['notifications']] })),
    );
    this.delivery.update((rows) =>
      rows.map((r) => ({ ...r, checked: !!s.delivery[r.key as keyof PatientSettingsDto['delivery']] })),
    );
  }
}
