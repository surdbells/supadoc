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
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  catchError,
  distinctUntilChanged,
  filter,
  firstValueFrom,
  forkJoin,
  map,
  of,
  startWith,
  Subscription,
  switchMap,
  tap,
} from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  AppointmentsApi,
  AvailabilityCalendarStore,
  DocumentsApi,
  DocumentSharingApi,
  injectCallPresence,
  openBlobDocument,
  openClinicalDocument,
  openPendingTab,
  PrescriptionsApi,
  WalletApi,
} from '@supadoc/data-access';
import type {
  AcceptFollowUpParams,
  AppointmentDocumentAccessDto,
  AppointmentDto,
  ClinicalDocumentKind,
  DocumentAccessRequestDto,
  DocumentGrantDto,
  DocumentShareResultDto,
  FollowUpPriceDto,
  FollowUpQuoteDto,
  MedicalDocumentDto,
  MessageDto,
  PatientVisibleDocumentDto,
  PrescriptionDto,
  PrescriptionStatus,
} from '@supadoc/models';
import {
  AlertComponent,
  BookingCalendarComponent,
  ButtonComponent,
  CallPresenceComponent,
  ConfirmDetail,
  DialogComponent,
  DialogService,
  IconComponent,
  MessageThreadComponent,
} from '@supadoc/ui';
import { doctorTitle } from '../call/call-helpers';
import { afterDialogsClose } from '../dialog-helpers';
import { type ApproveOutcome, approveOutcomeLine, ApproveRequestDialog } from './approve-request-dialog';
import { detailsLink, isPast, nairaLabel, OPEN_STATUSES, phaseOf, StatusBadge, statusBadge } from './appointment-status';
import { calendarErrorText } from './booking-helpers';
import {
  accessUntilPhrase,
  bookedShareLine,
  countNoun,
  isSharingUnavailable,
  possessive,
  shareResultLine,
  SHARING_UNAVAILABLE,
  untilPhrase,
} from './document-sharing';
import { DocumentUploadDialog } from './document-upload-dialog';
import { dayLabel, isOpenProposal, priceLabel, priceNote, whenLabel } from './follow-up';
import { GuestsPanel } from './guests-panel';
import { loadPaystack } from './paystack';
import { ShareDialog } from './share-dialog';

/** Referrals and certificates still render as HTML documents; prescriptions open as PDFs. */
interface DocumentItem {
  readonly kind: Exclude<ClinicalDocumentKind, 'prescription'>;
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

/** Every prescription status reads as an icon AND a word — never colour alone. */
const RX_STATUS: Record<PrescriptionStatus, { label: string; icon: string; cls: string }> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-warning/15 text-warning-ink' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-sage/15 text-sage-ink' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert-ink' },
};

/** How long after its start an ended consultation nobody has closed yet can still be rejoined. */
const REJOIN_WINDOW_MS = 12 * 60 * 60_000;

interface DetailsVm {
  readonly id: string;
  readonly specialistId: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeLabel: string;
  readonly typeIcon: string;
  /** The server's label, colours, icon and the line under it ("Awaiting doctor confirmation"). */
  readonly badge: StatusBadge;
  readonly amount: string;
  readonly guests: string[];
  /** Before its start only (`can_cancel`); after it: 422 "This consultation has started". */
  readonly canCancel: boolean;
  /** Before its start only (`can_reschedule`). */
  readonly canReschedule: boolean;
  /** Open, started, and no longer cancellable or movable — said next to the actions. */
  readonly started: boolean;
  readonly canReview: boolean;
  /** Open and not over (or ended and not closed yet, within the rejoin window) — a closed one has no call to join. */
  readonly canJoin: boolean;
  /** In progress now. */
  readonly live: boolean;
  /** Over — the back link goes to History. */
  readonly past: boolean;
  /** Over and a real booking (not a proposal never taken up): its record is on its History page. */
  readonly inHistory: boolean;
  /** The line pointing to History — a cancelled booking never took place, so no "summary" there. */
  readonly historyNote: string;
  /** A doctor's follow-up proposal (answered with the panel, not Join / Cancel). */
  readonly isProposal: boolean;
  /** The consultation this follows up ('' when it isn't a follow-up). */
  readonly parentId: string;
  readonly parentDate: string;
}

/** What the "Follow-up proposed" panel shows. */
interface ProposalVm {
  /** Still answerable (not past `expires_at`). */
  readonly open: boolean;
  readonly note: string;
  readonly respondBy: string;
  /** The proposed start, local time. */
  readonly when: string;
  readonly amount: string;
  readonly pricing: FollowUpPriceDto | null;
}

const NAIRA = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

/** Why an appointment that is over has its record in History — worded for how it ended. */
function historyNote(a: AppointmentDto, badge: StatusBadge): string {
  if (a.status === 'cancelled') return 'This appointment was cancelled. Its payment and any refund are in your history.';
  if (a.status === 'missed') return 'This consultation was closed as missed. What happened and any refund are in your history.';
  if (badge.key === 'not_confirmed') {
    return "Your doctor didn't confirm this consultation in time. Its payment and any refund are in your history.";
  }
  return 'This consultation is over. Its summary, documents and payment are in your history.';
}

function toDetails(a: AppointmentDto, now: number): DetailsVm {
  const when = new Date(a.scheduled_at);
  const badge = statusBadge(a);
  const open = OPEN_STATUSES.includes(a.status);
  const phase = phaseOf(a);
  // The server's flags (open and not started when read) — and the start not
  // reached since, as the page ticks; an older payload has only the latter.
  const beforeStart = now < when.getTime();
  const canCancel = (a.can_cancel ?? open) && beforeStart;
  const canReschedule = (a.can_reschedule ?? open) && beforeStart;
  const rejoinable = badge.key === 'finalising' && now < when.getTime() + REJOIN_WINDOW_MS;
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
    badge,
    // A free consultation reads "Free", never "₦0.00".
    amount: Number(a.amount) > 0 ? `₦${NAIRA.format(Number(a.amount))}` : 'Free',
    guests: (a.guests ?? []).map((g) => g.name),
    canCancel,
    canReschedule,
    started: open && !beforeStart,
    canReview: a.status === 'completed',
    canJoin: open && (phase !== 'past' || rejoinable),
    live: badge.key === 'live',
    past: isPast(a),
    inHistory: detailsLink(a)[0] === '/dashboard/history',
    historyNote: historyNote(a, badge),
    isProposal: a.status === 'proposed',
    parentId: a.parent_appointment_id ?? '',
    parentDate: dayLabel(a.parent?.scheduled_at),
  };
}

/**
 * Appointment details (Figma 648:9480) — wired to GET /api/portal/appointments/{id}.
 * A follow-up the doctor proposed is answered here: the doctor's note, the
 * price (and why), optionally another open time of the same doctor (picked on
 * their month calendar), payment by wallet or card (free ones need none),
 * Accept, or Decline with an optional reason. `?respond=accept|time|decline`
 * (from the appointments list) jumps straight to that step. Rescheduling picks
 * the new time on the same calendar, in a dialog.
 *
 * Cancel and Reschedule are offered only before the start (`can_cancel` /
 * `can_reschedule`; the API answers 422 "This consultation has started" after
 * it). Cancelling asks first, saying what goes back to the wallet
 * (`cancel_policy`). A consultation that is over points to its History page.
 */
@Component({
  selector: 'pat-appointment-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    BookingCalendarComponent,
    ButtonComponent,
    CallPresenceComponent,
    DialogComponent,
    ApproveRequestDialog,
    DocumentUploadDialog,
    GuestsPanel,
    IconComponent,
    MessageThreadComponent,
    ShareDialog,
  ],
  // One doctor's calendar: the reschedule dialog's or the follow-up's "another
  // time" (never both — a proposal can't be rescheduled).
  providers: [AvailabilityCalendarStore],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <a
            [routerLink]="vm()?.past ? '/dashboard/history' : '/dashboard/appointments'"
            class="mb-1 flex min-h-11 w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean sm:min-h-0"
          >
            <sd-icon name="chevron-right" [size]="16" class="rotate-180" />
            {{ vm()?.past ? 'Consultation History' : 'My Appointments' }}
          </a>
          <h1 #pageTitle tabindex="-1" class="font-heading text-h3 text-ink outline-none">Appointment Details</h1>
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
              class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert-ink"
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
              class="flex flex-col gap-6 rounded-card border border-haze bg-white p-6 shadow-card md:flex-row md:items-center md:justify-between"
            >
              <div class="flex items-center gap-4">
                <span
                  class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean-dark"
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
                  @if (v.parentId) {
                    <a
                      [routerLink]="['/dashboard/history', v.parentId]"
                      class="flex min-h-11 items-center gap-2 font-semibold text-cerulean hover:underline sm:min-h-0"
                    >
                      <sd-icon name="history" [size]="16" />
                      Follow-up of your {{ v.parentDate || 'earlier' }} consultation
                    </a>
                  }
                </div>
                <!-- Status + who's in the call; wraps under the dates on narrow phones -->
                <div class="ml-auto flex flex-col items-end gap-2">
                  <span
                    class="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-1.5 font-sans text-body-sm font-medium inset-ring inset-ring-current/20"
                    [class]="v.badge.class"
                    ><sd-icon [name]="v.badge.icon" [size]="16" />{{ v.badge.label }}</span
                  >
                  @if (v.badge.detail) {
                    <span class="max-w-[14rem] text-right font-sans text-caption text-slate">{{ v.badge.detail }}</span>
                  }
                  <sd-call-presence
                    [presence]="presence()[v.id]"
                    viewer="patient"
                    size="md"
                  />
                </div>
              </div>
            </section>

            <!-- Over: its summary, documents and payment live in History -->
            @if (v.inHistory) {
              <section class="flex flex-col gap-3 rounded-card border border-cloud bg-glacier p-5 sm:flex-row sm:items-center sm:justify-between">
                <p class="flex items-start gap-3 font-sans text-body-sm text-ink">
                  <sd-icon name="history" [size]="20" class="mt-0.5 shrink-0 text-cerulean" />
                  {{ v.historyNote }}
                </p>
                <a
                  [routerLink]="['/dashboard/history', v.id]"
                  class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-field border border-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30"
                >
                  View in history<sd-icon name="chevron-right" [size]="16" />
                </a>
              </section>
            }

            <!-- A follow-up the doctor proposed: accept (paying unless free), another time, or decline -->
            @if (proposal(); as fp) {
              <section
                #respondPanel
                tabindex="-1"
                class="flex flex-col gap-5 rounded-card border border-teal/30 bg-white p-5 shadow-card outline-none sm:p-6"
                aria-labelledby="proposal-title"
              >
                <div class="flex flex-col gap-1">
                  <h2
                    id="proposal-title"
                    class="flex items-center gap-2 font-sans text-body font-semibold text-teal"
                  >
                    <sd-icon name="calendar-plus" [size]="20" />
                    {{ v.name }} proposed a follow-up
                  </h2>
                  @if (fp.open) {
                    <p class="flex items-start gap-1.5 font-sans text-body-sm text-slate">
                      <sd-icon name="hourglass" [size]="16" class="mt-0.5 shrink-0 text-warning" />
                      Respond by {{ fp.respondBy }} — the time is held for you until then.
                    </p>
                  }
                </div>

                @if (!fp.open) {
                  <!-- Expired: read-only (the server closes it shortly) -->
                  <sd-alert tone="warning">
                    <span class="text-ink">
                      This follow-up proposal has expired, so it can no longer be
                      accepted.
                    </span>
                    @if (v.parentId) {
                      <a
                        [routerLink]="['/dashboard/history', v.parentId]"
                        class="mt-2 flex w-fit items-center gap-1 font-semibold text-cerulean hover:underline"
                      >
                        <sd-icon name="calendar-plus" [size]="16" />
                        Book a follow-up from your consultation
                      </a>
                    }
                  </sd-alert>
                } @else {
                  @if (fp.note) {
                    <figure class="flex flex-col gap-1 rounded-field bg-glacier px-4 py-3">
                      <figcaption class="font-sans text-caption font-semibold text-slate">
                        Note from {{ v.name }}
                      </figcaption>
                      <blockquote class="whitespace-pre-line break-words font-sans text-body-sm text-ink">
                        {{ fp.note }}
                      </blockquote>
                    </figure>
                  }

                  <!-- Time: the proposed one, or another open slot of the same doctor -->
                  <div class="flex flex-col gap-3">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div class="flex min-w-0 flex-col gap-0.5">
                        <span class="font-sans text-caption font-semibold text-slate">
                          {{ altIso() ? 'Your new time' : 'Proposed time' }}
                        </span>
                        <span class="flex items-center gap-2 font-sans text-body font-semibold text-ink">
                          <sd-icon name="calendar-clock" [size]="18" class="shrink-0 text-slate" />
                          {{ altIso() ? altWhen() : fp.when }}
                        </span>
                      </div>
                      <button
                        type="button"
                        class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:opacity-60 disabled:shadow-none"
                        [attr.aria-expanded]="slotsOpen()"
                        aria-controls="proposal-slots"
                        [disabled]="accepting()"
                        (click)="toggleSlots(v.specialistId)"
                      >
                        <sd-icon [name]="slotsOpen() ? 'x' : 'calendar-days'" [size]="16" />
                        {{ slotsOpen() ? 'Keep the proposed time' : 'Choose another time' }}
                      </button>
                    </div>
                    <div id="proposal-slots">
                      @if (slotsOpen()) {
                        <!-- Edge to edge on phones so each day stays a 44px target -->
                        <div class="-mx-5 flex flex-col gap-3 border-y border-cloud bg-glacier/40 px-1 py-3 sm:mx-0 sm:rounded-card sm:border sm:p-4">
                          @if (calendarError()) {
                            <sd-alert tone="error">{{ calendarError() }}</sd-alert>
                            <button
                              type="button"
                              class="min-h-11 w-fit rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
                              (click)="cal.refresh()"
                            >
                              Try again
                            </button>
                          }
                          @if (noOpenings()) {
                            <p class="font-sans text-body-sm text-slate">
                              {{ v.name }} has no other open times in the next {{ cal.range()?.horizon_days }} days.
                            </p>
                          } @else {
                            <!-- The patient's own calendar and clock (cal.tz) -->
                            <sd-booking-calendar
                              [days]="cal.days()"
                              [month]="cal.month()"
                              (monthChange)="cal.setMonth($event)"
                              [selectedDate]="cal.selectedDate()"
                              (selectedDateChange)="cal.selectDate($event)"
                              [slots]="cal.slots()"
                              [value]="altIso() || null"
                              (valueChange)="pickAlt($event ?? '')"
                              [loading]="cal.loading()"
                              [slotsLoading]="cal.slotsLoading()"
                              [min]="cal.min()"
                              [max]="cal.max()"
                              [nextAvailable]="cal.nextAvailable()"
                              [timeZone]="cal.tz()"
                              [timeZoneLabel]="cal.timeZoneLabel()"
                              [weekStartsOn]="cal.weekStartsOn()"
                              [disabled]="accepting()"
                            />
                            <p class="font-sans text-caption text-slate">
                              Pick another time, or keep the proposed time.
                            </p>
                          }
                        </div>
                      }
                    </div>
                  </div>

                  <!-- Price, and why -->
                  <div class="flex flex-col gap-1 border-t border-cloud pt-4" aria-live="polite">
                    <div class="flex items-center justify-between gap-3">
                      <span class="font-sans text-body-sm text-slate">Follow-up fee</span>
                      <span class="font-heading text-h5 text-ink">
                        {{ priceReady() ? priceText() : quoteError() ? '—' : 'Checking price…' }}
                      </span>
                    </div>
                    @if (priceReady() && priceWhy()) {
                      <p class="font-sans text-caption text-slate">{{ priceWhy() }}</p>
                    }
                    @if (quoteError()) {
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <p class="flex min-w-0 items-start gap-1.5 font-sans text-caption text-alert" role="alert">
                          <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ quoteError() }}
                        </p>
                        <button
                          type="button"
                          class="min-h-11 shrink-0 rounded-field border border-haze bg-white px-4 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
                          (click)="pickAlt(altIso())"
                        >
                          Try again
                        </button>
                      </div>
                    }
                  </div>

                  <!-- Payment (none for a free follow-up) -->
                  @if (priceReady() && !proposalFree()) {
                    <div class="flex flex-col gap-3" role="group" aria-labelledby="pay-with-title">
                      <h3 id="pay-with-title" class="font-sans text-body-sm font-semibold text-ink">Pay with</h3>
                      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          class="flex min-h-11 items-center gap-3 rounded-card border-2 p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                          [class]="payMethod() === 'card' ? 'border-cerulean bg-frost/30' : 'border-cloud hover:border-cerulean/40'"
                          [attr.aria-pressed]="payMethod() === 'card'"
                          [disabled]="accepting()"
                          (click)="payMethod.set('card')"
                        >
                          <sd-icon name="credit-card" [size]="22" class="shrink-0 text-cerulean" />
                          <span class="flex min-w-0 flex-col">
                            <span class="font-sans text-body-sm font-semibold text-ink">Card</span>
                            <span class="font-sans text-caption text-slate">Secure checkout via Paystack</span>
                          </span>
                          @if (payMethod() === 'card') {
                            <sd-icon name="circle-check" [size]="20" class="ml-auto shrink-0 text-cerulean" />
                          }
                        </button>
                        <!-- Not once the card has been charged: the wallet would pay twice. -->
                        <button
                          type="button"
                          class="flex min-h-11 items-center gap-3 rounded-card border-2 p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed disabled:opacity-50"
                          [class]="payMethod() === 'wallet' ? 'border-cerulean bg-frost/30' : 'border-cloud hover:border-cerulean/40'"
                          [attr.aria-pressed]="payMethod() === 'wallet'"
                          [disabled]="accepting() || !!paidReference()"
                          (click)="payMethod.set('wallet')"
                        >
                          <sd-icon name="wallet" [size]="22" class="shrink-0 text-cerulean" />
                          <span class="flex min-w-0 flex-col">
                            <span class="font-sans text-body-sm font-semibold text-ink">Wallet</span>
                            <span class="font-sans text-caption text-slate">{{ walletCaption() }}</span>
                          </span>
                          @if (payMethod() === 'wallet') {
                            <sd-icon name="circle-check" [size]="20" class="ml-auto shrink-0 text-cerulean" />
                          }
                        </button>
                      </div>
                      @if (payMethod() === 'wallet' && walletShort()) {
                        <p class="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-card bg-alert/5 px-4 py-3 font-sans text-caption text-alert">
                          <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />
                          <span class="min-w-0 flex-1">
                            Your wallet is short by {{ shortfallText() }}. Pay by card, or
                            <a routerLink="/dashboard/wallet" class="font-semibold text-cerulean underline">top up your wallet</a>
                            and come back to accept.
                          </span>
                        </p>
                      }
                      @if (payMethod() === 'card' && paidReference()) {
                        <p class="flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate">
                          <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
                          Your card payment went through, but the follow-up wasn't
                          confirmed. Fix what's shown below and try again — you won't
                          be charged twice.
                        </p>
                      }
                    </div>
                  }

                  @if (paidNote()) {
                    <sd-alert tone="warning">{{ paidNote() }}</sd-alert>
                  }
                  @if (unusedPayment()) {
                    <sd-alert tone="warning">{{ unusedPayment() }}</sd-alert>
                  }
                  @if (acceptError()) {
                    <sd-alert tone="error">{{ acceptError() }}</sd-alert>
                  }

                  <div class="flex flex-col gap-3 border-t border-cloud pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <button
                      type="button"
                      class="inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-alert px-4 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60 sm:order-first"
                      [disabled]="accepting()"
                      (click)="openDecline()"
                    >
                      <sd-icon name="circle-x" [size]="18" />
                      Decline
                    </button>
                    <sd-button [disabled]="!canAccept()" (click)="accept()">
                      @if (accepting()) {
                        <sd-icon name="loader-circle" [size]="18" class="animate-spin" />
                      } @else {
                        <sd-icon name="circle-check" [size]="18" />
                      }
                      {{ acceptLabel() }}
                    </sd-button>
                  </div>
                }
              </section>
            }

            <!-- Instructions + actions (not once it is over and there is nothing left to do) -->
            @if (!v.isProposal && (!v.past || v.canJoin || v.canReview)) {
            <section
              class="flex flex-col gap-6 rounded-card border border-haze bg-white p-6 shadow-card lg:flex-row lg:justify-between"
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
                    Your doctor can only see the documents you share with them.
                    You can share, change or stop sharing below or in
                    <a [routerLink]="'/dashboard/documents/sharing'" [queryParams]="{ doctor: v.specialistId }" class="font-semibold text-cerulean hover:underline">Manage sharing</a>.
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 flex-col gap-3 lg:w-[240px]">
                <!-- A soft green halo + clearer label once the doctor is waiting -->
                @if (v.canJoin) {
                  <sd-button
                    [full]="true"
                    [class]="doctorInCall() || v.live ? 'rounded-field ring-4 ring-success/25' : ''"
                    (click)="joinCall(v.id)"
                  >
                    <sd-icon name="video" [size]="18" />
                    {{
                      doctorInCall()
                        ? 'Join now — your doctor is in the call'
                        : v.live
                          ? 'Join now — it has started'
                          : 'Join Consultation'
                    }}
                  </sd-button>
                }
                @if (v.canReschedule) {
                  <sd-button variant="outline" [full]="true" (click)="openReschedule(v)"
                    >Reschedule Appointment</sd-button
                  >
                }
                @if (v.canCancel) {
                  <button
                    type="button"
                    class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-field border border-alert px-4 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40 aria-busy:opacity-70"
                    [attr.aria-busy]="cancelChecking() || null"
                    (click)="cancel()"
                  >
                    <!-- Not [disabled] while checking: that would drop focus, and the prompt returns focus here. -->
                    <sd-icon [name]="cancelChecking() ? 'loader-circle' : 'calendar-x'" [size]="18" [class.animate-spin]="cancelChecking()" />
                    Cancel Appointment
                  </button>
                  @if (cancelHint(); as hint) {
                    <p class="font-sans text-caption text-slate">{{ hint }}</p>
                  }
                }
                @if (v.started) {
                  <p class="flex items-start gap-1.5 font-sans text-caption text-slate">
                    <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
                    This consultation has started, so it can no longer be cancelled or moved.
                  </p>
                }
                @if (v.canReview && !reviewed()) {
                  <sd-button variant="outline" [full]="true" (click)="openReview()">
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
            }

            <!-- Guests: who is invited, their links, add / resend / remove -->
            @if (!v.isProposal) {
              <pat-guests-panel
                [appointmentId]="v.id"
                [doctorName]="doctorDisplayName()"
                [liveGuestIds]="presence()[v.id]?.guests ?? []"
                [version]="guestsVersion()"
                (changed)="guestsChanged(v.id)"
              />
            }

            <!-- Documents + payment -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section
                class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card"
              >
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="share-2" [size]="20" />
                  Shared with {{ doctorDisplayName() }}
                </h2>
                <p class="sr-only" aria-live="polite" aria-atomic="true">{{ sharingLive() }}</p>
                <!-- What this doctor can see, from the sharing API (refetched when a share ends) -->
                @if (sharingLoading() && !sharing()) {
                  <div class="sd-shimmer h-14 rounded-field"></div>
                } @else if (sharingOff()) {
                  <p class="flex items-start gap-2 font-sans text-body-sm text-slate" role="status">
                    <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ sharingOffText }}
                  </p>
                } @else if (sharingError() && !sharing()) {
                  <p class="flex items-start gap-2 font-sans text-caption text-alert-ink" role="alert">
                    <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />Could not load what you share with {{ doctorDisplayName() }}.
                  </p>
                  <button
                    type="button"
                    class="min-h-11 w-fit rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
                    (click)="loadSharing(v.id)"
                  >
                    Try again
                  </button>
                } @else if (sharing(); as s) {
                  @if (sharingNotice()) {
                    <!-- Announced once, by the section's live region (no second role="status" here). -->
                    <p class="flex items-start gap-2 rounded-field bg-sage/15 px-3 py-2 font-sans text-caption text-sage-ink">
                      <sd-icon name="circle-check" [size]="16" class="mt-0.5 shrink-0" />{{ sharingNotice() }}
                    </p>
                  }
                  @if (s.pending_request; as r) {
                    <div class="flex flex-col gap-2 rounded-field bg-warning/15 px-3 py-3 font-sans text-body-sm text-warning-ink">
                      <p class="flex items-start gap-2"><sd-icon name="key-round" [size]="18" class="mt-0.5 shrink-0" />{{ doctorDisplayName() }} asked to see your documents.</p>
                      <div class="flex flex-wrap gap-2 pl-6">
                        <button type="button" class="inline-flex min-h-11 items-center rounded-field bg-cerulean px-4 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="reviewRequest(r)">Review</button>
                        <button type="button" class="inline-flex min-h-11 items-center rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-slate shadow-control transition hover:border-cerulean" (click)="reviewRequest(r, true)">Decline</button>
                      </div>
                    </div>
                  }
                  <p class="font-sans text-body-sm text-ink">{{ sharingSummary() }}</p>

                  @if (s.visible_documents.length > 0) {
                    <ul class="flex flex-col gap-2" [attr.aria-label]="'Documents ' + doctorDisplayName() + ' can see'">
                      @for (d of s.visible_documents; track d.id) {
                        <li class="flex items-center gap-1 rounded-field border border-cloud pr-1">
                          <button
                            type="button"
                            class="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-field px-3 py-2 text-left transition-colors hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                            [attr.aria-label]="'Open ' + d.title + ', ' + d.type_label"
                            (click)="openShared(d)"
                          >
                            <sd-icon name="file-text" [size]="20" class="shrink-0 text-slate" />
                            <span class="flex min-w-0 flex-1 flex-col">
                              <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                              <span class="truncate font-sans text-caption text-slate"
                                ><span class="uppercase">{{ d.extension }}</span> · {{ d.size_label }} · {{ d.type_label }} · {{ visibleUntil(d) }}</span
                              >
                            </span>
                          </button>
                          <button
                            type="button"
                            class="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-field px-2 font-sans text-caption font-semibold text-alert-ink transition-colors hover:bg-alert/5"
                            [attr.aria-label]="'Remove ' + doctorDisplayName() + '’s access to ' + d.title"
                            (click)="removeAccess(v.id, d)"
                          >
                            <sd-icon name="user-x" [size]="16" />Remove
                          </button>
                        </li>
                      }
                    </ul>
                  }

                  @if (s.unshared_attachments.length > 0) {
                    <div class="flex flex-col gap-2">
                      <h3 class="font-sans text-body-sm font-semibold text-ink">Attached when you booked — not shared</h3>
                      <ul class="flex flex-col gap-2">
                        @for (d of s.unshared_attachments; track d.id) {
                          <li class="flex flex-wrap items-center gap-2 rounded-field border border-cloud px-3 py-2">
                            <button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left" [attr.aria-label]="'Open ' + d.title" (click)="openShared(d)">
                              <sd-icon name="file-text" [size]="20" class="shrink-0 text-slate" />
                              <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                            </button>
                            <span class="inline-flex items-center gap-1 rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-medium text-slate inset-ring inset-ring-current/20">
                              <sd-icon name="lock" [size]="12" />Private
                            </span>
                            <button
                              type="button"
                              class="inline-flex min-h-11 items-center gap-1 rounded-field border border-haze bg-white px-3 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60"
                              [disabled]="!s.can_share"
                              [attr.aria-label]="'Share ' + d.title + ' with ' + doctorDisplayName()"
                              (click)="shareOne(s.specialist.id, d.id)"
                            >
                              <sd-icon name="share-2" [size]="14" />Share
                            </button>
                          </li>
                        }
                      </ul>
                    </div>
                  }

                  @if (s.visible_documents.length === 0 && s.unshared_attachments.length === 0) {
                    <p class="font-sans text-body-sm text-slate">No documents shared for this consultation yet.</p>
                  }
                  @if (!s.can_share) {
                    <p class="flex items-start gap-2 font-sans text-caption text-slate">
                      <sd-icon name="hourglass" [size]="16" class="mt-0.5 shrink-0" />{{ doctorDisplayName() }} isn't practising on VideoMed right now.
                    </p>
                  }
                  <div class="flex flex-wrap gap-2">
                    <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field bg-cerulean px-4 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="!s.can_share" (click)="shareWithDoctor(s.specialist.id)">
                      <sd-icon name="share-2" [size]="16" />Share documents
                    </button>
                    @if (!v.past || v.live) {
                      <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="!s.can_share" (click)="uploadOpen.set(true)">
                        <sd-icon name="upload" [size]="16" />Upload and share
                      </button>
                    }
                    <a [routerLink]="'/dashboard/documents/sharing'" [queryParams]="{ doctor: s.specialist.id }" class="inline-flex min-h-11 items-center gap-1 px-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean">
                      Manage sharing<sd-icon name="chevron-right" [size]="16" />
                    </a>
                  </div>
                }
              </section>

              <section
                class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card"
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
              <section class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean">
                  <sd-icon name="file-text" [size]="20" />
                  Documents
                </h2>
                <ul class="flex flex-col gap-2">
                  @for (rx of prescriptions(); track rx.id) {
                    <li class="flex flex-col gap-3 rounded-field border border-cloud px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div class="flex min-w-0 items-start gap-3">
                        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal-ink">
                          <sd-icon name="pill" [size]="18" />
                        </span>
                        <span class="flex min-w-0 flex-col gap-1">
                          <span class="flex flex-wrap items-center gap-2">
                            <span class="font-sans text-body-sm font-semibold text-ink">Prescription {{ rx.number }}</span>
                            <span
                              class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20"
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
                          class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-3 py-1.5 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:opacity-60 disabled:shadow-none"
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
            <section class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card">
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

    <!-- Rate a completed consultation -->
    <sd-dialog
      [open]="reviewOpen()"
      title="Rate your consultation"
      [subtitle]="'How was your consultation with ' + (vm()?.name ?? 'your doctor') + '?'"
      size="sm"
      [busy]="reviewing()"
      (closed)="closeReview()"
      (afterClose)="focusTitleIfLost()"
    >
      <div class="flex flex-col gap-5">
        <div class="flex justify-center gap-1" role="group" aria-label="Your rating, 1 to 5 stars">
          @for (i of [1, 2, 3, 4, 5]; track i) {
            <button
              type="button"
              class="flex size-11 items-center justify-center rounded-field transition-colors hover:bg-(--sd-dialog-hover) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)"
              [attr.data-autofocus]="i === reviewRating() ? '' : null"
              [attr.aria-label]="i + (i === 1 ? ' star' : ' stars')"
              [attr.aria-pressed]="i === reviewRating()"
              [disabled]="reviewing()"
              (click)="reviewRating.set(i)"
            >
              <sd-icon name="star" [size]="30" [class]="i <= reviewRating() ? 'text-warning' : 'text-slate/80'" />
            </button>
          }
        </div>
        <label class="flex flex-col gap-1.5">
          <span class="font-sans text-caption font-semibold text-(--sd-dialog-muted)">Comment (optional)</span>
          <textarea
            rows="3"
            maxlength="1000"
            class="w-full rounded-field border border-(--sd-dialog-field) bg-(--sd-dialog-surface) px-4 py-3 font-sans text-body-sm text-(--sd-dialog-text) focus:border-(--sd-dialog-primary) focus:outline-none"
            placeholder="Share how it went"
            [disabled]="reviewing()"
            [value]="reviewComment()"
            (input)="reviewComment.set($any($event.target).value)"
          ></textarea>
        </label>
        @if (reviewError()) {
          <p class="flex items-start gap-2 font-sans text-caption text-(--sd-dialog-danger-text)" role="alert">
            <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ reviewError() }}
          </p>
        }
      </div>
      <div dialogFooter class="flex flex-col-reverse gap-3 border-t border-(--sd-dialog-border) px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button
          type="button"
          class="inline-flex min-h-11 items-center justify-center rounded-field border border-(--sd-dialog-border) px-5 py-2.5 font-sans text-body-sm font-semibold text-(--sd-dialog-muted) transition-colors hover:bg-(--sd-dialog-hover) disabled:opacity-60"
          [disabled]="reviewing()"
          (click)="closeReview()"
        >
          Not now
        </button>
        <sd-button [disabled]="reviewing()" (click)="submitReview()">
          @if (reviewing()) {
            <sd-icon name="loader-circle" [size]="18" class="animate-spin" />
          }
          {{ reviewing() ? 'Submitting…' : 'Submit review' }}
        </sd-button>
      </div>
    </sd-dialog>

    <!-- Move the booking to another open time of the same doctor -->
    <sd-dialog
      [open]="rescheduleOpen()"
      title="Reschedule appointment"
      [subtitle]="rescheduleSubtitle()"
      size="xl"
      [busy]="rescheduling()"
      (closed)="closeReschedule()"
    >
      <div class="flex flex-col gap-4">
        @if (calendarError()) {
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
            <sd-alert tone="error" class="min-w-0 flex-1">{{ calendarError() }}</sd-alert>
            <button
              type="button"
              class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-field border border-(--sd-dialog-border) px-4 font-sans text-body-sm font-semibold text-(--sd-dialog-primary) transition-colors hover:border-(--sd-dialog-primary)"
              (click)="cal.refresh()"
            >
              Try again
            </button>
          </div>
        }
        @if (noOpenings()) {
          <p class="font-sans text-body-sm text-(--sd-dialog-muted)">
            This specialist has no open times in the next {{ cal.range()?.horizon_days }} days. Please try again later.
          </p>
        } @else {
          <!-- The patient's own calendar and clock (cal.tz) -->
          <sd-booking-calendar
            [days]="cal.days()"
            [month]="cal.month()"
            (monthChange)="cal.setMonth($event)"
            [selectedDate]="cal.selectedDate()"
            (selectedDateChange)="cal.selectDate($event)"
            [slots]="cal.slots()"
            [value]="selectedIso() || null"
            (valueChange)="selectedIso.set($event ?? '')"
            [loading]="cal.loading()"
            [slotsLoading]="cal.slotsLoading()"
            [min]="cal.min()"
            [max]="cal.max()"
            [nextAvailable]="cal.nextAvailable()"
            [timeZone]="cal.tz()"
            [timeZoneLabel]="cal.timeZoneLabel()"
            [weekStartsOn]="cal.weekStartsOn()"
            [disabled]="rescheduling()"
          />
        }
        @if (rescheduleError()) {
          <p class="flex items-start gap-2 font-sans text-caption text-(--sd-dialog-danger-text)" role="alert">
            <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ rescheduleError() }}
          </p>
        }
      </div>
      <div dialogFooter class="flex flex-col gap-3 border-t border-(--sd-dialog-border) px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6">
        <p class="font-sans text-body-sm text-(--sd-dialog-muted) sm:mr-auto" aria-live="polite">
          @if (selectedIso()) {
            New time: <span class="font-semibold text-(--sd-dialog-strong)">{{ newTimeLabel() }}</span>
          } @else {
            Pick a day, then a time.
          }
        </p>
        <sd-button [disabled]="rescheduling() || !selectedIso()" (click)="submitReschedule()">
          @if (rescheduling()) {
            <sd-icon name="loader-circle" [size]="18" class="animate-spin" />
          }
          {{ rescheduling() ? 'Rescheduling…' : 'Confirm new time' }}
        </sd-button>
      </div>
    </sd-dialog>

    <!-- Document sharing with this consultation's doctor -->
    @if (shareReq(); as r) {
      <pat-share-dialog
        [preselectDoctorIds]="[r.doctorId]"
        [preselectDocumentIds]="r.documentIds"
        [initialScope]="r.documentIds.length > 0 ? 'selected' : null"
        [lockDoctor]="true"
        [appointment]="sharingAnchor()"
        [answersRequest]="sharing()?.pending_request ?? null"
        initialDuration="after_24h"
        surface="appointment_details"
        (done)="sharingDone($event)"
        (closed)="shareReq.set(null)"
      />
    }
    @if (uploadOpen() && sharing(); as s) {
      <pat-document-upload-dialog
        [presetDoctorId]="s.specialist.id"
        [appointment]="sharingAnchor()"
        [lockDoctor]="true"
        surface="appointment_details"
        doneLabel="Done"
        (closed)="uploadClosed($event.uploaded)"
      />
    }
    @if (requestReview(); as rr) {
      <pat-approve-request-dialog [request]="rr.request" [startWithDecline]="rr.decline" (done)="requestAnswered($event)" (closed)="requestReview.set(null)" />
    }
  `,
})
export class AppointmentDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);
  private readonly prescriptionsApi = inject(PrescriptionsApi);
  private readonly documentsApi = inject(DocumentsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly doc = inject(DOCUMENT);
  private readonly pageTitle = viewChild<ElementRef<HTMLElement>>('pageTitle');

  /** Who is in my appointments' calls right now — polled while the page is open. */
  protected readonly presence = injectCallPresence(() =>
    this.appointments.presence(),
  );
  /** The doctor has joined this appointment's call — the join button says so. */
  protected readonly doctorInCall = computed(() => {
    const id = this.vm()?.id;
    return !!id && !!this.presence()[id]?.doctor;
  });

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

  // What this consultation's doctor can see (GET …/appointments/{id}/document-access).
  private readonly sharingApi = inject(DocumentSharingApi);
  protected readonly sharing = signal<AppointmentDocumentAccessDto | null>(null);
  protected readonly sharingLoading = signal(false);
  protected readonly sharingError = signal('');
  /** 503 `sharing_unavailable`: sharing is switched off. */
  protected readonly sharingOff = signal(false);
  protected readonly sharingOffText = SHARING_UNAVAILABLE;
  protected readonly sharingNotice = signal('');
  protected readonly sharingLive = signal('');
  protected readonly shareReq = signal<{ doctorId: string; documentIds: string[] } | null>(null);
  /**
   * The consultation "after the consultation" ends anchor to. Never a
   * follow-up proposal: it has no such ends, and the API refuses its id.
   */
  protected readonly sharingAnchor = computed(() =>
    this.appt()?.status === 'proposed' ? null : (this.sharing()?.appointment ?? null),
  );
  protected readonly uploadOpen = signal(false);
  protected readonly requestReview = signal<{ request: DocumentAccessRequestDto; decline: boolean } | null>(null);
  /** Refetch (passively) when a share ends or starts. */
  private sharingTimer?: ReturnType<typeof setTimeout>;
  protected readonly sharingSummary = computed(() => {
    const s = this.sharing();
    if (!s) return '';
    const doctor = this.doctorDisplayName();
    const a = s.access;
    if (a.state === 'paused') return `${doctor} isn't practising on VideoMed right now, so they can't see anything.`;
    if (a.state === 'none') return `You haven't shared any documents with ${doctor}.`;
    // A folder holder: the folder share's own end ("including new uploads").
    const tail = accessUntilPhrase(a);
    const what =
      a.scope === 'all'
        ? 'all your documents, including new uploads'
        : countNoun(a.document_count, 'document');
    return `${doctor} can see ${what}${tail ? ` · ${tail}` : ''}`;
  });

  // ----- Follow-up proposal (status `proposed`) -----
  private readonly walletApi = inject(WalletApi);
  private readonly respondPanel = viewChild<ElementRef<HTMLElement>>('respondPanel');
  /** The `?respond=` step to jump to once the proposal has loaded (used once). */
  private pendingRespond = this.route.snapshot.queryParamMap.get('respond');
  /** Ticks so an open proposal turns read-only once it expires. */
  private readonly clock = signal(Date.now());

  protected readonly proposal = computed<ProposalVm | null>(() => {
    const a = this.appt();
    if (!a || a.status !== 'proposed') return null;
    return {
      open: isOpenProposal(a, this.clock()),
      note: a.follow_up_note?.trim() ?? '',
      respondBy: whenLabel(a.expires_at),
      when: whenLabel(a.scheduled_at),
      amount: a.amount,
      pricing: a.follow_up_pricing ?? null,
    };
  });

  // The doctor's month calendar — for another time instead of the proposed
  // one, and for rescheduling.
  protected readonly cal = inject(AvailabilityCalendarStore);
  protected readonly calendarError = computed(() => calendarErrorText(this.cal.error(), this.appt()?.specialist.name));
  /** Nothing open anywhere in the booking window (once the calendar knows). */
  protected readonly noOpenings = computed(() => {
    const range = this.cal.range();
    return !!range && range.next_available === null && !this.cal.error();
  });

  // Another open slot of the same doctor instead of the proposed time.
  protected readonly slotsOpen = signal(false);
  /** The slot the patient picked instead ('' = the proposed time). */
  protected readonly altIso = signal('');
  protected readonly altWhen = computed(() => whenLabel(this.altIso()));
  /** The price quoted for the patient's other time, keyed by the slot it is for. */
  private readonly altQuote = signal<{ iso: string; quote: FollowUpQuoteDto } | null>(null);
  protected readonly quoteError = signal('');
  private quoteSub?: Subscription;

  /** The chosen time is priced: the proposed one always is; another one once quoted. */
  protected readonly priceReady = computed(() => {
    const iso = this.altIso();
    return !iso || this.altQuote()?.iso === iso;
  });
  /** What accepting costs at the chosen time, and the rule that priced it. */
  private readonly price = computed<{ amount: string; pricing: FollowUpPriceDto | null }>(() => {
    const iso = this.altIso();
    const q = this.altQuote();
    if (iso && q?.iso === iso) return { amount: q.quote.amount, pricing: q.quote };
    const fp = this.proposal();
    return { amount: fp?.amount ?? '0', pricing: fp?.pricing ?? null };
  });
  protected readonly priceText = computed(() => priceLabel(this.price().amount));
  protected readonly priceWhy = computed(() => priceNote(this.price().pricing));
  protected readonly proposalFree = computed(() => !(Number(this.price().amount) > 0));

  // Paying: card (Paystack, the same pop-up as booking) or the wallet balance.
  protected readonly payMethod = signal<'card' | 'wallet'>('card');
  private readonly walletBalance = signal<number | null>(null);
  private readonly walletFailed = signal(false);
  private walletRequested = false;
  protected readonly walletCaption = computed(() => {
    const balance = this.walletBalance();
    if (this.walletFailed()) return 'Balance unavailable';
    return balance === null ? 'Balance …' : `Balance ₦${NAIRA.format(balance)}`;
  });
  protected readonly walletShort = computed(() => {
    const balance = this.walletBalance();
    return balance !== null && balance < Number(this.price().amount);
  });
  protected readonly shortfallText = computed(
    () => `₦${NAIRA.format(Math.max(0, Number(this.price().amount) - (this.walletBalance() ?? 0)))}`,
  );

  protected readonly accepting = signal(false);
  protected readonly acceptError = signal('');
  /**
   * A card payment that went through for an acceptance the server then refused
   * (another time taken, …), with the amount it paid — reused on the next try
   * instead of charging again, as long as it covers the chosen time's price.
   */
  private readonly paid = signal<{ reference: string; amount: number } | null>(null);
  /** The kept card payment while it covers the chosen time ('' otherwise). */
  protected readonly paidReference = computed(() => {
    const p = this.paid();
    if (!p) return '';
    // While another time is being priced it still counts (accepting waits for the price).
    if (!this.priceReady()) return p.reference;
    return !this.proposalFree() && Number(this.price().amount) <= p.amount ? p.reference : '';
  });
  /** How the kept card payment differs from the chosen time's price ('' when it matches). */
  protected readonly paidNote = computed(() => {
    const p = this.paid();
    if (!p || !this.priceReady()) return '';
    const now = Number(this.price().amount);
    const paidText = `₦${NAIRA.format(p.amount)}`;
    if (!(now > 0)) {
      return `This time is free, so your earlier card payment of ${paidText} won't be used — contact support with reference ${p.reference} about it.`;
    }
    if (now > p.amount) {
      return (
        `Your earlier card payment of ${paidText} doesn't cover this time (${this.priceText()}). ` +
        `Pick a time that costs ${paidText} or less to accept on it without paying again — ` +
        `paying now is a separate charge, so contact support about the earlier payment.`
      );
    }
    if (now < p.amount) {
      return (
        `Your earlier card payment of ${paidText} is more than this time costs (${this.priceText()}). ` +
        `Accepting uses it — contact support about the ₦${NAIRA.format(p.amount - now)} difference.`
      );
    }
    return '';
  });
  /** A card payment the server wouldn't take for this proposal, for support to sort out. */
  protected readonly unusedPayment = signal('');

  protected readonly canAccept = computed(() => {
    if (this.accepting() || !this.priceReady() || !this.proposal()?.open) return false;
    if (this.proposalFree() || this.payMethod() === 'card') return true;
    // The wallet: once the balance is known to cover it (or couldn't be read — the server decides).
    return this.walletFailed() || (this.walletBalance() !== null && !this.walletShort());
  });

  protected readonly acceptLabel = computed(() => {
    if (this.accepting()) return 'Processing…';
    if (!this.priceReady() || this.proposalFree()) return 'Accept follow-up';
    if (this.payMethod() === 'wallet') return `Pay ${this.priceText()} from wallet & accept`;
    return this.paidReference() ? 'Complete acceptance' : `Pay ${this.priceText()} by card & accept`;
  });

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
        // Another appointment: nothing from the last one carries over.
        this.override.set(null);
        this.notice.set(null);
        this.resetProposalState();
        this.paid.set(null);
        this.unusedPayment.set('');
        this.loadMessages(id);
        this.loadDocuments(id);
        this.sharing.set(null);
        this.sharingNotice.set('');
        this.shareReq.set(null);
        this.requestReview.set(null);
        this.loadSharing(id);
      });

    // Just booked with files (from Book a Consultation): what happened to the
    // sharing choice — shared (who and until when, from the booking's answer),
    // or not as asked.
    const docs = this.route.snapshot.queryParamMap.get('docs');
    if (docs === 'shared') {
      const shared = this.bookedShare();
      if (shared) this.notice.set({ ok: true, text: bookedShareLine(shared.doctorName, shared.untilLabelAt) });
    }
    if (docs === 'unavailable' || docs === 'private') {
      this.notice.set({
        ok: true,
        text:
          docs === 'unavailable'
            ? 'Booked. Sharing is unavailable right now, so your files stay private — you can share them below later.'
            : 'Booked. Your files weren’t shared with your doctor — you can share them below.',
      });
    }
    if (docs) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { docs: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }

    const tick = setInterval(() => this.clock.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      clearTimeout(this.sharingTimer);
      this.quoteSub?.unsubscribe();
    });

    // A card payment that covers the chosen time again is how it is paid: the
    // wallet would pay twice.
    effect(() => {
      if (this.paidReference()) untracked(() => this.payMethod.set('card'));
    });

    // An open proposal that may need paying: read the wallet balance once.
    effect(() => {
      if (!this.proposal()?.open || this.walletRequested) return;
      this.walletRequested = true;
      untracked(() => this.loadWallet());
    });

    // Arrived from the list's Accept / Choose another time / Decline: go to that step once.
    effect(() => {
      const fp = this.proposal();
      const step = this.pendingRespond;
      const specialistId = this.appt()?.specialist.id ?? '';
      if (!fp || !step) return;
      this.pendingRespond = null;
      untracked(() => {
        // Drop the param so a reload or Back doesn't jump again.
        void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
        if (fp.open && step === 'decline') {
          void this.openDecline();
          return;
        }
        if (fp.open && step === 'time' && !this.slotsOpen()) this.toggleSlots(specialistId);
        this.focusAfterRender(() => this.respondPanel()?.nativeElement);
      });
    });
  }

  // ----- Follow-up proposal -----

  protected toggleSlots(specialistId: string): void {
    if (this.slotsOpen()) {
      this.slotsOpen.set(false);
      this.pickAlt(''); // back to the proposed time
      return;
    }
    this.slotsOpen.set(true);
    this.cal.load(specialistId);
  }

  /** Take another slot (or '' for the proposed time) and price it for that date. */
  protected pickAlt(iso: string): void {
    this.altIso.set(iso);
    this.acceptError.set('');
    this.quoteError.set('');
    this.quoteSub?.unsubscribe();
    const id = this.appt()?.id;
    if (!iso || !id) return;
    this.quoteSub = this.appointments
      .followUpQuote(id, iso)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.altQuote.set({ iso, quote: res.data }),
        error: (err: unknown) =>
          this.quoteError.set(apiErrorMessage(err, 'Could not check the price for that time. Please try again.')),
      });
  }

  private loadWallet(): void {
    this.walletApi
      .wallet()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.walletBalance.set(Number(res.data.balance));
          this.walletFailed.set(false);
        },
        error: () => this.walletFailed.set(true),
      });
  }

  /**
   * Accept the proposal at the chosen time: free → straight away; wallet →
   * debited by the server; card → the Paystack pop-up (pay-init for this
   * proposal), then the verified reference confirms it.
   */
  protected async accept(): Promise<void> {
    const id = this.appt()?.id;
    if (!id || !this.canAccept()) return;
    const scheduledAt = this.altIso() || undefined;
    this.accepting.set(true);
    this.acceptError.set('');
    this.notice.set(null);
    if (this.proposalFree()) return this.sendAccept(id, { scheduled_at: scheduledAt });
    if (this.payMethod() === 'wallet') {
      return this.sendAccept(id, { payment_method: 'wallet', scheduled_at: scheduledAt });
    }
    // Already paid, but the acceptance was refused: try again on the same payment.
    const paid = this.paidReference();
    if (paid) return this.sendAccept(id, { payment_method: 'card', payment_reference: paid, scheduled_at: scheduledAt });
    try {
      const init = await firstValueFrom(this.appointments.payInitForProposal(id, scheduledAt));
      const Pop = await loadPaystack();
      new Pop().resumeTransaction(init.data.access_code, {
        onSuccess: () => {
          // An earlier payment this one replaces was never used.
          const earlier = this.paid();
          if (earlier) this.unusedPayment.set(this.unusedPaymentNote(earlier));
          this.paid.set({ reference: init.data.reference, amount: Number(init.data.amount) });
          this.sendAccept(id, {
            payment_method: 'card',
            payment_reference: init.data.reference,
            scheduled_at: scheduledAt,
          });
        },
        onCancel: () => {
          this.accepting.set(false);
          this.acceptError.set('Payment cancelled — nothing was charged. Try again when you’re ready.');
        },
        onError: () => {
          this.accepting.set(false);
          this.acceptError.set('The payment could not be completed. Please try again.');
        },
      });
    } catch (err) {
      // `payment: free` is a flag: nothing to pay at this time after all.
      if (apiErrorFields(err)['payment'] === 'free') {
        this.sendAccept(id, { scheduled_at: scheduledAt });
        return;
      }
      this.accepting.set(false);
      this.acceptError.set(apiErrorMessage(err, 'Could not start the card payment. Please try again.'));
      this.afterRefusal(err);
    }
  }

  private sendAccept(id: string, params: AcceptFollowUpParams): void {
    this.appointments
      .acceptFollowUp(id, params)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.accepting.set(false);
          // A card payment left unused on the way (refused, replaced, or not
          // needed at the time accepted) stays in view once the panel is gone.
          const kept = this.paid();
          const unused = [
            this.unusedPayment(),
            kept && kept.reference !== params.payment_reference ? this.unusedPaymentNote(kept) : '',
          ]
            .filter(Boolean)
            .join(' ');
          // Already accepted (another device): the card payment this try brought
          // wasn't needed, so the server put it in the wallet — the message says so.
          const credited = res.meta?.card_payment === 'credited_to_wallet';
          this.paid.set(null);
          this.unusedPayment.set('');
          this.resetProposalState();
          this.override.set(res.data);
          this.notice.set({
            ok: true,
            text: credited
              ? `${res.message}${unused ? ` ${unused}` : ''}`
              : 'Follow-up confirmed. We’ve emailed you the join link — you can also join from this page.' +
                (unused ? ` ${unused}` : ''),
          });
          // The panel (and the button that had focus) is gone.
          this.focusAfterRender(() => this.pageTitle()?.nativeElement);
        },
        error: (err: unknown) => {
          this.accepting.set(false);
          const fields = apiErrorFields(err);
          // The server put the card payment in the wallet (the acceptance was
          // refused, or it had been credited already): it can't pay again, but
          // the wallet can. The server's message says where the money went, so
          // no "contact support" note about it; a note about an earlier,
          // different payment (`unusedPayment`) still stands.
          if (fields['card_payment'] === 'credited_to_wallet' || /already in your wallet/i.test(fields['payment'] ?? '')) {
            const said = apiErrorMessage(err, 'Could not accept the follow-up. Please try again.');
            this.paid.set(null);
            this.payMethod.set('wallet');
            this.loadWallet();
            this.acceptError.set(said);
            // Closed meanwhile: the panel goes, so it is said at the top of the page.
            if (fields['status']) this.notice.set({ ok: false, text: said });
            this.afterRefusal(err);
            return;
          }
          // `wallet: insufficient_funds` is a flag, so it gets words of its own.
          if (fields['wallet'] === 'insufficient_funds') {
            this.acceptError.set(
              'Your wallet balance is too low to accept this follow-up. Pay by card, or top up your wallet and try again.',
            );
            this.loadWallet();
            return;
          }
          // The server won't take the kept card payment (it doesn't cover the
          // price, or was used already): stop retrying on it, and say what to do.
          // A verification hiccup ("… Please try again.") keeps it for a retry.
          const kept = this.paid();
          const refused = fields['payment'] ?? '';
          if (params.payment_reference && kept?.reference === params.payment_reference && refused && !/try again/i.test(refused)) {
            this.paid.set(null);
            this.unusedPayment.set(this.unusedPaymentNote(kept, refused));
            return;
          }
          // Closed meanwhile (expired, withdrawn): the panel goes, so the reason —
          // incl. a returned wallet debit or a card payment made for it — is
          // reported at the top of the page.
          if (fields['status']) {
            if (kept) this.paid.set(null);
            this.notice.set({ ok: false, text: kept ? this.unusedPaymentNote(kept, fields['status']) : fields['status'] });
          }
          this.acceptError.set(apiErrorMessage(err, 'Could not accept the follow-up. Please try again.'));
          this.afterRefusal(err);
        },
      });
  }

  /** What to tell the patient about a card payment no acceptance used (with the server's reason, if any). */
  private unusedPaymentNote(p: { reference: string; amount: number }, reason = ''): string {
    return (
      `${reason ? reason + ' ' : ''}Your earlier card payment of ₦${NAIRA.format(p.amount)} couldn't be used — ` +
      `contact support with reference ${p.reference}.`
    );
  }

  /**
   * The proposal closed meanwhile → show it as it is now; the other time went →
   * back to the proposed time, with fresh times to pick from (`paidNote` says
   * if a card payment made for the other time doesn't cover the proposed one).
   */
  private afterRefusal(err: unknown): void {
    const a = this.appt();
    if (!a) return;
    const fields = apiErrorFields(err);
    if (fields['status']) this.refresh(a.id);
    if (fields['scheduled_at'] && this.altIso()) {
      this.altIso.set('');
      this.cal.refresh();
    }
  }

  /** Re-read the appointment in place (best effort). */
  private refresh(id: string): void {
    this.appointments
      .getMine(id)
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (res?.data && res.data.id === this.appt()?.id) this.override.set(res.data);
      });
  }

  private resetProposalState(): void {
    this.quoteSub?.unsubscribe();
    this.slotsOpen.set(false);
    this.altIso.set('');
    this.altQuote.set(null);
    this.cal.selectDate(null);
    this.quoteError.set('');
    this.acceptError.set('');
  }

  /**
   * Decline the doctor's proposal (an optional reason goes to them). Asked in
   * the shared dialog, which shows the request's progress and any failure.
   */
  protected async openDecline(): Promise<void> {
    const id = this.appt()?.id;
    if (!id) return;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'circle-x',
      title: 'Decline this follow-up?',
      message:
        'Nothing has been charged. The time is released and your doctor is told you declined. ' +
        'You can still book a follow-up later.',
      reason: {
        label: 'Reason for your doctor',
        placeholder: "For example: I'm feeling better, or the time doesn't suit me",
        maxLength: 500,
      },
      confirmLabel: 'Decline follow-up',
      cancelLabel: 'Keep it',
      busyLabel: 'Declining…',
      size: 'md',
      action: (reason) =>
        this.appointments.declineFollowUp(id, reason || undefined).pipe(
          tap({
            next: (res) => {
              this.resetProposalState();
              this.override.set(res.data);
              // Withdrawn by the doctor or expired while the dialog was open: a 200 all the same.
              this.notice.set({
                ok: true,
                text:
                  res.message === 'Follow-up declined'
                    ? 'Follow-up declined. We’ve let your doctor know.'
                    : 'This follow-up proposal had already been closed.',
              });
            },
            error: (err: unknown) => {
              if (apiErrorFields(err)['status']) this.refresh(id);
            },
          }),
        ),
      errorMessage: (err) => apiErrorMessage(err, 'Could not decline the follow-up. Please try again.'),
    });
    // The panel (and the Decline button that opened the dialog) is gone.
    if (confirmed) afterDialogsClose(this.dialogs, this.injector, () => this.pageTitle()?.nativeElement.focus());
  }

  /**
   * What this consultation's doctor can see, their pending request and the
   * booking's attachments that aren't shared. `passive` for the refetch when a
   * share ends (it never extends the idle session).
   */
  protected loadSharing(id: string, passive = false): void {
    clearTimeout(this.sharingTimer);
    if (!passive) {
      this.sharingLoading.set(true);
      this.sharingError.set('');
    }
    this.sharingApi
      .forAppointment(id, { passive })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (this.appt()?.id && res.data.appointment.id !== this.appt()?.id) return;
          this.sharing.set(res.data);
          this.sharingLoading.set(false);
          this.sharingError.set('');
          this.sharingOff.set(false);
          this.scheduleSharingRefresh(id, res.data.access.next_change_at);
        },
        error: (err: unknown) => {
          this.sharingLoading.set(false);
          if (isSharingUnavailable(err)) {
            this.sharingOff.set(true);
            this.sharing.set(null);
            return;
          }
          if (!passive) this.sharingError.set(apiErrorMessage(err, 'Could not load what you share with your doctor.'));
        },
      });
  }

  /** One refetch when the next share ends (clamped to 1 s – 24 h), passively. */
  private scheduleSharingRefresh(id: string, nextChangeAt: string | null): void {
    clearTimeout(this.sharingTimer);
    const at = nextChangeAt ? Date.parse(nextChangeAt) : NaN;
    if (isNaN(at)) return;
    const delay = Math.min(Math.max(at - Date.now() + 1000, 1000), 24 * 60 * 60_000);
    this.sharingTimer = setTimeout(() => this.loadSharing(id, true), delay);
  }

  /** Same authenticated view as the Documents page: fetched as a blob, opened in a new tab. */
  protected openShared(d: MedicalDocumentDto): void {
    openBlobDocument(this.documentsApi.fileBlob(d.id));
  }

  /**
   * The sharing answer Book a Consultation handed over with the navigation
   * (`document_share` of the booking response, and the doctor's name), or null.
   */
  private bookedShare(): { doctorName: string | null; untilLabelAt: string | null } | null {
    const state = (this.router.currentNavigation()?.extras.state ??
      (typeof history !== 'undefined' ? history.state : null)) as Record<string, unknown> | null | undefined;
    const share = state?.['documentShare'] as AppointmentDto['document_share'] | null | undefined;
    if (!share || share.outcome !== 'shared') return null;
    const name = state?.['doctorName'];
    return { doctorName: typeof name === 'string' ? name : null, untilLabelAt: share.until_label_at ?? null };
  }

  /** "until 30 Oct 2026" / "no end date" for a visible document's sub-line. */
  protected visibleUntil(d: PatientVisibleDocumentDto): string {
    return d.indefinite ? 'no end date' : untilPhrase(d.until_label_at, false) || 'no end date';
  }

  protected shareWithDoctor(doctorId: string): void {
    this.sharingNotice.set('');
    this.shareReq.set({ doctorId, documentIds: [] });
  }

  protected shareOne(doctorId: string, documentId: string): void {
    this.sharingNotice.set('');
    this.shareReq.set({ doctorId, documentIds: [documentId] });
  }

  protected reviewRequest(request: DocumentAccessRequestDto, decline = false): void {
    this.sharingNotice.set('');
    this.requestReview.set({ request, decline });
  }

  private sharingSay(text: string): void {
    this.sharingNotice.set(text);
    this.sharingLive.set(text);
  }

  protected sharingDone(result: DocumentShareResultDto | DocumentGrantDto): void {
    this.sharingSay('outcomes' in result ? shareResultLine(result) : 'Changes saved.');
    const id = this.appt()?.id;
    if (id) this.loadSharing(id);
  }

  protected requestAnswered(outcome: ApproveOutcome): void {
    const line = approveOutcomeLine(outcome);
    if (line) this.sharingSay(line);
    const id = this.appt()?.id;
    if (id) this.loadSharing(id);
  }

  protected uploadClosed(uploaded: number): void {
    this.uploadOpen.set(false);
    const id = this.appt()?.id;
    if (uploaded > 0 && id) this.loadSharing(id);
  }

  /** Remove the doctor's access to one document (asked first; their other access stays). */
  protected async removeAccess(appointmentId: string, d: PatientVisibleDocumentDto): Promise<void> {
    const s = this.sharing();
    if (!s) return;
    const doctor = this.doctorDisplayName();
    this.sharingNotice.set('');
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'user-x',
      title: `Remove ${possessive(doctor)} access to this document?`,
      message: `They won't be able to open "${d.title}" any more, even through your whole-folder share. Everything else you share with them stays as it is. Copies they've already downloaded aren't affected.`,
      confirmLabel: 'Remove access',
      cancelLabel: 'Keep access',
      action: () => firstValueFrom(this.documentsApi.removeDoctorAccess(d.id, s.specialist.id)),
      errorMessage: (err) =>
        isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not remove access. Please try again.'),
    });
    if (!confirmed) return;
    this.sharingSay('Access removed.');
    this.loadSharing(appointmentId);
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

  /** "Dr Ada Obi" — named in the guest invitation note. */
  protected readonly doctorDisplayName = computed(() => doctorTitle(this.appt()?.specialist.name));
  /** The guest list is read again when the appointment changes (cancelled, rescheduled…). */
  protected readonly guestsVersion = computed(() => {
    const a = this.appt();
    return a ? `${a.status}|${a.scheduled_at}` : '';
  });

  /** A guest was added or removed: the summary's guest names (and amount) follow. */
  protected guestsChanged(id: string): void {
    this.refresh(id);
  }

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  /**
   * A dialog closed and the control that opened it is gone (e.g. "Leave a
   * review" after reviewing): put focus on the page heading rather than
   * dropping it on the page body. Runs after the dialog's own focus return.
   */
  protected focusTitleIfLost(): void {
    setTimeout(() => {
      const active = this.doc.activeElement;
      if (!active || active === this.doc.body) this.pageTitle()?.nativeElement.focus();
    });
  }

  protected openReview(): void {
    this.reviewError.set('');
    this.reviewOpen.set(true);
  }

  protected closeReview(): void {
    if (this.reviewing()) return; // let the request finish first
    this.reviewOpen.set(false);
  }

  protected closeReschedule(): void {
    if (this.rescheduling()) return; // let the request finish first
    this.rescheduleOpen.set(false);
  }

  // Reschedule
  protected readonly rescheduleOpen = signal(false);
  /** The new time's ISO start ('' = none picked yet). */
  protected readonly selectedIso = signal('');
  protected readonly newTimeLabel = computed(() => whenLabel(this.selectedIso()));
  protected readonly rescheduling = signal(false);
  protected readonly rescheduleError = signal('');
  /** The dialog's line under its title: the current time, and that the doctor confirms the new one. */
  protected readonly rescheduleSubtitle = computed(() => {
    const v = this.vm();
    return v
      ? `Now ${v.date} at ${v.time}. Choose a new time with ${v.name} — they'll confirm it.`
      : 'Choose a new time.';
  });

  protected openReschedule(v: DetailsVm): void {
    this.rescheduleOpen.set(true);
    this.rescheduleError.set('');
    this.selectedIso.set('');
    // The doctor's calendar (kept if it is already loaded), no day picked yet.
    this.cal.load(v.specialistId);
    this.cal.selectDate(null);
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
          // The reschedule reply has no `cancel_policy` (and the new time changes it): re-read the booking.
          this.refresh(id);
          // The old time is free again and the new one taken: no cached calendar.
          this.cal.refresh();
          this.rescheduling.set(false);
          this.closeReschedule();
          this.notice.set({
            ok: true,
            text:
              res.data.status === 'rescheduled'
                ? `Appointment moved to ${whenLabel(res.data.scheduled_at)}. Your doctor will confirm the new time.`
                : `Appointment moved to ${whenLabel(res.data.scheduled_at)}.`,
          });
        },
        error: (err) => {
          this.rescheduling.set(false);
          const fields = apiErrorFields(err);
          const message = apiErrorMessage(err, 'Could not reschedule. Please pick another slot.');
          // The time went meanwhile (or is past the booking window): fresh times, said so.
          if (fields['scheduled_at']) {
            this.selectedIso.set('');
            this.cal.refresh();
            this.rescheduleError.set(`${message.replace(/\.?$/, '.')} We've refreshed the calendar with the times still open.`);
            return;
          }
          // Started (or closed) meanwhile: it can't be moved any more — the page catches up.
          if (fields['status']) this.refresh(id);
          this.rescheduleError.set(message);
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
          this.reviewed.set(true);
          this.closeReview();
        },
        error: (err) => {
          this.reviewError.set(apiErrorMessage(err, 'Could not submit your review.'));
          this.reviewing.set(false);
        },
      });
  }

  /**
   * One line under Cancel on what cancelling now gives back ('' when nothing
   * was paid) — from the server's `cancel_policy`.
   */
  protected readonly cancelHint = computed(() => {
    const a = this.appt();
    const policy = a?.cancel_policy;
    if (!a || !policy) return '';
    const refund = nairaLabel(policy.refund_amount);
    const hours = policy.late_cancel_hours;
    // Late window first: a part refund that rounds to nothing still needs saying why.
    if (policy.refund_percent < 100) {
      if (refund) {
        return `Cancelling now refunds ${refund} — ${policy.refund_percent}% of the consultation fee, plus any guest fees.`;
      }
      return a.payment_status === 'paid'
        ? `Cancelling within ${hours} hours of the start refunds ${policy.refund_percent}% of the consultation fee — nothing goes back to your wallet.`
        : '';
    }
    if (!refund) return '';
    const lateWindow = a.status === 'confirmed' && hours > 0;
    // The policy was read with the page: once the late window has opened since, the amount above no longer holds.
    if (lateWindow && this.clock() >= new Date(a.scheduled_at).getTime() - hours * 3_600_000) {
      return `You're now within ${hours} hours of the start, so less is refunded — the amount is shown before you confirm.`;
    }
    const late = lateWindow ? ` Less is refunded within ${hours} hours of the start.` : '';
    return `Cancelling now refunds ${refund} to your wallet.${late}`;
  });

  /** Re-reading the booking for an up-to-date refund before the cancel prompt opens. */
  protected readonly cancelChecking = signal(false);

  /**
   * Cancel the booking — asked first, with the time, the doctor and what goes
   * back to the wallet (the server's `cancel_policy`). The dialog shows the
   * request's progress; a refusal (e.g. 422 "This consultation has started")
   * is shown in it, and the page re-reads the booking.
   */
  protected async cancel(): Promise<void> {
    const current = this.appt();
    if (!current || !this.vm()?.canCancel || this.cancelChecking()) return;
    this.notice.set(null);
    // The refund depends on how close to the start it is NOW, not when the page
    // loaded (late-cancel window): re-read the booking's `cancel_policy` first.
    this.cancelChecking.set(true);
    try {
      const res = await firstValueFrom(this.appointments.getMine(current.id));
      if (res.data.id !== this.appt()?.id) return;
      this.override.set(res.data);
    } catch {
      // Keep the policy read with the page — the server applies the real one anyway.
    } finally {
      this.cancelChecking.set(false);
    }
    const a = this.appt();
    const v = this.vm();
    if (!a || !v || a.id !== current.id) return;
    if (!v.canCancel) {
      // Started or closed meanwhile — the page now says so next to the actions.
      this.notice.set({ ok: false, text: 'This appointment can no longer be cancelled.' });
      return;
    }
    const doctor = doctorTitle(a.specialist.name);
    const policy = a.cancel_policy ?? null;
    const paid = a.payment_status === 'paid';
    // `cancel_policy` is sent with the booking; an older payload refunds a paid one in full.
    const refund = nairaLabel(policy ? policy.refund_amount : paid ? a.amount : 0);
    const guests = (a.guests ?? []).length;
    let money: string;
    if (policy && policy.refund_percent < 100) {
      // Inside the late window: say why less (or nothing) comes back.
      const share = `cancelling within ${policy.late_cancel_hours} hours of the start refunds ${policy.refund_percent}% of the consultation fee`;
      money = refund
        ? `${refund} goes back to your wallet straight away — ${share} (guest fees in full).`
        : paid
          ? `Nothing goes back to your wallet — ${share}.`
          : "Nothing was paid, so there's nothing to refund.";
    } else if (!refund) {
      money = paid ? 'Nothing is refunded.' : "Nothing was paid, so there's nothing to refund.";
    } else {
      money = `${refund} goes back to your wallet straight away.`;
    }
    const details: ConfirmDetail[] = [
      { label: 'Doctor', value: doctor },
      { label: 'When', value: `${v.date}, ${v.time}` },
      { label: 'Refund to wallet', value: refund || 'None' },
    ];
    if (guests > 0) details.push({ label: 'Guests', value: `${guests} — their links stop working` });

    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'calendar-x',
      title: `Cancel your appointment with ${doctor}?`,
      message: `${money}${guests > 0 ? ' Your guests are told too.' : ''} This can't be undone.`,
      details,
      confirmLabel: 'Cancel appointment',
      cancelLabel: 'Keep it',
      busyLabel: 'Cancelling…',
      size: 'md',
      action: () =>
        this.appointments.cancel(a.id).pipe(
          tap({
            next: (res) => {
              this.override.set(res.data);
              const back =
                nairaLabel(res.data.refunded_amount) ||
                (res.data.payment_status === 'refunded' ? nairaLabel(res.data.amount) : '');
              this.notice.set({
                ok: true,
                text: back
                  ? `Appointment cancelled. ${back} has been refunded to your wallet.`
                  : 'Appointment cancelled.',
              });
            },
            error: (err: unknown) => {
              // Started or closed meanwhile: the page catches up (Cancel goes).
              if (apiErrorFields(err)['status']) this.refresh(a.id);
            },
          }),
        ),
      errorMessage: (err) => apiErrorMessage(err, 'Could not cancel the appointment.'),
    });
    // The Cancel button is gone once the booking is cancelled: land on the page heading, not <body>.
    if (confirmed) afterDialogsClose(this.dialogs, this.injector, () => this.pageTitle()?.nativeElement.focus());
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

  /** The appointment as last read, or as an in-place change (cancel, accept…) left it. */
  private readonly appt = computed<AppointmentDto | null>(() => this.override() ?? this.result().appt);

  protected readonly vm = computed<DetailsVm | null>(() => {
    const appt = this.appt();
    return appt ? toDetails(appt, this.clock()) : null;
  });
}
