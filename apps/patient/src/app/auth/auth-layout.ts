import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IconComponent, LogoComponent } from '@supadoc/ui';

/**
 * Split-screen shell for the web auth flow (VideoMed): a rounded photo panel on
 * the left (lg+) with the onboarding tagline, and the routed auth screen on the
 * right beneath a header with the logo and a Back control.
 */
@Component({
  selector: 'pat-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, LogoComponent, IconComponent],
  template: `
    <div
      class="min-h-screen bg-glacier lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,720px)]"
    >
      <aside class="hidden p-6 lg:block">
        <div
          class="relative h-full min-h-[640px] overflow-hidden rounded-[28px] bg-abyss"
        >
          <img
            src="/auth-hero.png"
            alt=""
            class="absolute inset-0 size-full object-cover"
          />
          <div
            class="absolute inset-0 bg-gradient-to-b from-abyss/10 via-abyss/25 to-abyss/95"
          ></div>
          <div
            class="absolute inset-x-8 bottom-9 flex flex-col gap-3 text-white"
          >
            <h2 class="font-heading text-h3 max-w-md">
              Healthcare shouldn't take your entire day.
            </h2>
            <p class="max-w-md text-body text-white/85">
              Book an appointment, speak with a licensed doctor online, and
              receive medical guidance without spending hours in crowded waiting
              rooms.
            </p>
            <div class="mt-2 flex gap-2" aria-hidden="true">
              <span class="h-1.5 w-8 rounded-pill bg-white/90"></span>
              <span class="h-1.5 w-8 rounded-pill bg-white/30"></span>
              <span class="h-1.5 w-8 rounded-pill bg-white/30"></span>
              <span class="h-1.5 w-8 rounded-pill bg-white/30"></span>
            </div>
          </div>
        </div>
      </aside>

      <main class="flex min-h-screen flex-col px-6 py-6 sm:px-12">
        <header class="flex items-center justify-between">
          <sd-logo [size]="44" />
          <button
            type="button"
            class="inline-flex items-center gap-2 font-sans text-body text-ink hover:text-cerulean"
            (click)="back()"
          >
            <sd-icon name="arrow-right" [size]="20" class="rotate-180" />
            Back
          </button>
        </header>
        <div class="flex flex-1 items-center justify-center py-10">
          <div class="w-full max-w-[440px]">
            <router-outlet />
          </div>
        </div>
      </main>
    </div>
  `,
})
export class AuthLayout {
  private readonly location = inject(Location);

  protected back(): void {
    this.location.back();
  }
}
