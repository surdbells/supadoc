import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoComponent } from '@supadoc/ui';

/**
 * Split-screen shell for the web auth flow: a brand panel on the left (lg+) and
 * the routed auth screen (login, sign up, …) on the right.
 */
@Component({
  selector: 'pat-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, LogoComponent],
  template: `
    <div class="flex min-h-screen bg-glacier">
      <aside
        class="relative hidden w-1/2 max-w-[560px] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#0d3b6f] to-abyss p-10 text-white lg:flex"
      >
        <sd-logo [size]="40" [wordmark]="false" />
        <div class="flex flex-col gap-4">
          <h2 class="font-heading text-h2 max-w-sm">
            Healthcare shouldn't take your entire day.
          </h2>
          <p class="max-w-sm text-body text-white/80">
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
      </aside>

      <main class="flex flex-1 flex-col">
        <header class="p-6 sm:p-8">
          <sd-logo [size]="36" />
        </header>
        <div class="flex flex-1 items-center justify-center px-6 pb-10">
          <div class="w-full max-w-md">
            <router-outlet />
          </div>
        </div>
      </main>
    </div>
  `,
})
export class AuthLayout {}
