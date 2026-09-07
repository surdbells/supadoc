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
import { IconComponent } from '@supadoc/ui';

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly link: string;
  readonly permission: string;
}

const NAV: NavItem[] = [
  { label: 'Dashboard', icon: 'layout-dashboard', link: '/dashboard', permission: 'monitoring.view' },
  { label: 'Appointments', icon: 'calendar-days', link: '/appointments', permission: 'appointments.view' },
  { label: 'Analytics', icon: 'chart-column', link: '/analytics', permission: 'monitoring.view' },
  { label: 'Monitoring', icon: 'activity', link: '/monitoring', permission: 'monitoring.view' },
  { label: 'Specialists', icon: 'stethoscope', link: '/specialists', permission: 'specialists.manage' },
  { label: 'Staff & roles', icon: 'users', link: '/staff', permission: 'staff.manage' },
  { label: 'Payouts', icon: 'wallet', link: '/payouts', permission: 'payouts.manage' },
  { label: 'Support', icon: 'headphones', link: '/support', permission: 'support.manage' },
  { label: 'Pricing', icon: 'banknote', link: '/pricing', permission: 'settings.manage' },
  { label: 'Audit log', icon: 'history', link: '/audit', permission: 'monitoring.view' },
];

/** Back-office shell — permission-gated side nav + header. */
@Component({
  selector: 'bo-shell',
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
          <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close menu" (click)="menuOpen.set(false)"></button>
          <aside class="absolute left-0 top-0 flex h-full w-72 max-w-[85%] flex-col justify-between overflow-y-auto bg-glacier px-6 pt-6 pb-10 shadow-2xl">
            <ng-container [ngTemplateOutlet]="nav" />
          </aside>
        </div>
      }

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-16 items-center justify-between gap-4 px-5 lg:h-20 lg:justify-end lg:px-6">
          <div class="flex items-center gap-3 lg:hidden">
            <button type="button" class="text-ink transition-colors hover:text-cerulean" aria-label="Open menu" (click)="menuOpen.set(true)">
              <sd-icon name="menu" [size]="24" />
            </button>
            <span class="font-heading text-h5 tracking-tight">
              <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink/10 font-heading text-body-sm font-semibold text-ink">
              {{ initials() || 'AD' }}
            </span>
            <div class="hidden flex-col leading-tight sm:flex">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ displayName() || 'Admin' }}</span>
              <span class="font-sans text-caption text-slate capitalize">{{ roleLabel() }}</span>
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
          <span class="rounded-pill bg-ink/10 px-2.5 py-1 font-sans text-caption font-semibold text-ink">Admin</span>
        </a>
        <nav class="flex flex-col gap-1">
          @for (item of visibleNav(); track item.link) {
            <a
              [routerLink]="item.link"
              routerLinkActive="bg-frost !text-cerulean"
              class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
              (click)="menuOpen.set(false)"
            >
              <sd-icon [name]="item.icon" [size]="20" />{{ item.label }}
            </a>
          }
        </nav>
      </div>
      <div class="flex flex-col gap-1">
        <a
          routerLink="/settings"
          routerLinkActive="bg-frost !text-cerulean"
          class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
          (click)="menuOpen.set(false)"
        >
          <sd-icon name="settings" [size]="20" />Settings
        </a>
        <button type="button" class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40" (click)="logout()">
          <sd-icon name="log-out" [size]="20" />Sign out
        </button>
      </div>
    </ng-template>
  `,
})
export class AdminShell {
  private readonly auth = inject(StaffAuthService);
  private readonly router = inject(Router);

  protected readonly menuOpen = signal(false);
  protected readonly displayName = computed(() => this.auth.displayName());
  protected readonly roleLabel = computed(() => this.auth.roles()[0] ?? 'staff');
  protected readonly visibleNav = computed(() =>
    NAV.filter((item) => this.auth.hasPermission(item.permission)),
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

  constructor() {
    void this.auth.loadMe();
  }

  protected logout(): void {
    this.menuOpen.set(false);
    this.auth.logout();
    void this.router.navigateByUrl('/auth/login');
  }
}
