import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonComponent, IconComponent, LogoComponent } from '@supadoc/ui';

export interface AuthStatusData {
  variant: 'success' | 'error';
  title: string;
  subtitle?: string;
  actionLabel: string;
  actionLink: string;
}

/** Full-screen auth result screen (Figma 338:4872 success / 427:13265 failure). */
@Component({
  selector: 'pat-auth-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, LogoComponent],
  template: `
    <div class="flex min-h-screen flex-col bg-glacier px-6 py-6 sm:px-12">
      <header><sd-logo [size]="44" /></header>
      <div class="flex flex-1 items-center justify-center">
        <div
          class="flex w-full max-w-[440px] flex-col items-center gap-6 text-center"
        >
          <div
            class="flex size-16 items-center justify-center rounded-full text-white"
            [class.bg-sage]="data.variant === 'success'"
            [class.bg-alert]="data.variant === 'error'"
          >
            <sd-icon
              [name]="data.variant === 'success' ? 'check' : 'x'"
              [size]="30"
            />
          </div>
          <div class="flex flex-col gap-2">
            <h1 class="font-heading text-h2 text-abyss">{{ data.title }}</h1>
            @if (data.subtitle) {
              <p class="text-body text-slate">{{ data.subtitle }}</p>
            }
          </div>
          <sd-button (click)="go()">
            {{ data.actionLabel }}
            <sd-icon name="arrow-right" [size]="18" />
          </sd-button>
        </div>
      </div>
    </div>
  `,
})
export class AuthStatus {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly data = this.route.snapshot
    .data as unknown as AuthStatusData;

  protected go(): void {
    void this.router.navigateByUrl(this.data.actionLink);
  }
}
