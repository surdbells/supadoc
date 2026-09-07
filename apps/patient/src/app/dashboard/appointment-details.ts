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
  map,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import { apiErrorMessage, AppointmentsApi } from '@supadoc/data-access';
import type { AppointmentDto, MessageDto } from '@supadoc/models';
import { ButtonComponent, IconComponent, MessageThreadComponent } from '@supadoc/ui';

interface SharedDoc {
  readonly name: string;
  readonly size: string;
}

interface DetailsVm {
  readonly id: string;
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
  imports: [RouterLink, ButtonComponent, IconComponent, MessageThreadComponent],
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
                This appointment doesn't exist or is no longer available.
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
                <img
                  src="/dashboard/avatar-james.png"
                  alt=""
                  width="64"
                  height="64"
                  class="size-16 shrink-0 rounded-full object-cover"
                />
                <div class="flex flex-col gap-1">
                  <p class="font-sans text-body-lg font-semibold text-ink">
                    {{ v.name }}
                  </p>
                  <p class="font-sans text-caption text-slate">
                    {{ v.specialty }}
                  </p>
                </div>
              </div>
              <div class="flex items-start justify-between gap-8 md:items-center">
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
                <span
                  class="shrink-0 rounded-lg px-4 py-1.5 font-sans text-body-sm font-medium"
                  [class]="v.statusClass"
                  >{{ v.statusLabel }}</span
                >
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
                <sd-button [full]="true" (click)="joinCall(v.id)">
                  <sd-icon name="video" [size]="18" />
                  Join Consultation
                </sd-button>
                <sd-button variant="outline" [full]="true"
                  >Reschedule Appointment</sd-button
                >
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
  `,
})
export class AppointmentDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly cancelling = signal(false);
  protected readonly notice = signal<{ ok: boolean; text: string } | null>(null);

  // Secure messaging
  protected readonly messages = signal<MessageDto[]>([]);
  protected readonly messagesLoading = signal(false);
  protected readonly sendingMessage = signal(false);
  protected readonly messageError = signal('');

  constructor() {
    // Load the thread whenever the appointment id in the route changes.
    this.route.paramMap
      .pipe(
        map((p) => p.get('id') ?? ''),
        filter((id): id is string => id !== ''),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => this.loadMessages(id));
  }

  private loadMessages(id: string): void {
    this.messagesLoading.set(true);
    this.appointments
      .messages(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.messages.set(res.data);
          this.messagesLoading.set(false);
        },
        error: () => this.messagesLoading.set(false),
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

  // Document sharing isn't modelled by the backend yet — show an empty state
  // rather than fabricated files.
  protected readonly documents: SharedDoc[] = [];

  private readonly result = toSignal(
    this.route.paramMap.pipe(
      map((p) => p.get('id') ?? ''),
      switchMap((id) =>
        this.appointments.getMine(id).pipe(
          map((res) => ({ state: 'loaded' as const, appt: res.data })),
          catchError(() => of({ state: 'error' as const, appt: null })),
          startWith({ state: 'loading' as const, appt: null }),
        ),
      ),
    ),
    { initialValue: { state: 'loading' as const, appt: null } },
  );

  protected readonly viewState = computed(() => this.result().state);

  protected readonly vm = computed<DetailsVm | null>(() => {
    const appt = this.override() ?? this.result().appt;
    return appt ? toDetails(appt) : null;
  });
}
