import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { IconComponent, LogoComponent } from '@supadoc/ui';

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly link: string;
}

/**
 * Signed-in patient shell — fixed side nav + header, with the active page in the
 * outlet (Figma 666:9342). The nav mirrors the design's order and icons.
 */
@Component({
  selector: 'pat-dashboard-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    IconComponent,
    LogoComponent,
  ],
  template: `
    <div class="flex min-h-screen bg-glacier">
      <!-- Side nav -->
      <aside
        class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col justify-between border-r-[0.5px] border-ash px-6 pt-6 pb-10 lg:flex"
      >
        <div class="flex flex-col gap-14">
          <a routerLink="/dashboard" class="flex items-center gap-2">
            <sd-logo [size]="32" />
          </a>

          <nav class="flex w-52 flex-col">
            @for (item of navItems; track item.link) {
              <a
                [routerLink]="item.link"
                routerLinkActive="bg-frost !text-cerulean"
                [routerLinkActiveOptions]="{
                  exact: item.link === '/dashboard',
                }"
                class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
              >
                <sd-icon [name]="item.icon" [size]="20" />
                {{ item.label }}
              </a>
            }
          </nav>
        </div>

        <div class="flex flex-col gap-6">
          <a
            routerLink="/dashboard/settings"
            routerLinkActive="bg-frost !text-cerulean"
            class="flex w-52 items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
          >
            <sd-icon name="settings" [size]="20" />
            Settings
          </a>
          <hr class="w-52 border-t border-ash/60" />
          <button
            type="button"
            class="flex w-52 items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
            (click)="logOut()"
          >
            <sd-icon name="log-out" [size]="20" />
            Log Out
          </button>
        </div>
      </aside>

      <!-- Content -->
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-20 items-center justify-end gap-6 px-6">
          <button
            type="button"
            class="relative text-ink transition-colors hover:text-cerulean"
            aria-label="Notifications"
          >
            <sd-icon name="bell" [size]="24" />
            <span
              class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-alert"
            ></span>
          </button>
          <div class="flex items-center gap-2">
            <img
              src="/dashboard/avatar-sarah.png"
              alt=""
              width="40"
              height="40"
              class="size-10 rounded-full object-cover"
            />
            <span class="font-sans text-body font-semibold text-ink">
              {{ userName }}
            </span>
          </div>
        </header>

        <main class="px-6 pb-10">
          <div class="mx-auto w-full max-w-[1128px]">
            <router-outlet />
          </div>
        </main>
      </div>
    </div>
  `,
})
export class DashboardShell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly navItems: NavItem[] = [
    { label: 'Dashboard', icon: 'layout-dashboard', link: '/dashboard' },
    {
      label: 'Find a Specialist',
      icon: 'stethoscope',
      link: '/dashboard/specialists',
    },
    {
      label: 'Appointments',
      icon: 'calendar-days',
      link: '/dashboard/appointments',
    },
    { label: 'History', icon: 'history', link: '/dashboard/history' },
    { label: 'Notification', icon: 'bell', link: '/dashboard/notifications' },
    { label: 'Wallet', icon: 'wallet', link: '/dashboard/wallet' },
    { label: 'My Profile', icon: 'user', link: '/dashboard/profile' },
  ];

  // TODO: source from GetProfile once login returns a usable token.
  protected readonly userName = 'Sarah Johnson';

  protected async logOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/auth/login');
  }
}
