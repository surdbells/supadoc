import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, ToggleComponent } from '@supadoc/ui';

interface PrefRow {
  readonly title: string;
  readonly desc: string;
  checked: boolean;
}

/** Settings › Notification Preferences (standard pattern; Figma 896:33868). */
@Component({
  selector: 'pat-settings-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, ToggleComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">
            Notification Preferences
          </h1>
          <p class="font-sans text-body text-slate">
            Manage reminders and alerts.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @for (group of groups; track group.title) {
        <section
          class="flex flex-col gap-1 rounded-card border border-cloud bg-white p-6"
        >
          <h2 class="mb-2 font-sans text-body font-semibold text-ink">
            {{ group.title }}
          </h2>
          @for (row of group.rows; track row.title) {
            <div
              class="flex items-center justify-between gap-4 border-t border-cloud py-4 first-of-type:border-t-0"
            >
              <div class="flex flex-col">
                <p class="font-sans text-body font-medium text-ink">
                  {{ row.title }}
                </p>
                <p class="font-sans text-caption text-slate">{{ row.desc }}</p>
              </div>
              <sd-toggle [(checked)]="row.checked" />
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class SettingsNotifications {
  // TODO: persist via the preferences API once available.
  protected readonly groups: { title: string; rows: PrefRow[] }[] = [
    {
      title: 'Channels',
      rows: [
        {
          title: 'Email',
          desc: 'Receive updates in your inbox',
          checked: true,
        },
        {
          title: 'Push notifications',
          desc: 'Alerts on your device',
          checked: true,
        },
        { title: 'SMS', desc: 'Text message alerts', checked: false },
      ],
    },
    {
      title: 'Activity',
      rows: [
        {
          title: 'Appointment reminders',
          desc: 'Upcoming and rescheduled consultations',
          checked: true,
        },
        {
          title: 'Consultation updates',
          desc: 'Notes and follow-ups from your doctor',
          checked: true,
        },
        {
          title: 'Payment alerts',
          desc: 'Receipts and billing activity',
          checked: true,
        },
        {
          title: 'Announcements',
          desc: 'Product news and health tips',
          checked: false,
        },
      ],
    },
  ];
}
