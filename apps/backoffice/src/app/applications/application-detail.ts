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
import { type Observable, type Subscription, tap } from 'rxjs';
import { AdminDoctorApplicationsApi, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type {
  ApproveApplicationResultDto,
  DoctorApplicationAction,
  DoctorApplicationDetailDto,
  DoctorInviteResultDto,
  SuccessResponse,
} from '@supadoc/models';
import { AlertComponent, DialogService, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { afterDialogCloses, focusIfLost } from '../shared/after-dialog';
import {
  BACK_LINK,
  BTN_ICON,
  BTN_PRIMARY,
  CHIP,
  DETAIL_ACTIONS,
  DETAIL_AVATAR,
  DETAIL_HEADER,
  DETAIL_NAME,
  EMPTY_FRAME,
  FOCUS_RING,
  INFO_TILE,
  INFO_TILE_LABEL,
  INFO_TILE_VALUE,
  INFO_TILES,
  PAGE,
  PAGE_HEADER_DETAIL,
  PAGE_SUBTITLE,
  PILL,
} from '../shared/layout';
import {
  type Badge,
  BTN_DANGER_OUTLINE,
  BTN_SECONDARY,
  BTN_SUCCESS,
  dateOnly,
  initials,
  loginBadge,
} from '../specialists/specialist-ui';
import {
  applicationStatusBadge,
  type ApplicationTab as TabKey,
  NEEDS_ACTION_BADGE,
  openInfoRequest,
  routeBadge,
  waitingLabel,
  waitingSince,
} from './application-ui';
import { ApplicationsQueue } from './applications-queue';
import { ApproveDialog } from './dialogs/approve-dialog';
import { isConflict, RequestInfoDialog } from './dialogs/request-info-dialog';
import { ScheduleInterviewDialog } from './dialogs/schedule-interview-dialog';
import { ApplicationTab } from './tabs/application-tab';
import { ApplicationDocumentsTab } from './tabs/documents-tab';
import { ApplicationNotesTab } from './tabs/notes-tab';
import { ApplicationTimelineTab } from './tabs/timeline-tab';

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'application', label: 'Application' },
  { key: 'documents', label: 'Documents' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'notes', label: 'Notes' },
];

/** One button of the actions column. */
export interface ActionButton {
  readonly action: DoctorApplicationAction;
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
}

/**
 * The actions a reviewer gets for a status, in order (the primary first),
 * limited to what the API allows now (`actions[]`).
 */
export function actionButtons(d: Pick<DoctorApplicationDetailDto, 'status' | 'actions'>): ActionButton[] {
  const allowed = new Set(d.actions ?? []);
  const start: ActionButton = {
    action: 'start_review',
    label: d.status === 'submitted' ? 'Start review' : 'Resume review',
    icon: 'search-check',
    cls: d.status === 'submitted' ? BTN_PRIMARY : BTN_SECONDARY,
  };
  const approve: ActionButton = { action: 'approve', label: 'Approve', icon: 'badge-check', cls: BTN_SUCCESS };
  const schedule: ActionButton = {
    action: 'schedule_interview',
    label: d.status === 'interview_scheduled' ? 'Reschedule' : 'Schedule interview',
    icon: 'calendar-plus',
    cls: BTN_SECONDARY,
  };
  const resend: ActionButton = { action: 'resend_interview', label: 'Resend interview details', icon: 'send', cls: BTN_SECONDARY };
  const info: ActionButton = { action: 'request_info', label: 'Request more info', icon: 'message-square', cls: BTN_SECONDARY };
  const reject: ActionButton = { action: 'reject', label: 'Reject', icon: 'circle-x', cls: BTN_DANGER_OUTLINE };
  const byStatus: Partial<Record<DoctorApplicationDetailDto['status'], ActionButton[]>> = {
    submitted: [start, reject],
    under_review: [approve, schedule, info, reject],
    more_info_needed: [start, reject],
    interview_scheduled: [approve, schedule, resend, info, start, reject],
  };
  return (byStatus[d.status] ?? []).filter((b) => allowed.has(b.action));
}

/**
 * One doctor application (route `/applications/:id`, needs
 * `specialists.manage`): who applied and where it stands — reference (copy),
 * status, licence route, how long it has waited and who started the review —
 * with the actions the status allows (start / resume review, request more
 * info, schedule or reschedule the interview and resend its details, approve,
 * reject), and tabs for the application itself, its documents, the timeline
 * and internal notes (`?tab=`). Once approved it links to the new doctor page
 * and can resend their invite. Every action re-reads the page and the nav
 * badge.
 */
@Component({
  selector: 'bo-application-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    EmptyStateComponent,
    IconComponent,
    ApplicationTab,
    ApplicationDocumentsTab,
    ApplicationTimelineTab,
    ApplicationNotesTab,
    RequestInfoDialog,
    ScheduleInterviewDialog,
    ApproveDialog,
  ],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER_DETAIL}">
        <p class="${PAGE_SUBTITLE}">Doctor application</p>
        <a routerLink="/applications" [queryParams]="backParams" class="${BACK_LINK}" aria-label="Back to applications">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Applications
        </a>
      </header>

      @if (loading()) {
        <div class="flex flex-col gap-6" aria-busy="true">
          <span class="sr-only" role="status">Loading the application…</span>
          <div class="sd-shimmer h-48 rounded-card"></div>
          <div class="sd-shimmer h-12 w-full max-w-xl rounded-pill"></div>
          <div class="sd-shimmer h-72 rounded-card"></div>
        </div>
      } @else if (loadError()) {
        <div class="${EMPTY_FRAME}">
          <sd-empty-state icon="wifi-off" tone="error" title="Couldn't open this application" [message]="loadError()">
            <button type="button" class="${BTN_SECONDARY}" (click)="load()">
              <sd-icon name="refresh-cw" [size]="16" />Try again
            </button>
          </sd-empty-state>
        </div>
      } @else if (detail(); as d) {
        <section class="${DETAIL_HEADER}" aria-labelledby="bo-app-name">
          <div class="flex min-w-0 flex-col gap-4">
            <div class="flex min-w-0 flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
              <span class="${DETAIL_AVATAR}" aria-hidden="true">{{ initials(d.full_name) }}</span>
              <div class="flex min-w-0 flex-1 flex-col gap-2.5">
                <h1 #heading id="bo-app-name" tabindex="-1" class="${DETAIL_NAME} focus:outline-none">{{ d.full_name }}</h1>
                <div class="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                  <span class="select-all break-all font-mono text-body-sm text-ink">{{ d.reference }}</span>
                  <button type="button" class="${BTN_ICON}" (click)="copyReference(d.reference)" [attr.aria-label]="'Copy reference ' + d.reference">
                    <sd-icon [name]="copied() ? 'check' : 'copy'" [size]="16" />
                  </button>
                  <span class="sr-only" role="status">{{ copied() ? 'Reference copied' : '' }}</span>
                </div>
                <div class="flex flex-wrap items-center justify-center gap-1.5 sm:justify-start">
                  @for (b of badges(); track b.label) {
                    <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                  }
                  <span class="${CHIP}" [class]="route().cls"><sd-icon [name]="route().icon" [size]="14" />{{ route().label }}</span>
                </div>
                <p class="flex flex-wrap justify-center gap-x-3 gap-y-1 font-sans text-caption text-slate sm:justify-start">
                  <span>Submitted {{ day(d.submitted_at) }}</span>
                  @if (d.awaiting_staff) {
                    <span class="font-semibold text-ink">{{ waiting() }}</span>
                  }
                  @if (d.review_started_by_name) {
                    <span>Review started by {{ d.review_started_by_name }}{{ d.review_started_at ? ' on ' + day(d.review_started_at) : '' }}</span>
                  }
                </p>
              </div>
            </div>

            <dl class="${INFO_TILES}">
              <div class="${INFO_TILE}">
                <dt class="${INFO_TILE_LABEL}"><sd-icon name="mail" [size]="14" />Email</dt>
                <dd class="${INFO_TILE_VALUE} break-all">{{ d.email }}</dd>
              </div>
              <div class="${INFO_TILE}">
                <dt class="${INFO_TILE_LABEL}"><sd-icon name="phone" [size]="14" />Phone</dt>
                <dd class="${INFO_TILE_VALUE}">{{ d.phone || '—' }}</dd>
              </div>
              <div class="${INFO_TILE}">
                <dt class="${INFO_TILE_LABEL}"><sd-icon name="stethoscope" [size]="14" />Speciality</dt>
                <dd class="${INFO_TILE_VALUE}">{{ d.specialty || '—' }}</dd>
              </div>
            </dl>

            @if (d.status === 'rejected') {
              <div class="rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-ink">
                <span class="block font-semibold">Rejected{{ d.decided_at ? ' on ' + day(d.decided_at) : '' }}{{ d.decided_by_name ? ' by ' + d.decided_by_name : '' }} — reason shown to the applicant:</span>
                <span class="whitespace-pre-line break-words">{{ d.rejection_reason || '—' }}</span>
              </div>
            } @else if (d.status === 'withdrawn') {
              <div class="rounded-field bg-cloud px-4 py-3 font-sans text-body-sm text-ink">
                <span class="block font-semibold">Withdrawn by the applicant{{ d.decided_at ? ' on ' + day(d.decided_at) : '' }}.</span>
                <span>{{ d.withdraw_reason_label ? 'Reason: ' + d.withdraw_reason_label : 'No reason given.' }}</span>
              </div>
            }

            <div aria-live="polite">
              @if (announcement(); as a) {
                <sd-alert tone="success">{{ a }}</sd-alert>
              }
            </div>
          </div>

          <div class="${DETAIL_ACTIONS}">
            <span class="font-heading text-body-lg text-ink">{{ d.status === 'approved' ? 'Doctor' : 'Actions' }}</span>
            @if (d.status === 'more_info_needed') {
              <p class="flex items-start gap-2 rounded-field bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink">
                <sd-icon name="hourglass" [size]="16" class="mt-0.5 shrink-0 text-warning" />
                <span>Waiting for the applicant{{ openRequest() ? ' since ' + day(openRequest()?.requested_at) : '' }}.</span>
              </p>
            }
            @if (d.status === 'approved') {
              @if (d.specialist; as s) {
                <a [routerLink]="['/specialists', s.id]" class="${BTN_PRIMARY} w-full">
                  <sd-icon name="stethoscope" [size]="18" />Open doctor page
                </a>
                <span class="${PILL}" [class]="login().cls"><sd-icon [name]="login().icon" [size]="13" />{{ login().label }}</span>
                @if (!s.login?.password_set) {
                  <button type="button" class="${BTN_SECONDARY} w-full" [disabled]="inviting()" (click)="resendInvite(s.id)">
                    <sd-icon [name]="inviting() ? 'loader-circle' : 'mail'" [size]="18" [class.animate-spin]="inviting()" />{{ inviting() ? 'Sending…' : 'Resend invite' }}
                  </button>
                }
                <div aria-live="polite">
                  @if (inviteResult(); as r) {
                    <div class="flex flex-col gap-1 rounded-field px-3 py-2 font-sans text-caption text-ink" [class]="r.email_sent ? 'bg-sage/10' : 'bg-warning/10'">
                      <span>{{ r.email_sent ? 'Invite sent. The link works for 7 days.' : 'The link was created, but the email could not be sent. Try again shortly.' }}</span>
                      @if (r.dev_link) {
                        <span class="break-all text-slate">Testing only — set-password link: <span class="select-all font-mono text-ink">{{ r.dev_link }}</span></span>
                      }
                    </div>
                  }
                  @if (inviteError(); as e) {
                    <sd-alert tone="error">{{ e }}</sd-alert>
                  }
                </div>
              } @else {
                <p class="font-sans text-body-sm text-slate">Approved{{ d.decided_at ? ' on ' + day(d.decided_at) : '' }}.</p>
              }
            } @else if (d.status === 'rejected' || d.status === 'withdrawn') {
              <p class="font-sans text-body-sm text-slate">This application is closed. Nothing more to do.</p>
            } @else {
              @for (b of buttons(); track b.action) {
                <button type="button" [id]="'bo-app-action-' + b.action" class="w-full" [class]="b.cls" (click)="run(b.action)">
                  <sd-icon [name]="b.icon" [size]="18" />{{ b.label }}
                </button>
              } @empty {
                <p class="font-sans text-body-sm text-slate">No actions available right now.</p>
              }
            }
          </div>
        </section>

        <div class="-mx-1 overflow-x-auto px-1 pb-1">
          <div class="flex w-max min-w-full gap-1 rounded-pill border border-haze bg-glacier p-1 shadow-bar" role="tablist" aria-label="Application record">
            @for (t of tabs; track t.key; let i = $index) {
              <button
                #tabButton
                type="button"
                role="tab"
                [id]="tabId(t.key)"
                [attr.aria-selected]="tab() === t.key"
                [attr.aria-controls]="tab() === t.key ? panelId(t.key) : null"
                [tabIndex]="tab() === t.key ? 0 : -1"
                class="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition ${FOCUS_RING}"
                [class]="tab() === t.key ? 'bg-frost text-cerulean-dark shadow-control' : 'text-slate hover:text-ink'"
                (click)="selectTab(t.key)"
                (keydown)="onTabKeydown($event, i)"
              >
                {{ t.label }}
                @if (tabCount(t.key); as n) {
                  <span class="flex min-w-5 items-center justify-center rounded-full bg-cloud px-1.5 text-[11px] font-semibold text-slate">{{ n }}</span>
                }
              </button>
            }
          </div>
        </div>

        <div role="tabpanel" [id]="panelId(tab())" [attr.aria-labelledby]="tabId(tab())" tabindex="0" class="rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40">
          @switch (tab()) {
            @case ('application') {
              <bo-application-tab [detail]="d" />
            }
            @case ('documents') {
              <bo-application-documents [detail]="d" />
            }
            @case ('timeline') {
              <bo-application-timeline [detail]="d" />
            }
            @case ('notes') {
              <bo-application-notes [applicationId]="d.id" (countChange)="notesCount.set($event)" />
            }
          }
        </div>

        <bo-request-info-dialog
          [open]="dialog() === 'request_info'"
          [detail]="d"
          (closed)="closeDialog()"
          (done)="finish($event, 'Request sent. The applicant has been told what to send.')"
          (stale)="reload()"
        />
        <bo-schedule-interview-dialog
          [open]="dialog() === 'schedule_interview'"
          [detail]="d"
          (closed)="closeDialog()"
          (done)="finish($event, d.status === 'interview_scheduled' ? 'New time saved. The applicant has been told.' : 'Interview scheduled. The applicant has been emailed the details.')"
          (stale)="reload()"
        />
        <bo-approve-dialog
          [open]="dialog() === 'approve'"
          [detail]="d"
          (closed)="closeDialog()"
          (approved)="onApproved($event)"
          (stale)="reload()"
        />
      }
    </div>
  `,
})
export class AdminApplicationDetail implements OnInit {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly specialists = inject(SpecialistsApi);
  private readonly dialogs = inject(DialogService);
  private readonly doc = inject(DOCUMENT);
  private readonly route$ = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queue = inject(ApplicationsQueue);

  protected readonly tabs = TABS;
  protected readonly initials = initials;
  protected readonly detail = signal<DoctorApplicationDetailDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly tab = signal<TabKey>('application');
  /** The action dialog that is open. */
  protected readonly dialog = signal<'request_info' | 'schedule_interview' | 'approve' | null>(null);
  protected readonly announcement = signal('');
  protected readonly copied = signal(false);
  protected readonly notesCount = signal(0);
  protected readonly inviting = signal(false);
  protected readonly inviteResult = signal<DoctorInviteResultDto | null>(null);
  protected readonly inviteError = signal('');

  /** The list's filters, handed over by its row link, so "Back" returns to them. */
  protected readonly backParams: Params =
    (this.router.currentNavigation()?.extras.state?.['listQuery'] as Params | undefined) ??
    (history.state?.listQuery as Params | undefined) ??
    {};

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private id = '';
  private loadSub?: Subscription;
  private copiedTimer?: ReturnType<typeof setTimeout>;

  protected readonly badges = computed<Badge[]>(() => {
    const d = this.detail();
    if (!d) return [];
    const out = [applicationStatusBadge(d.status)];
    if (d.awaiting_staff) out.push(NEEDS_ACTION_BADGE);
    return out;
  });
  protected readonly route = computed(() => {
    const d = this.detail();
    return routeBadge(d?.licence_route ?? 'ng', d?.licence_label);
  });
  protected readonly waiting = computed(() => {
    const d = this.detail();
    return d ? waitingLabel(waitingSince(d)) : '';
  });
  protected readonly openRequest = computed(() => openInfoRequest(this.detail()?.info_requests));
  protected readonly buttons = computed(() => {
    const d = this.detail();
    return d ? actionButtons(d) : [];
  });
  protected readonly login = computed(() => loginBadge(this.detail()?.specialist?.login));

  ngOnInit(): void {
    const wanted = this.route$.snapshot.queryParamMap.get('tab') as TabKey | null;
    if (wanted && TABS.some((t) => t.key === wanted)) this.tab.set(wanted);
    // Another application's page reuses this component: follow the id.
    this.route$.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id') ?? '';
      if (id === this.id) return;
      this.id = id;
      this.detail.set(null);
      this.announcement.set('');
      this.inviteResult.set(null);
      this.load();
    });
    this.destroyRef.onDestroy(() => clearTimeout(this.copiedTimer));
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
          this.setDetail(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load this application.'));
          this.loading.set(false);
        },
      });
  }

  /** Re-read in place (no loading state, so an open dialog stays) — after a 409, or an invite. */
  protected reload(): void {
    const id = this.id;
    this.api
      .detail(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (this.id === id && !this.loading()) this.setDetail(res.data);
        },
        error: () => undefined,
      });
  }

  private setDetail(d: DoctorApplicationDetailDto): void {
    this.detail.set(d);
    this.notesCount.set(d.notes_count ?? 0);
  }

  /** What an action returned: the page, the nav badge and the reviewer's notice. */
  protected apply(d: DoctorApplicationDetailDto, notice = ''): void {
    this.setDetail(d);
    this.announcement.set(notice);
    this.queue.refresh();
  }

  protected run(action: DoctorApplicationAction): void {
    const d = this.detail();
    if (!d) return;
    this.announcement.set('');
    switch (action) {
      case 'start_review':
        void this.startReview(d);
        break;
      case 'reject':
        void this.reject(d);
        break;
      case 'resend_interview':
        void this.resendInterview(d);
        break;
      default:
        this.dialog.set(action);
    }
  }

  private async startReview(d: DoctorApplicationDetailDto): Promise<void> {
    const first = d.status === 'submitted';
    const { confirmed } = await this.dialogs.confirm({
      tone: 'info',
      icon: 'search-check',
      title: first ? 'Start reviewing this application?' : 'Resume the review?',
      message: first
        ? 'The applicant is told by email and SMS that their application is under review.'
        : "The applicant's status goes back to Under review.",
      confirmLabel: first ? 'Start review' : 'Resume review',
      action: () => this.act(this.api.startReview(d.id, { expected_status: d.status })),
    });
    if (confirmed) this.afterAction(first ? 'Review started. The applicant has been told.' : 'Review resumed.');
  }

  private async reject(d: DoctorApplicationDetailDto): Promise<void> {
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'circle-x',
      title: 'Reject this application?',
      message: 'The applicant is told by email and SMS. This can’t be undone; they can apply again.',
      reason: {
        label: 'Reason (shown to the applicant)',
        required: true,
        maxLength: 2000,
        hint: 'They see this on their status page and in an email. Be clear and kind.',
      },
      confirmLabel: 'Reject application',
      size: 'md',
      action: (reason) => this.act(this.api.reject(d.id, { expected_status: d.status, reason: reason ?? '' })),
    });
    if (confirmed) this.afterAction('Application rejected. The applicant has been told why.');
  }

  private async resendInterview(d: DoctorApplicationDetailDto): Promise<void> {
    const { confirmed } = await this.dialogs.confirm({
      tone: 'info',
      icon: 'send',
      title: 'Resend the interview details?',
      message: 'The applicant gets the interview email and SMS again, with the same time and link.',
      confirmLabel: 'Resend details',
      action: () => this.act(this.api.resendInterview(d.id)),
    });
    if (confirmed) this.afterAction('Interview details sent again.');
  }

  /** Runs an action inside a confirm dialog: applies its result; a 409 re-reads the page behind. */
  private act(req: Observable<SuccessResponse<DoctorApplicationDetailDto>>): Observable<unknown> {
    return req.pipe(
      tap({
        next: (res) => this.apply(res.data),
        error: (err: unknown) => {
          if (isConflict(err)) this.reload();
        },
      }),
    );
  }

  /** After a confirm: the notice, and focus back on the page (the button that opened it may be gone). */
  private afterAction(notice: string): void {
    this.announcement.set(notice);
    this.focusHeadingIfLost();
  }

  /** A dialog's work is done: close it, apply the result, announce it. */
  protected finish(d: DoctorApplicationDetailDto, notice: string): void {
    this.dialog.set(null);
    this.apply(d, notice);
    this.focusHeadingIfLost();
  }

  protected closeDialog(): void {
    this.dialog.set(null);
    this.focusHeadingIfLost();
  }

  /** Approved: the dialog stays on its result until "Done"; the page behind shows the approval. */
  protected onApproved(result: ApproveApplicationResultDto): void {
    this.apply(result.application, 'Approved. The doctor profile was created.');
  }

  protected resendInvite(specialistId: string): void {
    if (this.inviting()) return;
    this.inviting.set(true);
    this.inviteError.set('');
    this.inviteResult.set(null);
    this.specialists
      .invite(specialistId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.inviting.set(false);
          this.inviteResult.set(res.data);
          this.reload();
        },
        error: (err: unknown) => {
          this.inviting.set(false);
          this.inviteError.set(apiErrorMessage(err, 'Could not send the invite.'));
        },
      });
  }

  protected async copyReference(reference: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(reference);
      this.copied.set(true);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), 2500);
    } catch {
      // No clipboard (an insecure origin, a denied permission): the reference stays selectable.
      this.copied.set(false);
    }
  }

  /** Counts on the Documents / Notes tabs (0 hides it). */
  protected tabCount(key: TabKey): number {
    const d = this.detail();
    if (!d) return 0;
    if (key === 'documents') return d.documents.filter((x) => x.state === 'active').length;
    if (key === 'notes') return this.notesCount();
    return 0;
  }

  protected selectTab(key: TabKey): void {
    this.tab.set(key);
    void this.router.navigate([], {
      relativeTo: this.route$,
      queryParams: { tab: key === 'application' ? null : key },
      queryParamsHandling: 'merge',
      replaceUrl: true,
      // Keep the list's filters for "Back to applications".
      state: { listQuery: this.backParams },
    });
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
    this.selectTab(TABS[next].key);
    this.tabButtons()[next]?.nativeElement.focus();
  }

  protected tabId(key: TabKey): string {
    return `bo-app-tab-${key}`;
  }
  protected panelId(key: TabKey): string {
    return `bo-app-panel-${key}`;
  }

  protected day(iso: string | null | undefined): string {
    return dateOnly(iso);
  }

  /** After an action the button that opened it may be gone — put focus on the applicant's name. */
  private focusHeadingIfLost(): void {
    afterDialogCloses(() => focusIfLost(this.heading()?.nativeElement, this.doc), this.doc);
  }
}
