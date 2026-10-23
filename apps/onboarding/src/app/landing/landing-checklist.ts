import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IconComponent } from '@supadoc/ui';

export const CHECKLIST = [
  {
    title: 'Valid Medical Licence',
    text: "MDCN registration number and current practising licence (abroad: your regulator's licence and a Certificate of Good Standing issued within 6 months).",
  },
  {
    title: 'Proof of Identity',
    text: "Government-issued ID (NIN, international passport or driver's licence).",
  },
  { title: 'Professional Credentials', text: 'Medical degree certificate (MBBS / MBChB).' },
  { title: 'Professional Profile', text: 'CV / résumé, years of experience and specialisation.' },
  { title: 'Professional Indemnity', text: 'Proof of current indemnity cover.' },
] as const;

/**
 * "Requirement Checklist" (Figma 1.4) on the Haze band: five items with Sage
 * ticks, the illustration on the right (above it below 1024px), and the CTA
 * card projected in at the bottom so it can straddle the band and the footer.
 */
@Component({
  selector: 'onb-landing-checklist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block bg-haze' },
  template: `
    <section class="mx-auto max-w-[1280px] px-4 pt-12 md:px-8 xl:px-0" aria-labelledby="onb-checklist-title">
      <h2 id="onb-checklist-title" class="text-center font-heading text-[26px] font-semibold leading-8 text-ink lg:text-h2">
        Requirement Checklist
      </h2>
      <p class="mx-auto mt-4 max-w-[640px] text-center font-sans text-[17px] leading-[26px] text-slate lg:text-[20px] lg:leading-7">
        We verify every doctor to maintain trust and quality. Please have these ready.
      </p>
      <div class="mt-10 flex flex-col gap-10 lg:mt-12 lg:flex-row lg:items-start lg:justify-between">
        <ul class="flex flex-col gap-6 lg:mt-6 lg:max-w-[560px]">
          @for (item of items; track item.title) {
            <li class="flex items-start gap-2">
              <sd-icon name="check-check" [size]="24" [strokeWidth]="1.5" class="mt-0.5 shrink-0 text-sage" />
              <span class="flex flex-col gap-1">
                <span class="font-sans text-[18px] font-medium leading-7 text-ink lg:text-[20px]">{{ item.title }}</span>
                <span class="font-sans text-body-sm text-ink/80">{{ item.text }}</span>
              </span>
            </li>
          }
        </ul>
        <img
          src="images/join-checklist.webp"
          alt=""
          width="1000"
          height="664"
          loading="lazy"
          class="mx-auto h-auto w-full max-w-[500px] lg:mx-0 lg:mr-[10px] lg:w-[500px]"
        />
      </div>
      <ng-content />
    </section>
  `,
})
export class LandingChecklistComponent {
  protected readonly items = CHECKLIST;
}
