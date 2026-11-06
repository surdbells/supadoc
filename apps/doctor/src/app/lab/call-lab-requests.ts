import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { apiErrorMessage, DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto, LabRequestSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { DocumentViewerService, type ViewerWatermark } from '@supadoc/viewer';
import type { Subscription } from 'rxjs';
import { WS_RESULTS_NOT_SHARED } from '../call-workspace/call-workspace-copy';
import { LabFiles } from './lab-files';
import { labStatusMeta, numberParts } from './lab-ui';
import { isOpenableResult, labResultSource } from './lab-viewer-sources';

export const CALL_LAB_CAPTION = 'Opens in a new tab. Your call stays connected.';
export const CALL_LAB_CAPTION_NARROW =
  "Opens in a new tab. Your call stays connected, but your video may pause while you're in the other tab.";

/**
 * The call cockpit's "Lab requests" tab. "New lab request" opens the composer
 * in a NEW TAB (navigating this tab would drop the call; the portal session is
 * shared through localStorage), with the patient and the consultation filled
 * in. Lists this consultation's requests — refreshed when the doctor comes back
 * to this tab — and, read-only, any earlier lab orders. Each request's PDF and
 * results open in the shared viewer, over the call.
 */
@Component({
  selector: 'doc-call-lab-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'flex flex-col gap-4',
    '(window:focus)': 'onFocus()',
    '(document:visibilitychange)': 'onVisibility()',
  },
  styles: `
    /* White on cerulean in both cockpit themes (the light theme remaps .text-white to ink). */
    .cl-cta {
      background: var(--color-cerulean);
      color: #fff;
    }
    .cl-cta:hover {
      background: var(--color-cerulean-dark);
    }
    .cl-cta[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
  template: `
    @if (!signedIn()) {
      <p class="rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">Sign in to the doctor portal to request tests.</p>
    } @else {
      <div class="flex flex-col gap-1.5">
        <button
          type="button"
          class="cl-cta flex w-fit items-center gap-1.5 rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
          [disabled]="!patientId()"
          (click)="newRequest()"
        >
          <sd-icon name="external-link" [size]="16" /> New lab request
        </button>
        @if (!patientId()) {
          <p class="font-sans text-caption text-white/60" role="status">Loading the patient…</p>
        } @else {
          <p class="font-sans text-caption text-white/60">{{ narrow() ? captionNarrow : caption }}</p>
        }
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <!-- Focus lands here when the viewer closes after its opener has gone. -->
          <p #listHeading tabindex="-1" class="font-sans text-caption font-semibold text-white/60 outline-none">From this consultation</p>
          <button type="button" class="rounded-field px-2 py-1 font-sans text-caption font-semibold text-frost hover:underline" (click)="refresh()">Refresh</button>
        </div>
        @if (error()) {
          <p class="font-sans text-caption text-alert" role="alert">{{ error() }}</p>
        }
        @if (requests().length) {
          <ul class="flex flex-col gap-2">
            @for (r of requests(); track r.id) {
              <li class="flex flex-wrap items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="font-sans text-caption font-semibold text-white/85 [overflow-wrap:anywhere]">@for (p of numberParts(r.number); track $index) {<span>{{ p }}</span><wbr />}</span>
                  <span class="font-sans text-caption text-white/60 [overflow-wrap:anywhere]">{{ r.tests_label }}</span>
                </span>
                <span class="rounded-pill px-2 py-0.5 font-sans text-caption" [class]="chipClass(r)">{{ chipLabel(r) }}</span>
                <button
                  type="button"
                  class="min-h-11 rounded-field px-2 py-1 font-sans text-caption font-semibold text-frost hover:underline"
                  [attr.aria-label]="'View PDF of ' + r.number"
                  (click)="viewPdf(r, $event.currentTarget)"
                >
                  View PDF
                </button>
                @if (r.results_count > 0 && watermark()) {
                  <button
                    type="button"
                    class="min-h-11 rounded-field px-2 py-1 font-sans text-caption font-semibold text-frost hover:underline disabled:opacity-60"
                    [attr.aria-label]="'View results of ' + r.number"
                    [disabled]="resultsBusy() === r.id"
                    (click)="openResults(r, $event.currentTarget)"
                  >
                    {{ resultsBusy() === r.id ? 'Opening…' : 'Results (' + r.results_count + ')' }}
                  </button>
                }
                <button
                  type="button"
                  class="min-h-11 rounded-field px-2 py-1 font-sans text-caption font-semibold text-frost hover:underline"
                  [attr.aria-label]="'Open ' + r.number + ' in a new tab'"
                  (click)="openRequest(r.id)"
                >
                  Open
                </button>
                @if (resultsNote()?.id === r.id) {
                  <p class="w-full font-sans text-caption text-white/70" role="status">{{ resultsNote()?.text }}</p>
                }
              </li>
            }
          </ul>
        } @else if (!loading()) {
          <p class="font-sans text-caption text-white/60">No lab requests from this consultation yet.</p>
        }
      </div>

      @if (legacy().length) {
        <div class="flex flex-col gap-2 border-t border-white/10 pt-3">
          <p class="font-sans text-caption font-semibold text-white/60">Earlier lab orders</p>
          <p class="font-sans text-caption text-white/60">Ordered before lab requests. They can't be changed.</p>
          <ul class="flex flex-col gap-2">
            @for (o of legacy(); track o.id) {
              <li class="flex items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                <sd-icon name="clipboard-list" [size]="16" class="text-frost" />
                <span class="flex-1 font-sans text-body-sm text-white/85">{{ o.tests.join(', ') }}</span>
                <span class="font-sans text-caption text-white/60">{{ o.priority === 'urgent' ? 'Urgent' : 'Routine' }}</span>
                <span class="rounded-pill bg-white/[0.06] px-2 py-0.5 font-sans text-caption text-white/60">Ordered</span>
              </li>
            }
          </ul>
        </div>
      }
    }
  `,
})
export class CallLabRequests {
  private readonly api = inject(LabRequestsApi);
  private readonly doctorApi = inject(DoctorApi);
  private readonly files = inject(LabFiles);
  private readonly viewer = inject(DocumentViewerService);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly appointmentId = input<string | null>(null);
  readonly patientId = input<string | null>(null);
  /** Signed in to the doctor portal in this browser (as this call's doctor). */
  readonly signedIn = input(false);
  /** The cockpit's theme. */
  readonly tone = input<'dark' | 'light'>('dark');
  /** Phone / tablet layout: a background tab may pause the camera. */
  readonly narrow = input(false);
  /** The view-only watermark (results open only with one). */
  readonly watermark = input<ViewerWatermark | null>(null);
  /** The list is on screen: a fresh read each time it comes back, and focus / visibility re-reads only meanwhile. */
  readonly active = input(true);

  protected readonly numberParts = numberParts;
  protected readonly caption = CALL_LAB_CAPTION;
  protected readonly captionNarrow = CALL_LAB_CAPTION_NARROW;
  protected readonly requests = signal<LabRequestSummaryDto[]>([]);
  protected readonly legacy = signal<LabOrderDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  /** The request whose results are being read ("Opening…"). */
  protected readonly resultsBusy = signal<string | null>(null);
  /** Under a request: none of its results can be opened, or they could not be read. */
  protected readonly resultsNote = signal<{ readonly id: string; readonly text: string } | null>(null);
  private readonly listHeading = viewChild<ElementRef<HTMLElement>>('listHeading');
  private subs: Subscription[] = [];
  private resultsSub: Subscription | null = null;

  constructor() {
    effect(() => {
      const signedIn = this.signedIn();
      const id = this.appointmentId();
      const active = this.active();
      untracked(() => {
        if (!signedIn || !id) this.clear();
        else if (active) this.refresh();
        else this.cancelResults();
      });
    });
    this.destroyRef.onDestroy(() => {
      this.subs.forEach((s) => s.unsubscribe());
      this.resultsSub?.unsubscribe();
    });
  }

  /** Opens the composer in a new tab, with the patient and this consultation filled in. */
  protected newRequest(): void {
    const pid = this.patientId();
    if (!pid) return;
    const aid = this.appointmentId();
    if (aid) {
      window.open(
        `/prescriptions/labs/new?patientId=${encodeURIComponent(pid)}&appointmentId=${encodeURIComponent(aid)}`,
        '_blank',
        'noopener',
      );
    } else {
      window.open(`/prescriptions/labs/new?patientId=${encodeURIComponent(pid)}`, '_blank', 'noopener');
    }
  }

  protected openRequest(id: string): void {
    window.open(`/prescriptions/labs/${encodeURIComponent(id)}`, '_blank', 'noopener');
  }

  protected onFocus(): void {
    if (this.active()) this.refresh(true);
  }

  protected onVisibility(): void {
    if (this.active() && this.doc.visibilityState === 'visible') this.refresh(true);
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
            fallbackFocus: () => this.listHeading()?.nativeElement ?? null,
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
   * never extends the idle session); Refresh and the first load count.
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
    this.cancelResults();
    this.resultsNote.set(null);
  }

  /** The list is gone, or no longer showing: a late answer must not open the viewer over whatever is there now. */
  private cancelResults(): void {
    this.resultsSub?.unsubscribe();
    this.resultsSub = null;
    this.resultsBusy.set(null);
  }

  protected chipLabel(r: LabRequestSummaryDto): string {
    return labStatusMeta(r).label;
  }

  /** The light cockpit uses the portal's chips; the dark one a neutral pill (the text names the state). */
  protected chipClass(r: LabRequestSummaryDto): string {
    return this.tone() === 'light' ? labStatusMeta(r).cls : 'bg-white/10 text-white/85';
  }
}
