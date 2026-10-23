import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DialogService, IconComponent } from '@supadoc/ui';
import { filter } from 'rxjs';
import { ApplicationsQueue } from './applications/applications-queue';
import {
  badgeCount,
  badgeLabel,
  canOpen,
  landingLink,
  NAV,
  type NavBadge,
  type NavBadgeCounts,
  type NavItem,
  waitingSummary,
} from './nav';
import { ReviewQueue } from './specialists/review-queue';

/** Back-office shell — permission-gated side nav + header. */
@Component({
  selector: 'bo-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  template: `
    <div class="flex min-h-screen bg-glacier">
      <aside
        class="sticky top-0 hidden h-screen w-64 shrink-0 flex-col justify-between gap-6 overflow-y-auto border-r-[0.5px] border-ash bg-snow px-6 pt-6 pb-10 lg:flex"
      >
        <ng-container [ngTemplateOutlet]="nav" />
      </aside>

      @if (menuOpen()) {
        <div class="fixed inset-0 z-40 lg:hidden">
          <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close menu" (click)="menuOpen.set(false)"></button>
          <aside class="absolute left-0 top-0 flex h-full w-72 max-w-[85%] flex-col justify-between gap-6 overflow-y-auto bg-snow px-6 pt-6 pb-10 shadow-2xl">
            <ng-container [ngTemplateOutlet]="nav" />
          </aside>
        </div>
      }

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-16 items-center justify-between gap-4 px-5 lg:h-20 lg:justify-end lg:px-6">
          <div class="flex items-center gap-3 lg:hidden">
            <button type="button" class="relative text-ink transition-colors hover:text-cerulean" [attr.aria-label]="waiting() ? 'Open menu (' + waiting() + ')' : 'Open menu'" (click)="menuOpen.set(true)">
              <sd-icon name="menu" [size]="24" />
              @if (badgeCounts().review + badgeCounts().applications > 0) {
                <span class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-warning ring-2 ring-glacier"></span>
              }
            </button>
            <span class="font-heading text-h5 tracking-tight">
              <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink/10 font-heading text-body-sm font-semibold text-ink ring-2 ring-white shadow-control">
              {{ initials() || 'AD' }}
            </span>
            <div class="hidden flex-col leading-tight sm:flex">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ displayName() || 'Admin' }}</span>
              <span class="font-sans text-caption text-slate capitalize">{{ roleLabel() }}</span>
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

    <ng-template #nav>
      <div class="flex flex-col gap-10">
        <a [routerLink]="homeLink()" class="flex items-center gap-2" (click)="menuOpen.set(false)">
          <span class="font-heading text-h4 tracking-tight">
            <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
          </span>
          <span class="rounded-pill bg-ink/10 px-2.5 py-1 font-sans text-caption font-semibold text-ink inset-ring inset-ring-current/15">Admin</span>
        </a>
        <nav class="flex flex-col gap-1">
          @for (item of visibleNav(); track item.link) {
            <a
              [routerLink]="item.link"
              routerLinkActive="!bg-haze !text-cerulean-dark shadow-control inset-ring inset-ring-cerulean/10"
              class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition hover:bg-frost/40"
              (click)="menuOpen.set(false)"
            >
              <sd-icon [name]="item.icon" [size]="20" />{{ item.label }}
              @let n = count(item);
              @if (n > 0 && item.badge) {
                <span class="ml-auto rounded-pill bg-warning/20 px-2 py-0.5 font-sans text-caption font-semibold text-ink inset-ring inset-ring-warning/40" [attr.title]="label(item.badge, n)">
                  {{ n }}<span class="sr-only"> {{ label(item.badge, n) }}</span>
                </span>
              }
            </a>
          }
        </nav>
      </div>
      <div class="flex flex-col gap-1 border-t border-ash pt-4">
        <a
          routerLink="/settings"
          routerLinkActive="!bg-haze !text-cerulean-dark shadow-control inset-ring inset-ring-cerulean/10"
          class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition hover:bg-frost/40"
          (click)="menuOpen.set(false)"
        >
          <sd-icon name="settings" [size]="20" />Settings
        </a>
        <button type="button" class="flex items-center gap-2 rounded-lg px-4 py-3 font-sans text-body text-ink transition hover:bg-frost/40" (click)="askLogout()">
          <sd-icon name="log-out" [size]="20" />Sign out
        </button>
      </div>
    </ng-template>
  `,
})
export class AdminShell {
  private readonly auth = inject(StaffAuthService);
  private readonly router = inject(Router);
  private readonly reviewQueue = inject(ReviewQueue);
  private readonly applicationsQueue = inject(ApplicationsQueue);
  private readonly dialogs = inject(DialogService);

  /**
   * What waits for a reviewer (reviewers only; 0 hides a badge): profiles in
   * review, change requests and documents to verify (`review`, on
   * Specialists), and doctor applications that need action (`applications`).
   */
  protected readonly badgeCounts = computed<NavBadgeCounts>(() => {
    const reviewer = this.auth.hasPermission('specialists.manage');
    return {
      review: reviewer ? this.reviewQueue.count() : 0,
      applications: reviewer ? this.applicationsQueue.count() : 0,
    };
  });
  /** The mobile menu button's words for what is waiting ('' when nothing). */
  protected readonly waiting = computed(() => waitingSummary(this.badgeCounts()));

  protected readonly menuOpen = signal(false);
  protected readonly displayName = computed(() => this.auth.displayName());
  protected readonly roleLabel = computed(() => this.auth.roles()[0] ?? 'staff');
  /** The logo's target: this user's landing page (not `/`, whose redirect would re-ask about unsaved edits). */
  protected readonly homeLink = computed(() => landingLink(this.auth));
  protected readonly visibleNav = computed(() =>
    NAV.filter((item) => canOpen(this.auth, item)),
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
    // Keep the review and applications badges current as the admin moves around.
    this.reviewQueue.refresh();
    this.applicationsQueue.refresh();
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.reviewQueue.refresh();
        this.applicationsQueue.refresh();
      });
  }

  protected count(item: NavItem): number {
    return badgeCount(item, this.badgeCounts());
  }

  protected label(badge: NavBadge, n: number): string {
    return badgeLabel(badge, n);
  }

  protected async askLogout(): Promise<void> {
    this.menuOpen.set(false);
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'log-out',
      title: 'Sign out?',
      message: "You'll need to sign in again to use the console.",
      confirmLabel: 'Sign out',
      cancelLabel: 'Stay signed in',
    });
    if (confirmed) this.logout();
  }

  private logout(): void {
    this.menuOpen.set(false);
    this.auth.logout();
    void this.router.navigateByUrl('/auth/login');
  }
}
