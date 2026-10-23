import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IconComponent } from '@supadoc/ui';

export const WHY_CARDS = [
  { icon: 'calendar-clock', title: 'Flexible Schedule', body: 'Consult from anywhere, set your own availability.' },
  {
    icon: 'shield-check',
    title: 'Secured & Trusted',
    body: 'Licensed, encrypted, and built to protect your practice and patient data.',
  },
  { icon: 'target', title: 'Real Impact', body: 'Reach patients who need you most, across the globe.' },
] as const;

/** "Why Join VideoMed" (Figma 1.3): three cards, 1 column below 768px, 2 at 768–1023px. */
@Component({
  selector: 'onb-landing-why',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block bg-snow' },
  template: `
    <section class="mx-auto max-w-[1280px] px-4 pb-16 pt-14 md:px-8 lg:pb-24 lg:pt-[72px] xl:px-0" aria-labelledby="onb-why-title">
      <h2 id="onb-why-title" class="text-center font-heading text-[26px] font-semibold leading-8 text-ink lg:text-h2">
        Why Join <span class="text-cerulean">Video</span><span class="text-teal">Med</span>
      </h2>
      <p class="mx-auto mt-4 max-w-[700px] text-center font-sans text-[17px] leading-[26px] text-slate lg:text-[20px] lg:leading-7">
        Expand your practice beyond the clinic. Consult, earn, and impact more lives — on your own schedule.
      </p>
      <ul class="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2 lg:mt-12 lg:grid-cols-3 lg:gap-8">
        @for (card of cards; track card.title) {
          <li class="flex flex-col items-center rounded-[24px] border border-haze bg-white px-6 pb-8 pt-8 text-center lg:min-h-[240px]">
            <span class="inline-flex size-14 items-center justify-center rounded-full bg-haze text-cerulean" aria-hidden="true">
              <sd-icon [name]="card.icon" [size]="32" [strokeWidth]="1.5" />
            </span>
            <h3 class="mt-4 font-sans text-[22px] font-medium leading-8 text-ink lg:text-[24px]">{{ card.title }}</h3>
            <p class="mt-4 max-w-[300px] font-sans text-body text-slate lg:mt-6">{{ card.body }}</p>
          </li>
        }
      </ul>
    </section>
  `,
})
export class LandingWhyComponent {
  protected readonly cards = WHY_CARDS;
}
