import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { StaffNotificationsApi } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly link: string;
}

/**
 * Signed-in doctor shell — side nav + header with the active page in the outlet.
 * Mirrors the patient dashboard shell: fixed sidebar on desktop, slide-in drawer
 * below `lg`. The in-call cockpit (`/call/:token`) lives outside this shell.
 */
@Component({
  selector: 'doc-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  template: `
    <div class="flex min-h-screen bg-glacier">
      <aside
        class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col justify-between overflow-hidden border-r-[0.5px] border-ash px-6 pt-6 pb-10 lg:flex"
      >
        <ng-container [ngTemplateOutlet]="nav" />
      </aside>

      @if (menuOpen()) {
        <div class="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            class="absolute inset-0 cursor-default bg-abyss/40"
            aria-label="Close menu"
            (click)="menuOpen.set(false)"
          ></button>
          <aside
            class="absolute left-0 top-0 flex h-full w-72 max-w-[85%] flex-col justify-between overflow-y-auto bg-glacier px-6 pt-6 pb-10 shadow-2xl"
          >
            <ng-container [ngTemplateOutlet]="nav" />
          </aside>
        </div>
      }

      <div class="flex min-w-0 flex-1 flex-col">
        <header
          class="flex h-16 items-center justify-between gap-4 px-5 lg:h-20 lg:justify-end lg:px-6"
        >
          <div class="flex items-center gap-3 lg:hidden">
            <button
              type="button"
              class="text-ink transition-colors hover:text-cerulean"
              aria-label="Open menu"
              (click)="menuOpen.set(true)"
            >
              <sd-icon name="menu" [size]="24" />
            </button>
            <span class="font-heading text-h5 tracking-tight">
              <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
            </span>
          </div>

          <div class="flex items-center gap-3">
            <a
              routerLink="/notifications"
              class="relative text-ink transition-colors hover:text-cerulean"
              aria-label="Notifications"
            >
              <sd-icon name="bell" [size]="22" />
              @if (unread() > 0) {
                <span class="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-alert px-1 text-[10px] font-semibold text-white">{{ unread() > 9 ? '9+' : unread() }}</span>
              }
            </a>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean"
            >
              {{ initials() || 'DR' }}
            </span>
            <div class="hidden flex-col leading-tight sm:flex">
              <span class="font-sans text-body-sm font-semibold text-ink">{{
                displayName() || 'Doctor'
              }}</span>
              <span class="font-sans text-caption text-slate">{{
                specialty()
              }}</span>
            </div>
          </div>
        </header>

        <main class="px-5 pb-10 sm:px-6">
          <div class="mx-auto w-full max-w-6xl">
            <router-outlet />
          </div>
        </main>
      </div>
    </div>

    <ng-template #nav>
      <div class="flex flex-col gap-10">
        <a routerLink="/dashboard" class="flex items-center gap-2" (click)="menuOpen.set(false)">
          <span class="font-heading text-h4 tracking-tight">
            <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
          </span>
          <span
            class="rounded-pill bg-cerulean/10 px-2.5 py-1 font-sans text-caption font-semibold text-cerulean"
            >Doctor</span
          >
        </a>

        <nav class="flex flex-col gap-1">
          @for (item of navItems; track item.link) {
            <a
              [routerLink]="item.link"
              routerLinkActive="bg-frost !text-cerulean"
              class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
              (click)="menuOpen.set(false)"
            >
              <sd-icon [name]="item.icon" [size]="20" />
              {{ item.label }}
            </a>
          }
        </nav>
      </div>

      <button
        type="button"
        class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
        (click)="logout()"
      >
        <sd-icon name="log-out" [size]="20" />
        Sign out
      </button>
    </ng-template>
  `,
})
export class DoctorShell {
  private readonly auth = inject(StaffAuthService);
  private readonly notificationsApi = inject(StaffNotificationsApi);
  private readonly router = inject(Router);

  protected readonly menuOpen = signal(false);
  protected readonly unread = signal(0);
  protected readonly displayName = computed(() => this.auth.displayName());
  protected readonly specialty = computed(
    () => this.auth.user()?.roles.includes('doctor') ? 'Specialist' : '',
  );
  protected readonly initials = computed(() =>
    this.auth
      .displayName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected readonly navItems: NavItem[] = [
    { label: 'Dashboard', icon: 'layout-dashboard', link: '/dashboard' },
    { label: 'Schedule', icon: 'calendar-days', link: '/schedule' },
    { label: 'History', icon: 'history', link: '/appointments/history' },
    { label: 'Patients', icon: 'users', link: '/patients' },
    { label: 'Reviews', icon: 'star', link: '/reviews' },
    { label: 'Earnings', icon: 'banknote', link: '/earnings' },
    { label: 'Payouts', icon: 'wallet', link: '/payouts' },
    { label: 'Availability', icon: 'calendar-clock', link: '/availability' },
    { label: 'My Profile', icon: 'user', link: '/profile' },
  ];

  constructor() {
    // Refresh roles/permissions in the background (they may have changed).
    void this.auth.loadMe();
    this.notificationsApi.unread().subscribe({
      next: (res) => this.unread.set(res.data.count),
      error: () => undefined,
    });
  }

  protected logout(): void {
    this.menuOpen.set(false);
    this.auth.logout();
    void this.router.navigateByUrl('/auth/login');
  }
}
