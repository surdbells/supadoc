import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PatientApi } from '@supadoc/data-access';
import type {
  PatientSettingsDto,
  PatientSettingsPatch,
} from '@supadoc/models';
import { ButtonComponent, IconComponent, ToggleComponent } from '@supadoc/ui';

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
  imports: [RouterLink, ButtonComponent, IconComponent, ToggleComponent],
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
          class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-6 py-10 text-center"
        >
          <sd-icon name="triangle-alert" [size]="28" class="text-alert" />
          <p class="font-sans text-body text-slate">
            We couldn't load your preferences.
          </p>
          <sd-button variant="outline" (click)="load()">Try again</sd-button>
        </div>
      } @else {
        <section class="flex flex-col gap-4">
          <h2 class="font-sans text-body font-semibold text-ink">
            Notification Types
          </h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            @for (row of types(); track row.key) {
              <div
                class="flex items-center justify-between gap-4 rounded-2xl border border-cloud bg-white px-5 py-4"
              >
                <div class="flex flex-col">
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
                class="flex items-center justify-between gap-4 rounded-2xl border border-cloud bg-white px-5 py-4"
              >
                <div class="flex flex-col">
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
            class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
          >
            {{ saveError() }}
          </p>
        }

        <div class="flex items-center justify-end gap-3">
          @if (saved()) {
            <span
              class="flex items-center gap-1.5 font-sans text-body-sm text-sage"
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
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal('');
  protected readonly dirty = signal(false);

  protected readonly types = signal<PrefRow[]>([]);
  protected readonly delivery = signal<PrefRow[]>([]);

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
    this.loadError.set(false);
    this.saveError.set('');
    this.saved.set(false);
    this.dirty.set(false);
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
    } catch {
      this.loadError.set(true);
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
      const message = (err as { message?: string })?.message;
      this.saveError.set(message ?? 'Could not save your preferences.');
    } finally {
      this.saving.set(false);
    }
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
