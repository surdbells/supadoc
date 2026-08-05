import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

interface Channel {
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
  readonly link?: string;
  readonly href?: string;
}

/** Settings › Help & Support (Figma 932:18890) — pick a support channel. */
@Component({
  selector: 'pat-settings-help',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Help &amp; Support</h1>
          <p class="font-sans text-body text-slate">
            Around the clock - pick a channel
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

      <div class="flex flex-col gap-4">
        @for (c of channels; track c.title) {
          <a
            [routerLink]="c.link ?? null"
            [href]="c.href ?? null"
            class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5 transition-colors hover:border-cerulean/50"
          >
            <span
              class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean"
            >
              <sd-icon [name]="c.icon" [size]="22" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col">
              <p class="font-sans text-body font-semibold text-ink">
                {{ c.title }}
              </p>
              <p class="font-sans text-caption text-slate">{{ c.desc }}</p>
            </div>
            <sd-icon
              name="chevron-right"
              [size]="20"
              class="shrink-0 text-slate"
            />
          </a>
        }
      </div>
    </div>
  `,
})
export class SettingsHelp {
  protected readonly channels: Channel[] = [
    {
      icon: 'circle-help',
      title: 'FAQs',
      desc: 'Common questions answered',
      link: '/dashboard/settings/help/faqs',
    },
    {
      icon: 'headphones',
      title: 'Contact Support',
      desc: 'Reply within 2 hours',
      href: 'mailto:support@videomed.com',
    },
    {
      icon: 'message-square',
      title: 'Live chat',
      desc: 'Chat with a care specialist',
      href: '#',
    },
  ];
}
