import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ButtonComponent, CardComponent } from '@supadoc/ui';

@Component({
  selector: 'bo-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, CardComponent],
  template: `
    <main
      class="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 p-6"
    >
      <sd-card>
        <div class="flex flex-col items-start gap-4">
          <span
            class="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700"
          >
            Supadoc
          </span>
          <h1 class="text-3xl font-bold text-surface-900">Backoffice</h1>
          <p class="max-w-prose text-surface-500">
            Monorepo scaffold is ready. Build the control center from the Figma
            designs using the shared <code>&#64;supadoc/ui</code> components and
            Tailwind design tokens.
          </p>
          <div class="flex gap-3">
            <sd-button variant="primary">Get started</sd-button>
            <sd-button variant="ghost">View components</sd-button>
          </div>
        </div>
      </sd-card>
    </main>
  `,
})
export class Home {}
