import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { AuthService } from '@supadoc/auth';
import { NotificationsApi, PatientApi } from '@supadoc/data-access';
import { IconComponent, LogoComponent } from '@supadoc/ui';

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly link: string;
}

/**
 * Signed-in patient shell — side nav + header, with the active page in the
 * outlet (Figma 666:9342). On desktop the nav is a fixed sidebar; below `lg` it
 * collapses behind a hamburger and opens as a slide-in drawer, so navigation
 * (and log out) stay reachable on mobile. The nav markup is shared between the
 * two via the `#nav` template.
 */
@Component({
  selector: 'pat-dashboard-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    IconComponent,
    LogoComponent,
  ],
  template: `
    <div class="flex min-h-screen bg-glacier">
      <!-- Desktop side nav (collapsible) -->
      <aside
        class="sticky top-0 hidden h-screen shrink-0 flex-col justify-between border-r-[0.5px] border-ash pt-6 pb-10 transition-[width,padding] duration-200 ease-out lg:flex"
        [class.w-64]="!collapsed()"
        [class.px-6]="!collapsed()"
        [class.w-20]="collapsed()"
        [class.px-3]="collapsed()"
      >
        <ng-container
          [ngTemplateOutlet]="nav"
          [ngTemplateOutletContext]="{ collapsed: collapsed(), desktop: true }"
        />
      </aside>

      <!-- Mobile drawer -->
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
            <ng-container
              [ngTemplateOutlet]="nav"
              [ngTemplateOutletContext]="{ collapsed: false, desktop: false }"
            />
          </aside>
        </div>
      }

      <!-- Content -->
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
            <sd-logo [size]="28" />
          </div>

          <div class="flex items-center gap-4 lg:gap-6">
            <button
              type="button"
              class="relative text-ink transition-colors hover:text-cerulean"
              aria-label="Notifications"
              (click)="goNotifications()"
            >
              <sd-icon name="bell" [size]="24" />
              @if (unread() > 0) {
                <span
                  class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-alert"
                ></span>
              }
            </button>
            <div class="flex items-center gap-2">
              @if (avatarSrc()) {
                <img
                  [src]="avatarSrc()"
                  alt="Profile photo"
                  width="40"
                  height="40"
                  class="size-10 shrink-0 rounded-full object-cover"
                />
              } @else {
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean"
                >
                  @if (initials()) {
                    {{ initials() }}
                  } @else {
                    <sd-icon name="user" [size]="18" />
                  }
                </span>
              }
              <span
                class="hidden font-sans text-body font-semibold text-ink sm:inline"
              >
                {{ userName() }}
              </span>
            </div>
          </div>
        </header>

        <main class="px-5 pb-10 sm:px-6">
          <div class="mx-auto w-full">
            <router-outlet />
          </div>
        </main>
      </div>
    </div>

    <!-- Shared nav (desktop sidebar + mobile drawer) -->
    <ng-template #nav let-collapsed="collapsed" let-desktop="desktop">
      <div class="flex flex-col gap-10">
        <div
          class="flex items-center"
          [class.justify-between]="!collapsed"
          [class.justify-center]="collapsed"
        >
          @if (!collapsed) {
            <a
              routerLink="/dashboard"
              class="flex items-center gap-2"
              (click)="menuOpen.set(false)"
            >
              <sd-logo [size]="32" />
            </a>
          }
          @if (desktop) {
            <button
              type="button"
              class="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate transition-colors hover:bg-frost/40 hover:text-cerulean"
              [attr.aria-label]="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
              [attr.title]="collapsed ? 'Expand' : 'Collapse'"
              (click)="toggleCollapse()"
            >
              <sd-icon
                name="chevron-right"
                [size]="20"
                class="transition-transform"
                [class.rotate-180]="!collapsed"
              />
            </button>
          }
        </div>

        <nav class="flex flex-col gap-1">
          @for (item of navItems; track item.link) {
            <a
              [routerLink]="item.link"
              routerLinkActive="bg-frost !text-cerulean"
              [routerLinkActiveOptions]="{ exact: item.link === '/dashboard' }"
              class="flex items-center gap-2 rounded-lg py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
              [class.px-4]="!collapsed"
              [class.justify-center]="collapsed"
              [attr.title]="collapsed ? item.label : null"
              (click)="menuOpen.set(false)"
            >
              <sd-icon [name]="item.icon" [size]="20" />
              @if (!collapsed) {
                {{ item.label }}
              }
            </a>
          }
        </nav>
      </div>

      <div class="flex flex-col gap-6">
        <a
          routerLink="/dashboard/settings"
          routerLinkActive="bg-frost !text-cerulean"
          class="flex items-center gap-2 rounded-lg py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
          [class.px-4]="!collapsed"
          [class.justify-center]="collapsed"
          [attr.title]="collapsed ? 'Settings' : null"
          (click)="menuOpen.set(false)"
        >
          <sd-icon name="settings" [size]="20" />
          @if (!collapsed) {
            Settings
          }
        </a>
        <hr class="border-t border-ash/60" />
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
          [class.px-4]="!collapsed"
          [class.justify-center]="collapsed"
          [attr.title]="collapsed ? 'Log Out' : null"
          (click)="logOut()"
        >
          <sd-icon name="log-out" [size]="20" />
          @if (!collapsed) {
            Log Out
          }
        </button>
      </div>
    </ng-template>
  `,
})
export class DashboardShell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly patient = inject(PatientApi);
  private readonly notificationsApi = inject(NotificationsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly menuOpen = signal(false);
  protected readonly unread = signal(0);
  /** Desktop sidebar collapsed to an icon rail; persisted across sessions. */
  protected readonly collapsed = signal(this.readCollapsed());

  protected toggleCollapse(): void {
    this.collapsed.update((c) => !c);
    try {
      localStorage.setItem('videomed.sidebar', this.collapsed() ? '1' : '0');
    } catch {
      /* preference is best-effort */
    }
  }

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem('videomed.sidebar') === '1';
    } catch {
      return false;
    }
  }

  constructor() {
    this.patient
      .me()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const full = `${res.data.first_name} ${res.data.last_name}`.trim();
          if (full) this.userName.set(full);
          this.avatarPath.set(res.data.avatar_url ?? null);
        },
        error: () => {
          /* keep the placeholder on failure */
        },
      });

    this.notificationsApi
      .list({ per_page: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.unread.set(res.meta.unread),
        error: () => {
          /* no badge on failure */
        },
      });
  }

  protected goNotifications(): void {
    this.menuOpen.set(false);
    void this.router.navigate(['/dashboard/notifications']);
  }

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

  // From GET /api/portal/me; blank until it resolves.
  protected readonly userName = signal('');
  protected readonly avatarPath = signal<string | null>(null);
  protected readonly avatarSrc = computed(() =>
    this.patient.assetUrl(this.avatarPath()),
  );
  protected readonly initials = computed(() =>
    this.userName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected async logOut(): Promise<void> {
    this.menuOpen.set(false);
    await this.auth.logout();
    // Land on the public home (a signed-out visitor), not a dead-end login page.
    await this.router.navigateByUrl('/');
  }
}
