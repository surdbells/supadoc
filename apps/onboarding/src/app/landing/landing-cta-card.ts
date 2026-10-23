import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * "Ready to make a difference?" (Figma 1.4 CTA): a translucent card that
 * straddles the checklist band and the footer, painted above the illustration.
 */
@Component({
  selector: 'onb-landing-cta-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  host: { class: 'relative z-10 mx-auto block w-full max-w-[443px]' },
  template: `
    <section
      class="flex flex-col items-center rounded-card border border-haze bg-white/40 px-6 pb-4 pt-5 text-center shadow-[0_4px_8px_rgba(21,101,192,0.2)] backdrop-blur-sm"
      aria-labelledby="onb-cta-title"
    >
      <h2 id="onb-cta-title" class="font-sans text-[24px] font-semibold leading-8 text-ink">Ready to make a difference?</h2>
      <p class="mt-3.5 font-sans text-body text-slate">
        Join thousands of specialists who trust VideoMed to deliver quality care.
      </p>
      <a
        routerLink="/apply"
        class="mt-10 inline-flex h-12 w-full max-w-[243px] items-center justify-center rounded-field bg-cerulean px-6 font-sans text-body-sm font-medium text-white shadow-btn transition-colors hover:bg-cerulean-dark hover:shadow-btn-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
      >
        Apply Now
      </a>
    </section>
  `,
})
export class LandingCtaCardComponent {}
