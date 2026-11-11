import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { apiErrorMessage, DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto, LabRequestDto, LabRequestSummaryDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { DocumentViewerService, type ViewerWatermark } from '@supadoc/viewer';
import type { Subscription } from 'rxjs';
import { WS_RESULTS_NOT_SHARED } from '../call-workspace/call-workspace-copy';
import { DoctorClock } from '../doctor-clock';
import { focusAfterDialogs } from '../focus-after-dialog';
import { RX_ACTION } from '../prescriptions/rx-shared';
import { CallLabComposer } from './call-lab-composer';
import { CallLabRequestDetail } from './call-lab-request-detail';
import { LabFiles } from './lab-files';
import { LAB_PRIORITY_META, LAB_STATUS_META, type LabChipMeta, labDayLabel, labStatusMeta, numberParts } from './lab-ui';
import { isOpenableResult, labResultSource } from './lab-viewer-sources';

/** The tab's three views, one at a time: the list, the composer, a request's drill-in. */
export type CallLabView = 'list' | 'compose' | 'detail';

/**
 * The call workspace's "Lab requests" tab, on the light paper zone the host
 * puts around it (like Prescriptions). Everything happens in place: "New lab
 * request" swaps the list for the composer (this patient, this consultation),
 * "Open" for the request's drill-in; nothing opens a tab or navigates. The
 * host keeps this mounted for the call, so a request being written survives
 * closing the workspace, a tab switch and a sign-out. Lists this
 * consultation's requests (refreshed each time the list shows again) and,
 * read-only, any earlier lab orders; PDFs and results open in the shared
 * viewer over the call.
 */
@Component({
  selector: 'doc-call-lab-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, CallLabComposer, CallLabRequestDetail],
  host: {
    class: 'block',
    '(window:focus)': 'onFocus()',
    '(document:visibilitychange)': 'onVisibility()',
  },
  template: `
    @switch (view()) {
      @case ('compose') {
        <doc-call-lab-composer
          [patientId]="patientId() ?? ''"
          [appointmentId]="appointmentId() ?? ''"
          [duplicate]="dupSource()"
          [disabled]="!signedIn()"
          (closed)="onComposerClosed()"
          (done)="onSent($event)"
        />
      }
      @case ('detail') {
        <doc-call-lab-request-detail
          [labId]="detailId() ?? ''"
          [patientId]="patientId()"
          [watermark]="watermark()"
          [active]="active()"
          [sharing]="sharing()"
          [signedIn]="signedIn()"
          (back)="onDetailBack()"
          (duplicate)="compose($event)"
        />
      }
      @default {
        <section class="flex flex-col gap-4" aria-labelledby="call-lab-list-title">
          <header class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 flex-col gap-0.5">
              <h2 id="call-lab-list-title" tabindex="-1" class="flex items-center gap-2 font-heading text-body-lg text-ink outline-none">
                <sd-icon name="flask-conical" [size]="18" class="text-cerulean" /> Lab requests
              </h2>
              <p class="font-sans text-caption text-slate">Requested during this consultation.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <!-- Never disabled while loading: a pressed button that disables itself drops focus to <body>. -->
              <button
                type="button"
                class="${RX_ACTION} min-h-11 min-w-11"
                aria-label="Refresh the lab requests"
                [attr.aria-busy]="loading() || null"
                (click)="refresh()"
              >
                <sd-icon name="refresh-cw" [size]="16" />
              </button>
              <sd-button id="call-lab-new" size="sm" [disabled]="!canCompose()" (click)="compose()">
                <sd-icon name="plus" [size]="16" /> New lab request
              </sd-button>
            </div>
          </header>

          @if (patientError()) {
            <sd-alert tone="error">
              {{ patientError() }}
              <button type="button" class="ml-1 font-semibold underline underline-offset-2" (click)="retryPatient.emit()">Try again</button>
            </sd-alert>
          } @else if (detailsFailed()) {
            <p class="font-sans text-body-sm text-slate">Lab requests are available once this consultation's details have loaded.</p>
          } @else if (!patientId()) {
            <p class="font-sans text-caption text-slate" role="status">Loading the patient…</p>
          }

          @if (notice()) {
            <sd-alert #noticeEl tabindex="-1" class="outline-none" tone="success">{{ notice() }}</sd-alert>
          }

          <!-- The shimmer, the error card and the empty card only while there are no rows: every return to the
               list re-reads it, and the rows (focus targets) must stay meanwhile. -->
          @if (requests().length === 0) {
            @if (loading()) {
              <div class="flex flex-col gap-3" aria-busy="true">
                <span class="sr-only">Loading lab requests…</span>
                <div class="sd-shimmer h-24 rounded-card"></div>
                <div class="sd-shimmer h-24 rounded-card"></div>
              </div>
            } @else if (error()) {
              <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-10 text-center shadow-card">
                <sd-icon name="wifi-off" [size]="30" class="text-alert" />
                <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
                <sd-button variant="secondary" size="sm" (click)="refresh()">
                  <sd-icon name="refresh-cw" [size]="16" /> Try again
                </sd-button>
              </div>
            } @else {
              <div class="flex flex-col items-center gap-3 rounded-card border border-dashed border-ash bg-white px-4 py-10 text-center">
                <span class="flex size-14 items-center justify-center rounded-full bg-glacier text-slate">
                  <sd-icon name="flask-conical" [size]="26" />
                </span>
                <p class="font-sans text-body-sm text-slate">No lab requests yet for this consultation</p>
              </div>
            }
          } @else {
            @if (error()) {
              <sd-alert tone="error">{{ error() }}</sd-alert>
            }
            <ul class="flex flex-col gap-3">
              @for (r of requests(); track r.id) {
                @let chip = chipFor(r);
                <li class="@container rounded-card border border-haze bg-white p-4 shadow-card">
                  <div class="flex flex-col gap-3 @xl:flex-row @xl:items-center @xl:justify-between">
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-sans text-body-sm font-semibold text-ink [overflow-wrap:anywhere]">@for (p of numberParts(r.number); track $index) {<span>{{ p }}</span><wbr />}</span>
                        <span class="inline-flex w-fit shrink-0 rounded-xl px-4 py-1.5 font-sans text-caption font-medium" [class]="chip.cls">{{ chip.label }}</span>
                        <span class="font-sans text-caption font-medium" [class]="priorityOf(r).cls">{{ priorityOf(r).label }}</span>
                      </div>
                      <p class="font-sans text-caption text-slate [overflow-wrap:anywhere]">{{ r.tests_label }}</p>
                      <p class="font-sans text-caption text-slate">Sent {{ day(r.sent_at) }}, {{ clock.time(r.sent_at) }}</p>
                    </div>
                    <div class="flex flex-wrap gap-2 @xl:justify-end">
                      <button type="button" class="${RX_ACTION}" [attr.aria-label]="'View PDF of ' + r.number" (click)="viewPdf(r, $event.currentTarget)">
                        <sd-icon name="file-text" [size]="14" /> View PDF
                      </button>
                      @if (r.results_count > 0 && watermark()) {
                        <button
                          type="button"
                          class="${RX_ACTION}"
                          [attr.aria-label]="'View results of ' + r.number"
                          [disabled]="resultsBusy() === r.id"
                          (click)="openResults(r, $event.currentTarget)"
                        >
                          {{ resultsBusy() === r.id ? 'Opening…' : 'Results (' + r.results_count + ')' }}
                        </button>
                      }
                      <button type="button" class="${RX_ACTION}" [attr.data-lab-open]="r.id" [attr.aria-label]="'Open ' + r.number" (click)="openDetail(r.id)">
                        Open <sd-icon name="chevron-right" [size]="14" />
                      </button>
                    </div>
                  </div>
                  @if (resultsNote()?.id === r.id) {
                    <p class="mt-2 font-sans text-caption text-slate" role="status">{{ resultsNote()?.text }}</p>
                  }
                </li>
              }
            </ul>
          }

          @if (legacy().length) {
            <section class="flex flex-col gap-3" aria-labelledby="call-lab-legacy-title">
              <div class="flex flex-col gap-0.5">
                <h3 id="call-lab-legacy-title" class="font-heading text-body font-semibold text-ink">Earlier lab orders</h3>
                <p class="font-sans text-caption text-slate">Ordered before lab requests. They can't be changed.</p>
              </div>
              <ul class="flex flex-col gap-2">
                @for (o of legacy(); track o.id) {
                  <li class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-haze bg-white px-4 py-3">
                    <span class="min-w-0 flex-1 font-sans text-body-sm text-ink [overflow-wrap:anywhere]">{{ o.tests.join(', ') }}</span>
                    <span class="font-sans text-caption text-slate">{{ o.priority === 'urgent' ? 'Urgent' : 'Routine' }}</span>
                    <span class="rounded-xl bg-cloud px-3 py-1 font-sans text-caption font-medium text-slate">Ordered</span>
                  </li>
                }
              </ul>
            </section>
          }
        </section>
      }
    }
  `,
})
export class CallLabRequests {
  protected readonly clock = inject(DoctorClock);
  private readonly api = inject(LabRequestsApi);
  private readonly doctorApi = inject(DoctorApi);
  private readonly files = inject(LabFiles);
  private readonly viewer = inject(DocumentViewerService);
  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  readonly appointmentId = input<string | null>(null);
  readonly patientId = input<string | null>(null);
  /** The patient could not be found for this consultation (doc-call's rxPatientError()). */
  readonly patientError = input('');
  /** The consultation's details failed to load. */
  readonly detailsFailed = input(false);
  /** Signed in to the doctor portal in this browser (as this call's doctor). */
  readonly signedIn = input(false);
  /** The view-only watermark (results open only with one). */
  readonly watermark = input<ViewerWatermark | null>(null);
  /** The tab is on screen in an open workspace: the list re-reads each time it shows again. */
  readonly active = input(true);
  /** The doctor shares their screen: no "Abnormal" anywhere in this tab. */
  readonly sharing = input(false);
  /** Bumped by the host to open the composer (the Full EMR's New lab request); a request being written is kept. */
  readonly composeRequest = input(0);

  readonly retryPatient = output<void>();

  protected readonly numberParts = numberParts;
  private readonly viewState = signal<CallLabView>('list');
  /** Which view shows (read by doc-call). */
  readonly view = this.viewState.asReadonly();
  readonly composing = computed(() => this.viewState() === 'compose');
  private readonly composerHost = viewChild(CallLabComposer);
  /** A request is being written and has not been sent (launcher, tab mark, Leave / End). */
  readonly unsent = computed(() => this.composing() && !!this.composerHost()?.unsent());
  /** "Send to Patient" is waiting for the server. */
  readonly sending = computed(() => this.composing() && !!this.composerHost()?.sending());

  protected readonly canCompose = computed(() => this.signedIn() && !!this.patientId() && !!this.appointmentId() && !this.detailsFailed());
  protected readonly detailId = signal<string | null>(null);
  protected readonly dupSource = signal<LabRequestDto | null>(null);
  protected readonly notice = signal('');
  protected readonly requests = signal<LabRequestSummaryDto[]>([]);
  protected readonly legacy = signal<LabOrderDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  /** The request whose results are being read ("Opening…"). */
  protected readonly resultsBusy = signal<string | null>(null);
  /** Under a request: none of its results can be opened, or they could not be read. */
  protected readonly resultsNote = signal<{ readonly id: string; readonly text: string } | null>(null);
  private readonly noticeEl = viewChild<string, ElementRef<HTMLElement>>('noticeEl', { read: ElementRef });
  private subs: Subscription[] = [];
  private resultsSub: Subscription | null = null;
  private handledCompose = 0;

  constructor() {
    effect(() => {
      const signedIn = this.signedIn();
      const id = this.appointmentId();
      const active = this.active();
      const view = this.viewState();
      untracked(() => {
        if (!signedIn || !id) {
          this.clear();
          // The drill-in holds nothing to lose and shows patient details. A request being written is kept.
          if (view === 'detail') this.viewState.set('list');
        } else if (active && view === 'list') {
          this.refresh();
        } else {
          this.cancelResults();
        }
      });
    });
    // The Full EMR's "New lab request". A request that cannot be honoured now is consumed, never replayed.
    effect(() => {
      const n = this.composeRequest();
      untracked(() => {
        if (n <= this.handledCompose) return;
        this.handledCompose = n;
        this.compose();
      });
    });
    this.destroyRef.onDestroy(() => {
      this.subs.forEach((s) => s.unsubscribe());
      this.resultsSub?.unsubscribe();
    });
  }

  /** The composer in place of the list (focus on its title); a request already being written is kept, focus untouched. */
  compose(dup: LabRequestDto | null = null): void {
    if (!this.canCompose() || this.composing()) return;
    this.dupSource.set(dup);
    this.notice.set('');
    this.cancelResults();
    this.viewState.set('compose');
    this.focusAfterRender(() => this.doc.getElementById('call-lab-compose-title'));
  }

  protected openDetail(id: string): void {
    this.detailId.set(id);
    this.notice.set('');
    this.cancelResults();
    this.viewState.set('detail');
    this.focusAfterRender(() => this.doc.getElementById('call-lab-detail-title'));
  }

  /** Back / Cancel in the composer (already asked when something was unsent): nothing was sent. */
  protected onComposerClosed(): void {
    this.viewState.set('list');
    this.dupSource.set(null);
    // The leave prompt may still be closing (the page under it is inert until then).
    focusAfterDialogs(this.injector, () =>
      this.signedIn() ? this.doc.querySelector<HTMLElement>('#call-lab-new button') : this.doc.getElementById('ws-tab-labs'),
    );
  }

  /** Sent, and the doctor left the Sent dialog: the refreshed list, with a focused notice. */
  protected onSent(r: LabRequestDto): void {
    this.viewState.set('list');
    this.dupSource.set(null);
    if (this.signedIn()) {
      this.notice.set(`${r.number} sent — the patient has been notified.`);
      this.focusAfterRender(() => this.noticeEl()?.nativeElement);
      return;
    }
    // Closed by a sign-out: the list is cleared and hidden. Focus only if it was in here (or lost).
    this.focusAfterRender(() => {
      const active = this.doc.activeElement;
      return !active || active === this.doc.body || this.host.nativeElement.contains(active) ? this.doc.getElementById('ws-tab-labs') : null;
    });
  }

  protected onDetailBack(): void {
    const id = this.detailId();
    this.viewState.set('list');
    this.focusAfterRender(() => {
      const open = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-lab-open]')).find((b) => b.getAttribute('data-lab-open') === id);
      return open ?? this.doc.getElementById('call-lab-list-title');
    });
  }

  private focusAfterRender(target: () => HTMLElement | null | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  protected onFocus(): void {
    if (this.active() && this.viewState() === 'list') this.refresh(true);
  }

  protected onVisibility(): void {
    if (this.active() && this.viewState() === 'list' && this.doc.visibilityState === 'visible') this.refresh(true);
  }

  /** The request's PDF in the shared viewer (over the call; focus comes back to the button). */
  protected viewPdf(r: LabRequestSummaryDto, opener: EventTarget | null): void {
    this.files.view(r, opener instanceof HTMLElement ? opener : null);
  }

  /** The results the patient shares, view-only: watermarked, audited, never downloadable. */
  protected openResults(r: LabRequestSummaryDto, opener: EventTarget | null): void {
    const watermark = this.watermark();
    if (!watermark) return;
    this.resultsSub?.unsubscribe();
    this.resultsBusy.set(r.id);
    this.resultsNote.set(null);
    this.resultsSub = this.api.get(r.id).subscribe({
      next: (res) => {
        this.resultsBusy.set(null);
        const openable = res.data.results.filter(isOpenableResult);
        if (!openable.length) {
          this.resultsNote.set({ id: r.id, text: WS_RESULTS_NOT_SHARED });
          return;
        }
        this.viewer.open(
          openable.map((x) => labResultSource(this.api, r.id, x, { onGone: () => this.refresh() })),
          {
            opener: opener instanceof HTMLElement ? opener : null,
            watermark,
            listLabel: 'results',
            fallbackFocus: () => this.doc.getElementById('call-lab-list-title'),
          },
        );
      },
      error: (err: unknown) => {
        this.resultsBusy.set(null);
        this.resultsNote.set({ id: r.id, text: apiErrorMessage(err, 'Could not open the results.') });
      },
    });
  }

  /**
   * Reload this consultation's requests (and the legacy orders). `passive`
   * for the re-read on returning to the window or tab (`X-SD-Passive`: it
   * never extends the idle session); Refresh and each return to the list count.
   */
  refresh(passive = false): void {
    const id = this.appointmentId();
    if (!this.signedIn() || !id) return;
    const options = passive ? { passive: true } : undefined;
    this.subs.forEach((s) => s.unsubscribe());
    this.loading.set(true);
    this.error.set('');
    this.subs = [
      this.api.list({ appointment_id: id, per_page: 50 }, options).subscribe({
        next: (res) => {
          this.requests.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.error.set('Could not load the lab requests.');
        },
      }),
      this.doctorApi.listLabOrders(id, options).subscribe({
        next: (res) => this.legacy.set(Array.isArray(res.data) ? res.data : []),
        error: () => undefined,
      }),
    ];
  }

  private clear(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.subs = [];
    this.requests.set([]);
    this.legacy.set([]);
    this.loading.set(false);
    this.error.set('');
    this.notice.set('');
    this.cancelResults();
    this.resultsNote.set(null);
  }

  /** The list is gone, or no longer showing: a late answer must not open the viewer over whatever is there now. */
  private cancelResults(): void {
    this.resultsSub?.unsubscribe();
    this.resultsSub = null;
    this.resultsBusy.set(null);
  }

  /** The portal's status chip; while sharing, never "Result ready · Abnormal". */
  protected chipFor(r: LabRequestSummaryDto): LabChipMeta {
    if (this.sharing() && r.status === 'result_ready') return LAB_STATUS_META.result_ready;
    return labStatusMeta(r);
  }

  protected priorityOf(r: LabRequestSummaryDto): LabChipMeta {
    return LAB_PRIORITY_META[r.priority] ?? LAB_PRIORITY_META.routine;
  }

  protected day(iso: string): string {
    return labDayLabel(iso, this.clock);
  }
}
