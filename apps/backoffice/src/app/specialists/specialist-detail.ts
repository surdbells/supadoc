import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import type { HasUnsavedChanges } from '@supadoc/auth';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDetailDto } from '@supadoc/models';
import type { LeaveCopy } from '@supadoc/ui';
import { AlertComponent, DialogService, IconComponent } from '@supadoc/ui';
import { ReviewQueue } from './review-queue';
import { SpecialistAppointmentsTab } from './tabs/appointments-tab';
import { SpecialistCredentialsTab } from './tabs/credentials-tab';
import { SpecialistEarningsTab } from './tabs/earnings-tab';
import { SpecialistHistoryTab } from './tabs/history-tab';
import { SpecialistOverviewTab } from './tabs/overview-tab';
import { SpecialistReviewTab } from './tabs/review-tab';
import { SpecialistReviewsTab } from './tabs/reviews-tab';
import { afterDialogCloses } from '../shared/after-dialog';
import { ReinstateDialog } from './dialogs/reinstate-dialog';
import { SuspendDialog } from './dialogs/suspend-dialog';
import {
  Badge,
  BTN_DANGER_OUTLINE,
  BTN_SUCCESS,
  calendarDay,
  dateOnly,
  type DoctorTab,
  FOCUS_RING,
  initials,
  licenceStateBadge,
  loginBadge,
  money,
  PILL,
  plural,
  statusBadge,
} from './specialist-ui';

const TABS: readonly { key: DoctorTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'credentials', label: 'Credentials' },
  { key: 'review', label: 'Review' },
  { key: 'appointments', label: 'Appointments' },
  { key: 'earnings', label: 'Earnings & payouts' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'history', label: 'History' },
];

/**
 * The doctor page (route `/specialists/:id`, needs `specialists.manage`): the
 * doctor's standing at a glance and tabs for their profile, licensing
 * documents, review, appointments, earnings, patient reviews and history
 * (`?tab=` deep-links one). Header actions suspend an approved doctor
 * (preview → confirm), finish a suspension that left future bookings behind
 * (it stopped part-way), or reinstate a suspended doctor.
 */
@Component({
  selector: 'bo-specialist-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IconComponent,
    AlertComponent,
    SpecialistOverviewTab,
    SpecialistCredentialsTab,
    SpecialistReviewTab,
    SpecialistAppointmentsTab,
    SpecialistEarningsTab,
    SpecialistReviewsTab,
    SpecialistHistoryTab,
    SuspendDialog,
    ReinstateDialog,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-5 py-2">
      <a routerLink="/specialists" [queryParams]="backParams" class="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-body-sm font-semibold text-cerulean hover:underline ${FOCUS_RING}">
        <sd-icon name="chevron-left" [size]="18" />Back to specialists
      </a>

      @if (loading()) {
        <div class="flex flex-col gap-4" aria-busy="true">
          <span class="sr-only" role="status">Loading the doctor's page…</span>
          <div class="sd-shimmer h-40 rounded-card"></div>
          <div class="sd-shimmer h-11 w-full max-w-xl rounded-pill"></div>
          <div class="sd-shimmer h-72 rounded-card"></div>
        </div>
      } @else if (loadError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-14 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ loadError() }}</p>
          <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean hover:border-cerulean ${FOCUS_RING}" (click)="load()">
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </button>
        </div>
      } @else if (detail(); as d) {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 sm:p-6" aria-labelledby="bo-doctor-name">
          <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div class="flex min-w-0 items-start gap-4">
              @if (photoSrc(); as src) {
                <img [src]="src" alt="" class="size-16 shrink-0 rounded-full border border-cloud object-cover" />
              } @else {
                <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean" aria-hidden="true">{{ initialsOf(d.profile.name) }}</span>
              }
              <div class="flex min-w-0 flex-col gap-1.5">
                <h1 #heading id="bo-doctor-name" tabindex="-1" class="break-words font-heading text-h4 text-ink focus:outline-none">{{ d.profile.name }}</h1>
                <p class="font-sans text-body-sm text-slate">
                  <span class="text-cerulean">{{ d.profile.specialty }}</span> · {{ money(d.profile.consultation_fee) }} per consultation
                </p>
                <div class="flex flex-wrap items-center gap-1.5">
                  @for (b of badges(); track b.label) {
                    <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                  }
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row lg:shrink-0">
              @if (d.status === 'approved') {
                <button type="button" class="${BTN_DANGER_OUTLINE}" (click)="openSuspend(false)">
                  <sd-icon name="ban" [size]="18" />Suspend
                </button>
              } @else if (d.status === 'suspended') {
                @if (d.suspension && d.stats.upcoming > 0) {
                  <button type="button" class="${BTN_DANGER_OUTLINE}" (click)="openSuspend(true)" aria-describedby="bo-doctor-unfinished">
                    <sd-icon name="refresh-cw" [size]="18" />Finish suspension
                  </button>
                }
                <button type="button" class="${BTN_SUCCESS}" (click)="reinstateOpen.set(true)">
                  <sd-icon name="user-check" [size]="18" />Reinstate
                </button>
              }
            </div>
          </div>

          @if (d.suspension; as s) {
            <sd-alert tone="error">
              <span class="block font-semibold">Suspended{{ s.suspended_at ? ' since ' + dateOnly(s.suspended_at) : '' }} · {{ s.code_label }}</span>
              @if (s.reason) {
                <span class="block whitespace-pre-line break-words">{{ s.reason }}</span>
              }
              <span class="mt-1 block text-caption">Unlisted, signed out and blocked from clinical work. They can still sign in to see this reason and their earnings.</span>
              @if (d.stats.upcoming > 0) {
                <span id="bo-doctor-unfinished" class="mt-1 block text-caption font-semibold">{{ plural(d.stats.upcoming, 'future booking') }} still {{ d.stats.upcoming === 1 ? 'needs' : 'need' }} cancelling and refunding — use “Finish suspension”.</span>
              }
            </sd-alert>
          }
          @if (d.credentials_missing) {
            <sd-alert tone="warning">
              Approved before licensing documents were required{{ d.credentials_due_at ? '; due by ' + calendarDay(d.credentials_due_at) : '' }}. They get reminders but are not suspended automatically — decide here if the documents don't arrive.
            </sd-alert>
          }
          @if (d.status === 'approved' && d.standing; as st) {
            <!-- The API's message speaks to the doctor; staff read it in the third person. -->
            <sd-alert tone="info">
              @if (st.code === 'terms_required') {
                Hasn't accepted the current practitioner terms{{ d.terms?.current_version ? ' (version ' + d.terms?.current_version + ')' : '' }} yet. They can finish consultations already under way, but can't start new ones until they accept in their doctor portal.
              } @else {
                {{ st.message }}
              }
            </sd-alert>
          }
          <div aria-live="polite">
            @if (announcement(); as a) {
              <sd-alert tone="success">{{ a }}</sd-alert>
            }
          </div>
        </section>

        <div class="-mx-1 overflow-x-auto px-1 pb-1">
          <div class="flex w-max min-w-full gap-1 rounded-pill border border-cloud bg-white p-1" role="tablist" aria-label="Doctor record">
            @for (t of tabs; track t.key; let i = $index) {
              <button
                #tabButton
                type="button"
                role="tab"
                [id]="tabId(t.key)"
                [attr.aria-selected]="tab() === t.key"
                [attr.aria-controls]="tab() === t.key ? panelId(t.key) : null"
                [tabIndex]="tab() === t.key ? 0 : -1"
                class="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors ${FOCUS_RING}"
                [class]="tab() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
                (click)="selectTab(t.key)"
                (keydown)="onTabKeydown($event, i)"
              >
                {{ t.label }}
                @if (tabCount(t.key); as n) {
                  <span class="flex min-w-5 items-center justify-center rounded-full bg-warning/25 px-1.5 text-[11px] font-semibold text-ink">{{ n }}<span class="sr-only"> waiting</span></span>
                }
              </button>
            }
          </div>
        </div>

        <div role="tabpanel" [id]="panelId(tab())" [attr.aria-labelledby]="tabId(tab())" tabindex="0" class="rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40">
          @switch (tab()) {
            @case ('overview') {
              <bo-specialist-overview [detail]="d" (updated)="apply($event)" />
            }
            @case ('credentials') {
              <bo-specialist-credentials [detail]="d" (updated)="apply($event)" />
            }
            @case ('review') {
              <bo-specialist-review [detail]="d" (updated)="apply($event)" (openTab)="selectTab($event, true)" />
            }
            @case ('appointments') {
              <bo-specialist-appointments [specialistId]="d.profile.id" [version]="version()" />
            }
            @case ('earnings') {
              <bo-specialist-earnings [specialistId]="d.profile.id" [suspended]="d.status === 'suspended'" />
            }
            @case ('reviews') {
              <bo-specialist-reviews [specialistId]="d.profile.id" [summary]="d.stats.reviews" />
            }
            @case ('history') {
              <bo-specialist-history [specialistId]="d.profile.id" [version]="version()" />
            }
          }
        </div>

        <bo-suspend-dialog
          [open]="suspendOpen()"
          [specialistId]="d.profile.id"
          [doctorName]="d.profile.name"
          [finishCode]="finishingSuspension() ? (d.suspension?.code ?? null) : null"
          [finishReason]="finishingSuspension() ? (d.suspension?.reason ?? null) : null"
          (closed)="suspendOpen.set(false); focusHeadingIfLost()"
          (suspended)="apply($event); announcement.set(''); reload()"
        />
        <bo-reinstate-dialog
          [open]="reinstateOpen()"
          [detail]="d"
          (closed)="reinstateOpen.set(false); focusHeadingIfLost()"
          (reinstated)="apply($event); announcement.set('Reinstated. The doctor is listed and bookable again, and has been emailed.')"
          (openTab)="reinstateOpen.set(false); selectTab($event, true)"
        />
      }
    </div>
  `,
})
export class AdminSpecialistDetail implements OnInit, HasUnsavedChanges {
  private readonly api = inject(SpecialistsApi);
  private readonly dialogs = inject(DialogService);
  private readonly overviewTab = viewChild(SpecialistOverviewTab);
  private readonly doc = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reviewQueue = inject(ReviewQueue);

  protected readonly tabs = TABS;
  protected readonly detail = signal<SpecialistDetailDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly tab = signal<DoctorTab>('overview');
  /** Bumped after every change, so the appointments and history tabs re-read. */
  protected readonly version = signal(0);
  protected readonly suspendOpen = signal(false);
  /** The suspend dialog finishes an earlier suspension that stopped part-way. */
  protected readonly finishingSuspension = signal(false);
  protected readonly reinstateOpen = signal(false);
  /** A standing change to announce under the header. */
  protected readonly announcement = signal('');

  /**
   * The list's filters, handed over by its row link, so "Back" returns to them
   * (read from the navigation that is opening this page; after a reload, from
   * the history entry the router saved it in).
   */
  protected readonly backParams: Params =
    (this.router.currentNavigation()?.extras.state?.['listQuery'] as Params | undefined) ??
    (history.state?.listQuery as Params | undefined) ??
    {};

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private id = '';
  private loadSub?: Subscription;

  protected readonly photoSrc = computed(() => this.api.assetUrl(this.detail()?.profile.photo_url ?? null));

  protected readonly badges = computed<Badge[]>(() => {
    const d = this.detail();
    if (!d) return [];
    const out: Badge[] = [statusBadge(d.status)];
    if (d.status === 'approved' || d.status === 'suspended' || d.licence.status !== 'missing') out.push(licenceStateBadge(d.licence));
    out.push(loginBadge(d.login));
    const waiting = d.credentials.filter((c) => c.status === 'pending').length;
    if (waiting > 0) out.push({ label: plural(waiting, 'document') + ' to verify', icon: 'file-check', cls: 'bg-warning/15 text-ink' });
    if (d.pending_changes) out.push({ label: 'Changes pending', icon: 'square-pen', cls: 'bg-warning/15 text-ink' });
    if (d.credentials_missing) out.push({ label: 'Credentials missing', icon: 'badge-alert', cls: 'bg-alert/10 text-alert' });
    if (!d.profile.available && d.status === 'approved') out.push({ label: 'Bookings paused', icon: 'calendar-off', cls: 'bg-cloud text-slate' });
    // Consultations they didn't attend in the alert window (Booking settings: doctor no-show alert).
    const noShows = d.stats.doctor_no_shows_30d ?? 0;
    if (noShows > 0) out.push({ label: `${plural(noShows, 'missed consultation')} in 30 days`, icon: 'calendar-x', cls: 'bg-alert/10 text-alert' });
    return out;
  });

  ngOnInit(): void {
    const wanted = this.route.snapshot.queryParamMap.get('tab') as DoctorTab | null;
    if (wanted && TABS.some((t) => t.key === wanted)) this.tab.set(wanted);
    // Another doctor's page reuses this component: follow the id.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id') ?? '';
      if (id === this.id) return;
      this.id = id;
      this.detail.set(null);
      this.load();
    });
  }

  protected load(): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    this.loadSub = this.api
      .detail(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.detail.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, "Could not load this doctor's page."));
          this.loading.set(false);
        },
      });
  }

  /**
   * Re-read the page in place (no loading state, so an open dialog stays) —
   * after a suspension, whose summary doesn't carry the upcoming-bookings count
   * or the login. A failure keeps what is shown.
   */
  protected reload(): void {
    const id = this.id;
    this.api
      .detail(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (this.id === id && !this.loading()) this.detail.set(res.data);
        },
        error: () => undefined,
      });
  }

  protected openSuspend(finish: boolean): void {
    this.finishingSuspension.set(finish);
    this.suspendOpen.set(true);
  }

  /** Merge what a tab or dialog changed (review summary, profile…) into the page. */
  protected apply(patch: Partial<SpecialistDetailDto>): void {
    this.detail.update((d) => (d ? { ...d, ...patch, profile: { ...d.profile, ...(patch.profile ?? {}) } } : d));
    this.version.update((v) => v + 1);
    this.reviewQueue.refresh();
  }

  /** Waiting-for-a-reviewer counts on the Credentials / Review tabs (0 hides it). */
  protected tabCount(key: DoctorTab): number {
    const d = this.detail();
    if (!d) return 0;
    if (key === 'credentials') return d.credentials.filter((c) => c.status === 'pending').length;
    if (key === 'review') return (d.status === 'pending_review' ? 1 : 0) + (d.pending_changes ? 1 : 0);
    return 0;
  }

  /** For the route's unsavedChangesGuard: unsaved edits on the Overview tab. */
  hasUnsavedChanges(): boolean {
    return this.overviewTab()?.hasUnsavedChanges() ?? false;
  }
  readonly leaveCopy: LeaveCopy = {
    title: 'Leave without saving the profile?',
    message: "Your edits to this doctor's profile haven't been saved. If you leave now, they'll be lost.",
  };

  /** Show a tab; resolves false when the person chose to keep editing the Overview instead. */
  protected async selectTab(key: DoctorTab, focusPanel = false): Promise<boolean> {
    // Switching tabs drops the Overview form: ask when it holds unsaved edits.
    if (this.asksBeforeLeaving(key) && !(await this.dialogs.confirmLeave(this.leaveCopy))) return false;
    this.tab.set(key);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: key === 'overview' ? null : key },
      queryParamsHandling: 'merge',
      replaceUrl: true,
      // Keep the list's filters for "Back to specialists".
      state: { listQuery: this.backParams },
    });
    if (focusPanel) {
      const i = TABS.findIndex((t) => t.key === key);
      // After any dialog that led here has gone (the page is inert while one closes).
      afterDialogCloses(() => this.tabButtons()[i]?.nativeElement.focus(), this.doc);
    }
    return true;
  }

  protected onTabKeydown(event: KeyboardEvent, index: number): void {
    const last = TABS.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    if (!this.asksBeforeLeaving(TABS[next].key)) {
      void this.selectTab(TABS[next].key);
      this.tabButtons()[next]?.nativeElement.focus();
      return;
    }
    // Focus moves only once the leave prompt is answered — to the new tab, or
    // back to this one on "Keep editing" — and after the prompt has closed.
    void this.selectTab(TABS[next].key).then((ok) =>
      afterDialogCloses(() => this.tabButtons()[ok ? next : index]?.nativeElement.focus(), this.doc),
    );
  }

  /** Leaving the Overview with unsaved edits asks first. */
  private asksBeforeLeaving(key: DoctorTab): boolean {
    return key !== this.tab() && this.tab() === 'overview' && this.hasUnsavedChanges();
  }

  protected tabId(key: DoctorTab): string {
    return `bo-doctor-tab-${key}`;
  }
  protected panelId(key: DoctorTab): string {
    return `bo-doctor-panel-${key}`;
  }

  protected initialsOf(name: string): string {
    return initials(name);
  }
  protected money(amount: string): string {
    return money(amount);
  }
  protected dateOnly(iso: string | null): string {
    return dateOnly(iso);
  }
  protected calendarDay(ymd: string | null | undefined): string {
    return calendarDay(ymd);
  }
  protected plural(n: number, word: string): string {
    return plural(n, word);
  }

  /**
   * After suspend / reinstate the button that opened the dialog is gone, so
   * focus would fall to the page body — put it on the doctor's name instead.
   */
  protected focusHeadingIfLost(): void {
    setTimeout(() => {
      const active = this.doc.activeElement;
      if (!active || active === this.doc.body) this.heading()?.nativeElement.focus();
    }, 50);
  }
}
