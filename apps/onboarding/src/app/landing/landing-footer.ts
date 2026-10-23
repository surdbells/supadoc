import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ApplicationConfigDto } from '@supadoc/models';
import { LogoComponent } from '@supadoc/ui';

interface FooterLink {
  label: string;
  href: string;
}

/**
 * Landing footer (Figma 1.5): brand and tagline, Navigation / Resources /
 * Legal columns, the divider, then © · social icons · "Secure • Private •
 * Patient First". Links (O5): Privacy / Terms → the legal URLs from config
 * (hidden while unset), Contact / Contact Support → the support address,
 * everything else → the patient site.
 */
@Component({
  selector: 'onb-landing-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LogoComponent],
  host: { class: 'block bg-snow' },
  template: `
    <footer class="mx-auto max-w-[1280px] px-4 pb-8 pt-[124px] md:px-8 xl:px-0">
      <div class="grid grid-cols-2 gap-x-6 gap-y-10 lg:flex lg:justify-between">
        <div class="col-span-2 lg:col-span-1">
          <sd-logo [size]="40" />
          <p class="mt-6 max-w-[280px] font-sans text-body leading-7 text-ink">Trusted healthcare, wherever you are.</p>
        </div>
        @for (col of columns(); track col.title) {
          <nav [attr.aria-label]="col.title">
            <h2 class="font-sans text-[20px] font-medium leading-7 text-ink">{{ col.title }}</h2>
            <ul class="mt-6 flex flex-col gap-2">
              @for (link of col.links; track link.label) {
                <li>
                  <a [href]="link.href" class="font-sans text-body text-slate transition-colors hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40">{{ link.label }}</a>
                </li>
              }
            </ul>
          </nav>
        }
      </div>
      <div class="mt-12 flex flex-col items-center gap-4 border-t border-ash pt-6 text-center lg:mt-[86px] lg:flex-row lg:justify-between lg:text-left">
        <p class="font-sans text-body text-ink">© {{ year }} VideoMed. All rights reserved</p>
        <div class="flex items-center gap-5 text-cerulean">
          <svg role="img" aria-label="Facebook" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13.5 21v-7.5h2.53l.38-2.94H13.5V8.69c0-.85.24-1.43 1.46-1.43h1.55V4.63A20.8 20.8 0 0 0 14.25 4.5c-2.24 0-3.77 1.37-3.77 3.88v2.18H7.95v2.94h2.53V21h3.02Z" />
          </svg>
          <svg role="img" aria-label="Instagram" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
          </svg>
          <svg role="img" aria-label="X" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.17h1.7L7.4 4.74H5.58l11.09 14.43Z" />
          </svg>
        </div>
        <p class="font-sans text-body text-ink">Secure • Private • Patient First</p>
      </div>
    </footer>
  `,
})
export class LandingFooterComponent {
  readonly config = input.required<ApplicationConfigDto>();
  protected readonly year = new Date().getFullYear();

  protected readonly columns = computed(() => {
    const c = this.config();
    const site = c.patient_site_url;
    const mail = `mailto:${c.support_email}`;
    const legal: FooterLink[] = [];
    if (c.legal_privacy_url) legal.push({ label: 'Privacy Policy', href: c.legal_privacy_url });
    if (c.legal_terms_url) legal.push({ label: 'Terms of Service', href: c.legal_terms_url });
    legal.push({ label: 'Cookie Policy', href: site }, { label: 'Accessibility', href: site });
    return [
      {
        title: 'Navigation',
        links: [
          { label: 'Home', href: site },
          { label: 'About Us', href: site },
          { label: 'Services', href: site },
          { label: 'Contact', href: mail },
        ],
      },
      {
        title: 'Resources',
        links: [
          { label: 'Help Center', href: site },
          { label: 'FAQs', href: site },
          { label: 'Health Articles', href: site },
          { label: 'Contact Support', href: mail },
        ],
      },
      { title: 'Legal', links: legal },
    ];
  });
}
