import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LogoComponent } from '@supadoc/ui';

/** Landing header (Figma 1.1): the logo, and Log In → the doctor portal's sign-in. */
@Component({
  selector: 'onb-landing-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LogoComponent, RouterLink],
  host: { class: 'block bg-white' },
  template: `
    <header class="mx-auto flex h-20 max-w-[1280px] items-center justify-between px-4 md:px-8 lg:h-28 xl:px-0">
      <a routerLink="/" aria-label="VideoMed, home" class="inline-flex rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2">
        <sd-logo [size]="48" />
      </a>
      <a
        [href]="loginUrl()"
        class="inline-flex h-12 items-center justify-center rounded-field bg-cerulean px-6 font-sans text-body-sm font-medium text-white shadow-btn transition-colors hover:bg-cerulean-dark hover:shadow-btn-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
      >
        Log In
      </a>
    </header>
  `,
})
export class LandingHeaderComponent {
  readonly loginUrl = input.required<string>();
}
