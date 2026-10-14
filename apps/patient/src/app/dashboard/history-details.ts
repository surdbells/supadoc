import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, startWith, switchMap } from 'rxjs';
import {
  apiErrorMessage,
  AppointmentsApi,
  openClinicalDocument,
  openPendingTab,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type {
  AppointmentDto,
  ClinicalDocumentKind,
  ConsultationSummaryDto,
  LabOrderDto,
  PrescriptionDto,
  PrescriptionStatus,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { isAlreadyReviewed, rememberReviewed, wasReviewed } from './review-memory';

/**
 * How long after its start a consultation the doctor hasn't closed yet can be
 * rejoined from here (the reminders cron closes a visit with proof it took
 * place 12 hours after its slot).
 */
const REJOIN_WINDOW_MS = 12 * 60 * 60_000;

/** While the doctor hasn't closed the visit, look for it being closed this often. */
const STATUS_POLL_MS = 30_000;

/** Referrals and certificates still render as HTML documents; prescriptions open as PDFs. */
interface DocItem {
  readonly kind: Exclude<ClinicalDocumentKind, 'prescription'>;
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

/** Every prescription status reads as an icon AND a word — never colour alone. */
const RX_STATUS: Record<PrescriptionStatus, { label: string; icon: string; cls: string }> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-warning/15 text-warning' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
};

const NAIRA = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-sage/15 text-sage',
  cancelled: 'bg-alert/10 text-alert',
};

/** Consultation details (Figma 808:13576) — wired to GET /api/portal/appointments/{id}. */
@Component({
  selector: 'pat-history-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Consultation Details</h1>
          <p class="font-sans text-body text-slate">See your consultation full information.</p>
        </div>
        <a [routerLink]="backLink()" class="flex min-h-11 shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-6">
            <div class="h-28 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
          </div>
        }
        @case ('error') {
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert"><sd-icon name="calendar-off" [size]="36" /></span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">Consultation not found</h2>
              <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
            </div>
            <a routerLink="/dashboard/history" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white">Back to history</a>
          </div>
        }
        @default {
          @if (appt(); as a) {
            <!-- Summary -->
            <section class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 md:flex-row md:items-center md:justify-between">
              <div class="flex items-center gap-4">
                <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">{{ initials(a.specialist.name) }}</span>
                <div class="flex flex-col gap-1">
                  <p class="font-sans text-body-lg font-semibold text-ink">{{ a.specialist.name }}</p>
                  <p class="font-sans text-caption text-slate">{{ a.specialist.specialty }}</p>
                </div>
              </div>
              <div class="flex items-start justify-between gap-8 md:items-center">
                <div class="flex flex-col gap-2 font-sans text-caption text-slate">
                  <span class="flex items-center gap-2"><sd-icon name="calendar-days" [size]="16" />{{ dateLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2"><sd-icon name="clock" [size]="16" />{{ timeLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2"><sd-icon name="video" [size]="16" />{{ a.type_label }}</span>
                </div>
                <span class="shrink-0 rounded-lg px-4 py-1.5 font-sans text-body-sm font-medium" [class]="statusClass(a.status)">{{ a.status_label }}</span>
              </div>
            </section>

            <!-- Right after leaving a call the doctor may not have closed the visit yet. -->
            @if (a.status === 'confirmed') {
              <section class="flex flex-col gap-4 rounded-card border border-warning/30 bg-warning/5 p-5 sm:flex-row sm:items-center sm:justify-between">
                <p class="flex items-start gap-3 font-sans text-body-sm text-ink">
                  <sd-icon name="hourglass" [size]="20" class="mt-0.5 shrink-0 text-warning" />
                  Your doctor hasn't closed this consultation yet — summaries and prescriptions appear here once issued.
                </p>
                @if (canRejoin()) {
                  <a
                    [routerLink]="['/dashboard/call', a.id]"
                    class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean"
                  >
                    <sd-icon name="video" [size]="18" />Rejoin consultation
                  </a>
                }
              </section>
            }

            <!-- Rate a completed consultation (once — the API refuses a second review). -->
            @if (ratingVisible()) {
              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6" aria-labelledby="rate-consultation-title">
                <h2 id="rate-consultation-title" class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="star" [size]="20" />Rate your consultation</h2>
                @if (reviewState() === 'done') {
                  <p #reviewDone tabindex="-1" class="flex items-center gap-2 font-sans text-body-sm font-semibold text-sage outline-none" role="status">
                    <sd-icon name="circle-check" [size]="18" class="shrink-0" />{{ reviewNote() }}
                  </p>
                } @else {
                  <p class="font-sans text-body-sm text-slate">How was your consultation with {{ a.specialist.name }}?</p>
                  <div class="flex items-center gap-1" role="group" aria-label="Your rating, 1 to 5 stars">
                    @for (n of stars; track n) {
                      <button
                        type="button"
                        class="flex size-11 items-center justify-center rounded-field transition-colors hover:bg-glacier disabled:opacity-60"
                        [attr.aria-label]="n + ' star' + (n === 1 ? '' : 's')"
                        [attr.aria-pressed]="n === reviewRating()"
                        [disabled]="reviewState() === 'sending'"
                        (click)="reviewRating.set(n)"
                      >
                        <sd-icon name="star" [size]="28" [class]="n <= reviewRating() ? 'text-warning' : 'text-cloud'" />
                      </button>
                    }
                  </div>
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-slate">Comment (optional)</span>
                    <textarea
                      rows="3"
                      maxlength="1000"
                      class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
                      placeholder="Share how it went"
                      [disabled]="reviewState() === 'sending'"
                      [value]="reviewComment()"
                      (input)="reviewComment.set($any($event.target).value)"
                    ></textarea>
                  </label>
                  @if (reviewState() === 'error') {
                    <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                      <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ reviewNote() }}
                    </p>
                  }
                  <button
                    type="button"
                    class="inline-flex min-h-11 w-full items-center justify-center rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60 sm:w-fit"
                    [disabled]="reviewRating() === 0 || reviewState() === 'sending'"
                    (click)="submitReview(a.id)"
                  >
                    {{ reviewState() === 'sending' ? 'Sending…' : 'Submit rating' }}
                  </button>
                }
              </section>
            }

            <!-- Summary + Note -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="clipboard-list" [size]="20" />Consultation Summary</h2>
                @if (summary()?.available) {
                  <div class="flex flex-col gap-3 font-sans text-body-sm text-slate">
                    @if (summary()?.subjective) { <p>{{ summary()?.subjective }}</p> }
                    @if (summary()?.assessment) { <p><span class="font-semibold text-ink">Assessment: </span>{{ summary()?.assessment }}</p> }
                  </div>
                } @else {
                  <p class="font-sans text-body-sm text-slate">The consultation summary isn't available yet.</p>
                }
              </section>

              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="clipboard-list" [size]="20" />Care Plan</h2>
                @if (summary()?.plan) {
                  <p class="font-sans text-body-sm text-ink">{{ summary()?.plan }}</p>
                } @else {
                  <p class="font-sans text-body-sm text-slate">No care plan was recorded for this consultation.</p>
                }
              </section>
            </div>

            <!-- Documents + payment -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="file-text" [size]="20" />Documents</h2>
                @if (docsLoading()) {
                  <div class="flex flex-col gap-2.5">
                    <div class="h-14 animate-pulse rounded-field bg-cloud"></div>
                    <div class="h-14 animate-pulse rounded-field bg-cloud"></div>
                  </div>
                } @else if (prescriptions().length > 0 || docs().length > 0 || labs().length > 0) {
                  <ul class="flex flex-col gap-2.5">
                    @for (rx of prescriptions(); track rx.id) {
                      <li class="flex flex-col gap-3 rounded-field border border-cloud p-3 sm:flex-row sm:items-center">
                        <div class="flex min-w-0 flex-1 items-start gap-3">
                          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal"><sd-icon name="pill" [size]="18" /></span>
                          <span class="flex min-w-0 flex-col gap-1">
                            <span class="flex flex-wrap items-center gap-2">
                              <span class="font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                              <span class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium" [class]="rxStatus(rx.status).cls">
                                <sd-icon [name]="rxStatus(rx.status).icon" [size]="12" />{{ rxStatus(rx.status).label }}
                              </span>
                            </span>
                            <span class="font-sans text-caption text-slate">
                              {{ prescriberName(rx) }}@if (rx.valid_until) { · Valid until {{ shortDate(rx.valid_until) }} }
                            </span>
                          </span>
                        </div>
                        <div class="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
                          <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-field border border-cloud px-3 py-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60"
                            [disabled]="openingRx() === rx.id"
                            [attr.aria-label]="'View prescription ' + rx.number"
                            (click)="viewRx(rx)"
                          >
                            <sd-icon [name]="openingRx() === rx.id ? 'loader-circle' : 'eye'" [size]="14" [class.animate-spin]="openingRx() === rx.id" />View
                          </button>
                          <a
                            [routerLink]="['/dashboard/prescriptions', rx.id]"
                            class="inline-flex items-center gap-1 rounded-field px-2 py-1.5 font-sans text-caption font-semibold text-slate transition-colors hover:text-cerulean"
                            [attr.aria-label]="'Details for prescription ' + rx.number"
                          >
                            Details<sd-icon name="chevron-right" [size]="14" />
                          </a>
                        </div>
                      </li>
                    }
                    @for (doc of docs(); track doc.kind + doc.id) {
                      <li class="flex items-center gap-3">
                        <sd-icon name="file-text" [size]="20" class="shrink-0 text-slate" />
                        <span class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate font-sans text-body-sm font-medium text-ink">{{ doc.title }}</span>
                          @if (doc.meta) { <span class="truncate font-sans text-caption text-slate">{{ doc.meta }}</span> }
                        </span>
                        <button type="button" class="flex size-8 items-center justify-center rounded-field border border-cloud text-slate transition-colors hover:bg-glacier" aria-label="Open document" (click)="openDoc(a.id, doc)">
                          <sd-icon name="eye" [size]="16" />
                        </button>
                      </li>
                    }
                    @for (lab of labs(); track lab.id) {
                      <li class="flex items-center gap-3">
                        <sd-icon name="clipboard-list" [size]="20" class="shrink-0 text-slate" />
                        <span class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink">Lab order: {{ lab.tests.join(', ') }}</span>
                      </li>
                    }
                  </ul>
                } @else if (!docsError()) {
                  <p class="font-sans text-body-sm text-slate">No documents were shared for this consultation.</p>
                }
                @if (docsError()) {
                  <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                    <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ docsError() }}
                  </p>
                }
                @if (rxError()) {
                  <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                    <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ rxError() }}
                  </p>
                }
              </section>

              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="credit-card" [size]="20" />Payment Status</h2>
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="credit-card" [size]="20" class="text-slate" />Amount: ₦{{ money(a.amount) }}</span>
                  <span class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1 font-sans text-caption font-medium" [class]="a.payment_status === 'paid' ? 'bg-sage/15 text-sage' : a.payment_status === 'refunded' ? 'bg-frost text-cerulean' : 'bg-warning/15 text-warning'">
                    <sd-icon [name]="a.payment_status === 'paid' ? 'circle-check' : 'clock'" [size]="14" />
                    {{ paymentLabel(a.payment_status) }}
                  </span>
                </div>
              </section>
            </div>
          }
        }
      }
    </div>
  `,
})
export class HistoryDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AppointmentsApi);
  private readonly prescriptionsApi = inject(PrescriptionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  protected readonly summary = signal<ConsultationSummaryDto | null>(null);
  protected readonly prescriptions = signal<PrescriptionDto[]>([]);
  protected readonly docs = signal<DocItem[]>([]);
  protected readonly labs = signal<LabOrderDto[]>([]);
  protected readonly docsLoading = signal(true);
  /** A documents request failed — shown so a failure never reads as "no documents". */
  protected readonly docsError = signal('');
  /** Opening a prescription PDF failed. */
  protected readonly rxError = signal('');
  /** Id of the prescription whose PDF link is being fetched. */
  protected readonly openingRx = signal('');

  /** The appointment as re-read while the doctor hadn't closed it yet (overrides the first load). */
  private readonly refreshed = signal<AppointmentDto | null>(null);
  /** Ticks so the rejoin window re-evaluates. */
  private readonly now = signal(Date.now());

  // Rating (a completed consultation, once).
  protected readonly stars = [1, 2, 3, 4, 5];
  protected readonly reviewRating = signal(0);
  protected readonly reviewComment = signal('');
  protected readonly reviewState = signal<'idle' | 'sending' | 'done' | 'error'>('idle');
  /** The thanks / "already rated" / error line. */
  protected readonly reviewNote = signal('');
  private readonly reviewDone = viewChild<ElementRef<HTMLElement>>('reviewDone');

  private readonly result = toSignal(
    this.route.paramMap.pipe(
      map((p) => p.get('id') ?? ''),
      switchMap((id) => {
        this.refreshed.set(null);
        this.reviewState.set('idle');
        this.reviewNote.set('');
        this.reviewRating.set(0);
        this.reviewComment.set('');
        if (id !== '') this.loadExtras(id);
        return this.api.getMine(id).pipe(
          map((res) => ({ state: 'loaded' as const, appt: res.data, error: '' })),
          catchError((err: unknown) =>
            of({
              state: 'error' as const,
              appt: null,
              error: apiErrorMessage(
                err,
                "This consultation doesn't exist or is no longer available.",
              ),
            }),
          ),
          startWith({ state: 'loading' as const, appt: null, error: '' }),
        );
      }),
    ),
    { initialValue: { state: 'loading' as const, appt: null, error: '' } },
  );

  protected readonly viewState = computed(() => this.result().state);
  protected readonly appt = computed<AppointmentDto | null>(() => {
    const loaded = this.result().appt;
    const fresh = this.refreshed();
    return fresh && loaded && fresh.id === loaded.id ? fresh : loaded;
  });
  protected readonly loadError = computed(() => this.result().error);

  /** The history lists closed visits only — an open one goes back to the appointments. */
  protected readonly backLink = computed(() => {
    const s = this.appt()?.status;
    return s && s !== 'completed' && s !== 'cancelled' ? '/dashboard/appointments' : '/dashboard/history';
  });

  /** Not closed yet and still within the rejoin window. */
  protected readonly canRejoin = computed(() => {
    const a = this.appt();
    return !!a && a.status === 'confirmed' && this.now() < new Date(a.scheduled_at).getTime() + REJOIN_WINDOW_MS;
  });

  /** Completed and not rated from this browser yet (or rated just now — keep the thanks in view). */
  protected readonly ratingVisible = computed(() => {
    const a = this.appt();
    if (!a || a.status !== 'completed') return false;
    return this.reviewState() !== 'idle' || !wasReviewed(a.id);
  });

  constructor() {
    // Just back from a call the doctor hasn't ended: pick up the moment they
    // close it (the summary, prescriptions and rating then appear).
    const timer = setInterval(() => {
      this.now.set(Date.now());
      this.pollStatus();
    }, STATUS_POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  private pollStatus(): void {
    const a = this.appt();
    if (!a || a.status !== 'confirmed') return;
    this.api
      .getMine(a.id)
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        const fresh = res?.data;
        if (!fresh || fresh.id !== this.appt()?.id || fresh.status === 'confirmed') return;
        this.refreshed.set(fresh);
        this.loadExtras(fresh.id);
      });
  }

  /** Send the rating (an "already reviewed" answer counts as done). */
  protected submitReview(id: string): void {
    if (this.reviewRating() === 0 || this.reviewState() === 'sending') return;
    this.reviewState.set('sending');
    this.reviewNote.set('');
    this.api
      .review(id, this.reviewRating(), this.reviewComment().trim() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.reviewed(id, 'Thanks for your feedback!'),
        error: (err: unknown) => {
          if (isAlreadyReviewed(err)) {
            this.reviewed(id, 'You have already rated this consultation — thank you.');
            return;
          }
          this.reviewState.set('error');
          this.reviewNote.set(apiErrorMessage(err, 'Could not send your rating. Please try again.'));
        },
      });
  }

  private reviewed(id: string, note: string): void {
    rememberReviewed(id);
    this.reviewNote.set(note);
    this.reviewState.set('done');
    // The form (and its focused button) is gone — say so where focus lands.
    afterNextRender(() => this.reviewDone()?.nativeElement.focus(), { injector: this.injector });
  }

  private loadExtras(id: string): void {
    this.api
      .consultationSummary(id)
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => this.summary.set(res?.data ?? null));

    this.docsLoading.set(true);
    this.docsError.set('');
    this.rxError.set('');
    forkJoin({
      prescriptions: this.api.prescriptions(id).pipe(catchError((err: unknown) => of(this.failed(err, 'your prescriptions')))),
      referrals: this.api.referrals(id).pipe(catchError((err: unknown) => of(this.failed(err, 'your referrals')))),
      certificates: this.api.certificates(id).pipe(catchError((err: unknown) => of(this.failed(err, 'your certificates')))),
      labOrders: this.api.labOrders(id).pipe(catchError((err: unknown) => of(this.failed(err, 'your lab orders')))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ prescriptions, referrals, certificates, labOrders }) => {
        const failure = [prescriptions, referrals, certificates, labOrders].find(
          (r): r is { failed: string } => 'failed' in r,
        );
        this.docsError.set(failure?.failed ?? '');
        this.prescriptions.set('data' in prescriptions ? (prescriptions.data ?? []) : []);
        const docs: DocItem[] = [];
        for (const r of 'data' in referrals ? (referrals.data ?? []) : []) {
          docs.push({ kind: 'referral', id: r.id, title: `Referral · ${r.target}`, meta: r.reason });
        }
        for (const c of 'data' in certificates ? (certificates.data ?? []) : []) {
          docs.push({
            kind: 'certificate',
            id: c.id,
            title: c.type_label,
            meta: c.from_date && c.to_date ? `${c.from_date} → ${c.to_date}` : new Date(c.created_at).toLocaleDateString('en-GB'),
          });
        }
        this.docs.set(docs);
        this.labs.set('data' in labOrders ? (labOrders.data ?? []) : []);
        this.docsLoading.set(false);
      });
  }

  /** A failed documents request, carrying the API's message. */
  private failed(err: unknown, what: string): { failed: string } {
    return { failed: apiErrorMessage(err, `Could not load ${what}. Please try again.`) };
  }

  protected openDoc(id: string, doc: DocItem): void {
    openClinicalDocument(this.api.document(id, doc.kind, doc.id));
  }

  /**
   * Open the prescription PDF in a new tab. The tab is opened synchronously on
   * the click (so popup blockers allow it), then pointed at the signed link.
   */
  protected viewRx(rx: PrescriptionDto): void {
    if (this.openingRx()) return;
    const pending = openPendingTab();
    this.openingRx.set(rx.id);
    this.rxError.set('');
    this.prescriptionsApi
      .link(rx.id, false)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          pending.go(this.prescriptionsApi.fileUrl(res.data));
          this.openingRx.set('');
        },
        error: (err: unknown) => {
          pending.fail();
          this.openingRx.set('');
          this.rxError.set(apiErrorMessage(err, 'Could not open the prescription. Please try again.'));
        },
      });
  }

  protected rxStatus(status: PrescriptionStatus): { label: string; icon: string; cls: string } {
    return RX_STATUS[status] ?? RX_STATUS.active;
  }

  protected prescriberName(rx: PrescriptionDto): string {
    return rx.prescriber || rx.prescriber_details?.name || this.appt()?.specialist.name || 'Your doctor';
  }

  /** `YYYY-MM-DD` → "12 Oct 2026". */
  protected shortDate(ymd: string): string {
    const d = new Date(`${ymd.slice(0, 10)}T00:00:00`);
    return isNaN(d.getTime())
      ? ymd
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  protected initials(name: string): string {
    return name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }
  protected dateLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  }
  protected timeLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
  protected money(amount: string): string {
    return NAIRA.format(Number(amount) || 0);
  }
  protected paymentLabel(status: string | undefined): string {
    switch (status) {
      case 'paid': return 'Paid';
      case 'refunded': return 'Refunded';
      case 'pending': return 'Pending';
      default: return 'Unpaid';
    }
  }
}
