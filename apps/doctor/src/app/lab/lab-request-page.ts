import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, LabRequestsApi } from '@supadoc/data-access';
import type { DoctorLabResultDto, LabRequestDto } from '@supadoc/models';
import { DialogService, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { DocumentViewerService } from '@supadoc/viewer';
import { map, type Subscription, tap } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { viewerWatermark } from '../viewer/doctor-viewer-sources';
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
  labStatusMeta,
  numberParts,
  showsAbnormalCaption,
} from './lab-ui';
import { isOpenableResult, labResultSource } from './lab-viewer-sources';

const BTN =
  'inline-flex items-center justify-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-medium text-cerulean-dark shadow-control transition hover:border-cerulean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60';
const BTN_DANGER =
  'inline-flex items-center justify-center gap-1.5 rounded-field border border-alert bg-white px-4 py-2 font-sans text-body-sm font-medium text-alert-ink shadow-control transition hover:bg-alert/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-60';

/** Appended when the same announcement repeats, so screen readers say it again (a no-break space). */
const REPEAT = String.fromCharCode(0xa0);

/**
 * One lab request (route `/prescriptions/labs/:labId`): status, the timeline,
 * results (view-only in the shared viewer, audited print; review Normal /
 * Abnormal on results the doctor can open), the request as sent, and Cancel /
 * Duplicate / the signed PDF. Only the requesting doctor reaches it (404 else).
 */
@Component({
  selector: 'doc-lab-request-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyStateComponent, IconComponent, LabRequestSummary, LabReviewDialog, LabTimeline],
  host: { class: 'block' },
  styles: `
    .rp-card {
      border-radius: 24px;
    }
    .rp-shimmer {
      height: 140px;
    }
  `,
  template: `
    <div class="flex flex-col gap-8 py-2">
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-heading text-h2 text-ink">Lab request</h1>
        <a
          routerLink="/prescriptions/labs"
          class="flex items-center gap-1 rounded-field font-sans text-h5 font-medium text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
        >
          <sd-icon name="arrow-left" [size]="24" /> Back
        </a>
      </div>

      <p class="sr-only" role="status">{{ announce() }}</p>

      @if (dto(); as r) {
        @let chip = chipOf(r);
        <!-- Header -->
        <section class="rp-card flex flex-col gap-5 border-[0.5px] border-haze bg-white px-6 py-5 shadow-card lg:flex-row lg:items-start lg:justify-between" aria-labelledby="lab-req-number">
          <div class="flex min-w-0 items-start gap-5">
            <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/10 text-cerulean-dark" aria-hidden="true">
              <sd-icon name="microscope" [size]="24" />
            </span>
            <div class="flex min-w-0 flex-col gap-2">
              <div class="flex flex-wrap items-center gap-3">
                <h2 id="lab-req-number" class="font-sans text-h5 text-ink [overflow-wrap:anywhere]">@for (p of numberParts(r.number); track $index) {<span>{{ p }}</span><wbr />}</h2>
                <span class="inline-flex rounded-xl px-4 py-1.5 font-sans text-caption font-medium" [class]="chip.cls">{{ chip.label }}</span>
                <span class="font-sans text-body-sm font-medium" [class]="priority(r).cls">{{ priority(r).label }}</span>
              </div>
              @if (r.unreviewed_count > 0) {
                <span class="font-sans text-caption font-medium text-alert-ink">Needs review</span>
              }
              @if (abnormalCaption(r)) {
                <span class="font-sans text-caption font-medium text-alert-ink">Abnormal result</span>
              }
              <p class="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-body-sm text-ink">
                <span class="[overflow-wrap:anywhere]">{{ patientLine(r) }}</span>
                <a [routerLink]="['/patients', r.patient.id]" class="font-medium text-cerulean-dark underline-offset-2 hover:underline">Open patient record</a>
              </p>
              <p class="font-sans text-body-sm text-slate">Sent {{ clock.dateTime(r.sent_at) }}</p>
              @if (r.appointment_id) {
                <a [routerLink]="['/appointments', r.appointment_id]" class="w-fit font-sans text-body-sm text-cerulean-dark underline-offset-2 hover:underline">
                  From the consultation on {{ clock.dayTime(r.appointment_scheduled_at) }}
                </a>
              }
            </div>
          </div>
          <div class="flex flex-wrap gap-2 lg:justify-end">
            <button type="button" class="${BTN}" [disabled]="downloading()" (click)="download(r)">
              <sd-icon name="download" [size]="16" /> {{ downloading() ? 'Downloading…' : 'Download PDF' }}
            </button>
            <button type="button" class="${BTN}" (click)="viewPdf(r, $event)">
              <sd-icon name="file-text" [size]="16" /> View PDF
            </button>
            <a class="${BTN}" routerLink="/prescriptions/labs/new" [queryParams]="{ patientId: r.patient.id, from: r.id }">
              <sd-icon name="copy" [size]="16" /> Duplicate
            </a>
            @if (r.can.cancel) {
              <button type="button" class="${BTN_DANGER}" (click)="cancelRequest(r)">
                <sd-icon name="circle-x" [size]="16" /> Cancel request
              </button>
            }
          </div>
        </section>
        @if (fileError()) {
          <p role="alert" class="rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink">{{ fileError() }}</p>
        }

        <div class="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
          <!-- Timeline -->
          <section class="flex flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card" aria-labelledby="lab-req-status">
            <h2 id="lab-req-status" class="font-sans text-body-lg font-semibold text-ink">Status</h2>
            <doc-lab-timeline [request]="r" />
          </section>

          <!-- Results -->
          <section class="flex flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card" aria-labelledby="lab-req-results">
            <h2 #resultsHeading id="lab-req-results" tabindex="-1" class="font-sans text-body-lg font-semibold text-ink outline-none">Results</h2>
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
                          <span
                            class="inline-flex rounded-xl px-3 py-1 font-sans text-caption font-medium"
                            [class]="rv.outcome === 'abnormal' ? 'bg-alert/10 text-alert-ink' : 'bg-sage/10 text-sage-ink'"
                            >{{ rv.outcome === 'abnormal' ? 'Abnormal' : 'Normal' }}</span
                          >
                          <span class="font-sans text-caption text-slate">Reviewed {{ clock.dateTime(rv.reviewed_at) }}</span>
                        </div>
                        @if (rv.comment) {
                          <p class="whitespace-pre-line font-sans text-body-sm text-ink [overflow-wrap:anywhere]">{{ rv.comment }}</p>
                        }
                      </div>
                    }

                    <div class="flex flex-wrap gap-2">
                      @if (openable(res)) {
                        <button type="button" class="${BTN}" (click)="viewResult(r, res, $event)">
                          <sd-icon name="eye" [size]="16" /> View
                        </button>
                      }
                      @if (canReview(r, res)) {
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

        <!-- The request as sent -->
        <section class="flex flex-col gap-4 rounded-2xl border border-haze bg-white p-4 shadow-card sm:p-6" aria-labelledby="lab-req-request">
          <h2 id="lab-req-request" class="font-sans text-body-lg font-semibold text-ink">Request</h2>
          <doc-lab-request-summary [view]="summary()!" />
          <div class="flex flex-col gap-1 border-t border-haze pt-4">
            <p class="font-sans text-body-sm text-ink">Signed electronically by {{ signer(r) }} on {{ clock.dateTime(r.sent_at) }}</p>
            @if (r.status === 'awaiting_consent' || r.status === 'booked') {
              <p class="font-sans text-body-sm text-slate">Valid until {{ validUntil(r) }}</p>
            }
          </div>
        </section>
      } @else if (notFound()) {
        <sd-empty-state icon="microscope" title="Lab request not found">
          <a
            routerLink="/prescriptions/labs"
            class="inline-flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-3 font-sans text-body-sm font-medium text-white shadow-btn transition hover:bg-cerulean-dark"
            >Back to Laboratory &amp; Diagnostics</a
          >
        </sd-empty-state>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-16 text-center shadow-card">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean"
            (click)="load()"
          >
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </button>
        </div>
      } @else {
        <div class="flex flex-col gap-6" aria-busy="true">
          <span class="sr-only">Loading the lab request…</span>
          <div class="rp-shimmer sd-shimmer rounded-[24px]"></div>
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <div class="rp-shimmer sd-shimmer rounded-2xl"></div>
            <div class="rp-shimmer sd-shimmer rounded-2xl"></div>
          </div>
        </div>
      }
    </div>

    <doc-lab-review-dialog
      [open]="reviewOpen()"
      [target]="reviewTarget()"
      (saved)="onReviewed($event)"
      (stale)="load(true)"
      (closed)="closeReview()"
    />
  `,
})
export class LabRequestPage {
  /** The doctor's clock (their profile time zone): every time shown here. */
  protected readonly clock = inject(DoctorClock);
  /** The number with a break point after each hyphen (never "…-0 / 0001" on a phone). */
  protected readonly numberParts = numberParts;
  private readonly api = inject(LabRequestsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly files = inject(LabFiles);
  private readonly viewer = inject(DocumentViewerService);
  private readonly dialogs = inject(DialogService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resultsHeading = viewChild<ElementRef<HTMLElement>>('resultsHeading');

  private labId = '';
  protected readonly dto = signal<LabRequestDto | null>(null);
  protected readonly notFound = signal(false);
  protected readonly error = signal('');
  protected readonly fileError = signal('');
  protected readonly downloading = signal(false);
  protected readonly announce = signal('');
  protected readonly summary = computed(() => {
    const r = this.dto();
    return r ? summaryFromRequest(r) : null;
  });

  protected readonly reviewOpen = signal(false);
  protected readonly reviewTarget = signal<LabReviewTarget | null>(null);
  private reviewOpener: HTMLElement | null = null;

  private loadSub: Subscription | null = null;
  private fileSub: Subscription | null = null;

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const id = p.get('labId') ?? '';
      if (id === this.labId) return;
      this.labId = id;
      this.dto.set(null);
      this.load();
    });
    this.destroyRef.onDestroy(() => {
      this.loadSub?.unsubscribe();
      this.fileSub?.unsubscribe();
    });
  }

  /** Load (or, `quiet`, refresh in place) the request. */
  load(quiet = false): void {
    if (!this.labId) return;
    this.loadSub?.unsubscribe();
    if (!quiet) {
      this.notFound.set(false);
      this.error.set('');
    }
    this.loadSub = this.api.get(this.labId).subscribe({
      next: (res) => this.dto.set(res.data),
      error: (err: unknown) => {
        if (quiet && this.dto()) return;
        if (httpStatusOf(err) === 404) this.notFound.set(true);
        else this.error.set(apiErrorMessage(err, 'Could not load this lab request. Please try again.'));
      },
    });
  }

  // ----- labels -----

  protected chipOf(r: LabRequestDto) {
    return labStatusMeta(r);
  }

  protected abnormalCaption(r: LabRequestDto): boolean {
    return showsAbnormalCaption(r);
  }

  protected priority(r: LabRequestDto) {
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

  // ----- results -----

  /** The request's openable results in the viewer (‹ / › move through them), starting at this one. */
  protected viewResult(r: LabRequestDto, res: DoctorLabResultDto, event?: Event): void {
    const list = r.results.filter(isOpenableResult);
    const at = Math.max(0, list.findIndex((x) => x.id === res.id));
    const opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.viewer.open(
      list.map((x) => labResultSource(this.api, r.id, x, { onGone: () => this.load(true) })),
      {
        index: at,
        opener,
        fallbackFocus: () => this.resultsHeading()?.nativeElement ?? null,
        watermark: viewerWatermark(this.clock, this.auth),
        tone: 'light',
        listLabel: 'results',
      },
    );
  }

  protected openReview(r: LabRequestDto, res: DoctorLabResultDto, event?: Event): void {
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
    this.announce.set(this.announce() === 'Review saved.' ? `Review saved.${REPEAT}` : 'Review saved.');
    // The row's button may have changed ("Review" → "Change review"): fall back to the heading.
    setTimeout(() => {
      const opener = this.reviewOpener;
      if (!opener?.isConnected) this.resultsHeading()?.nativeElement.focus();
    }, 0);
  }

  // ----- PDF, cancel -----

  protected viewPdf(r: LabRequestDto, event?: Event): void {
    this.fileError.set('');
    this.files.view(r, event?.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  }

  protected download(r: LabRequestDto): void {
    if (this.downloading()) return;
    this.fileError.set('');
    this.downloading.set(true);
    this.fileSub?.unsubscribe();
    this.fileSub = this.files.download(
      r.id,
      (err) => {
        this.downloading.set(false);
        this.fileError.set(apiErrorMessage(err, "Couldn't download the PDF. Try again."));
      },
      () => this.downloading.set(false),
    );
  }

  protected async cancelRequest(r: LabRequestDto): Promise<void> {
    const { confirmed } = await this.dialogs.confirm({
      title: 'Cancel this request?',
      message: `${r.patient.name} will be told it was cancelled. You can duplicate it later if needed.`,
      tone: 'danger',
      reason: { label: 'Reason for the patient', required: true, minLength: 3, maxLength: 500 },
      confirmLabel: 'Cancel request',
      cancelLabel: 'Keep request',
      size: 'md',
      action: (reason) =>
        this.api.cancel(r.id, reason ?? '').pipe(
          tap({
            next: (res) => this.dto.set(res.data),
            // 409 (e.g. a result arrived): the dialog still shows why, and the page behind it
            // catches up (status, actions, results) instead of offering the same stale Cancel again.
            error: (err: unknown) => {
              if (httpStatusOf(err) === 409) this.load(true);
            },
          }),
          map(() => undefined),
        ),
    });
    if (confirmed) this.announce.set('Request cancelled.');
  }
}
