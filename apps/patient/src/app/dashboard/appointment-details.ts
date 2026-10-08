import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  catchError,
  distinctUntilChanged,
  filter,
  forkJoin,
  map,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import {
  apiErrorMessage,
  AppointmentsApi,
  injectCallPresence,
  openClinicalDocument,
  openPendingTab,
  PrescriptionsApi,
  SpecialistsApi,
} from '@supadoc/data-access';
import type {
  AppointmentDto,
  ClinicalDocumentKind,
  DayAvailability,
  MessageDto,
  PrescriptionDto,
  PrescriptionStatus,
} from '@supadoc/models';
import {
  ButtonComponent,
  CallPresenceComponent,
  IconComponent,
  MessageThreadComponent,
} from '@supadoc/ui';

/** Referrals and certificates still render as HTML documents; prescriptions open as PDFs. */
interface DocumentItem {
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

interface SharedDoc {
  readonly name: string;
  readonly size: string;
}

interface DetailsVm {
  readonly id: string;
  readonly specialistId: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeLabel: string;
  readonly typeIcon: string;
  readonly statusLabel: string;
  readonly statusClass: string;
  readonly amount: string;
  readonly guests: string[];
  readonly canCancel: boolean;
  readonly canReview: boolean;
}

const NAIRA = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

function toDetails(a: AppointmentDto): DetailsVm {
  const when = new Date(a.scheduled_at);
  return {
    id: a.id,
    specialistId: a.specialist.id,
    name: a.specialist.name,
    specialty: a.specialist.specialty ?? '',
    date: new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(when),
    time: new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(when),
    typeLabel: a.type_label,
    typeIcon: TYPE_ICON[a.type] ?? 'calendar-check',
    statusLabel: a.status_label,
    statusClass: STATUS_CLASS[a.status] ?? 'bg-cloud text-slate',
    amount: `₦${NAIRA.format(Number(a.amount) || 0)}`,
    guests: (a.guests ?? []).map((g) => g.name),
    canCancel: ['pending', 'confirmed', 'rescheduled'].includes(a.status),
    canReview: a.status === 'completed',
  };
}

/** Appointment details (Figma 648:9480) — wired to GET /api/portal/appointments/{id}. */
@Component({
  selector: 'pat-appointment-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ButtonComponent,
    CallPresenceComponent,
    IconComponent,
    MessageThreadComponent,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <a
            routerLink="/dashboard/appointments"
            class="mb-1 flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean"
          >
            <sd-icon name="chevron-right" [size]="16" class="rotate-180" />
            My Appointments
          </a>
          <h1 class="font-heading text-h3 text-ink">Appointment Details</h1>
          <p class="font-sans text-body text-slate">
            View and manage your scheduled consultations
          </p>
        </div>
        <sd-button size="sm" (click)="book()">
          <sd-icon name="plus" [size]="18" />
          Book Consultation
        </sd-button>
      </div>

      @if (notice(); as n) {
        <div
          class="flex items-center gap-2 rounded-card px-5 py-3 font-sans text-body-sm"
          [class]="n.ok ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'"
          role="status"
        >
          <sd-icon [name]="n.ok ? 'circle-check' : 'triangle-alert'" [size]="18" />
          {{ n.text }}
        </div>
      }

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-6">
            <div class="h-28 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
          </div>
        }
        @case ('error') {
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span
              class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert"
            >
              <sd-icon name="calendar-off" [size]="36" />
            </span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                Appointment not found
              </h2>
              <p class="font-sans text-body-sm text-slate">
                {{ loadError() }}
              </p>
            </div>
            <sd-button routerLink="/dashboard/appointments">
              Back to appointments
            </sd-button>
          </div>
        }
        @default {
          @if (vm(); as v) {
            <!-- Summary -->
            <section
              class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 md:flex-row md:items-center md:justify-between"
            >
              <div class="flex items-center gap-4">
                <span
                  class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean"
                  >{{ initials(v.name) }}</span
                >
                <div class="flex flex-col gap-1">
                  <p class="font-sans text-body-lg font-semibold text-ink">
                    {{ v.name }}
                  </p>
                  <p class="font-sans text-caption text-slate">
                    {{ v.specialty }}
                  </p>
                </div>
              </div>
              <div
                class="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 md:items-center"
              >
                <div
                  class="flex flex-col gap-2 font-sans text-caption text-slate"
                >
                  <span class="flex items-center gap-2">
                    <sd-icon name="calendar-days" [size]="16" />{{ v.date }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon name="clock" [size]="16" />{{ v.time }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon [name]="v.typeIcon" [size]="16" />{{ v.typeLabel }}
                  </span>
                </div>
                <!-- Status + who's in the call; wraps under the dates on narrow phones -->
                <div class="ml-auto flex flex-col items-end gap-2">
                  <span
                    class="shrink-0 rounded-lg px-4 py-1.5 font-sans text-body-sm font-medium"
                    [class]="v.statusClass"
                    >{{ v.statusLabel }}</span
                  >
                  <sd-call-presence
                    [presence]="presence()[v.id]"
                    viewer="patient"
                    size="md"
                  />
                </div>
              </div>
            </section>

            <!-- Instructions + actions -->
            <section
              class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 lg:flex-row lg:justify-between"
            >
              <div class="flex flex-col gap-3">
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="clipboard-list" [size]="20" />
                  Consultation Instructions
                </h2>
                <div
                  class="flex flex-col gap-3 font-sans text-body-sm text-slate"
                >
                  <p>
                    Please ensure you have a stable internet connection.<br />
                    Join the consultation 5-10minutes early.
                  </p>
                  <p>
                    Upload any relevant medical reports or tests below, so the
                    doctor can review them.
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 flex-col gap-3 lg:w-[240px]">
                <!-- A soft green halo + clearer label once the doctor is waiting -->
                <sd-button
                  [full]="true"
                  [class]="doctorInCall() ? 'rounded-field ring-4 ring-success/25' : ''"
                  (click)="joinCall(v.id)"
                >
                  <sd-icon name="video" [size]="18" />
                  {{
                    doctorInCall()
                      ? 'Join now — your doctor is in the call'
                      : 'Join Consultation'
                  }}
                </sd-button>
                @if (v.canCancel) {
                  <sd-button variant="outline" [full]="true" (click)="openReschedule(v)"
                    >Reschedule Appointment</sd-button
                  >
                }
                @if (v.canCancel) {
                  <button
                    type="button"
                    class="inline-flex w-full items-center justify-center gap-2 rounded-field border border-alert px-4 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60"
                    [disabled]="cancelling()"
                    (click)="cancel(v.id)"
                  >
                    <sd-icon name="trash-2" [size]="18" />
                    {{ cancelling() ? 'Cancelling…' : 'Cancel Appointment' }}
                  </button>
                }
                @if (v.canReview && !reviewed()) {
                  <sd-button variant="outline" [full]="true" (click)="reviewOpen.set(true)">
                    <sd-icon name="star" [size]="18" />Leave a review
                  </sd-button>
                }
                @if (reviewed()) {
                  <p class="flex items-center justify-center gap-1.5 font-sans text-body-sm font-semibold text-sage">
                    <sd-icon name="circle-check" [size]="18" />Thanks for your review!
                  </p>
                }
              </div>
            </section>

            <!-- Documents + payment -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
              >
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="file-text" [size]="20" />
                  Shared Documents
                </h2>
                <ul class="flex flex-col gap-3">
                  @for (doc of documents; track doc.name) {
                    <li class="flex items-center gap-3">
                      <sd-icon
                        name="file-text"
                        [size]="20"
                        class="shrink-0 text-slate"
                      />
                      <span
                        class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink"
                      >
                        {{ doc.name }} ({{ doc.size }})
                      </span>
                    </li>
                  } @empty {
                    <li class="font-sans text-body-sm text-slate">
                      No documents were shared for this consultation.
                    </li>
                  }
                </ul>
              </section>

              <section
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
              >
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="credit-card" [size]="20" />
                  Consultation Fee
                </h2>
                <span
                  class="flex items-center gap-2 font-sans text-body-sm text-ink"
                >
                  <sd-icon name="credit-card" [size]="20" class="text-slate" />
                  Amount: {{ v.amount }}
                </span>
                @if (v.guests.length > 0) {
                  <span
                    class="flex items-start gap-2 font-sans text-body-sm text-ink"
                  >
                    <sd-icon name="users" [size]="20" class="mt-0.5 shrink-0 text-slate" />
                    Guests: {{ v.guests.join(', ') }}
                  </span>
                }
              </section>
            </div>

            <!-- Clinical documents (prescriptions, referrals, certificates) -->
            @if (prescriptions().length > 0 || clinicalDocs().length > 0 || docsError()) {
              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
                  <sd-icon name="file-text" [size]="20" />
                  Documents
                </h2>
                <ul class="flex flex-col gap-2">
                  @for (rx of prescriptions(); track rx.id) {
                    <li class="flex flex-col gap-3 rounded-field border border-cloud px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div class="flex min-w-0 items-start gap-3">
                        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal">
                          <sd-icon name="pill" [size]="18" />
                        </span>
                        <span class="flex min-w-0 flex-col gap-1">
                          <span class="flex flex-wrap items-center gap-2">
                            <span class="font-sans text-body-sm font-semibold text-ink">Prescription {{ rx.number }}</span>
                            <span
                              class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium"
                              [class]="rxStatus(rx.status).cls"
                            >
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
                          <sd-icon
                            [name]="openingRx() === rx.id ? 'loader-circle' : 'eye'"
                            [size]="14"
                            [class.animate-spin]="openingRx() === rx.id"
                          />View
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
                  @for (doc of clinicalDocs(); track doc.kind + doc.id) {
                    <li class="flex items-center justify-between gap-3 rounded-field border border-cloud px-4 py-3">
                      <span class="flex min-w-0 flex-col">
                        <span class="font-sans text-body-sm font-semibold text-ink">{{ doc.title }}</span>
                        @if (doc.meta) { <span class="truncate font-sans text-caption text-slate">{{ doc.meta }}</span> }
                      </span>
                      <button type="button" class="flex shrink-0 items-center gap-1.5 font-sans text-caption font-semibold text-cerulean hover:underline" (click)="openDoc(doc)">
                        <sd-icon name="download" [size]="16" />Open / print
                      </button>
                    </li>
                  }
                </ul>
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
            }

            <!-- Secure messages with the doctor -->
            <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
              <div class="flex flex-col gap-1">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
                  <sd-icon name="message-square" [size]="20" />
                  Messages
                </h2>
                <p class="font-sans text-caption text-slate">
                  Message {{ v.name }} about this consultation. For emergencies, call your local emergency number.
                </p>
              </div>
              <div class="h-[52vh]">
                <sd-message-thread
                  viewerRole="patient"
                  [messages]="messages()"
                  [loading]="messagesLoading()"
                  [sending]="sendingMessage()"
                  [placeholder]="'Message ' + v.name + '…'"
                  emptyText="No messages yet. Send a message to your doctor."
                  (send)="sendMessage(v.id, $event)"
                />
              </div>
              @if (messageError()) { <p class="font-sans text-caption text-alert">{{ messageError() }}</p> }
            </section>
          }
        }
      }
    </div>

    @if (reviewOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="reviewOpen.set(false)"></button>
        <div class="relative z-10 flex w-full max-w-md flex-col gap-5 rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)]">
          <div class="flex items-center justify-between">
            <h3 class="font-heading text-h5 text-ink">Rate your consultation</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="reviewOpen.set(false)"><sd-icon name="x" [size]="24" /></button>
          </div>
          <div class="flex justify-center gap-2">
            @for (i of [1,2,3,4,5]; track i) {
              <button type="button" (click)="reviewRating.set(i)" [attr.aria-label]="i + ' stars'">
                <sd-icon name="star" [size]="32" [class]="i <= reviewRating() ? 'text-warning' : 'text-cloud'" />
              </button>
            }
          </div>
          <textarea rows="3" class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" placeholder="Share how it went (optional)" [value]="reviewComment()" (input)="reviewComment.set($any($event.target).value)"></textarea>
          @if (reviewError()) { <p class="font-sans text-caption text-alert">{{ reviewError() }}</p> }
          <sd-button [full]="true" [disabled]="reviewing()" (click)="submitReview()">
            {{ reviewing() ? 'Submitting…' : 'Submit review' }}
          </sd-button>
        </div>
      </div>
    }

    @if (rescheduleOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="rescheduleOpen.set(false)"></button>
        <div class="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)]">
          <div class="flex items-center justify-between">
            <h3 class="font-heading text-h5 text-ink">Reschedule appointment</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="rescheduleOpen.set(false)"><sd-icon name="x" [size]="24" /></button>
          </div>

          @if (rescheduleLoading()) {
            <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
          } @else if (rescheduleDays().length === 0 && !rescheduleError()) {
            <p class="font-sans text-body-sm text-slate">This specialist has no open slots in the next couple of weeks. Please try again later.</p>
          } @else {
            <div class="flex flex-wrap gap-2">
              @for (d of rescheduleDays(); track d.date) {
                <button type="button" class="rounded-field border px-3 py-2 font-sans text-caption font-semibold transition-colors" [class]="selectedDay()?.date === d.date ? 'border-cerulean bg-frost text-cerulean' : 'border-cloud text-slate hover:border-cerulean/40'" (click)="selectDay(d)">
                  {{ d.weekday }} {{ d.day }}
                </button>
              }
            </div>
            @if (selectedDay(); as d) {
              <div class="grid grid-cols-3 gap-2">
                @for (s of d.slots; track s.iso) {
                  <button type="button" class="rounded-field border px-2 py-2 font-sans text-caption font-medium transition-colors" [class]="selectedIso() === s.iso ? 'border-cerulean bg-frost text-cerulean' : 'border-cloud text-ink hover:border-cerulean/40'" (click)="selectedIso.set(s.iso)">
                    {{ s.label }}
                  </button>
                }
              </div>
            }
          }

          @if (rescheduleError()) { <p class="font-sans text-caption text-alert">{{ rescheduleError() }}</p> }
          <sd-button [full]="true" [disabled]="rescheduling() || !selectedIso()" (click)="submitReschedule()">
            {{ rescheduling() ? 'Rescheduling…' : 'Confirm new time' }}
          </sd-button>
        </div>
      </div>
    }
  `,
})
export class AppointmentDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);
  private readonly prescriptionsApi = inject(PrescriptionsApi);
  private readonly specialists = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Who is in my appointments' calls right now — polled while the page is open. */
  protected readonly presence = injectCallPresence(() =>
    this.appointments.presence(),
  );
  /** The doctor has joined this appointment's call — the join button says so. */
  protected readonly doctorInCall = computed(() => {
    const id = this.vm()?.id;
    return !!id && !!this.presence()[id]?.doctor;
  });

  protected readonly cancelling = signal(false);
  protected readonly notice = signal<{ ok: boolean; text: string } | null>(null);

  // Secure messaging
  protected readonly messages = signal<MessageDto[]>([]);
  protected readonly messagesLoading = signal(false);
  protected readonly sendingMessage = signal(false);
  protected readonly messageError = signal('');

  // Clinical documents (issued prescriptions, referrals, certificates)
  protected readonly prescriptions = signal<PrescriptionDto[]>([]);
  protected readonly clinicalDocs = signal<DocumentItem[]>([]);
  /** A documents request failed — shown so a failure never reads as "no documents". */
  protected readonly docsError = signal('');
  /** Opening a prescription PDF failed. */
  protected readonly rxError = signal('');
  /** Id of the prescription whose PDF link is being fetched. */
  protected readonly openingRx = signal('');

  constructor() {
    // Load the thread + documents whenever the appointment id in the route changes.
    this.route.paramMap
      .pipe(
        map((p) => p.get('id') ?? ''),
        filter((id): id is string => id !== ''),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => {
        this.loadMessages(id);
        this.loadDocuments(id);
      });
  }

  private loadDocuments(id: string): void {
    this.docsError.set('');
    this.rxError.set('');
    forkJoin({
      prescriptions: this.appointments
        .prescriptions(id)
        .pipe(catchError((err: unknown) => of(this.failed(err, 'your prescriptions')))),
      referrals: this.appointments
        .referrals(id)
        .pipe(catchError((err: unknown) => of(this.failed(err, 'your referrals')))),
      certificates: this.appointments
        .certificates(id)
        .pipe(catchError((err: unknown) => of(this.failed(err, 'your certificates')))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ prescriptions, referrals, certificates }) => {
        const failure = [prescriptions, referrals, certificates].find(
          (r): r is { failed: string } => 'failed' in r,
        );
        this.docsError.set(failure?.failed ?? '');
        this.prescriptions.set('data' in prescriptions ? (prescriptions.data ?? []) : []);
        const docs: DocumentItem[] = [];
        for (const r of 'data' in referrals ? (referrals.data ?? []) : []) {
          docs.push({
            kind: 'referral',
            id: r.id,
            title: `Referral · ${r.target}`,
            meta: r.reason,
          });
        }
        for (const c of 'data' in certificates ? (certificates.data ?? []) : []) {
          docs.push({
            kind: 'certificate',
            id: c.id,
            title: c.type_label,
            meta:
              c.from_date && c.to_date
                ? `${c.from_date} → ${c.to_date}`
                : new Date(c.created_at).toLocaleDateString('en-GB'),
          });
        }
        this.clinicalDocs.set(docs);
      });
  }

  /** A failed documents request, carrying the API's message. */
  private failed(err: unknown, what: string): { failed: string } {
    return { failed: apiErrorMessage(err, `Could not load ${what}. Please try again.`) };
  }

  protected openDoc(doc: DocumentItem): void {
    const id = this.vm()?.id;
    if (id) openClinicalDocument(this.appointments.document(id, doc.kind, doc.id));
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
    return rx.prescriber || rx.prescriber_details?.name || this.vm()?.name || 'Your doctor';
  }

  /** `YYYY-MM-DD` → "12 Oct 2026". */
  protected shortDate(ymd: string): string {
    const d = new Date(`${ymd.slice(0, 10)}T00:00:00`);
    return isNaN(d.getTime())
      ? ymd
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  private loadMessages(id: string): void {
    this.messagesLoading.set(true);
    this.messageError.set('');
    this.appointments
      .messages(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.messages.set(res.data);
          this.messagesLoading.set(false);
        },
        error: (err: unknown) => {
          this.messageError.set(apiErrorMessage(err, 'Could not load your messages.'));
          this.messagesLoading.set(false);
        },
      });
  }

  protected sendMessage(id: string, body: string): void {
    this.sendingMessage.set(true);
    this.messageError.set('');
    this.appointments
      .sendMessage(id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.messages.update((list) => [...list, res.data]);
          this.sendingMessage.set(false);
        },
        error: (err) => {
          this.messageError.set(apiErrorMessage(err, 'Could not send the message.'));
          this.sendingMessage.set(false);
        },
      });
  }

  // Review
  protected readonly reviewOpen = signal(false);
  protected readonly reviewRating = signal(5);
  protected readonly reviewComment = signal('');
  protected readonly reviewing = signal(false);
  protected readonly reviewError = signal('');
  protected readonly reviewed = signal(false);
  /** Latest appointment after an in-place mutation (e.g. cancel), overriding the fetch. */
  private readonly override = signal<AppointmentDto | null>(null);

  protected joinCall(id: string): void {
    void this.router.navigate(['/dashboard/call', id]);
  }

  // Reschedule
  protected readonly rescheduleOpen = signal(false);
  protected readonly rescheduleLoading = signal(false);
  protected readonly rescheduleDays = signal<DayAvailability[]>([]);
  protected readonly selectedDay = signal<DayAvailability | null>(null);
  protected readonly selectedIso = signal('');
  protected readonly rescheduling = signal(false);
  protected readonly rescheduleError = signal('');

  protected openReschedule(v: DetailsVm): void {
    this.rescheduleOpen.set(true);
    this.rescheduleError.set('');
    this.selectedDay.set(null);
    this.selectedIso.set('');
    this.rescheduleDays.set([]);
    this.rescheduleLoading.set(true);
    this.specialists
      .slots(v.specialistId, 14)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.rescheduleDays.set(res.data);
          this.selectedDay.set(res.data[0] ?? null);
          this.rescheduleLoading.set(false);
        },
        error: (err: unknown) => {
          this.rescheduleError.set(
            apiErrorMessage(err, 'Could not load available times. Please try again.'),
          );
          this.rescheduleLoading.set(false);
        },
      });
  }

  protected selectDay(d: DayAvailability): void {
    this.selectedDay.set(d);
    this.selectedIso.set('');
  }

  protected submitReschedule(): void {
    const id = this.vm()?.id;
    const iso = this.selectedIso();
    if (!id || !iso || this.rescheduling()) return;
    this.rescheduling.set(true);
    this.rescheduleError.set('');
    this.appointments
      .reschedule(id, iso)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.override.set(res.data);
          this.rescheduling.set(false);
          this.rescheduleOpen.set(false);
          this.notice.set({ ok: true, text: 'Appointment rescheduled to your new time.' });
        },
        error: (err) => {
          this.rescheduling.set(false);
          this.rescheduleError.set(apiErrorMessage(err, 'Could not reschedule. Please pick another slot.'));
        },
      });
  }

  protected submitReview(): void {
    const id = this.vm()?.id;
    if (!id || this.reviewing()) return;
    this.reviewing.set(true);
    this.reviewError.set('');
    this.appointments
      .review(id, this.reviewRating(), this.reviewComment().trim() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.reviewing.set(false);
          this.reviewOpen.set(false);
          this.reviewed.set(true);
        },
        error: (err) => {
          this.reviewError.set(apiErrorMessage(err, 'Could not submit your review.'));
          this.reviewing.set(false);
        },
      });
  }

  protected cancel(id: string): void {
    if (this.cancelling()) return;
    if (!window.confirm('Cancel this appointment? Any payment will be refunded to your wallet.')) {
      return;
    }
    this.cancelling.set(true);
    this.notice.set(null);
    this.appointments
      .cancel(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.override.set(res.data);
          this.cancelling.set(false);
          this.notice.set({
            ok: true,
            text:
              res.data.payment_status === 'refunded'
                ? 'Appointment cancelled. Your payment has been refunded to your wallet.'
                : 'Appointment cancelled.',
          });
        },
        error: (err) => {
          this.cancelling.set(false);
          this.notice.set({ ok: false, text: apiErrorMessage(err, 'Could not cancel the appointment.') });
        },
      });
  }

  /** Booking starts at the specialist directory (same as the dashboard CTA). */
  protected book(): void {
    void this.router.navigate(['/dashboard/specialists']);
  }

  protected initials(name: string): string {
    return (name ?? '')
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';
  }

  // Document sharing isn't modelled by the backend yet — show an empty state
  // rather than fabricated files.
  protected readonly documents: SharedDoc[] = [];

  private readonly result = toSignal(
    this.route.paramMap.pipe(
      map((p) => p.get('id') ?? ''),
      switchMap((id) =>
        this.appointments.getMine(id).pipe(
          map((res) => ({ state: 'loaded' as const, appt: res.data, error: '' })),
          catchError((err: unknown) =>
            of({
              state: 'error' as const,
              appt: null,
              error: apiErrorMessage(
                err,
                "This appointment doesn't exist or is no longer available.",
              ),
            }),
          ),
          startWith({ state: 'loading' as const, appt: null, error: '' }),
        ),
      ),
    ),
    { initialValue: { state: 'loading' as const, appt: null, error: '' } },
  );

  protected readonly viewState = computed(() => this.result().state);
  protected readonly loadError = computed(() => this.result().error);

  protected readonly vm = computed<DetailsVm | null>(() => {
    const appt = this.override() ?? this.result().appt;
    return appt ? toDetails(appt) : null;
  });
}
