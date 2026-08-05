import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonComponent, IconComponent, ToggleComponent } from '@supadoc/ui';

interface PrefRow {
  readonly title: string;
  readonly sub?: string;
  checked: boolean;
}

/** Settings › Notification Preferences (Figma 896:33868). */
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

      <section class="flex flex-col gap-4">
        <h2 class="font-sans text-body font-semibold text-ink">
          Notification Types
        </h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          @for (row of types; track row.title) {
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
              <sd-toggle [(checked)]="row.checked" />
            </div>
          }
        </div>
      </section>

      <section class="flex flex-col gap-4">
        <h2 class="font-sans text-body font-semibold text-ink">
          Delivery Methods
        </h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          @for (row of delivery; track row.title) {
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
              <sd-toggle [(checked)]="row.checked" />
            </div>
          }
        </div>
      </section>

      <div class="flex justify-end gap-3">
        <sd-button variant="outline">Cancel</sd-button>
        <sd-button>Save Preferences</sd-button>
      </div>
    </div>
  `,
})
export class SettingsNotifications {
  // TODO: persist via the preferences API once available.
  protected readonly types: PrefRow[] = [
    { title: 'Appointment reminder', checked: true },
    { title: 'Consultation updates', checked: true },
    { title: 'Payment notifications', checked: true },
    { title: 'Account security alerts', checked: true },
    { title: 'Marketing announcements', checked: false },
  ];

  protected readonly delivery: PrefRow[] = [
    { title: 'SMS notifications', checked: false },
    { title: 'Push notifications', checked: true },
    {
      title: 'Email notifications',
      sub: 'sarahjohnson@gmail.com',
      checked: true,
    },
  ];
}
