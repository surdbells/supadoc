import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi, StaffNotificationsApi } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';
import { DoctorSignOut } from './sign-out';
import { DoctorStandingStore } from './standing/doctor-standing.store';

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly link: string;
}

interface StandingBanner {
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  readonly cta: string;
  readonly link: string;
  /** Card border/background classes. */
  readonly tone: string;
  /** Icon + call-to-action text colour. */
  readonly iconTone: string;
}

/** Pages that explain the doctor's standing themselves (no banner over them). */
const EXPLAINS_STANDING = ['/dashboard', '/account-status', '/onboarding'];

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
                <span class="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-white bg-alert"></span>
              }
            </a>
            @if (photoSrc()) {
              <img [src]="photoSrc()" alt="" width="40" height="40" class="size-10 shrink-0 rounded-full object-cover" />
            } @else {
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-sm font-semibold text-cerulean"
              >
                {{ initials() || 'DR' }}
              </span>
            }
            <div class="hidden flex-col leading-tight sm:flex">
              <span class="font-sans text-body-sm font-semibold text-ink">{{
                displayName() || 'Doctor'
              }}</span>
              <span class="font-sans text-caption text-slate">{{
                specialty() || 'Specialist'
              }}</span>
            </div>
          </div>
        </header>

        <main class="px-5 pb-10 sm:px-6">
          <div class="mx-auto w-full">
            <!-- The account's standing, on pages that don't explain it themselves. -->
            @if (standingBanner(); as b) {
              <a
                [routerLink]="b.link"
                class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border px-4 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [class]="b.tone"
              >
                <sd-icon [name]="b.icon" [size]="20" class="shrink-0" [class]="b.iconTone" />
                <span class="min-w-0 flex-1 basis-48 font-sans text-body-sm text-ink"><span class="font-semibold">{{ b.title }}</span> {{ b.text }}</span>
                <span class="ml-auto flex shrink-0 items-center gap-1 font-sans text-body-sm font-semibold" [class]="b.iconTone">
                  {{ b.cta }}<sd-icon name="chevron-right" [size]="16" />
                </span>
              </a>
            }
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

      <div class="flex flex-col gap-1 border-t border-ash pt-4">
        <a
          routerLink="/settings"
          routerLinkActive="bg-frost !text-cerulean"
          class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
          (click)="menuOpen.set(false)"
        >
          <sd-icon name="settings" [size]="20" />
          Settings
        </a>
        <button
          type="button"
          class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition-colors hover:bg-frost/40"
          (click)="askLogout()"
        >
          <sd-icon name="log-out" [size]="20" />
          Log Out
        </button>
      </div>
    </ng-template>
  `,
})
export class DoctorShell {
  private readonly auth = inject(StaffAuthService);
  private readonly notificationsApi = inject(StaffNotificationsApi);
  private readonly doctorApi = inject(DoctorApi);
  private readonly router = inject(Router);
  private readonly standing = inject(DoctorStandingStore);

  /** The current URL, as a signal (the banner depends on the page). */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Suspended, or owing the practitioner terms: a slim banner on every page
   * that doesn't explain it itself (an unapproved doctor is working through
   * their checklist — the dashboard and checklist say enough).
   */
  protected readonly standingBanner = computed<StandingBanner | null>(() => {
    const code = this.standing.code();
    const path = this.url().split(/[?#]/)[0];
    if (EXPLAINS_STANDING.some((p) => path === p || path.startsWith(p + '/'))) return null;
    if (code === 'doctor_suspended') {
      return {
        icon: 'ban',
        title: 'Your account is suspended.',
        text: 'Patients can’t book you and clinical work is closed.',
        cta: 'Why, and what next',
        link: '/account-status',
        tone: 'border-alert/30 bg-alert/5 hover:bg-alert/10',
        iconTone: 'text-alert',
      };
    }
    if (code === 'terms_required') {
      const updated = !!this.standing.onboarding()?.terms?.accepted_version;
      return {
        icon: 'scroll-text',
        title: updated ? 'Accept the updated practitioner terms' : 'Accept the VideoMed practitioner terms',
        text: 'to join calls and write clinical records.',
        cta: 'Read and accept',
        link: '/onboarding/terms',
        tone: 'border-warning/30 bg-warning/5 hover:bg-warning/10',
        iconTone: 'text-warning',
      };
    }
    return null;
  });

  protected readonly menuOpen = signal(false);
  protected readonly unread = signal(0);
  protected readonly displayName = computed(() => this.auth.displayName());
  protected readonly specialty = signal('');
  protected readonly photoSrc = signal<string | null>(null);
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
    { label: 'Patients', icon: 'users', link: '/patients' },
    { label: 'Prescriptions', icon: 'pill', link: '/prescriptions' },
    { label: 'History', icon: 'history', link: '/appointments/history' },
    { label: 'Reviews', icon: 'star', link: '/reviews' },
    { label: 'Earnings', icon: 'banknote', link: '/earnings' },
    { label: 'Payout', icon: 'wallet', link: '/payouts' },
    { label: 'Availability', icon: 'calendar-clock', link: '/availability' },
    { label: 'Notification', icon: 'bell', link: '/notifications' },
    { label: 'My Profile', icon: 'user', link: '/profile' },
  ];

  constructor() {
    // Refresh roles/permissions in the background (they may have changed).
    void this.auth.loadMe();
    // The account's standing (suspended / owes the terms) for the banner and the guard.
    void this.standing.load();
    this.notificationsApi.unread().subscribe({
      next: (res) => this.unread.set(res.data.count),
      error: () => undefined,
    });
    // The header shows the doctor's real specialty + headshot.
    this.doctorApi.getProfile().subscribe({
      next: (res) => {
        this.specialty.set(res.data.specialty ?? '');
        this.photoSrc.set(this.doctorApi.assetUrl(res.data.photo_url));
      },
      error: () => undefined,
    });
  }

  private readonly signOut = inject(DoctorSignOut);

  /** "Sign out?" (the app's dialog), then out to the sign-in page. */
  protected askLogout(): void {
    this.menuOpen.set(false);
    void this.signOut.ask();
  }
}
