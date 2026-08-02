import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

interface Faq {
  readonly q: string;
  readonly a: string;
}

interface Contact {
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
  readonly action: string;
}

/** Settings › Help & Support (standard pattern; Figma 933:19132). */
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
            Contact support &amp; browse FAQs.
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

      <!-- Search -->
      <span
        class="flex items-center gap-2 rounded-field border border-cloud bg-white px-4 py-3"
      >
        <sd-icon name="search" [size]="20" class="text-slate" />
        <input
          type="search"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
          placeholder="Search for help"
          class="w-full bg-transparent font-sans text-body text-ink placeholder:text-slate/70 focus:outline-none"
        />
      </span>

      <!-- Contact cards -->
      <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
        @for (c of contacts; track c.title) {
          <div
            class="flex flex-col items-start gap-3 rounded-card border border-cloud bg-white p-6"
          >
            <span
              class="flex size-11 items-center justify-center rounded-full bg-frost text-cerulean"
            >
              <sd-icon [name]="c.icon" [size]="22" />
            </span>
            <div class="flex flex-col">
              <p class="font-sans text-body font-semibold text-ink">
                {{ c.title }}
              </p>
              <p class="font-sans text-caption text-slate">{{ c.desc }}</p>
            </div>
            <span class="font-sans text-body-sm font-medium text-cerulean">{{
              c.action
            }}</span>
          </div>
        }
      </div>

      <!-- FAQ -->
      <section
        class="flex flex-col rounded-card border border-cloud bg-white p-6"
      >
        <h2 class="mb-2 font-sans text-body font-semibold text-ink">
          Frequently asked questions
        </h2>
        @for (faq of filteredFaqs(); track faq.q; let i = $index) {
          <div class="border-t border-cloud first-of-type:border-t-0">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-4 py-4 text-left"
              [attr.aria-expanded]="open() === i"
              (click)="toggle(i)"
            >
              <span class="font-sans text-body font-medium text-ink">{{
                faq.q
              }}</span>
              <sd-icon
                name="chevron-down"
                [size]="18"
                class="shrink-0 text-slate transition-transform"
                [class.rotate-180]="open() === i"
              />
            </button>
            @if (open() === i) {
              <p class="pb-4 font-sans text-body-sm text-slate">{{ faq.a }}</p>
            }
          </div>
        }
        @if (filteredFaqs().length === 0) {
          <p class="py-4 font-sans text-body-sm text-slate">
            No results — try a different search or contact support.
          </p>
        }
      </section>
    </div>
  `,
})
export class SettingsHelp {
  protected readonly query = signal('');
  protected readonly open = signal<number | null>(0);

  protected toggle(i: number): void {
    this.open.update((cur) => (cur === i ? null : i));
  }

  protected readonly contacts: Contact[] = [
    {
      icon: 'mail',
      title: 'Email support',
      desc: 'support@videomed.com',
      action: 'Send an email',
    },
    {
      icon: 'message-square',
      title: 'Live chat',
      desc: 'Typically replies in minutes',
      action: 'Start a chat',
    },
    {
      icon: 'phone',
      title: 'Call us',
      desc: 'Mon–Fri, 9am–6pm',
      action: '+1 (800) 555-0199',
    },
  ];

  private readonly faqs: Faq[] = [
    {
      q: 'How do I book a consultation?',
      a: 'Go to Find a Specialist, choose a doctor, and tap Book Consultation to pick a time that works for you.',
    },
    {
      q: 'How do I join my video consultation?',
      a: 'Open the appointment from your dashboard or Appointments and tap Join Call a few minutes before it starts.',
    },
    {
      q: 'Can I reschedule or cancel an appointment?',
      a: 'Yes — open the appointment details and use Reschedule Appointment or Cancel Appointment.',
    },
    {
      q: 'How are payments and refunds handled?',
      a: 'Consultations are charged to your wallet or card. Refunds for cancelled visits are returned to your original payment method.',
    },
    {
      q: 'Is my medical information secure?',
      a: 'Your data is encrypted in transit and at rest, and is only shared with the clinicians you consult.',
    },
  ];

  protected filteredFaqs(): Faq[] {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.faqs;
    return this.faqs.filter(
      (f) => f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q),
    );
  }
}
