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
} from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  AppointmentsApi,
  AvailabilityCalendarStore,
  DocumentsApi,
  injectCallPresence,
  openBlobDocument,
  openClinicalDocument,
  openPendingTab,
  PrescriptionsApi,
  WalletApi,
} from '@supadoc/data-access';
import type {
  AcceptFollowUpParams,
  AppointmentDto,
  ClinicalDocumentKind,
  FollowUpPriceDto,
  FollowUpQuoteDto,
  MedicalDocumentDto,
  MessageDto,
  PrescriptionDto,
  PrescriptionStatus,
} from '@supadoc/models';
import {
  AlertComponent,
  BookingCalendarComponent,
  ButtonComponent,
  CallPresenceComponent,
  IconComponent,
  MessageThreadComponent,
} from '@supadoc/ui';
import { doctorTitle } from '../call/call-helpers';
import { calendarErrorText } from './booking-helpers';
import { dayLabel, isOpenProposal, priceLabel, priceNote, whenLabel } from './follow-up';
import { GuestsPanel } from './guests-panel';
import { loadPaystack } from './paystack';

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

/** What Tab can land on inside a dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isRadio(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'radio';
}

/** One Tab stop: the same control, or radios of one named group (Tab leaves a group in one step). */
function sameTabStop(a: Element, b: Element | null): boolean {
  return a === b || (isRadio(a) && isRadio(b) && a.name !== '' && a.name === b.name);
}

/** Where Tab lands on `el`'s stop: a radio group's checked radio, else `el` itself. */
function tabStopOf(items: readonly HTMLElement[], el: HTMLElement): HTMLElement {
  if (!isRadio(el) || el.name === '') return el;
  return items.find((i) => isRadio(i) && i.name === el.name && i.checked) ?? el;
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
  /** A cancelled appointment (a declined follow-up among them) has no call to join. */
  readonly canJoin: boolean;
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

const STATUS_CLASS: Record<string, string> = {
  proposed: 'bg-teal/10 text-teal',
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
    // A free consultation reads "Free", never "₦0.00".
    amount: Number(a.amount) > 0 ? `₦${NAIRA.format(Number(a.amount))}` : 'Free',
    guests: (a.guests ?? []).map((g) => g.name),
    canCancel: ['pending', 'confirmed', 'rescheduled'].includes(a.status),
    canReview: a.status === 'completed',
    canJoin: a.status !== 'cancelled',
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
    GuestsPanel,
    IconComponent,
    MessageThreadComponent,
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
            routerLink="/dashboard/appointments"
            class="mb-1 flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean"
          >
            <sd-icon name="chevron-right" [size]="16" class="rotate-180" />
            My Appointments
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

            <!-- A follow-up the doctor proposed: accept (paying unless free), another time, or decline -->
            @if (proposal(); as fp) {
              <section
                #respondPanel
                tabindex="-1"
                class="flex flex-col gap-5 rounded-card border border-teal/30 bg-white p-5 outline-none sm:p-6"
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
                        class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-cloud px-4 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60"
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
                              class="min-h-11 w-fit rounded-field border border-cloud bg-white px-5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
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
                          class="min-h-11 shrink-0 rounded-field border border-cloud bg-white px-4 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean"
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

            <!-- Instructions + actions -->
            @if (!v.isProposal) {
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
                    Your doctor can review the documents shared below and
                    everything in your
                    <a routerLink="/dashboard/documents" class="font-semibold text-cerulean hover:underline">medical documents</a>,
                    where you can add more at any time.
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 flex-col gap-3 lg:w-[240px]">
                <!-- A soft green halo + clearer label once the doctor is waiting -->
                @if (v.canJoin) {
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
                }
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
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
              >
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="file-text" [size]="20" />
                  Shared Documents
                </h2>
                <!-- The files attached when booking (opened through the authenticated document route) -->
                @if (sharedLoading()) {
                  <div class="sd-shimmer h-14 rounded-field"></div>
                } @else if (sharedError()) {
                  <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                    <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ sharedError() }}
                  </p>
                  <button
                    type="button"
                    class="min-h-11 w-fit rounded-field border border-cloud bg-white px-5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
                    (click)="loadSharedDocs(v.id)"
                  >
                    Try again
                  </button>
                } @else {
                  <ul class="flex flex-col gap-2">
                    @for (d of sharedDocs(); track d.id) {
                      <li>
                        <button
                          type="button"
                          class="flex min-h-11 w-full items-center gap-3 rounded-field border border-cloud px-3 py-2 text-left transition-colors hover:border-cerulean/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                          [attr.aria-label]="'Open ' + d.title + ', ' + d.type_label"
                          (click)="openShared(d)"
                        >
                          <sd-icon name="file-text" [size]="20" class="shrink-0 text-slate" />
                          <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                            <span class="truncate font-sans text-caption text-slate"
                              ><span class="uppercase">{{ d.extension }}</span> · {{ d.size_label }} · {{ d.type_label }}</span
                            >
                          </span>
                          <sd-icon name="eye" [size]="18" class="shrink-0 text-cerulean" />
                        </button>
                      </li>
                    } @empty {
                      <li class="font-sans text-body-sm text-slate">
                        No documents were shared for this consultation.
                      </li>
                    }
                  </ul>
                }
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
        <button type="button" tabindex="-1" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="closeReview()"></button>
        <div
          #reviewDialog
          class="relative z-10 flex w-full max-w-md flex-col gap-5 rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)] outline-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-title"
          tabindex="-1"
          (keydown.escape)="closeReview()"
          (keydown)="trapTab($event, reviewDialog)"
        >
          <div class="flex items-center justify-between">
            <h3 #reviewTitle id="review-title" tabindex="-1" class="font-heading text-h5 text-ink outline-none">Rate your consultation</h3>
            <button type="button" class="inline-flex size-11 items-center justify-center text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeReview()"><sd-icon name="x" [size]="24" /></button>
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
        <button type="button" tabindex="-1" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="closeReschedule()"></button>
        <div
          #rescheduleDialog
          class="relative z-10 flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-[16px] border border-cloud bg-white p-4 shadow-[0_4px_24px_rgba(10,22,40,0.12)] outline-none sm:p-6 md:max-w-3xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reschedule-title"
          aria-describedby="reschedule-desc"
          tabindex="-1"
          (keydown.escape)="closeReschedule()"
          (keydown)="trapTab($event, rescheduleDialog)"
        >
          <div class="flex items-center justify-between">
            <h3 #rescheduleTitle id="reschedule-title" tabindex="-1" class="font-heading text-h5 text-ink outline-none">Reschedule appointment</h3>
            <button type="button" class="inline-flex size-11 items-center justify-center text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeReschedule()"><sd-icon name="x" [size]="24" /></button>
          </div>
          @if (vm(); as v) {
            <p id="reschedule-desc" class="font-sans text-body-sm text-slate">
              Now {{ v.date }} at {{ v.time }}. Choose a new time with {{ v.name }}.
            </p>
          }

          @if (calendarError()) {
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <sd-alert tone="error" class="min-w-0 flex-1">{{ calendarError() }}</sd-alert>
              <button
                type="button"
                class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-field border border-cloud bg-white px-4 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
                (click)="cal.refresh()"
              >
                Try again
              </button>
            </div>
          }
          @if (noOpenings()) {
            <p class="font-sans text-body-sm text-slate">
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
            <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
              <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ rescheduleError() }}
            </p>
          }
          <div class="flex flex-col gap-2 border-t border-cloud pt-4 sm:flex-row sm:items-center sm:justify-end">
            <p class="font-sans text-body-sm text-slate sm:mr-auto" aria-live="polite">
              @if (selectedIso()) {
                New time: <span class="font-semibold text-ink">{{ newTimeLabel() }}</span>
              }
            </p>
            <sd-button [disabled]="rescheduling() || !selectedIso()" (click)="submitReschedule()">
              {{ rescheduling() ? 'Rescheduling…' : 'Confirm new time' }}
            </sd-button>
          </div>
        </div>
      </div>
    }

    @if (declineOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" tabindex="-1" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="closeDecline()"></button>
        <div
          #declineDialog
          class="relative z-10 flex w-full max-w-md flex-col gap-4 rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)] outline-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="decline-title"
          aria-describedby="decline-desc"
          tabindex="-1"
          (keydown.escape)="closeDecline()"
          (keydown)="trapTab($event, declineDialog)"
        >
          <div class="flex items-center justify-between">
            <h3 #declineTitle id="decline-title" tabindex="-1" class="font-heading text-h5 text-ink outline-none">Decline this follow-up?</h3>
            <button type="button" class="inline-flex size-11 items-center justify-center text-slate transition-colors hover:text-ink" aria-label="Close" (click)="closeDecline()"><sd-icon name="x" [size]="24" /></button>
          </div>
          <p id="decline-desc" class="font-sans text-body-sm text-slate">
            Nothing has been charged. The time is released and your doctor is told
            you declined. You can still book a follow-up later.
          </p>
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Reason for your doctor (optional)</span>
            <textarea
              rows="3"
              maxlength="500"
              class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
              placeholder="For example: I'm feeling better, or the time doesn't suit me"
              [disabled]="declining()"
              [value]="declineReason()"
              (input)="declineReason.set($any($event.target).value)"
            ></textarea>
            <span class="text-right font-sans text-caption text-slate">{{ declineReason().length }}/500</span>
          </label>
          @if (declineError()) {
            <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
              <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ declineError() }}
            </p>
          }
          <div class="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              class="inline-flex min-h-11 flex-1 items-center justify-center rounded-field border border-cloud px-4 py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
              [disabled]="declining()"
              (click)="closeDecline()"
            >
              Keep it
            </button>
            <button
              type="button"
              class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-field bg-alert px-4 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-alert/90 disabled:opacity-60"
              [disabled]="declining()"
              (click)="submitDecline()"
            >
              {{ declining() ? 'Declining…' : 'Decline follow-up' }}
            </button>
          </div>
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
  private readonly documentsApi = inject(DocumentsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly pageTitle = viewChild<ElementRef<HTMLElement>>('pageTitle');
  private readonly reviewTitle = viewChild<ElementRef<HTMLElement>>('reviewTitle');
  private readonly rescheduleTitle = viewChild<ElementRef<HTMLElement>>('rescheduleTitle');
  /** What had focus before a dialog opened — it gets focus back on close. */
  private opener: HTMLElement | null = null;

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

  // Files the patient attached when booking (their own medical documents).
  protected readonly sharedDocs = signal<MedicalDocumentDto[]>([]);
  protected readonly sharedLoading = signal(false);
  protected readonly sharedError = signal('');

  // ----- Follow-up proposal (status `proposed`) -----
  private readonly walletApi = inject(WalletApi);
  private readonly declineTitle = viewChild<ElementRef<HTMLElement>>('declineTitle');
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

  // Declining (optional reason for the doctor).
  protected readonly declineOpen = signal(false);
  protected readonly declineReason = signal('');
  protected readonly declining = signal(false);
  protected readonly declineError = signal('');

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
        this.loadSharedDocs(id);
      });

    const tick = setInterval(() => this.clock.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
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
          this.openDecline();
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

  protected openDecline(): void {
    this.rememberOpener();
    this.declineError.set('');
    this.declineOpen.set(true);
    this.focusAfterRender(() => this.declineTitle()?.nativeElement);
  }

  protected closeDecline(): void {
    if (this.declining()) return; // let the request finish first
    this.declineOpen.set(false);
    this.returnFocus();
  }

  protected submitDecline(): void {
    const id = this.appt()?.id;
    if (!id || this.declining()) return;
    this.declining.set(true);
    this.declineError.set('');
    this.appointments
      .declineFollowUp(id, this.declineReason().trim() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.declining.set(false);
          this.declineReason.set('');
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
          this.closeDecline(); // focus falls back to the page heading (the panel is gone)
        },
        error: (err: unknown) => {
          this.declining.set(false);
          this.declineError.set(apiErrorMessage(err, 'Could not decline the follow-up. Please try again.'));
          if (apiErrorFields(err)['status']) this.refresh(id);
        },
      });
  }

  /** The booking's attachments, in the order they were added. */
  protected loadSharedDocs(id: string): void {
    this.sharedLoading.set(true);
    this.sharedError.set('');
    this.documentsApi
      .list({ appointment_id: id, per_page: 50, sort_dir: 'asc' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.sharedDocs.set(res.data ?? []);
          this.sharedLoading.set(false);
        },
        error: (err: unknown) => {
          this.sharedError.set(apiErrorMessage(err, 'Could not load the shared documents.'));
          this.sharedLoading.set(false);
        },
      });
  }

  /** Same authenticated view as the Documents page: fetched as a blob, opened in a new tab. */
  protected openShared(d: MedicalDocumentDto): void {
    openBlobDocument(this.documentsApi.fileBlob(d.id));
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

  // Dialogs: focus moves to the heading on open, Tab stays inside, Esc closes,
  // and focus goes back to the button that opened it.

  private rememberOpener(): void {
    const active = this.document.activeElement;
    this.opener = active instanceof HTMLElement && active !== this.document.body ? active : null;
  }

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  /** Back to the opener — or the page heading when it is gone (e.g. after reviewing). */
  private returnFocus(): void {
    const back = this.opener;
    this.opener = null;
    this.focusAfterRender(() => (back?.isConnected ? back : this.pageTitle()?.nativeElement));
  }

  /** Tab and Shift+Tab wrap around inside the dialog instead of leaving it. */
  protected trapTab(e: KeyboardEvent, root: HTMLElement): void {
    if (e.key !== 'Tab') return;
    // (:disabled also catches controls inside a disabled fieldset.)
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null && !el.matches(':disabled'),
    );
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.document.activeElement as HTMLElement | null;
    // Not in the list: the heading or the dialog itself has focus (both sit before every control).
    const outside = !active || !items.includes(active);
    if (e.shiftKey && (outside || sameTabStop(first, active))) {
      e.preventDefault();
      tabStopOf(items, last).focus();
    } else if (!e.shiftKey && sameTabStop(last, active)) {
      e.preventDefault();
      tabStopOf(items, first).focus();
    }
  }

  protected openReview(): void {
    this.rememberOpener();
    this.reviewError.set('');
    this.reviewOpen.set(true);
    this.focusAfterRender(() => this.reviewTitle()?.nativeElement);
  }

  protected closeReview(): void {
    if (this.reviewing()) return; // let the request finish first
    this.reviewOpen.set(false);
    this.returnFocus();
  }

  protected closeReschedule(): void {
    if (this.rescheduling()) return; // let the request finish first
    this.rescheduleOpen.set(false);
    this.returnFocus();
  }

  // Reschedule
  protected readonly rescheduleOpen = signal(false);
  /** The new time's ISO start ('' = none picked yet). */
  protected readonly selectedIso = signal('');
  protected readonly newTimeLabel = computed(() => whenLabel(this.selectedIso()));
  protected readonly rescheduling = signal(false);
  protected readonly rescheduleError = signal('');

  protected openReschedule(v: DetailsVm): void {
    this.rememberOpener();
    this.rescheduleOpen.set(true);
    this.focusAfterRender(() => this.rescheduleTitle()?.nativeElement);
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
          // The old time is free again and the new one taken: no cached calendar.
          this.cal.refresh();
          this.rescheduling.set(false);
          this.closeReschedule();
          this.notice.set({ ok: true, text: 'Appointment rescheduled to your new time.' });
        },
        error: (err) => {
          this.rescheduling.set(false);
          const message = apiErrorMessage(err, 'Could not reschedule. Please pick another slot.');
          // The time went meanwhile (or is past the booking window): fresh times, said so.
          if (apiErrorFields(err)['scheduled_at']) {
            this.selectedIso.set('');
            this.cal.refresh();
            this.rescheduleError.set(`${message.replace(/\.?$/, '.')} We've refreshed the calendar with the times still open.`);
            return;
          }
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
    return appt ? toDetails(appt) : null;
  });
}
