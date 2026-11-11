import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * "Prescriptions & Lab" page title and its two tabs (Prescriptions /
 * Laboratory & Diagnostics), shared by both lists. The tabs are links
 * (`aria-current="page"` on the active one), not an ARIA tab widget.
 * Below sm the pill is full width with two equal tabs that may wrap (it fits
 * 320 px); from sm it is the Figma pill sized to its tabs.
 */
@Component({
  selector: 'doc-prescriptions-lab-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <div class="flex flex-col gap-1">
      <h1 class="font-heading text-h2 text-ink">Prescriptions &amp; Lab</h1>
      <p class="font-sans text-body text-slate">
        View and manage your patients' prescriptions and laboratory &amp; diagnostic requests.
      </p>
    </div>
    <!-- The Figma 66/40 page tab bar (tailwind/pills.css). Below 40rem: two equal tabs whose labels may wrap (one line needs ≈378px). -->
    <nav aria-label="Prescriptions and lab" class="sd-track sd-track-l w-full [--sd-track-bg:var(--color-snow)] sm:w-fit">
      @for (t of tabs; track t.key) {
        <a
          [routerLink]="t.link"
          class="sd-pill sd-pill-l sd-seg max-sm:h-auto max-sm:min-h-[30px] max-sm:min-w-0 max-sm:flex-1 max-sm:self-stretch max-sm:whitespace-normal max-sm:py-1 max-sm:text-center"
          [attr.aria-current]="active() === t.key ? 'page' : null"
          >{{ t.label }}</a
        >
      }
    </nav>
  `,
})
export class DocPrescriptionsLabHeader {
  readonly active = input<'prescriptions' | 'labs'>('prescriptions');

  protected readonly tabs = [
    { key: 'prescriptions', label: 'Prescriptions', link: '/prescriptions' },
    { key: 'labs', label: 'Laboratory & Diagnostics', link: '/prescriptions/labs' },
  ] as const;
}
