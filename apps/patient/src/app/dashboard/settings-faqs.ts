import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

interface Faq {
  readonly q: string;
  readonly a: string;
}

/** Settings › Help & Support › FAQs (Figma 933:19132). */
@Component({
  selector: 'pat-settings-faqs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">FAQs</h1>
          <p class="font-sans text-body text-slate">
            Everything you need to know about VideoMed
          </p>
        </div>
        <a
          routerLink="/dashboard/settings/help"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <div class="mx-auto flex w-full max-w-[820px] flex-col gap-6">
        @for (faq of faqs; track faq.q; let i = $index) {
          <div
            class="rounded-card border border-cloud bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)]"
          >
            <button
              type="button"
              class="flex w-full items-center justify-between gap-4 text-left"
              [attr.aria-expanded]="isOpen(i)"
              (click)="toggle(i)"
            >
              <span class="font-sans text-body font-semibold text-ink">{{
                faq.q
              }}</span>
              <sd-icon
                [name]="isOpen(i) ? 'minus' : 'plus'"
                [size]="20"
                class="shrink-0 text-slate"
              />
            </button>
            @if (isOpen(i)) {
              <p class="mt-4 font-sans text-body-sm text-slate">{{ faq.a }}</p>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class SettingsFaqs {
  private readonly openSet = signal(new Set<number>([0, 1, 2, 3]));

  protected isOpen(i: number): boolean {
    return this.openSet().has(i);
  }

  protected toggle(i: number): void {
    this.openSet.update((set) => {
      const next = new Set(set);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  protected readonly faqs: Faq[] = [
    {
      q: 'How do I reschedule an appointment?',
      a: 'Open the appointment from the dashboard, tap Reschedule, and pick a new time.',
    },
    {
      q: 'Can I share records with my doctor?',
      a: 'Yes — from Records, tap Share and choose the specialist. Access expires after 14 days.',
    },
    {
      q: 'How is my data protected?',
      a: 'All health data is encrypted at rest and in transit. See Privacy & Security for details.',
    },
    {
      q: 'What happens if I miss a call?',
      a: 'Your specialist will retry twice, then send you a rescheduling link.',
    },
  ];
}
