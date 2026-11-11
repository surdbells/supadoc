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
import { apiErrorMessage, LabRequestsApi } from '@supadoc/data-access';
import type { DoctorLabResultDto, LabRequestDto } from '@supadoc/models';
import { type ConfirmOptions, DialogService, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { DocumentViewerService, type ViewerWatermark } from '@supadoc/viewer';
import { map, type Subscription, tap, throwError } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { focusAfterDialogs } from '../focus-after-dialog';
import { RX_ACTION } from '../prescriptions/rx-shared';
import { LabFiles } from './lab-files';
import { LabRequestSummary, summaryFromRequest } from './lab-request-summary';
import { LabReviewDialog, type LabReviewTarget } from './lab-review-dialog';
import { LabTimeline } from './lab-timeline';
import {
  ageSex,
  calendarDate,
  drName,
  firstName,
  httpStatusOf,
  LAB_PRIORITY_META,
  LAB_STATUS_META,
  type LabChipMeta,
  labStatusMeta,
  numberParts,
  showsAbnormalCaption,
} from './lab-ui';
import { isOpenableResult, labResultSource } from './lab-viewer-sources';

const BTN =
  'inline-flex items-center justify-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-medium text-cerulean-dark shadow-control transition hover:border-cerulean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60';
const BTN_DANGER =
  'inline-flex items-center justify-center gap-1.5 rounded-field border border-alert bg-white px-4 py-2 font-sans text-body-sm font-medium text-alert-ink shadow-control transition hover:bg-alert/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60';

/** The cancel prompt outlived the drill-in's session: nothing is posted under another sign-in. */
const SIGNED_OUT = Symbol('signed-out');
/** Appended when the same announcement repeats, so screen readers say it again (a no-break space). */
const REPEAT = String.fromCharCode(0xa0);
const SHARING_NOTE = 'Review outcomes are hidden while you share your screen.';

/**
 * One lab request inside the call's Lab requests tab (the "Open" drill-in):
 * the request page's pieces without its navigation — status, the timeline,
 * results (view-only in the shared viewer; Review / Change review), the
 * request as sent, View PDF, Duplicate (into this tab's composer) and Cancel.
 * No router link, no Download button, no new tab. While the doctor shares
 * their screen nothing here says "Abnormal" (the patient may be watching).
 */
@Component({
  selector: 'doc-call-lab-request-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, IconComponent, LabRequestSummary, LabReviewDialog, LabTimeline],
  styles: `
    :host {
      display: block;
      container: call-lab-detail / inline-size;
    }
    .rp-card {
      border-radius: 24px;
    }
    .rp-shimmer {
      height: 140px;
    }
    .cd-head {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .cd-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      gap: 1.5rem;
    }
    @container call-lab-detail (min-width: 48rem) {
      .cd-head {
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
      }
      .cd-actions {
        justify-content: flex-end;
      }
    }
    @container call-lab-detail (min-width: 54rem) {
      .cd-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
  template: `
    <section class="flex flex-col gap-8" aria-labelledby="call-lab-detail-title">
      <div class="flex items-center justify-between gap-4">
        <h2 id="call-lab-detail-title" tabindex="-1" data-ws-focus class="font-heading text-h5 text-ink outline-none">Lab request</h2>
        <div class="flex items-center gap-2">
          <button type="button" class="${RX_ACTION} min-h-11 min-w-11" aria-label="Refresh this lab request" [attr.aria-busy]="loading() || null" (click)="load(true)">
            <sd-icon name="refresh-cw" [size]="16" />
          </button>
          <button
            type="button"
            aria-label="Back to lab requests"
            class="flex min-h-11 items-center gap-1 rounded-field px-2 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
            (click)="back.emit()"
          >
            <sd-icon name="arrow-left" [size]="20" /> Back
          </button>
        </div>
      </div>

      <p class="sr-only" role="status">{{ announce() }}</p>

      @if (dto(); as r) {
        @let chip = chipOf(r);
        <section class="rp-card cd-head border-[0.5px] border-haze bg-white px-6 py-5 shadow-card" aria-labelledby="call-lab-detail-number">
          <div class="flex min-w-0 items-start gap-5">
            <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/10 text-cerulean-dark" aria-hidden="true">
              <sd-icon name="microscope" [size]="24" />
            </span>
            <div class="flex min-w-0 flex-col gap-2">
              <div class="flex flex-wrap items-center gap-3">
                <h3 id="call-lab-detail-number" class="font-sans text-h5 text-ink [overflow-wrap:anywhere]">@for (p of numberParts(r.number); track $index) {<span>{{ p }}</span><wbr />}</h3>
                <span class="inline-flex rounded-xl px-4 py-1.5 font-sans text-caption font-medium" [class]="chip.cls">{{ chip.label }}</span>
                <span class="font-sans text-body-sm font-medium" [class]="priority(r).cls">{{ priority(r).label }}</span>
              </div>
              @if (r.unreviewed_count > 0) {
                <span class="font-sans text-caption font-medium text-alert-ink">Needs review</span>
              }
              @if (abnormalCaption(r)) {
                <span class="font-sans text-caption font-medium text-alert-ink">Abnormal result</span>
              }
              <p class="font-sans text-body-sm text-ink [overflow-wrap:anywhere]">{{ patientLine(r) }}</p>
              <p class="font-sans text-body-sm text-slate">Sent {{ clock.dateTime(r.sent_at) }}</p>
              @if (r.appointment_id) {
                <p class="font-sans text-body-sm text-slate">From this consultation</p>
              }
            </div>
          </div>
          <div class="cd-actions flex flex-wrap gap-2">
            <button type="button" class="${BTN}" (click)="viewPdf(r, $event)">
              <sd-icon name="file-text" [size]="16" /> View PDF
            </button>
            @if (r.patient.id === patientId()) {
              <button type="button" class="${BTN}" (click)="duplicate.emit(r)">
                <sd-icon name="copy" [size]="16" /> Duplicate
              </button>
            }
            @if (r.can.cancel) {
              <button type="button" class="${BTN_DANGER}" (click)="cancelRequest(r)">
                <sd-icon name="circle-x" [size]="16" /> Cancel request
              </button>
            }
          </div>
        </section>

        <div class="cd-grid">
          <section class="flex flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card" aria-labelledby="call-lab-detail-status">
            <h3 id="call-lab-detail-status" class="font-sans text-body-lg font-semibold text-ink">Status</h3>
            <doc-lab-timeline [request]="r" />
          </section>

          <section class="flex flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card" aria-labelledby="call-lab-detail-results">
            <h3 #resultsHeading id="call-lab-detail-results" tabindex="-1" class="font-sans text-body-lg font-semibold text-ink outline-none">Results</h3>
            @if (sharing() && r.results.length) {
              <p class="font-sans text-caption text-slate">{{ sharingNote }}</p>
            }
            @if (r.results.length === 0) {
              <p class="font-sans text-body-sm text-slate">No results yet. The patient adds results here after their test.</p>
            } @else {
              <ul class="flex flex-col gap-3">
                @for (res of r.results; track res.id) {
                  <li class="flex flex-col gap-3 rounded-2xl border border-haze bg-white p-4">
                    <div class="flex min-w-0 items-start gap-3">
                      <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/10 text-cerulean-dark" aria-hidden="true">
                        <sd-icon name="file-text" [size]="20" />
                      </span>
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        @if (res.visible && res.document) {
                          <p class="font-sans text-body-sm font-medium text-ink [overflow-wrap:anywhere]">{{ res.document.title }}</p>
                          <p class="font-sans text-caption text-slate">{{ res.document.type_label }} · {{ res.document.size_label }}</p>
                        } @else {
                          <p class="font-sans text-body-sm font-medium text-ink">Result</p>
                        }
                        <p class="font-sans text-caption text-slate">Added {{ clock.dateTime(res.uploaded_at) }}</p>
                        @if (covers(r, res); as c) {
                          <p class="font-sans text-caption text-slate [overflow-wrap:anywhere]">Covers: {{ c }}</p>
                        }
                      </div>
                    </div>

                    @if (!res.visible || !res.document) {
                      <p class="font-sans text-caption text-slate">{{ first(r) }} hasn't shared this result with you.</p>
                    } @else if (!res.document.viewable) {
                      <p class="font-sans text-caption text-slate">
                        Preview isn't available for this file type ({{ ext(res) }}). Ask the patient to share it as a PDF or photo.
                      </p>
                    }

                    @if (res.review; as rv) {
                      <div class="flex flex-col gap-1 border-t border-haze pt-3">
                        <div class="flex flex-wrap items-center gap-2">
                          @if (sharing()) {
                            <span class="inline-flex rounded-xl bg-cloud px-3 py-1 font-sans text-caption font-medium text-slate">Reviewed</span>
                          } @else {
                            <span
                              class="inline-flex rounded-xl px-3 py-1 font-sans text-caption font-medium"
                              [class]="rv.outcome === 'abnormal' ? 'bg-alert/10 text-alert-ink' : 'bg-sage/10 text-sage-ink'"
                              >{{ rv.outcome === 'abnormal' ? 'Abnormal' : 'Normal' }}</span
                            >
                          }
                          <span class="font-sans text-caption text-slate">Reviewed {{ clock.dateTime(rv.reviewed_at) }}</span>
                        </div>
                        @if (rv.comment) {
                          <p class="whitespace-pre-line font-sans text-body-sm text-ink [overflow-wrap:anywhere]">{{ rv.comment }}</p>
                        }
                      </div>
                    }

                    <div class="flex flex-wrap gap-2">
                      @if (openable(res) && watermark()) {
                        <button type="button" class="${BTN}" (click)="openResult(r, res, $event)">
                          <sd-icon name="eye" [size]="16" /> View
                        </button>
                      }
                      @if (canReview(r, res) && !sharing()) {
                        @if (res.review) {
                          <button type="button" class="${BTN}" (click)="openReview(r, res, $event)">Change review</button>
                        } @else {
                          <button type="button" class="${BTN}" (click)="openReview(r, res, $event)">
                            <sd-icon name="square-pen" [size]="16" /> Review
                          </button>
                        }
                      }
                    </div>
                  </li>
                }
              </ul>
            }
          </section>
        </div>

        <section class="flex flex-col gap-4 rounded-2xl border border-haze bg-white p-4 shadow-card sm:p-6" aria-labelledby="call-lab-detail-request">
          <h3 id="call-lab-detail-request" class="font-sans text-body-lg font-semibold text-ink">Request</h3>
          @if (summary(); as v) {
            <doc-lab-request-summary [view]="v" />
          }
          <div class="flex flex-col gap-1 border-t border-haze pt-4">
            <p class="font-sans text-body-sm text-ink">Signed electronically by {{ signer(r) }} on {{ clock.dateTime(r.sent_at) }}</p>
            @if (r.status === 'awaiting_consent' || r.status === 'booked') {
              <p class="font-sans text-body-sm text-slate">Valid until {{ validUntil(r) }}</p>
            }
          </div>
        </section>
      } @else if (notFound()) {
        <sd-empty-state icon="microscope" title="Lab request not found">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-3 font-sans text-body-sm font-medium text-white shadow-btn transition hover:bg-cerulean-dark"
            (click)="back.emit()"
          >
            Back to lab requests
          </button>
        </sd-empty-state>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-16 text-center shadow-card">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean"
            (click)="retry()"
          >
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </button>
        </div>
      } @else {
        <div class="flex flex-col gap-6" aria-busy="true">
          <span class="sr-only">Loading the lab request…</span>
          <div class="rp-shimmer sd-shimmer rounded-[24px]"></div>
          <div class="rp-shimmer sd-shimmer rounded-2xl"></div>
        </div>
      }
    </section>

    <doc-lab-review-dialog
      [open]="reviewOpen()"
      [target]="reviewTarget()"
      (saved)="onReviewed($event)"
      (stale)="load(true)"
      (closed)="closeReview()"
    />
  `,
})
export class CallLabRequestDetail {
  /** The doctor's clock (their profile time zone): every time shown here. */
  protected readonly clock = inject(DoctorClock);
  protected readonly numberParts = numberParts;
  protected readonly sharingNote = SHARING_NOTE;
  private readonly api = inject(LabRequestsApi);
  private readonly files = inject(LabFiles);
  private readonly viewer = inject(DocumentViewerService);
  private readonly dialogs = inject(DialogService);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  readonly labId = input.required<string>();
  /** This call's patient: Duplicate is offered only for their requests. */
  readonly patientId = input<string | null>(null);
  /** The view-only watermark (results open only with one). */
  readonly watermark = input<ViewerWatermark | null>(null);
  /** On screen in an open workspace: a quiet re-read each time it shows again. */
  readonly active = input(true);
  /** The doctor shares their screen: no "Abnormal" anywhere here. */
  readonly sharing = input(false);
  /** Signed in as this call's doctor. The parent destroys the drill-in on sign-out (see `gone`). */
  readonly signedIn = input(false);
  readonly back = output<void>();
  readonly duplicate = output<LabRequestDto>();

  private readonly resultsHeading = viewChild<ElementRef<HTMLElement>>('resultsHeading');

  protected readonly dto = signal<LabRequestDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly notFound = signal(false);
  protected readonly error = signal('');
  protected readonly announce = signal('');
  protected readonly summary = computed(() => {
    const r = this.dto();
    return r ? summaryFromRequest(r) : null;
  });

  protected readonly reviewOpen = signal(false);
  protected readonly reviewTarget = signal<LabReviewTarget | null>(null);
  private reviewOpener: HTMLElement | null = null;

  private loadSub: Subscription | null = null;
  private loadedId: string | null = null;
  private wasActive: boolean | null = null;
  /**
   * Destroyed: the parent swapped this drill-in for the list (a sign-out, or
   * another doctor signing in). Its inputs are frozen from then on — the last
   * `signedIn` it got is still true — so nothing it started may act.
   */
  private gone = false;
  /** The open "Cancel this request?" prompt's options (it lives in the app's outlet). */
  private cancelPrompt: ConfirmOptions | null = null;

  constructor() {
    // The first read, then a quiet one each time the tab shows again (results may arrive during the call).
    // No window-focus re-read: get(id) cannot be passive, and an active read on every focus would hold the session.
    effect(() => {
      const id = this.labId();
      const active = this.active();
      untracked(() => {
        if (id !== this.loadedId) {
          this.loadedId = id;
          this.dto.set(null);
          this.load();
        } else if (active && this.wasActive === false) {
          this.load(true);
        }
        this.wasActive = active;
      });
    });
    // Sharing starts while a review is open: its Normal / Abnormal choice leaves the screen. Its opener
    // (Review / Change review) is hidden while sharing, so focus would fall to <body> inside the workspace.
    effect(() => {
      if (!this.sharing() || !untracked(this.reviewOpen)) return;
      untracked(() => {
        this.reviewOpen.set(false);
        this.say(SHARING_NOTE);
        this.focusIfLost(() => this.resultsHeading()?.nativeElement);
      });
    });
    this.destroyRef.onDestroy(() => {
      this.gone = true;
      this.loadSub?.unsubscribe();
      // The cancel prompt goes with the drill-in it belongs to — unless its POST is already on its way
      // (sent while signed in): that one finishes, and shows how it went. Untracked: this runs while the
      // parent's @switch swaps views, inside its template.
      const prompt = this.cancelPrompt;
      if (!prompt) return;
      untracked(() => {
        for (const r of this.dialogs.requests()) if (r.options === prompt && !r.busy()) r.dismiss();
      });
    });
  }

  /** Load (or, `quiet`, refresh in place) the request. */
  load(quiet = false): void {
    const id = this.labId();
    this.loadSub?.unsubscribe();
    if (!quiet) {
      this.notFound.set(false);
      this.error.set('');
    }
    this.loading.set(true);
    this.loadSub = this.api.get(id).subscribe({
      next: (res) => {
        this.loading.set(false);
        this.dto.set(res.data);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        if (quiet && this.dto()) return;
        if (httpStatusOf(err) === 404) this.notFound.set(true);
        else this.error.set(apiErrorMessage(err, 'Could not load this lab request. Please try again.'));
      },
    });
  }

  /** The error card's Try again: the card (and the pressed button) gives way to the shimmer, so focus goes to the title. */
  protected retry(): void {
    this.load();
    this.focusIfLost(() => this.doc.getElementById('call-lab-detail-title'));
  }

  /**
   * After the next render, focus `target` — only if focus was lost meanwhile, never taken from elsewhere. Lost:
   * on <body>, or still on a control of a dialog that has just closed (the browser moves it to <body> a moment later).
   */
  private focusIfLost(target: () => HTMLElement | null | undefined): void {
    afterNextRender(
      () => {
        const active = this.doc.activeElement;
        const closedDialog = active?.closest('dialog');
        if (!active || active === this.doc.body || (closedDialog && !closedDialog.open)) target()?.focus();
      },
      { injector: this.injector },
    );
  }

  // ----- labels -----

  /** The status chip; while sharing, never "Result ready · Abnormal". */
  protected chipOf(r: LabRequestDto): LabChipMeta {
    if (this.sharing() && r.status === 'result_ready') return LAB_STATUS_META.result_ready;
    return labStatusMeta(r);
  }

  protected abnormalCaption(r: LabRequestDto): boolean {
    return showsAbnormalCaption(r) && !this.sharing();
  }

  protected priority(r: LabRequestDto): LabChipMeta {
    return LAB_PRIORITY_META[r.priority] ?? LAB_PRIORITY_META.routine;
  }

  /** "{patient name} · {age} years · {Sex}". */
  protected patientLine(r: LabRequestDto): string {
    const meta = ageSex(r.patient_snapshot?.age ?? r.patient.age, r.patient_snapshot?.sex ?? r.patient.sex);
    return [r.patient.name, meta].filter(Boolean).join(' · ');
  }

  protected first(r: LabRequestDto): string {
    return firstName(r.patient.name);
  }

  protected signer(r: LabRequestDto): string {
    return drName(r.prescriber?.name);
  }

  protected validUntil(r: LabRequestDto): string {
    return calendarDate(r.valid_until);
  }

  /** "FBC, Malaria MP": the tests a result covers (by item id). */
  protected covers(r: LabRequestDto, res: DoctorLabResultDto): string {
    const ids = new Set(res.item_ids ?? []);
    return (r.items ?? [])
      .filter((i) => ids.has(i.id))
      .map((i) => i.short)
      .join(', ');
  }

  protected ext(res: DoctorLabResultDto): string {
    return (res.document?.extension ?? '').toUpperCase() || 'this file';
  }

  protected openable(res: DoctorLabResultDto): boolean {
    return isOpenableResult(res);
  }

  /** Review only results the doctor can open, and only while the request takes reviews. */
  protected canReview(r: LabRequestDto, res: DoctorLabResultDto): boolean {
    return !!res.reviewable && !!r.can?.review;
  }

  private say(text: string): void {
    this.announce.set(this.announce() === text ? `${text}${REPEAT}` : text);
  }

  // ----- results -----

  /** The request's openable results in the viewer, view-only and watermarked (‹ / › move through them), from this one. */
  protected openResult(r: LabRequestDto, res: DoctorLabResultDto, event?: Event): void {
    const watermark = this.watermark();
    if (!watermark) return;
    const list = r.results.filter(isOpenableResult);
    const at = Math.max(0, list.findIndex((x) => x.id === res.id));
    const opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.viewer.open(
      list.map((x) => labResultSource(this.api, r.id, x, { onGone: () => this.load(true) })),
      {
        index: at,
        opener,
        watermark,
        listLabel: 'results',
        fallbackFocus: () => this.resultsHeading()?.nativeElement ?? null,
      },
    );
  }

  protected openReview(r: LabRequestDto, res: DoctorLabResultDto, event?: Event): void {
    if (this.sharing()) return;
    this.reviewOpener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const title = res.document?.title || 'Result';
    const covers = this.covers(r, res);
    this.reviewTarget.set({
      labId: r.id,
      resultId: res.id,
      subtitle: covers ? `${title} · ${covers}` : title,
      outcome: res.review?.outcome ?? null,
      comment: res.review?.comment ?? '',
    });
    this.reviewOpen.set(true);
  }

  protected closeReview(): void {
    this.reviewOpen.set(false);
  }

  protected onReviewed(r: LabRequestDto): void {
    this.dto.set(r);
    this.reviewOpen.set(false);
    this.say('Review saved.');
    // The row's button may have changed ("Review" → "Change review"): fall back to the heading.
    setTimeout(() => {
      if (!this.reviewOpener?.isConnected) this.resultsHeading()?.nativeElement.focus();
    }, 0);
  }

  // ----- PDF, cancel -----

  protected viewPdf(r: LabRequestDto, event?: Event): void {
    this.files.view(r, event?.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  }

  protected async cancelRequest(r: LabRequestDto): Promise<void> {
    const prompt: ConfirmOptions = {
      title: 'Cancel this request?',
      message: `${r.patient.name} will be told it was cancelled. You can duplicate it later if needed.`,
      tone: 'danger',
      reason: { label: 'Reason for the patient', required: true, minLength: 3, maxLength: 500 },
      confirmLabel: 'Cancel request',
      cancelLabel: 'Keep request',
      size: 'md',
      action: (reason) => {
        // The prompt lives in the app's outlet and can outlive this drill-in (a sign-out destroys it, and its
        // `signedIn` stays frozen at true): never post under another session, or none.
        if (this.gone || !this.signedIn()) return throwError(() => SIGNED_OUT);
        return this.api.cancel(r.id, reason ?? '').pipe(
          tap({
            next: (res) => this.dto.set(res.data),
            // 409 (e.g. a result arrived): the prompt still shows why, and the request behind it catches up.
            error: (err: unknown) => {
              if (httpStatusOf(err) === 409) this.load(true);
            },
          }),
          map(() => undefined),
        );
      },
      errorMessage: (e) => (e === SIGNED_OUT ? 'Sign in again to cancel this request.' : apiErrorMessage(e)),
    };
    this.cancelPrompt = prompt;
    const { confirmed } = await this.dialogs.confirm(prompt);
    if (this.cancelPrompt === prompt) this.cancelPrompt = null;
    // Gone meanwhile: the list's own focus rule applies (L16), nothing here is on screen any more.
    if (!confirmed || this.gone) return;
    this.say('Request cancelled.');
    // Cancel request (the prompt's opener) is gone: focus would fall to <body> inside the workspace modal.
    focusAfterDialogs(this.injector, () => this.doc.getElementById('call-lab-detail-title'));
  }
}
