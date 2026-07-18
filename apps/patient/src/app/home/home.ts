import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  ButtonComponent,
  CardComponent,
  IconComponent,
  LogoComponent,
} from '@supadoc/ui';

@Component({
  selector: 'pat-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, CardComponent, IconComponent, LogoComponent],
  template: `
    <main
      class="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-8 p-6"
    >
      <sd-card>
        <div class="flex flex-col items-start gap-6">
          <sd-logo [size]="40" />
          <div class="flex flex-col gap-2">
            <h1 class="font-heading text-h2 text-abyss">Patient Portal</h1>
            <p class="text-body text-slate">
              The Supadoc design system is wired up from the VideoMed Figma —
              Lexend + SF&nbsp;Pro type, the Cerulean palette, Lucide icons and
              the shared <code>&#64;supadoc/ui</code> components.
            </p>
          </div>
          <div class="flex flex-wrap gap-3">
            <sd-button variant="primary">
              Get started
              <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
            <sd-button variant="secondary">View components</sd-button>
          </div>
        </div>
      </sd-card>
    </main>
  `,
})
export class Home {}
