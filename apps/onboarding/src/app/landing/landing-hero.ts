import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

/**
 * Landing hero (Figma 1.2): badge, "Join VideoMed as a Doctor", the subhead
 * and body, Apply Now / Check Application Status, and the resume link; the
 * doctor photo on the right (stacked under the text below 1024px).
 */
@Component({
  selector: 'onb-landing-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink],
  host: { class: 'block' },
  template: `
    <section
      class="relative overflow-hidden bg-[radial-gradient(circle_at_100%_100%,#DBF2F7_0%,transparent_50%),linear-gradient(180deg,#F7FAFC_0%,#F2F8FC_45%,#DDEFFE_100%)]"
      aria-labelledby="onb-hero-title"
    >
      <div class="relative mx-auto flex max-w-[1280px] flex-col px-4 pb-10 pt-10 md:px-8 lg:min-h-[641px] lg:flex-row lg:items-center lg:py-0 xl:px-0">
        <div class="relative z-10 max-w-[750px] lg:max-w-[520px] lg:py-[102px] xl:max-w-[750px]">
          <p class="inline-flex rounded border border-haze bg-white px-2 py-1 font-sans text-caption text-cerulean">
            Trusted by thousands of patients
          </p>
          <h1 id="onb-hero-title" class="mt-2.5 font-heading text-[32px] font-bold leading-[1.25] text-ink sm:text-[44px] lg:text-[48px] lg:leading-[62px] xl:text-[56px] xl:leading-[73px]">
            Join <span class="text-cerulean">Video</span><span class="text-teal">Med</span> as&nbsp;a
            <span class="block text-ocean">Doctor</span>
          </h1>
          <p class="mt-6 font-heading text-[22px] font-semibold leading-[30px] text-ink lg:text-[28px] lg:leading-9">
            Expand your reach, make a bigger impact.
          </p>
          <p class="mt-4 font-sans text-[17px] leading-[26px] text-ink lg:text-[20px] lg:leading-7">
            Be part of a tested telehealth platform, connect with more patients and deliver quality care from anywhere.
          </p>
          <div class="mt-8 flex flex-col gap-4 sm:flex-row lg:mt-12">
            <a routerLink="/apply" [class]="applyClass">
              Apply Now
              <sd-icon name="arrow-right" [size]="24" [strokeWidth]="1.5" />
            </a>
            <button type="button" [class]="trackClass" (click)="checkStatus.emit()">Check Application Status</button>
          </div>
          <button
            type="button"
            class="mt-3 rounded font-sans text-body-sm text-cerulean hover:text-cerulean-dark hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 sm:mt-2"
            (click)="resumeApplication.emit()"
          >
            Already started? Resume your application
          </button>
        </div>
        <div class="relative mx-auto mt-10 w-full max-w-md lg:absolute lg:-right-10 lg:top-[18px] lg:mt-0 lg:w-[440px] lg:max-w-none xl:w-[564px]">
          <img
            src="images/join-hero.webp"
            alt=""
            width="1128"
            height="1230"
            class="h-auto w-full"
            fetchpriority="high"
          />
        </div>
      </div>
    </section>
  `,
})
export class LandingHeroComponent {
  readonly checkStatus = output<void>();
  readonly resumeApplication = output<void>();

  protected readonly applyClass =
    'inline-flex h-12 items-center justify-center gap-3 rounded-field bg-cerulean px-7 font-sans text-body-sm font-medium text-white shadow-btn transition-colors hover:bg-cerulean-dark hover:shadow-btn-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2';
  protected readonly trackClass =
    'inline-flex h-12 items-center justify-center rounded-field border border-ash bg-white px-4 font-sans text-body-sm text-slate transition-colors hover:border-cerulean/40 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2';
}
