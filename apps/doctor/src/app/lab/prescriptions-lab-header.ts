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
  styles: `
    .plh-nav {
      gap: 8px;
      padding: 8px;
    }
    .plh-tab {
      flex: 1 1 0%;
      min-width: 0;
      padding: 8px 12px;
      font-size: var(--text-body-sm);
      line-height: var(--text-body-sm--line-height);
      letter-spacing: var(--text-body-sm--letter-spacing);
      overflow-wrap: anywhere;
    }
    @media (min-width: 40rem) {
      .plh-nav {
        width: fit-content;
        gap: 16px;
        padding: 12px 24px;
      }
      .plh-tab {
        flex: none;
        padding: 8px 16px;
        font-size: var(--text-body);
        line-height: var(--text-body--line-height);
        letter-spacing: var(--text-body--letter-spacing);
        white-space: nowrap;
      }
    }
  `,
  template: `
    <div class="flex flex-col gap-1">
      <h1 class="font-heading text-h2 text-ink">Prescriptions &amp; Lab</h1>
      <p class="font-sans text-body text-slate">
        View and manage your patients' prescriptions and laboratory &amp; diagnostic requests.
      </p>
    </div>
    <nav aria-label="Prescriptions and lab" class="plh-nav flex w-full rounded-[32px] border border-haze bg-snow shadow-bar">
      @for (t of tabs; track t.key) {
        <a
          [routerLink]="t.link"
          class="plh-tab flex items-center justify-center rounded-[24px] text-center font-sans font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [class]="active() === t.key ? 'bg-cerulean/10 text-cerulean-dark' : 'text-slate hover:text-ink'"
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
