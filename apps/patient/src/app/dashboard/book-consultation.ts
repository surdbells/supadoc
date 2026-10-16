import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { HttpEventType } from '@angular/common/http';
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
  OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { firstValueFrom, merge, Subscription } from 'rxjs';
import type { HasUnsavedChanges } from '@supadoc/auth';
import {
  ApiService,
  apiErrorFields,
  apiErrorMessage,
  AppointmentsApi,
  AvailabilityCalendarStore,
  slotLabel,
  SpecialistsApi,
  WalletApi,
  ymdInZone,
  type SpecialistSuggestionParams,
} from '@supadoc/data-access';
import type {
  AppointmentDocumentDto,
  AppointmentDto,
  AvailabilityRangeDto,
  FollowUpQuoteDto,
  GuestInvite,
  PricingDto,
  SpecialistDto,
  SuccessResponse,
} from '@supadoc/models';
import {
  AlertComponent,
  BookingCalendarComponent,
  ButtonComponent,
  FileDropComponent,
  IconComponent,
  isOpenStatus,
  longDayLabel,
  shortDayLabel,
  StepperComponent,
  type LeaveCopy,
  warnBeforeUnload,
  type FileDropRejection,
} from '@supadoc/ui';
import { calendarErrorText, httpStatus, notBookableText } from './booking-helpers';
import { dayLabel, priceNote, whenLabel } from './follow-up';
import { loadPaystack } from './paystack';
import { SimilarDoctors } from './similar-doctors';

type AttachStatus = 'queued' | 'uploading' | 'done' | 'failed';

/** One supporting document: uploaded as soon as it's added, one at a time. */
interface Attachment {
  /** Local key for `@for` tracking (files have no id until uploaded). */
  readonly key: number;
  readonly file: File;
  readonly status: AttachStatus;
  readonly progress: number;
  /** The API's message when the upload failed. */
  readonly error: string;
  /** The filed document once uploaded — its id goes in the booking. */
  readonly doc: AppointmentDocumentDto | null;
}

/** A file that never made it into the list, and why. */
interface SkippedFile {
  readonly name: string;
  readonly reason: string;
}

/** Every upload status reads as an icon AND a word — never colour alone. */
const ATTACH_STATUS: Record<AttachStatus, { label: string; icon: string; cls: string }> = {
  queued: { label: 'Waiting', icon: 'clock', cls: 'bg-cloud text-slate' },
  uploading: { label: 'Uploading', icon: 'loader-circle', cls: 'bg-frost text-cerulean-dark' },
  done: { label: 'Attached', icon: 'circle-check', cls: 'bg-sage/15 text-sage-ink' },
  failed: { label: 'Failed', icon: 'circle-x', cls: 'bg-alert/10 text-alert-ink' },
};

/** Accepted client-side (mirrors MedicalDocumentStorage, which files these). */
const DOC_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.webp,.dcm,.docx,.doc,.mp4,.webm,.mov,application/pdf,image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime';
const DOC_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'dcm', 'docx', 'doc', 'mp4', 'webm', 'mov'];
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOC_TOO_BIG = 'File must be 10MB or smaller.';
const DOC_UNSUPPORTED = 'Unsupported file type. Use PDF, JPG, PNG, WEBP, DOCX, DICOM or video.';
/** The API attaches at most this many documents to one booking. */
const MAX_DOCS = 10;

/**
 * A card payment this tab made that no booking has used yet — kept in
 * sessionStorage (this tab only) from just before the Paystack pop-up opens
 * until the booking succeeds, so a reload or a dropped connection after paying
 * can still complete the booking on it.
 */
interface PendingCardPayment {
  readonly reference: string;
  readonly specialistId: string;
  /** The chosen time's ISO start. */
  readonly slot: string;
  readonly amount: number;
  /** The completed consultation this was a follow-up of ('' for a regular booking). */
  readonly parentId: string;
  /** When it was saved (epoch ms). */
  readonly savedAt: number;
}

const PENDING_CARD_KEY = 'videomed.booking.pendingCardPayment';
/** An unused card payment reaches the wallet automatically after about this long (the API's CARD_INTENT_CREDIT_AFTER_MINUTES). */
const AUTO_CREDIT_MINUTES = 30;

/**
 * GET /api/portal/card-payments/{reference} — where one of the patient's own
 * card payments stands, as the server knows it (it asks Paystack first when
 * it doesn't know yet). Only `paid` means money was taken and is still unused.
 */
interface CardPaymentStatus {
  readonly reference: string;
  readonly status: 'paid' | 'not_paid' | 'unconfirmed' | 'used' | 'credited_to_wallet' | 'review';
  readonly amount: string;
  readonly currency: string;
  readonly specialist_id: string | null;
  readonly used_for: string | null;
  readonly credited_amount: string | null;
  /** When an unused paid payment is credited to the wallet (ISO), if it is `paid`. */
  readonly credit_due_at: string | null;
  readonly credit_after_minutes: number;
}

/** A saved card payment the server confirmed as paid and unused — it can complete the booking. */
type ResumablePayment = PendingCardPayment & { readonly creditDueAt: string | null };

function readPendingCard(storage: Storage | null): PendingCardPayment | null {
  try {
    const raw = JSON.parse(storage?.getItem(PENDING_CARD_KEY) ?? 'null') as Partial<PendingCardPayment> | null;
    if (!raw || typeof raw.reference !== 'string' || typeof raw.specialistId !== 'string' || typeof raw.slot !== 'string') return null;
    const amount = Number(raw.amount);
    const savedAt = Number(raw.savedAt);
    if (!raw.reference || !Number.isFinite(amount) || !Number.isFinite(savedAt)) return null;
    return {
      reference: raw.reference,
      specialistId: raw.specialistId,
      slot: raw.slot,
      amount,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : '',
      savedAt,
    };
  } catch {
    return null;
  }
}

function writePendingCard(storage: Storage | null, value: PendingCardPayment | null): void {
  try {
    if (value) storage?.setItem(PENDING_CARD_KEY, JSON.stringify(value));
    else storage?.removeItem(PENDING_CARD_KEY);
  } catch {
    // Storage unavailable (private mode, quota): the in-page copy still works.
  }
}

/** Whole days between two 'YYYY-MM-DD' dates, either way round. */
function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Book a Consultation (Figma) — a 7-step wizard: date/time (a month calendar
 * of the doctor's real availability, in the patient's own time zone),
 * consultation type, reason, invite guests (up to 3, each adds the guest fee),
 * supporting documents (up to 10, each uploaded as soon as it's added), a
 * booking summary, and a payment step — card or wallet, or nothing for a free
 * consultation — that creates the appointment, priced by the
 * back-office-configured Naira pricing.
 *
 * `?slot=ISO` (a time picked on a card or a suggestion) opens on its day and
 * selects it while it is still open; `?date=YYYY-MM-DD` opens on that day, or
 * the nearest open day with a note saying exactly why. Otherwise the doctor's
 * next open day is shown and no time is chosen for the patient. A day with no
 * openings says when the doctor is next free and suggests similar doctors free
 * that day (never for a follow-up). A time taken meanwhile (422) refreshes the
 * calendar and says so; a doctor who stops taking bookings is said so plainly.
 *
 * `?follow_up=<consultation id>[&date=YYYY-MM-DD]` books a follow-up of one of
 * the patient's completed consultations with this doctor: the suggested day is
 * preselected, each slot is priced by the follow-up quote and the booking is
 * linked to that consultation (a link that doesn't hold falls back to a
 * regular booking, with a note).
 */
@Component({
  selector: 'pat-book-consultation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AlertComponent,
    BookingCalendarComponent,
    ButtonComponent,
    FileDropComponent,
    IconComponent,
    SimilarDoctors,
    StepperComponent,
  ],
  providers: [AvailabilityCalendarStore],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-8 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 #pageTitle tabindex="-1" class="font-heading text-h3 text-ink outline-none">Book a Consultation</h1>
          <p class="font-sans text-body text-slate">
            Schedule an appointment with your preferred specialist
          </p>
        </div>
        <a
          routerLink="/dashboard/specialists"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <!-- Stepper -->
      <sd-stepper [count]="steps.length" [current]="step()" />

      <!-- Booking a follow-up of an earlier consultation (?follow_up=) -->
      @if (parent()) {
        <div
          class="flex flex-col gap-2 rounded-card border border-teal/30 bg-teal/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p class="flex min-w-0 items-start gap-3 font-sans text-body-sm text-ink">
            <sd-icon name="refresh-cw" [size]="18" class="mt-0.5 shrink-0 text-teal" />
            <span class="min-w-0">
              <span class="font-semibold">Follow-up to your {{ parentDate() }} consultation</span>
              <!-- The price follows the chosen time, announced as it changes -->
              <span
                class="block font-sans text-caption"
                [class]="quoteError() ? 'text-alert' : 'text-slate'"
                aria-live="polite"
                >{{ followUpPriceLine() }}</span
              >
            </span>
          </p>
          @if (quoteError()) {
            <button
              type="button"
              class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-field border border-haze bg-white px-4 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
              (click)="retryQuote()"
            >
              Try again
            </button>
          }
        </div>
      }
      @if (parentNotice()) {
        <sd-alert tone="info">{{ parentNotice() }}</sd-alert>
      }

      <!-- The doctor stopped taking bookings while this was open -->
      @if (doctorGone() && specialist(); as s) {
        <div
          class="flex flex-col gap-3 rounded-card border border-alert/30 bg-alert/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p class="flex min-w-0 items-start gap-2 font-sans text-body-sm text-ink">
            <sd-icon name="calendar-off" [size]="18" class="mt-0.5 shrink-0 text-alert" />
            <span>{{ goneText() }} This booking can't be completed — nothing has been booked.</span>
          </p>
          <a
            routerLink="/dashboard/specialists"
            [queryParams]="{ specialty: s.specialty }"
            class="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
          >
            Find another {{ s.specialty }} specialist <sd-icon name="arrow-right" [size]="16" />
          </a>
        </div>
      }
      @if (unusedPayment() && step() < 7) {
        <sd-alert tone="warning">{{ unusedPayment() }}</sd-alert>
      }

      <!-- A card payment from before a reload / dropped connection that no booking used yet -->
      @if (resumable(); as p) {
        <div
          class="flex flex-col gap-3 rounded-card border border-cerulean/30 bg-frost/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <p class="flex min-w-0 items-start gap-2 font-sans text-body-sm text-ink">
            <sd-icon name="credit-card" [size]="18" class="mt-0.5 shrink-0 text-cerulean" />
            <span>
              <span class="font-semibold">You've already paid {{ fmt(p.amount) }} by card</span>
              for {{ openingLabel(p.slot) }}, but the booking wasn't completed. Complete it now
              without paying again — or, if you don't, the payment is added to your VideoMed
              wallet automatically {{ creditDueLabel(p.creditDueAt) }}.
            </span>
          </p>
          <div class="flex shrink-0 flex-wrap gap-2">
            <sd-button variant="outline" size="sm" (click)="dismissResume()">Not now</sd-button>
            <sd-button size="sm" [disabled]="doctorGone()" (click)="resumePaidBooking()">Complete your paid booking</sd-button>
          </div>
        </div>
      }
      @if (walletNotice()) {
        <sd-alert tone="info">{{ walletNotice() }}</sd-alert>
      }

      @if (loadError()) {
        <div class="flex flex-col items-center gap-4 py-16 text-center">
          <sd-icon [name]="loadErrorGone() ? 'calendar-off' : 'wifi-off'" [size]="36" class="text-alert" />
          <p class="max-w-md font-sans text-body-sm text-slate">
            {{ loadError() }}
          </p>
          <a routerLink="/dashboard/specialists"
            ><sd-button size="sm">{{ loadErrorGone() ? 'Find another specialist' : 'Back to specialists' }}</sd-button></a
          >
        </div>
      } @else if (specialist(); as s) {
        <!-- Step 1: date & time -->
        @if (step() === 1) {
          <div
            class="rounded-card border border-haze bg-white p-6 shadow-card"
          >
            <div class="flex flex-wrap items-start gap-4">
              <span
                class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h4 text-cerulean-dark"
                >{{ initials() }}</span
              >
              <div class="flex min-w-0 flex-col gap-1">
                <span
                  class="flex items-center gap-1.5 font-heading text-h5 text-ink"
                >
                  {{ s.name }}
                  @if (s.verified) {
                    <sd-icon
                      name="circle-check"
                      [size]="18"
                      class="text-cerulean"
                    />
                  }
                </span>
                <span class="font-sans text-body-sm text-cerulean">{{
                  s.specialty
                }}</span>
                <span
                  class="flex items-center gap-1 font-sans text-caption text-slate"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#f2a900">
                    <path
                      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                    />
                  </svg>
                  {{ rating() }} ({{ s.reviews_count }} reviews)
                </span>
              </div>
            </div>
            <div
              class="mt-5 grid grid-cols-2 gap-4 border-t border-cloud pt-5 font-sans text-caption md:grid-cols-4"
            >
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="languages" [size]="14" />Languages</span
                >
                <span class="text-ink">{{ s.languages ?? '—' }}</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="map-pin" [size]="14" />Location</span
                >
                <span class="text-ink">{{ s.location ?? '—' }}</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="briefcase" [size]="14" />Experience</span
                >
                <span class="text-ink"
                  >{{ s.years_experience ?? '—' }} years</span
                >
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="banknote" [size]="14" />Fee</span
                >
                <span class="text-ink">{{ feeLabel(s.consultation_fee) }}</span>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-4 rounded-card border border-haze bg-white px-3 py-4 shadow-card sm:p-6">
            <h2 class="font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >1</span
              >Choose Date &amp; Time
            </h2>
            @if (dateNotice()) {
              <p class="flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate" role="status">
                <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />{{ dateNotice() }}
              </p>
            }
            @if (slotNotice()) {
              <sd-alert tone="warning">{{ slotNotice() }}</sd-alert>
            }
            @if (calendarError()) {
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <sd-alert tone="error" class="min-w-0 flex-1">{{ calendarError() }}</sd-alert>
                @if (!doctorGone()) {
                  <button
                    type="button"
                    class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
                    (click)="cal.refresh()"
                  >
                    Try again
                  </button>
                }
              </div>
            }

            @if (noOpenings()) {
              <!-- Nothing open anywhere in the booking window -->
              <div class="flex flex-col gap-4">
                <p class="flex items-start gap-2 rounded-card border border-cloud bg-glacier/60 px-4 py-3 font-sans text-body-sm text-slate">
                  <sd-icon name="calendar-off" [size]="18" class="mt-0.5 shrink-0" />
                  <span>
                    {{ s.name }} has no open times in the next {{ cal.range()?.horizon_days }} days.
                    {{ followUp() ? 'Message your doctor about a time, or check back later.' : 'Please check back later, or book a similar doctor.' }}
                  </span>
                </p>
                @if (!followUp()) {
                  <pat-similar-doctors [params]="similarParams()" heading="Similar doctors with open times" />
                }
              </div>
            } @else if (!doctorGone()) {
              <!-- Days and times are the patient's own calendar and clock (cal.tz) -->
              <sd-booking-calendar
                [days]="cal.days()"
                [month]="cal.month()"
                (monthChange)="cal.setMonth($event)"
                [selectedDate]="cal.selectedDate()"
                (selectedDateChange)="pickDay($event)"
                [slots]="cal.slots()"
                [value]="selectedTime() || null"
                (valueChange)="pickTime($event)"
                [loading]="cal.loading()"
                [slotsLoading]="cal.slotsLoading()"
                [min]="cal.min()"
                [max]="cal.max()"
                [nextAvailable]="cal.nextAvailable()"
                [nextOnEmptyDay]="false"
                [timeZone]="cal.tz()"
                [timeZoneLabel]="cal.timeZoneLabel()"
                [weekStartsOn]="cal.weekStartsOn()"
              >
                <!-- The chosen day has no open times: this doctor's next opening (instead of the
                     calendar's own "Next available") + similar doctors.
                     (Projected content is created even while the calendar doesn't show it: the
                     @if keeps the suggestions from loading for days that have times.) -->
                <div calendarEmpty class="flex flex-col gap-4">
                  @if (dayEmpty()) {
                    <div class="flex flex-col gap-3 rounded-card bg-glacier/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <p class="font-sans text-body-sm text-ink">
                        {{ s.name }} isn't available on {{ selectedDayLabel() }}.
                        @if (nextOpening(); as n) {
                          <span class="block text-slate">Next opening: <span class="font-semibold text-ink">{{ openingLabel(n) }}</span></span>
                        }
                      </p>
                      @if (nextOpening(); as n) {
                        <button
                          type="button"
                          class="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-field bg-cerulean px-4 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
                          [attr.aria-label]="'Select ' + openingLabel(n)"
                          (click)="selectOpening(n)"
                        >
                          <sd-icon name="calendar-check" [size]="16" />Select
                        </button>
                      }
                    </div>
                    <!-- A follow-up stays with the same doctor by design -->
                    @if (!followUp()) {
                      <pat-similar-doctors
                        [params]="similarParams()"
                        (loaded)="requestedNext.set($event.requested?.next_available_at ?? null)"
                      />
                    }
                  }
                </div>
              </sd-booking-calendar>
            }
          </div>

          <div class="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <p class="font-sans text-body-sm text-slate" aria-live="polite">
              @if (selectedTime()) {
                Selected: <span class="font-semibold text-ink">{{ selectedLabel() }}</span>
              }
            </p>
            <sd-button [disabled]="!selectedTime() || doctorGone()" (click)="next()">
              Continue <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
          </div>
        }

        <!-- Step 2: consultation type -->
        @if (step() === 2) {
          <div class="rounded-card border border-haze bg-white p-6 shadow-card">
            <h2 class="mb-4 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >2</span
              >Select Consultation Type
            </h2>
            <button
              type="button"
              class="flex w-full items-start gap-4 rounded-card border-2 border-cerulean bg-frost/30 p-5 text-left"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-field bg-frost text-cerulean-dark"
                ><sd-icon name="video" [size]="22" /></span
              >
              <span class="flex flex-1 flex-col gap-1">
                <span class="flex items-center gap-2">
                  <span class="font-sans text-body font-semibold text-ink"
                    >Online</span
                  >
                  <span
                    class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage-ink"
                    >Recommended</span
                  >
                </span>
                <span class="font-sans text-body-sm text-slate"
                  >Meet with the doctor online via secure video call</span
                >
              </span>
              <sd-icon name="circle-check" [size]="22" class="text-cerulean" />
            </button>
            <div
              class="mt-4 flex w-full items-start gap-4 rounded-card border border-cloud bg-cloud/20 p-5"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-field bg-cloud text-slate"
                ><sd-icon name="building-2" [size]="22" /></span
              >
              <span class="flex flex-1 flex-col gap-1">
                <span class="flex items-center gap-2">
                  <span class="font-sans text-body font-semibold text-slate"
                    >In-person</span
                  >
                  <span
                    class="rounded-pill bg-frost px-2.5 py-0.5 font-sans text-[10px] font-medium text-cerulean-dark"
                    >Coming soon</span
                  >
                </span>
                <span class="font-sans text-body-sm text-slate"
                  >Visit the doctor at their clinic or hospital</span
                >
              </span>
            </div>
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 3: reason -->
        @if (step() === 3) {
          <div class="rounded-card border border-haze bg-white p-6 shadow-card">
            <h2 class="mb-4 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >3</span
              >Reasons for Consultation
            </h2>
            <textarea
              rows="6"
              maxlength="500"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
              placeholder="Briefly describe your symptoms or reason for the visit…"
              class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
            ></textarea>
            <div class="mt-1 text-right font-sans text-caption text-slate">
              {{ reason().length }}/500
            </div>
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 4: invite guests -->
        @if (step() === 4) {
          <div class="rounded-card border border-haze bg-white p-6 shadow-card">
            <div class="mb-1 flex items-center justify-between">
              <h2 class="font-heading text-h5 text-cerulean">
                <span
                  class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                  >4</span
                >Invite Others
                <span class="font-sans text-body-sm font-normal text-slate"
                  >(Optional)</span
                >
              </h2>
              <button
                type="button"
                class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                (click)="next()"
              >
                Skip
              </button>
            </div>
            <p class="mb-5 font-sans text-body-sm text-slate">
              Invite up to 3 people to join this video consultation. Each guest
              adds <span class="font-semibold text-ink">{{ fmt(guestFee()) }}</span>
              to the total, and everyone gets an email with their own join link.
            </p>

            @for (g of guests(); track $index) {
              <div class="mb-3 flex flex-col gap-2 rounded-card border border-cloud bg-glacier/40 p-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    placeholder="Full name"
                    maxlength="100"
                    [attr.aria-label]="'Guest ' + ($index + 1) + ' full name'"
                    [attr.aria-invalid]="!!guestError($index).name"
                    [value]="g.name"
                    (input)="setGuest($index, 'name', $any($event.target).value)"
                    class="w-full flex-1 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                    [class.border-alert]="!!guestError($index).name"
                  />
                  <input
                    type="email"
                    placeholder="Email address"
                    maxlength="190"
                    [attr.aria-label]="'Guest ' + ($index + 1) + ' email address'"
                    [attr.aria-invalid]="!!guestError($index).email || (g.email.length > 0 && !emailValid(g.email))"
                    [value]="g.email"
                    (input)="setGuest($index, 'email', $any($event.target).value)"
                    class="w-full flex-1 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                    [class.border-alert]="!!guestError($index).email || (g.email.length > 0 && !emailValid(g.email))"
                  />
                  <button
                    type="button"
                    [attr.aria-label]="'Remove guest ' + ($index + 1)"
                    class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-field border border-cloud px-3 py-2 text-slate transition-colors hover:border-alert/50 hover:text-alert"
                    (click)="removeGuest($index)"
                  >
                    <sd-icon name="trash-2" [size]="18" />
                  </button>
                </div>
                @if (guestError($index).name || guestError($index).email) {
                  <p class="flex items-start gap-1.5 font-sans text-caption text-alert" role="alert">
                    <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />
                    {{ guestError($index).name || guestError($index).email }}
                  </p>
                }
              </div>
            }

            @if (guests().length < 3) {
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-cerulean/40 bg-frost/20 px-4 py-3 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/40"
                (click)="addGuest()"
              >
                <sd-icon name="plus" [size]="18" />Add
                {{ guests().length === 0 ? 'a guest' : 'another guest' }}
              </button>
            }

            @if (validGuests().length > 0) {
              <div
                class="mt-4 flex items-center justify-between rounded-card bg-frost/40 px-4 py-3 font-sans text-body-sm"
              >
                <span class="flex items-center gap-2 text-slate"
                  ><sd-icon name="users" [size]="16" />{{ validGuests().length }}
                  guest{{ validGuests().length > 1 ? 's' : '' }} ×
                  {{ fmt(guestFee()) }}</span
                >
                <span class="font-semibold text-cerulean">{{
                  fmt(guestsTotal())
                }}</span>
              </div>
            }
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 5: documents -->
        @if (step() === 5) {
          <div class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card">
            <div class="flex items-center justify-between gap-3">
              <h2
                #docsTitle
                tabindex="-1"
                class="font-heading text-h5 text-cerulean outline-none"
              >
                <span
                  class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                  >5</span
                >Upload Supporting Documents
                <span class="font-sans text-body-sm font-normal text-slate"
                  >(Optional)</span
                >
              </h2>
              @if (attachments().length === 0) {
                <button
                  type="button"
                  class="min-h-11 shrink-0 px-2 font-sans text-body-sm font-semibold text-cerulean hover:underline"
                  (click)="next()"
                >
                  Skip
                </button>
              }
            </div>
            <p class="font-sans text-body-sm text-slate">
              Add lab results, scans or photos for your doctor. Each file is
              also saved to your medical documents.
            </p>

            <!-- Upload progress and outcomes, announced to screen readers -->
            <p class="sr-only" aria-live="polite" aria-atomic="true">{{ docsLiveStatus() }}</p>

            @if (attachments().length > 0) {
              <ul class="flex flex-col gap-3" aria-label="Attached documents">
                @for (a of attachments(); track a.key) {
                  <li class="flex flex-col gap-2 rounded-card border border-cloud p-3 sm:p-4">
                    <div class="flex items-center gap-3">
                      <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-glacier text-slate"
                        ><sd-icon name="file-text" [size]="18"
                      /></span>
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate font-sans text-body-sm font-semibold text-ink" [title]="a.file.name">{{ a.file.name }}</span>
                        <span class="font-sans text-caption text-slate">{{ sizeLabel(a.file.size) }}</span>
                      </span>
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium"
                        [class]="attachStatus(a.status).cls"
                      >
                        <sd-icon
                          [name]="attachStatus(a.status).icon"
                          [size]="12"
                          [class.animate-spin]="a.status === 'uploading'"
                        />{{ a.status === 'uploading' ? a.progress + '%' : attachStatus(a.status).label }}
                      </span>
                      <button
                        type="button"
                        class="inline-flex size-11 shrink-0 items-center justify-center rounded-field text-slate transition-colors hover:text-alert"
                        [attr.aria-label]="'Remove ' + a.file.name"
                        (click)="removeAttachment(a.key)"
                      >
                        <sd-icon name="trash-2" [size]="18" />
                      </button>
                    </div>
                    @if (a.status === 'uploading') {
                      <div
                        class="h-1.5 w-full overflow-hidden rounded-full bg-frost"
                        role="progressbar"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        [attr.aria-valuenow]="a.progress"
                        [attr.aria-label]="'Uploading ' + a.file.name"
                      >
                        <div class="h-full rounded-full bg-cerulean transition-[width] duration-200" [style.width.%]="a.progress"></div>
                      </div>
                    }
                    @if (a.status === 'failed') {
                      <div class="flex items-start justify-between gap-3">
                        <p class="flex min-w-0 items-start gap-1.5 font-sans text-caption text-alert">
                          <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" /><span class="min-w-0 wrap-anywhere">{{ a.error }}</span>
                        </p>
                        <button
                          type="button"
                          class="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-field border border-haze bg-white px-3 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
                          [attr.aria-label]="'Retry ' + a.file.name"
                          (click)="retryAttachment(a.key)"
                        >
                          <sd-icon name="refresh-cw" [size]="14" />Retry
                        </button>
                      </div>
                    }
                  </li>
                }
              </ul>
            }

            @if (attachments().length < maxDocs) {
              <sd-file-drop
                [accept]="docAccept"
                [multiple]="true"
                [maxBytes]="docMaxBytes"
                [compact]="attachments().length > 0"
                [label]="attachments().length > 0 ? 'Add more files' : 'Drag and drop files here'"
                [hint]="'PDF, JPG, PNG, WEBP, DOCX, DICOM or video · up to 10MB each · up to ' + maxDocs + ' files'"
                (files)="addAttachments($event)"
                (rejected)="onAttachmentsRejected($event)"
              />
            } @else {
              <p class="font-sans text-caption text-slate">
                That's the most you can attach to one booking ({{ maxDocs }} files).
              </p>
            }

            @if (skipped().length > 0) {
              <div class="flex flex-col gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert" role="alert">
                <div class="flex items-start justify-between gap-3">
                  <span class="flex items-start gap-2 font-semibold">
                    <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ skipped().length === 1 ? '1 file wasn’t added' : skipped().length + ' files weren’t added' }}
                  </span>
                  <button
                    type="button"
                    class="inline-flex size-11 shrink-0 items-center justify-center rounded-field transition-colors hover:text-ink"
                    aria-label="Dismiss"
                    (click)="dismissSkipped()"
                  >
                    <sd-icon name="x" [size]="18" />
                  </button>
                </div>
                <ul class="flex flex-col gap-1 pl-[26px] font-sans text-caption">
                  @for (s of skipped(); track $index) {
                    <li class="wrap-anywhere"><span class="font-semibold">{{ s.name }}</span> — {{ s.reason }}</li>
                  }
                </ul>
              </div>
            }

            @if (docsBusy()) {
              <p class="font-sans text-caption text-slate">You can continue once your files have uploaded.</p>
            } @else if (failedAttachments() > 0) {
              <p class="font-sans text-caption text-slate">
                Files that failed won't be attached. Retry or remove them.
              </p>
            }
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 6: summary -->
        @if (step() === 6) {
          <div class="rounded-card border border-haze bg-white p-6 shadow-card">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >6</span
              >Booking Summary
            </h2>
            <div class="flex items-center gap-4">
              <span
                class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 text-cerulean-dark"
                >{{ initials() }}</span
              >
              <div class="flex flex-col">
                <span
                  class="flex items-center gap-1.5 font-heading text-body font-semibold text-ink"
                  >{{ s.name }}
                  @if (s.verified) {
                    <sd-icon
                      name="circle-check"
                      [size]="16"
                      class="text-cerulean"
                    />
                  }</span
                >
                <span class="font-sans text-caption text-cerulean">{{
                  s.specialty
                }}</span>
              </div>
            </div>
            <dl
              class="mt-5 flex flex-col gap-3 border-t border-cloud pt-5 font-sans text-body-sm"
            >
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="calendar-days" [size]="16" />Date
                </dt>
                <dd class="text-right text-ink">{{ summaryDate() }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="clock" [size]="16" />Time
                </dt>
                <dd class="text-right text-ink">{{ summaryTime() }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="video" [size]="16" />Consultation Type
                </dt>
                <dd class="text-right text-ink">
                  {{ parent() ? 'Follow-up Video Consultation' : 'Online Video Consultation' }}
                </dd>
              </div>
              @if (parent()) {
                <div class="flex justify-between gap-4">
                  <dt class="flex items-center gap-2 text-slate">
                    <sd-icon name="history" [size]="16" />Follow-up of
                  </dt>
                  <dd class="text-right text-ink">Your {{ parentDate() }} consultation</dd>
                </div>
              }
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="clipboard-list" [size]="16" />Reason
                </dt>
                <dd class="max-w-[60%] text-right text-ink">
                  {{ reason() || '—' }}
                </dd>
              </div>
              @if (validGuests().length > 0) {
                <div class="flex justify-between gap-4">
                  <dt class="flex items-center gap-2 text-slate">
                    <sd-icon name="users" [size]="16" />Guests
                  </dt>
                  <dd class="max-w-[60%] text-right text-ink">
                    {{ guestNames() }}
                  </dd>
                </div>
              }
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="file-text" [size]="16" />Supporting Documents
                </dt>
                <dd class="text-right text-ink">
                  {{ attachedSummary() }}
                </dd>
              </div>
            </dl>
            <div
              class="mt-5 flex flex-col gap-2 border-t border-cloud pt-4 font-sans text-body-sm"
            >
              <div class="flex justify-between">
                <span class="text-slate">{{ parent() ? 'Follow-up Fee' : 'Consultation Fee' }}</span>
                <span class="text-ink">{{ priceReady() ? feeLabel(baseFee()) : '…' }}</span>
              </div>
              @if (validGuests().length > 0) {
                <div class="flex justify-between">
                  <span class="text-slate"
                    >Guests ({{ validGuests().length }} ×
                    {{ fmt(guestFee()) }})</span
                  >
                  <span class="text-ink">{{ fmt(guestsTotal()) }}</span>
                </div>
              }
              <div
                class="flex justify-between border-t border-cloud pt-2 font-semibold"
              >
                <span class="text-body text-cerulean">Amount</span>
                <span class="text-h5 text-cerulean">{{ priceReady() ? feeLabel(amount()) : '…' }}</span>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap justify-between gap-3">
            <sd-button variant="outline" (click)="back()"
              >Back to previous</sd-button
            >
            <!-- A follow-up waits for its price before payment -->
            <sd-button [disabled]="!priceReady() || doctorGone()" (click)="toPayment()">
              {{ isFree() ? 'Continue' : 'Continue to payment' }}
              <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
          </div>
          <p
            class="flex items-center justify-center gap-1.5 font-sans text-caption text-slate"
          >
            @if (isFree()) {
              <sd-icon name="circle-check" [size]="14" />This consultation is
              free — no payment needed
            } @else {
              <sd-icon name="lock" [size]="14" />Secure payment will be processed
              next
            }
          </p>
        }

        <!-- Step 7: a free consultation books with no payment at all -->
        @if (step() === 7 && isFree()) {
          <div class="rounded-card border border-haze bg-white p-6 shadow-card">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >7</span
              >Confirm Booking
            </h2>
            <div class="flex flex-col gap-3 font-sans text-body-sm">
              <div class="flex justify-between">
                <span class="text-slate">{{ parent() ? 'Follow-up Fee' : 'Consultation Fee' }}</span>
                <span class="text-ink">Free</span>
              </div>
              <div
                class="flex justify-between border-t border-cloud pt-3 font-semibold"
              >
                <span class="text-ink">Total</span>
                <span class="text-cerulean">Free</span>
              </div>
            </div>
            <p class="mt-4 flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate">
              <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
              This consultation is free — nothing will be charged to your card
              or wallet.
            </p>
          </div>

          @if (paidNote()) {
            <sd-alert tone="warning">{{ paidNote() }}</sd-alert>
          }
          @if (unusedPayment()) {
            <sd-alert tone="warning">{{ unusedPayment() }}</sd-alert>
          }
          @if (submitError()) {
            <sd-alert tone="error">{{ submitError() }}</sd-alert>
          }

          <div class="flex flex-wrap items-center justify-between gap-3">
            <sd-button variant="outline" (click)="back()"
              >Back to previous</sd-button
            >
            <!-- A card payment made earlier on this page is kept on the booking. -->
            <sd-button [disabled]="submitting() || doctorGone()" (click)="confirm(paidReference() || undefined)">
              {{ submitting() ? 'Booking…' : 'Confirm booking' }}
            </sd-button>
          </div>
        }

        <!-- Step 7: payment — card (Paystack) or wallet -->
        @if (step() === 7 && !isFree()) {
          <div class="rounded-card border border-haze bg-white p-6 shadow-card">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >7</span
              >Payment Summary
            </h2>
            <div class="flex flex-col gap-3 font-sans text-body-sm">
              <div class="flex justify-between">
                <span class="text-slate">{{ parent() ? 'Follow-up Fee' : 'Consultation Fee' }}</span>
                <span class="text-ink">{{ feeLabel(baseFee()) }}</span>
              </div>
              @if (validGuests().length > 0) {
                <div class="flex justify-between">
                  <span class="text-slate"
                    >Guests ({{ validGuests().length }} ×
                    {{ fmt(guestFee()) }})</span
                  >
                  <span class="text-ink">{{ fmt(guestsTotal()) }}</span>
                </div>
              }
              <div
                class="flex justify-between border-t border-cloud pt-3 font-semibold"
              >
                <span class="text-ink">Total</span>
                <span class="text-cerulean">{{ fmt(amount()) }}</span>
              </div>
            </div>

            <h3 class="mb-3 mt-6 font-heading text-body font-semibold text-cerulean">
              Payment method
            </h3>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                class="flex items-center gap-3 rounded-card border-2 p-4 text-left transition-colors"
                [class]="payMethod() === 'card' ? 'border-cerulean bg-frost/30' : 'border-cloud hover:border-cerulean/40'"
                (click)="payMethod.set('card')"
              >
                <sd-icon name="credit-card" [size]="22" class="shrink-0 text-cerulean" />
                <span class="flex min-w-0 flex-col">
                  <span class="font-sans text-body-sm font-semibold text-ink">Pay with card</span>
                  <span class="font-sans text-caption text-slate">Secure checkout via Paystack</span>
                </span>
                @if (payMethod() === 'card') {
                  <sd-icon name="circle-check" [size]="20" class="ml-auto shrink-0 text-cerulean" />
                }
              </button>
              <!-- Not once the card has been charged: the wallet would pay twice. -->
              <button
                type="button"
                class="flex items-center gap-3 rounded-card border-2 p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                [class]="payMethod() === 'wallet' ? 'border-cerulean bg-frost/30' : 'border-cloud hover:border-cerulean/40'"
                [disabled]="!!paidReference()"
                (click)="payMethod.set('wallet')"
              >
                <sd-icon name="wallet" [size]="22" class="shrink-0 text-cerulean" />
                <span class="flex min-w-0 flex-col">
                  <span class="font-sans text-body-sm font-semibold text-ink">Pay from wallet</span>
                  <span class="font-sans text-caption text-slate">{{
                    walletError()
                      ? 'Balance unavailable'
                      : walletLoaded()
                        ? 'Balance ' + fmt(walletBalance() ?? 0)
                        : 'Balance …'
                  }}</span>
                </span>
                @if (payMethod() === 'wallet') {
                  <sd-icon name="circle-check" [size]="20" class="ml-auto shrink-0 text-cerulean" />
                }
              </button>
            </div>

            @if (payMethod() === 'card') {
              <p class="mt-4 flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate">
                <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
                @if (paidReference()) {
                  Your card payment went through, but the booking didn't. Fix
                  what's shown below, then complete the booking — you won't be
                  charged again.
                } @else {
                  {{ fmt(amount()) }} will be charged to your card now via Paystack — you'll get a receipt by email.
                }
              </p>
              @if (fundError()) {
                <sd-alert tone="error" class="mt-2 block">{{ fundError() }}</sd-alert>
              }
            } @else {
              @if (walletError()) {
                <sd-alert tone="error" class="mt-4 block">{{ walletError() }}</sd-alert>
              }
              @if (walletLoaded() && !walletError() && !walletSufficient()) {
                <p class="mt-4 flex items-start gap-2 rounded-card bg-alert/5 px-4 py-3 font-sans text-caption text-alert">
                  <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />
                  Your wallet is short by {{ fmt(walletShortfall()) }}. Add funds
                  below to book without losing your details.
                </p>
                <!-- Inline top-up (Paystack) — no navigation, booking stays intact -->
                <div class="mt-3 flex flex-col gap-2 rounded-card border border-cloud bg-glacier/40 p-4">
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-slate">Amount to add</span>
                    <div class="flex items-center gap-2 rounded-field border border-cloud bg-white px-3 py-2.5 focus-within:border-cerulean">
                      <span class="font-sans text-body-sm text-slate">{{ currency() }}</span>
                      <input
                        inputmode="numeric"
                        class="min-w-0 flex-1 bg-transparent font-sans text-body-sm text-ink outline-none"
                        [value]="effectiveTopUp()"
                        (input)="topUpAmount.set($any($event.target).value)"
                        [disabled]="funding()"
                      />
                    </div>
                  </label>
                  @if (fundError()) {
                    <sd-alert tone="error" class="block">{{ fundError() }}</sd-alert>
                  }
                  <p class="font-sans text-caption text-slate">
                    You'll pay securely via Paystack in a pop-up. Once it clears, we
                    book your consultation automatically.
                  </p>
                </div>
              } @else {
                <p class="mt-4 flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate">
                  <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
                  {{ fmt(amount()) }} will be debited from your wallet when you
                  confirm — you'll get a receipt by email.
                </p>
              }
            }
          </div>

          @if (paidNote()) {
            <sd-alert tone="warning">{{ paidNote() }}</sd-alert>
          }
          @if (unusedPayment()) {
            <sd-alert tone="warning">{{ unusedPayment() }}</sd-alert>
          }
          @if (submitError()) {
            <sd-alert tone="error">{{ submitError() }}</sd-alert>
          }

          <div class="flex flex-wrap items-center justify-between gap-3">
            <sd-button variant="outline" (click)="back()"
              >Back to previous</sd-button
            >
            @if (payMethod() === 'card') {
              <sd-button [disabled]="funding() || submitting() || doctorGone()" (click)="payWithCard()">
                {{
                  funding() || submitting()
                    ? 'Processing…'
                    : paidReference()
                      ? 'Complete booking'
                      : 'Pay ' + fmt(amount()) + ' with card'
                }}
                @if (!funding() && !submitting()) { <sd-icon name="arrow-right" [size]="18" /> }
              </sd-button>
            } @else if (walletLoaded() && !walletError() && !walletSufficient()) {
              <sd-button [disabled]="funding() || doctorGone()" (click)="topUpAndBook()">
                {{ funding() ? 'Processing…' : 'Fund ' + fmt(topUpValue()) + ' & book' }}
                @if (!funding()) { <sd-icon name="arrow-right" [size]="18" /> }
              </sd-button>
            } @else {
              <sd-button
                [disabled]="submitting() || !walletLoaded() || doctorGone()"
                (click)="confirm()"
              >
                {{ submitting() ? 'Booking…' : 'Pay ' + fmt(amount()) + ' from wallet' }}
              </sd-button>
            }
          </div>
        }
      } @else {
        <div
          class="sd-shimmer h-64 rounded-card"
        ></div>
      }
    </div>

    <ng-template #navRow>
      <div class="flex flex-wrap justify-between gap-3">
        <sd-button variant="outline" (click)="back()">Back to previous</sd-button>
        <sd-button [disabled]="!canContinue() || doctorGone()" (click)="next()">
          Continue <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </div>
    </ng-template>
  `,
})
export class BookConsultation implements OnInit, HasUnsavedChanges {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly appointments = inject(AppointmentsApi);
  /** For GET /api/portal/card-payments/{reference} (a saved card payment's status). */
  private readonly api = inject(ApiService);
  private readonly wallet = inject(WalletApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  /** Step 5's heading — focus lands here when the control used is removed. */
  private readonly docsTitle = viewChild<ElementRef<HTMLElement>>('docsTitle');
  /** The page heading — focus lands here when another doctor is picked from the suggestions. */
  private readonly pageTitle = viewChild<ElementRef<HTMLElement>>('pageTitle');

  protected readonly steps = [1, 2, 3, 4, 5, 6, 7];
  protected readonly step = signal(1);

  // Wallet — the consultation is paid from the patient's wallet balance.
  protected readonly walletBalance = signal<number | null>(null);
  protected readonly walletLoaded = signal(false);
  /** Why the balance couldn't be loaded ('' when it loaded fine). */
  protected readonly walletError = signal('');

  protected readonly specialist = signal<SpecialistDto | null>(null);
  protected readonly pricing = signal<PricingDto | null>(null);
  /** Why the specialist couldn't be loaded ('' when it loaded fine). */
  protected readonly loadError = signal('');
  /** …because they can't be booked (not listed / not taking bookings), not a network problem. */
  protected readonly loadErrorGone = signal(false);
  /** The doctor stopped taking bookings while the patient was booking. */
  protected readonly doctorGone = signal(false);

  // ----- Date & time: the doctor's month calendar -----
  protected readonly cal = inject(AvailabilityCalendarStore);
  /** The chosen time's ISO start ('' = none chosen yet). */
  protected readonly selectedTime = signal('');
  /** The doctor being booked (the route's `:id`). */
  private readonly doctorId = signal('');
  /** The `?follow_up` this page was opened with (suggestions stay hidden for it). */
  private readonly followUpOf = signal('');
  /** A time to choose once its day's times have loaded (`?slot=`, or "Select" on the next opening). */
  private readonly pendingSlot = signal<{ iso: string; focus: boolean } | null>(null);
  /** `?date=`: the day to open on once the calendar knows the booking window. */
  private readonly pendingDate = signal<string | null>(null);
  /** Nothing asked for: open on the doctor's next open day once the calendar shows. */
  private readonly autoPick = signal(false);
  /** How `?date=` was resolved when it isn't the day shown (drives `dateNotice`). */
  private readonly dateResolution = signal<{ want: string; chosen: string; until: string | null } | null>(null);
  /** Something about the chosen time the patient must know (taken meanwhile, passed). */
  protected readonly slotNotice = signal('');
  /** The doctor's next opening on or after the chosen day, from the suggestions call. */
  protected readonly requestedNext = signal<string | null>(null);
  /** What `route` was last started for, so a repeated emission doesn't restart. */
  private startedFor = '';

  protected readonly reason = signal('');
  protected readonly guests = signal<GuestInvite[]>([]);
  /** The server refused a guest row (e.g. the patient's own email), by row. */
  private readonly guestServerErrors = signal<Record<number, { name?: string; email?: string }>>({});

  // Supporting documents — each is filed in the patient's medical documents as
  // it uploads; the booking attaches the uploaded ones by id.
  protected readonly docAccept = DOC_ACCEPT;
  protected readonly docMaxBytes = DOC_MAX_BYTES;
  protected readonly maxDocs = MAX_DOCS;
  protected readonly attachments = signal<Attachment[]>([]);
  protected readonly skipped = signal<SkippedFile[]>([]);
  /** A file is on the wire or waiting its turn — Continue waits for them. */
  protected readonly docsBusy = computed(() =>
    this.attachments().some((a) => a.status === 'uploading' || a.status === 'queued'),
  );
  protected readonly failedAttachments = computed(
    () => this.attachments().filter((a) => a.status === 'failed').length,
  );
  /** The uploaded documents' ids, in the order they were added. */
  private readonly attachedIds = computed(() =>
    this.attachments()
      .filter((a) => a.status === 'done')
      .map((a) => a.doc?.id)
      .filter((id): id is string => !!id),
  );
  protected readonly attachedSummary = computed(() => {
    const n = this.attachedIds().length;
    return n === 0 ? 'None' : n === 1 ? '1 document attached' : `${n} documents attached`;
  });
  /** What the aria-live region says — per file, not per progress tick. */
  protected readonly docsLiveStatus = computed(() => {
    const list = this.attachments();
    const at = list.find((a) => a.status === 'uploading');
    if (at) return `Uploading ${at.file.name}.`;
    if (list.length === 0) return '';
    const failed = this.failedAttachments();
    return `${this.attachedSummary()}.${failed > 0 ? ` ${failed} failed.` : ''}`;
  });
  private nextDocKey = 1;
  /** The in-flight upload per attachment, so Remove can cancel it. */
  private readonly uploads = new Map<number, Subscription>();

  protected readonly submitting = signal(false);
  protected readonly submitError = signal('');
  /** The booking went through: leaving (to My Appointments) needs no question. */
  private booked = false;

  // Payment method — card (Paystack, direct) or wallet. Card is the default so
  // patients are never forced to fund a wallet first.
  protected readonly payMethod = signal<'card' | 'wallet'>('card');

  // Inline Paystack popup during booking — the entered consultation details are
  // kept intact; on success we book automatically.
  protected readonly funding = signal(false);
  protected readonly fundError = signal('');
  /**
   * A card payment that went through for a booking the server then refused,
   * with the amount it paid — kept so "Complete booking" retries on it instead
   * of charging again, as long as it still covers the price (a follow-up's
   * price can change with the slot).
   */
  private readonly paid = signal<{ reference: string; amount: number } | null>(null);
  /** The kept card payment while it covers this booking ('' otherwise). */
  protected readonly paidReference = computed(() => {
    const p = this.paid();
    // While a new slot is being priced it still counts (paying waits for the price).
    return p && (!this.priceReady() || this.amount() <= p.amount) ? p.reference : '';
  });
  /** How the kept card payment differs from this booking's price ('' when it matches). */
  protected readonly paidNote = computed(() => {
    const p = this.paid();
    if (!p || !this.priceReady()) return '';
    const now = this.amount();
    if (now > p.amount) {
      return (
        `Your earlier card payment of ${this.fmt(p.amount)} doesn't cover this time (${this.fmt(now)}). ` +
        `Pick a time that costs ${this.fmt(p.amount)} or less to book on it without paying again — ` +
        `paying now is a separate charge, and the earlier payment is added to your VideoMed wallet automatically ` +
        `within about ${AUTO_CREDIT_MINUTES} minutes if no booking uses it.`
      );
    }
    if (now < p.amount) {
      return (
        `Your earlier card payment of ${this.fmt(p.amount)} is more than this time costs (${this.feeLabel(now)}). ` +
        `This booking uses it, and the ${this.fmt(p.amount - now)} difference is added to your VideoMed wallet.`
      );
    }
    return '';
  });
  /** A card payment the server wouldn't take for this booking, and where its money goes. */
  protected readonly unusedPayment = signal('');
  /** A card payment from before a reload that can still complete this booking ("Complete your paid booking"). */
  protected readonly resumable = signal<ResumablePayment | null>(null);
  /** Where an earlier card payment's money went (the wallet). */
  protected readonly walletNotice = signal('');
  /** The server check of a saved card payment, while it runs (a newer page start cancels it). */
  private resumeCheck?: Subscription;
  protected readonly topUpAmount = signal('');

  private readonly nf = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  // ----- Follow-up of an earlier consultation (`?follow_up=<id>[&date=YYYY-MM-DD]`) -----
  /** The completed consultation (with this doctor) this books a follow-up of; null = a regular booking. */
  protected readonly parent = signal<AppointmentDto | null>(null);
  /** `?follow_up` is being checked — prices wait for it. */
  protected readonly parentChecking = signal(false);
  /** Why the booking fell back to a regular one ('' when it didn't). */
  protected readonly parentNotice = signal('');
  /** The follow-up price, keyed by the slot it was quoted for. */
  private readonly quote = signal<{ iso: string; data: FollowUpQuoteDto } | null>(null);
  protected readonly quoteError = signal('');
  private quoteSub?: Subscription;
  protected readonly parentDate = computed(() => dayLabel(this.parent()?.scheduled_at));

  /**
   * The consultation fee for the chosen slot is known: always for a regular
   * booking; for a follow-up once the slot has been quoted.
   */
  protected readonly priceReady = computed(() => {
    if (this.parentChecking()) return false;
    const iso = this.selectedTime();
    return !this.parent() || (iso !== '' && this.quote()?.iso === iso);
  });

  /** The follow-up banner's price line. */
  protected readonly followUpPriceLine = computed(() => {
    const q = this.quote();
    if (this.quoteError()) return this.quoteError();
    if (!this.priceReady() || !q) return 'Checking the follow-up price…';
    const why = priceNote(q.data);
    return `${this.feeLabel(q.data.amount)} for the selected time${why ? ` · ${why}` : ''}`;
  });

  constructor() {
    // Closing or reloading the tab would lose a card payment no booking has
    // used yet (or one still going through), or files still uploading.
    warnBeforeUnload(() => !this.booked && (!!this.paid() || this.funding() || this.docsBusy()));

    // A follow-up's price depends on its date: quote each slot as it is picked.
    effect(() => {
      const parent = this.parent();
      const iso = this.selectedTime();
      untracked(() => this.fetchQuote(parent, iso));
    });

    // A card payment that covers the booking again is how it is paid: the
    // wallet would pay twice.
    effect(() => {
      if (this.paidReference()) untracked(() => this.payMethod.set('card'));
    });

    // A time asked for (`?slot=`, "Select"): chosen once its day's times are
    // in — or, taken meanwhile, said so.
    effect(() => {
      const pending = this.pendingSlot();
      const slots = this.cal.slots();
      // A failed load isn't an empty day: wait for "Try again".
      if (!pending || slots === null || this.cal.slotsLoading() || this.cal.error()) return;
      untracked(() => {
        this.pendingSlot.set(null);
        // The patient picked another day meanwhile.
        if (this.cal.selectedDate() !== ymdInZone(pending.iso, this.cal.tz())) return;
        const at = new Date(pending.iso).getTime();
        const slot = slots.find((s) => new Date(s.iso).getTime() === at);
        if (!slot) {
          this.slotNotice.set(`${whenLabel(pending.iso)} is no longer available — please choose another time.`);
          return;
        }
        this.selectedTime.set(slot.iso);
        if (pending.focus) this.focusChosenTime();
      });
    });

    // `?date=`: open on that day, or the nearest open day (and say why).
    effect(() => {
      const want = this.pendingDate();
      const range = this.cal.range();
      if (!want || !range) return;
      untracked(() => {
        const anchor = want > range.bookable_until ? range.bookable_until : want;
        // Its month isn't the one showing yet: show it, and decide once it's in.
        if (!range.days.some((d) => d.date === anchor)) {
          this.cal.setMonth(anchor.slice(0, 7));
          return;
        }
        this.pendingDate.set(null);
        this.resolveDate(want, anchor, range);
      });
    });

    // Nothing asked for: open on the next open day when it's in view (the
    // calendar's own "Next available" covers one further out). No time is
    // chosen for the patient.
    effect(() => {
      const range = this.cal.range();
      if (!this.autoPick() || !range) return;
      untracked(() => {
        this.autoPick.set(false);
        const next = range.next_available;
        if (!next || this.cal.selectedDate()) return;
        const day = ymdInZone(next, this.cal.tz());
        if (range.days.some((d) => d.date === day)) this.showDay(day);
      });
    });

    // The calendar says the doctor isn't listed any more (its 404).
    effect(() => {
      if (/not found/i.test(this.cal.error() ?? '')) untracked(() => this.markDoctorGone());
    });

    // While the documents step is showing, a file dropped just outside the
    // drop zone must not make the browser navigate away to open it (losing
    // the whole booking). The zone cancels its own events first, so anything
    // still uncancelled here is a miss.
    effect((onCleanup) => {
      const win = this.document.defaultView;
      if (this.step() !== 5 || !win) return;
      const guard = (e: DragEvent): void => {
        if (e.defaultPrevented || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      };
      win.addEventListener('dragover', guard);
      win.addEventListener('drop', guard);
      onCleanup(() => {
        win.removeEventListener('dragover', guard);
        win.removeEventListener('drop', guard);
      });
    });
  }

  ngOnInit(): void {
    // A suggested doctor's time links to this same route with another `:id`
    // (and `?slot=`): the page is reused, so it starts again for each.
    merge(this.route.paramMap, this.route.queryParamMap)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const snap = this.route.snapshot;
        const id = snap.paramMap.get('id') ?? '';
        const q = snap.queryParamMap;
        const key = [id, q.get('slot'), q.get('date'), q.get('follow_up')].join('|');
        if (key === this.startedFor) return;
        this.startedFor = key;
        this.start(id, q);
      });

    this.specialistsApi
      .pricing()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.pricing.set(res.data) });

    this.wallet
      .wallet()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.walletBalance.set(Number(res.data.balance));
          this.walletLoaded.set(true);
        },
        error: (err: unknown) => {
          this.walletError.set(apiErrorMessage(err, 'Could not load your wallet balance.'));
          this.walletLoaded.set(true);
        },
      });

  }

  /**
   * (Re)start for doctor `id` with the page's query: the doctor, a follow-up
   * link, and the calendar opened on `?slot=`'s day, `?date=` (or its nearest
   * open day), or the next open day. The patient's own entries — reason,
   * guests, documents — are kept when another doctor is picked from the
   * suggestions; anything priced or paid for the last doctor is not.
   */
  private start(id: string, query: ParamMap): void {
    const previous = this.doctorId();
    const sameDoctor = id === previous;
    this.doctorId.set(id);
    this.step.set(1);
    this.selectedTime.set('');
    this.pendingSlot.set(null);
    this.pendingDate.set(null);
    this.autoPick.set(false);
    this.dateResolution.set(null);
    this.slotNotice.set('');
    this.requestedNext.set(null);
    this.submitError.set('');
    this.fundError.set('');
    this.walletNotice.set('');
    // A follow-up link holds for this page only.
    this.quoteSub?.unsubscribe();
    this.parent.set(null);
    this.quote.set(null);
    this.quoteError.set('');
    this.parentNotice.set('');
    if (!sameDoctor) {
      this.specialist.set(null);
      this.loadError.set('');
      this.loadErrorGone.set(false);
      this.doctorGone.set(false);
      // A card payment made for the last doctor can't book this one.
      const kept = this.paid();
      if (kept) {
        this.paid.set(null);
        this.unusedPayment.set(this.unusedPaymentNote(kept));
        this.forgetPendingCard();
      }
      this.loadSpecialist(id);
      // Another doctor picked from the suggestions: the link that did it is
      // gone, so start at the top with focus on the heading.
      if (previous) {
        afterNextRender(
          () => {
            this.document.defaultView?.scrollTo({ top: 0 });
            this.pageTitle()?.nativeElement.focus();
          },
          { injector: this.injector },
        );
      }
    }

    const followUpOf = query.get('follow_up') ?? '';
    this.followUpOf.set(followUpOf);
    if (followUpOf) this.checkParent(followUpOf);
    this.offerResume(id, followUpOf);

    this.cal.load(id);
    const tz = this.cal.tz();
    const slot = query.get('slot') ?? '';
    const slotAt = new Date(slot).getTime();
    // A doctor's suggested follow-up day, or a day picked in the directory (a local calendar date).
    const date = query.get('date') ?? '';
    const want = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= ymdInZone(new Date(), tz) ? date : '';
    if (slot && !isNaN(slotAt) && slotAt > Date.now()) {
      this.pendingSlot.set({ iso: slot, focus: false });
      this.showDay(ymdInZone(slot, tz));
    } else if (want) {
      this.pendingDate.set(want);
    } else {
      if (slot && !isNaN(slotAt)) this.slotNotice.set(`${whenLabel(slot)} has already passed — please choose another time.`);
      this.autoPick.set(true);
    }
  }

  private loadSpecialist(id: string): void {
    this.specialistsApi
      .getPublic(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (id === this.doctorId()) this.specialist.set(res.data);
        },
        error: (err: unknown) => {
          if (id !== this.doctorId()) return;
          // Unlisted, suspended or switched off for bookings: say so, not "not found".
          const gone = httpStatus(err) === 404;
          this.loadErrorGone.set(gone);
          this.loadError.set(
            gone
              ? `${notBookableText(null)} Choose another specialist to book with.`
              : apiErrorMessage(err, 'Could not load this specialist.'),
          );
        },
      });
  }

  /**
   * Open on `want` (the anchor: `want`, or the last bookable day when it is
   * further off) if it has open times, else on the nearest day that does —
   * and say exactly which day and why.
   */
  private resolveDate(want: string, anchor: string, range: AvailabilityRangeDto): void {
    const open = range.days.filter((d) => isOpenStatus(d.status)).map((d) => d.date);
    const nearest = open.includes(anchor)
      ? anchor
      : ([...open].sort((a, b) => daysApart(a, anchor) - daysApart(b, anchor) || b.localeCompare(a))[0] ??
        (range.next_available ? ymdInZone(range.next_available, this.cal.tz()) : ''));
    this.showDay(nearest || anchor);
    const beyond = want > range.bookable_until;
    if (nearest === want) return;
    this.dateResolution.set({ want, chosen: nearest, until: beyond ? range.bookable_until : null });
  }

  /** Why the day shown isn't the one asked for (`?date=`), exactly. */
  protected readonly dateNotice = computed(() => {
    const r = this.dateResolution();
    if (!r) return '';
    const want = longDayLabel(r.want);
    const chosen = r.chosen ? `${longDayLabel(r.chosen)}, the nearest open day, is selected.` : 'no nearby day has open times right now.';
    const name = this.specialist()?.name ?? 'This doctor';
    if (this.followUpOf()) {
      return r.until
        ? `Your doctor suggested ${want}, but times can only be booked up to ${longDayLabel(r.until)} right now — ${chosen}`
        : `Your doctor suggested ${want}, but there are no open times that day — ${chosen}`;
    }
    return r.until
      ? `Times can only be booked up to ${longDayLabel(r.until)} right now — ${chosen}`
      : `${name} has no open times on ${want} — ${chosen}`;
  });

  /** A follow-up stays with this doctor: no similar doctors are offered. */
  protected readonly followUp = computed(() => !!this.followUpOf() && (!!this.parent() || this.parentChecking()));

  /** Nothing open anywhere in the booking window (once the calendar knows). */
  protected readonly noOpenings = computed(() => {
    const range = this.cal.range();
    return !!range && range.next_available === null && !this.cal.error();
  });

  protected readonly calendarError = computed(() =>
    calendarErrorText(this.cal.error(), this.specialist()?.name),
  );

  protected readonly goneText = computed(() => notBookableText(this.specialist()?.name));

  /** Similar doctors (same specialty) free on the chosen day — today when none is chosen. */
  protected readonly similarParams = computed<SpecialistSuggestionParams>(() => ({
    like: this.doctorId(),
    date: this.cal.selectedDate() ?? undefined,
    tz: this.cal.tz(),
  }));

  /** The chosen day has no open times (the calendar shows its `[calendarEmpty]` content). */
  protected readonly dayEmpty = computed(() => {
    if (!this.cal.selectedDate() || this.cal.slotsLoading()) return false;
    // Times that failed to load aren't an empty day (the error says so).
    if (this.cal.error()) return false;
    const slots = this.cal.slots();
    if (slots) return slots.length === 0;
    const status = this.cal.selectedDay()?.status;
    return status === 'full' || status === 'closed' || status === 'blocked';
  });

  protected readonly selectedDayLabel = computed(() => {
    const day = this.cal.selectedDate();
    return day ? shortDayLabel(day) : '';
  });

  /**
   * This doctor's next opening after the chosen (empty) day — never on or
   * before it: the first the calendar knows of (the next opening at all when
   * later, else the first open day after it in any month loaded), else the
   * suggestions' answer (`requested.next_available_at`).
   */
  protected readonly nextOpening = computed<string | null>(() => {
    const sel = this.cal.selectedDate();
    if (!sel) return null;
    const known = this.cal.nextAfterSelected();
    if (known) return known;
    const asked = this.requestedNext();
    return asked && ymdInZone(asked, this.cal.tz()) > sel ? asked : null;
  });

  protected openingLabel(iso: string): string {
    return whenLabel(iso);
  }

  /** The patient picked a day on the calendar. */
  protected pickDay(date: string): void {
    this.pendingSlot.set(null);
    this.slotNotice.set('');
    this.requestedNext.set(null);
    this.cal.selectDate(date);
  }

  /** The patient picked a time (null: the calendar dropped it for another day). */
  protected pickTime(iso: string | null): void {
    this.selectedTime.set(iso ?? '');
    if (iso) this.slotNotice.set('');
  }

  /** "Select" on the next opening: that day, with that time chosen. */
  protected selectOpening(iso: string): void {
    this.selectedTime.set('');
    this.slotNotice.set('');
    this.requestedNext.set(null);
    this.pendingSlot.set({ iso, focus: true });
    this.showDay(ymdInZone(iso, this.cal.tz()));
  }

  /**
   * Pick `date` for the patient and show its month — a day in the grid's
   * trailing week would otherwise be chosen out of sight.
   */
  private showDay(date: string): void {
    this.cal.selectDate(date);
    this.cal.setMonth(date.slice(0, 7));
  }

  /** Focus the chosen time's radio (the button that chose it is gone). */
  private focusChosenTime(): void {
    afterNextRender(
      () => this.document.querySelector<HTMLInputElement>('sd-booking-calendar input[type="radio"]:checked')?.focus(),
      { injector: this.injector },
    );
  }

  /**
   * The server refused the chosen time (taken meanwhile, or past the booking
   * window): back to step 1 with fresh availability, and say so.
   */
  private timeRefused(message: string): void {
    this.selectedTime.set('');
    this.cal.refresh();
    this.slotNotice.set(`${message.replace(/\.?$/, '.')} We've refreshed the calendar with the times still open.`);
    this.step.set(1);
  }

  /** The doctor can't be booked any more: say so, and stop any payment for them. */
  private markDoctorGone(): void {
    if (this.doctorGone()) return;
    this.doctorGone.set(true);
    this.resumable.set(null);
    const kept = this.paid();
    if (kept) {
      this.paid.set(null);
      this.unusedPayment.set(this.unusedPaymentNote(kept));
      this.forgetPendingCard();
    }
  }

  // ----- A card payment that outlives the page -----

  private storage(): Storage | null {
    try {
      return this.document.defaultView?.sessionStorage ?? null;
    } catch {
      return null;
    }
  }

  private rememberPendingCard(value: PendingCardPayment): void {
    writePendingCard(this.storage(), value);
  }

  private forgetPendingCard(): void {
    writePendingCard(this.storage(), null);
    this.resumable.set(null);
  }

  /**
   * On (re)opening the page: a card payment this tab started that no booking
   * used yet (saved just before the Paystack pop-up opened — so it may never
   * have been paid: the pop-up closed, or the page reloaded before paying).
   * Nothing is said until the server confirms what happened to it:
   *  - paid, still good for this doctor and time → offer "Complete your paid booking";
   *  - paid, for something this page can't book → say it goes to the wallet, and when;
   *  - used / credited / held for support → say so;
   *  - never paid (or unknown) → forgotten, silently;
   *  - the server can't tell just now → kept, silently, for the next visit.
   */
  private offerResume(doctorId: string, followUpOf: string): void {
    this.resumable.set(null);
    this.resumeCheck?.unsubscribe();
    const p = readPendingCard(this.storage());
    if (!p || p.reference === this.paid()?.reference) return;
    this.resumeCheck = this.api
      .get<SuccessResponse<CardPaymentStatus>>(`api/portal/card-payments/${encodeURIComponent(p.reference)}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.showSavedPayment(p, res.data, doctorId, followUpOf),
        error: (err) => {
          // No such payment of theirs: nothing to say. Anything else: ask again next time.
          if (httpStatus(err) === 404) writePendingCard(this.storage(), null);
        },
      });
  }

  /** What the server said about a saved card payment ({@link offerResume}). */
  private showSavedPayment(p: PendingCardPayment, s: CardPaymentStatus, doctorId: string, followUpOf: string): void {
    // The page moved on (another doctor) or the payment was taken up meanwhile: the new start decides.
    if (this.doctorId() !== doctorId || p.reference === this.paid()?.reference) return;
    const amount = Number(s.amount) > 0 ? Number(s.amount) : p.amount;
    const ref = `${this.fmt(amount)} (reference ${p.reference})`;
    switch (s.status) {
      case 'paid':
        if (new Date(p.slot).getTime() > Date.now() && p.specialistId === doctorId && p.parentId === followUpOf) {
          this.resumable.set({ ...p, amount, creditDueAt: s.credit_due_at });
          return;
        }
        this.walletNotice.set(
          `Your earlier card payment of ${ref} wasn't used for a booking, so it will be added to your VideoMed wallet automatically ${this.creditDueLabel(s.credit_due_at)}.`,
        );
        break;
      case 'credited_to_wallet':
        this.walletNotice.set(
          `Your earlier card payment of ${ref} wasn't used for a booking, so it has been added to your VideoMed wallet.`,
        );
        break;
      case 'used':
        this.walletNotice.set(
          `Your earlier card payment of ${ref} has already been used for a booking — check My appointments before paying again.`,
        );
        break;
      case 'review':
        this.walletNotice.set(
          `Your earlier card payment of ${ref} is being checked by our support team. Contact support with its reference if you need help.`,
        );
        break;
      case 'unconfirmed':
        return; // Paystack couldn't be asked just now: keep it, say nothing yet.
      default:
        break; // never paid: nothing was charged, nothing to say
    }
    writePendingCard(this.storage(), null);
  }

  /** "within about 25 minutes" / "shortly" — when an unused paid card payment reaches the wallet. */
  protected creditDueLabel(dueAt: string | null): string {
    const due = dueAt ? Date.parse(dueAt) : NaN;
    if (isNaN(due)) return `within about ${AUTO_CREDIT_MINUTES} minutes`;
    const minutes = Math.ceil((due - Date.now()) / 60_000);
    return minutes > 1 ? `within about ${minutes} minutes` : 'shortly';
  }

  /** "Complete your paid booking": the paid time is chosen again and the booking completes on that payment. */
  protected resumePaidBooking(): void {
    const p = this.resumable();
    if (!p) return;
    this.resumable.set(null);
    this.walletNotice.set('');
    this.paid.set({ reference: p.reference, amount: p.amount });
    this.payMethod.set('card');
    this.showDay(ymdInZone(p.slot, this.cal.tz()));
    this.selectedTime.set(p.slot);
    this.step.set(7);
  }

  /** "Not now": leave it — the server confirmed it paid and unused, and adds it to the wallet. */
  protected dismissResume(): void {
    const p = this.resumable();
    if (!p) return;
    this.walletNotice.set(
      `Your card payment of ${this.fmt(p.amount)} will be added to your VideoMed wallet automatically ` +
        `${this.creditDueLabel(p.creditDueAt)} — you can use it for any booking.`,
    );
    this.forgetPendingCard();
  }

  /** The API credited the card payment to the wallet: book from the wallet now, and say so. */
  private cardCreditedToWallet(message: string): void {
    this.paid.set(null);
    this.forgetPendingCard();
    this.unusedPayment.set('');
    this.walletNotice.set(message);
    this.payMethod.set('wallet');
    this.wallet
      .wallet()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.walletBalance.set(Number(res.data.balance));
          this.walletLoaded.set(true);
          this.walletError.set('');
        },
        error: () => undefined,
      });
  }

  /**
   * After a booking refused on the doctor (`specialist_id`): are they still
   * bookable? Not listed (404) → said so; still listed → `stillBookable`.
   */
  private recheckDoctor(stillBookable?: () => void): void {
    const id = this.doctorId();
    this.specialistsApi
      .getPublic(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (id === this.doctorId()) stillBookable?.();
        },
        error: (err: unknown) => {
          if (id !== this.doctorId()) return;
          if (httpStatus(err) === 404) this.markDoctorGone();
          else stillBookable?.();
        },
      });
  }

  protected readonly initials = computed(() =>
    (this.specialist()?.name ?? '')
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected readonly rating = computed(() =>
    Number(this.specialist()?.rating ?? 0).toFixed(1),
  );

  /** The chosen time, e.g. "Thu 16 Oct, 9:30 AM" (the patient's clock). */
  protected readonly selectedLabel = computed(() => whenLabel(this.selectedTime()));

  /** "Thursday, 16 October 2026" — the chosen time's day on the patient's calendar (the calendar's zone). */
  protected readonly summaryDate = computed(() => {
    const d = new Date(this.selectedTime());
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: this.cal.tz(),
    }).format(d);
  });

  /** The chosen time's local label, so the summary matches the picked time. */
  protected readonly summaryTime = computed(() => slotLabel(this.selectedTime()) || '—');

  // ----- Pricing -----

  protected readonly currency = computed(() => {
    const c = this.pricing()?.currency ?? 'NGN';
    return c === 'NGN' ? '₦' : c;
  });
  protected readonly guestFee = computed(() => this.pricing()?.guest_fee ?? 0);
  protected readonly platformFee = computed(
    () => this.pricing()?.platform_fee ?? 0,
  );
  /** The doctor's fee — or, for a follow-up, its quoted price for the chosen slot. */
  protected readonly baseFee = computed(() => {
    const q = this.quote();
    if (this.parent() && q && q.iso === this.selectedTime()) return Number(q.data.amount);
    return Number(this.specialist()?.consultation_fee ?? 0);
  });
  protected readonly validGuests = computed(() =>
    this.guests().filter((g) => g.name.trim() !== '' && this.emailValid(g.email)),
  );
  protected readonly guestsTotal = computed(
    () => this.validGuests().length * this.guestFee(),
  );
  /** Consultation fee + guest fees — what the backend charges the wallet. */
  protected readonly amount = computed(() => this.baseFee() + this.guestsTotal());
  /**
   * Nothing to pay: no card checkout and no wallet balance needed. With guests
   * it waits for the pricing, so an unloaded guest fee never reads as free.
   */
  protected readonly isFree = computed(
    () =>
      this.priceReady() &&
      this.amount() <= 0 &&
      (this.validGuests().length === 0 || this.pricing() !== null),
  );
  /** Amount + platform fee — the checkout total shown at payment. */
  protected readonly total = computed(() => this.amount() + this.platformFee());

  /** Wallet covers the charge (only meaningful once the balance has loaded). */
  protected readonly walletSufficient = computed(
    () => this.walletBalance() !== null && (this.walletBalance() as number) >= this.amount(),
  );
  /** How much more the wallet needs to cover this booking. */
  protected readonly walletShortfall = computed(() =>
    Math.max(0, this.amount() - (this.walletBalance() ?? 0)),
  );

  /** The top-up amount to fund: the patient's input, else the exact shortfall. */
  protected readonly topUpValue = computed(() => {
    const typed = Number(this.topUpAmount());
    if (this.topUpAmount().trim() !== '' && !Number.isNaN(typed) && typed > 0) return typed;
    return Math.ceil(this.walletShortfall());
  });
  /** String shown in the amount input (defaults to the shortfall). */
  protected effectiveTopUp(): string {
    return this.topUpAmount().trim() !== '' ? this.topUpAmount() : String(Math.ceil(this.walletShortfall()));
  }

  protected readonly guestNames = computed(() =>
    this.validGuests()
      .map((g) => g.name.trim())
      .join(', '),
  );

  protected fmt(value: number | string): string {
    return this.currency() + this.nf.format(Number(value) || 0);
  }

  /** A fee as money, or "Free" when there is nothing to pay (never "₦0.00"). */
  protected feeLabel(value: number | string): string {
    return Number(value) > 0 ? this.fmt(value) : 'Free';
  }

  // ----- Follow-up -----

  /**
   * `?follow_up` must be one of the patient's completed consultations with
   * this doctor; anything else falls back to a regular booking, with a note.
   */
  private checkParent(id: string): void {
    this.parentChecking.set(true);
    this.appointments
      .getMine(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.parentChecking.set(false);
          const a = res.data;
          const sameDoctor = a.specialist.id === this.doctorId();
          if (a.status === 'completed' && sameDoctor) this.parent.set(a);
          else if (a.status === 'confirmed' && sameDoctor) {
            // Straight after the call (e.g. from its prescription), before the
            // doctor has closed the consultation.
            this.dropParent(
              "Your consultation hasn't been closed by your doctor yet, so follow-up pricing can't apply yet — " +
                'book now at the usual fee, or come back once it is completed.',
            );
          } else this.dropParent();
        },
        error: () => {
          this.parentChecking.set(false);
          this.dropParent();
        },
      });
  }

  /** Book as a regular consultation from here on (the follow-up link didn't hold). */
  private dropParent(
    notice = "We couldn't link this to an earlier consultation with this doctor, so it's booked as a regular consultation at the usual fee.",
  ): void {
    this.quoteSub?.unsubscribe();
    this.parent.set(null);
    this.quote.set(null);
    this.quoteError.set('');
    this.parentNotice.set(notice);
  }

  /** Price the follow-up for the chosen slot (once per slot, unless `force`). */
  private fetchQuote(parent: AppointmentDto | null, iso: string, force = false): void {
    // A quote still on its way is for a slot no longer chosen.
    this.quoteSub?.unsubscribe();
    this.quoteError.set('');
    if (!parent || !iso) return;
    if (!force && this.quote()?.iso === iso) return;
    this.quoteSub = this.appointments
      .followUpQuote(parent.id, iso)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.quote.set({ iso, data: res.data }),
        error: (err: unknown) => {
          const fields = apiErrorFields(err);
          // The consultation can't be followed up after all (e.g. no longer completed).
          if (fields['parent_appointment_id'] || fields['specialist_id']) {
            this.dropParent();
            return;
          }
          this.quoteError.set(apiErrorMessage(err, "Couldn't check the follow-up price. Please try again."));
        },
      });
  }

  /** Retry a failed quote for the selected slot. */
  protected retryQuote(): void {
    this.fetchQuote(this.parent(), this.selectedTime(), true);
  }

  protected emailValid(email: string): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  }

  // ----- Guests -----

  protected addGuest(): void {
    if (this.guests().length >= 3) return;
    this.guests.update((list) => [...list, { name: '', email: '' }]);
  }

  protected removeGuest(index: number): void {
    this.guests.update((list) => list.filter((_, i) => i !== index));
    this.guestServerErrors.set({}); // the rows have moved
  }

  protected setGuest(index: number, field: keyof GuestInvite, value: string): void {
    this.guests.update((list) =>
      list.map((g, i) => (i === index ? { ...g, [field]: value } : g)),
    );
    const server = this.guestServerErrors()[index];
    if (server?.[field]) {
      this.guestServerErrors.update((all) => ({ ...all, [index]: { ...server, [field]: undefined } }));
    }
  }

  /**
   * What's wrong with a guest row: the server's answer (not the patient's own
   * or the doctor's email, …), or the same person twice on this list.
   */
  protected guestError(index: number): { name?: string; email?: string } {
    const server = this.guestServerErrors()[index] ?? {};
    const email = (this.guests()[index]?.email ?? '').trim().toLowerCase();
    const repeated =
      email !== '' &&
      this.emailValid(email) &&
      this.guests()
        .slice(0, index)
        .some((g) => g.email.trim().toLowerCase() === email);
    return {
      name: server.name,
      email: server.email ?? (repeated ? 'This person is already invited' : undefined),
    };
  }

  /** The server's `guests.N.name|email` errors, by the row they belong to. */
  private takeGuestErrors(fields: Record<string, string>): boolean {
    const valid = this.validGuests();
    const rows = this.guests();
    const byRow: Record<number, { name?: string; email?: string }> = {};
    for (const [key, message] of Object.entries(fields)) {
      const m = /^guests\.(\d+)\.(name|email)$/.exec(key);
      if (!m) continue;
      // N counts the guests sent (blank rows aren't), so find that guest's row.
      const row = rows.indexOf(valid[Number(m[1])]);
      if (row < 0) continue;
      byRow[row] = { ...byRow[row], [m[2]]: message };
    }
    this.guestServerErrors.set(byRow);
    return Object.keys(byRow).length > 0;
  }

  /** Per-step "Continue" gate for the shared nav row (steps 2–5). */
  protected readonly canContinue = computed(() => {
    switch (this.step()) {
      case 2:
        return true; // Online is preselected
      case 3:
        return this.reason().trim().length > 0;
      case 4:
        // Every started guest row must be complete + valid, and nobody invited twice.
        return this.guests().every(
          (g, i) =>
            ((g.name.trim() === '' && g.email.trim() === '') ||
              (g.name.trim() !== '' && this.emailValid(g.email))) &&
            !this.guestError(i).name &&
            !this.guestError(i).email,
        );
      case 5:
        return !this.docsBusy(); // wait for files still uploading
      default:
        return true;
    }
  });

  protected next(): void {
    if (this.step() < 7) this.step.update((s) => s + 1);
  }

  /** Summary → payment, once the price is known (a follow-up's is quoted per slot). */
  protected toPayment(): void {
    if (this.priceReady()) this.next();
  }

  protected back(): void {
    if (this.step() > 1) this.step.update((s) => s - 1);
  }

  // ----- Supporting documents -----

  /** Queue what a drop or pick produced (turning away what we can't take) and start uploading. */
  protected addAttachments(files: File[]): void {
    const current = this.attachments();
    const added: Attachment[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files) {
      const err = this.validateDocument(file);
      const dup = [...current, ...added].some(
        (a) =>
          a.file.name === file.name &&
          a.file.size === file.size &&
          a.file.lastModified === file.lastModified,
      );
      if (err) skipped.push({ name: file.name, reason: err });
      else if (dup) skipped.push({ name: file.name, reason: 'Already attached.' });
      else if (current.length + added.length >= MAX_DOCS) {
        skipped.push({ name: file.name, reason: `You can attach up to ${MAX_DOCS} files to a booking.` });
      } else {
        added.push({ key: this.nextDocKey++, file, status: 'queued', progress: 0, error: '', doc: null });
      }
    }
    if (added.length > 0) this.attachments.set([...current, ...added]);
    this.skip(skipped);
    // A full list hides the drop zone that was just used.
    if (this.attachments().length >= MAX_DOCS) this.keepDocsFocus();
    this.uploadNext();
  }

  /** Files the drop zone already turned away on type or size. */
  protected onAttachmentsRejected(rejections: FileDropRejection[]): void {
    this.skip(
      rejections.map((r) => ({ name: r.file.name, reason: r.reason === 'size' ? DOC_TOO_BIG : DOC_UNSUPPORTED })),
    );
  }

  protected dismissSkipped(): void {
    this.skipped.set([]);
    this.keepDocsFocus();
  }

  /**
   * Take a file off this booking. An upload still running is cancelled; one
   * that finished stays in the patient's medical documents (there is no
   * delete), it just won't be attached.
   */
  protected removeAttachment(key: number): void {
    this.uploads.get(key)?.unsubscribe();
    this.uploads.delete(key);
    this.attachments.update((list) => list.filter((a) => a.key !== key));
    this.keepDocsFocus(); // the Remove button went with its row
    this.uploadNext();
  }

  protected retryAttachment(key: number): void {
    this.patchAttachment(key, { status: 'queued', progress: 0, error: '' });
    this.keepDocsFocus(); // the row's Retry button is gone
    this.uploadNext();
  }

  /**
   * Upload the next waiting file. The API takes one file per request, so they
   * go one at a time — each with its own progress and outcome — and a failure
   * never stops the rest.
   */
  private uploadNext(): void {
    if (this.attachments().some((a) => a.status === 'uploading')) return;
    const next = this.attachments().find((a) => a.status === 'queued');
    if (!next) return;
    this.patchAttachment(next.key, { status: 'uploading', progress: 0, error: '' });

    const sub = this.appointments
      .uploadDocument(next.file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.patchAttachment(next.key, { progress: Math.round((event.loaded / event.total) * 100) });
          } else if (event.type === HttpEventType.Response) {
            const doc = event.body?.data ?? null;
            this.uploads.delete(next.key);
            // Only a filed document (it has an id) is attached. An older API
            // answers with just a public URL — that file can't be attached by
            // id, so it must never read as "Attached".
            this.patchAttachment(
              next.key,
              doc?.id
                ? { status: 'done', progress: 100, doc }
                : { status: 'failed', error: 'Upload failed. Please try again.' },
            );
            this.uploadNext();
          }
        },
        error: (err: unknown) => {
          this.uploads.delete(next.key);
          this.patchAttachment(next.key, {
            status: 'failed',
            error: apiErrorMessage(err, 'Upload failed. Please try again.'),
          });
          this.uploadNext();
        },
      });
    this.uploads.set(next.key, sub);
  }

  private patchAttachment(key: number, changes: Partial<Attachment>): void {
    this.attachments.update((list) => list.map((a) => (a.key === key ? { ...a, ...changes } : a)));
  }

  private skip(list: SkippedFile[]): void {
    if (list.length === 0) return;
    this.skipped.update((prev) => [
      ...prev.filter((p) => !list.some((s) => s.name === p.name && s.reason === p.reason)),
      ...list,
    ]);
  }

  private validateDocument(f: File): string | null {
    if (f.size > DOC_MAX_BYTES) return DOC_TOO_BIG;
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!DOC_EXT.includes(ext)) return DOC_UNSUPPORTED;
    if (f.size === 0) return 'This file is empty.';
    return null;
  }

  /**
   * After the next render, if the control that had focus was removed (focus
   * fell back to <body>), put it on the step's heading instead of losing it.
   */
  private keepDocsFocus(): void {
    afterNextRender(
      () => {
        const active = this.document.activeElement;
        if (active && active !== this.document.body && active.isConnected) return;
        this.docsTitle()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected attachStatus(status: AttachStatus): { label: string; icon: string; cls: string } {
    return ATTACH_STATUS[status];
  }

  protected sizeLabel(bytes: number): string {
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '')}MB`
      : `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  protected async confirm(paymentReference?: string): Promise<void> {
    if (this.doctorGone()) return;
    if (!this.selectedTime()) {
      this.step.set(1);
      return;
    }
    if (!this.priceReady()) return;
    this.submitting.set(true);
    this.submitError.set('');
    try {
      const guests = this.validGuests().map((g) => ({
        name: g.name.trim(),
        email: g.email.trim(),
      }));
      const documentIds = this.attachedIds();
      await firstValueFrom(
        this.appointments.book({
          specialist_id: this.doctorId(),
          scheduled_at: this.selectedTime(),
          type: 'video',
          notes: this.reason().trim() || undefined,
          document_ids: documentIds.length > 0 ? documentIds : undefined,
          guests: guests.length > 0 ? guests : undefined,
          payment_reference: paymentReference,
          // A follow-up: linked to the consultation and priced as one by the server.
          parent_appointment_id: this.parent()?.id,
        }),
      );
      this.booked = true;
      this.forgetPendingCard();
      await this.router.navigate(['/dashboard/appointments'], {
        queryParams: { booked: '1' },
      });
    } catch (err) {
      const fields = apiErrorFields(err);
      // The card payment can't book this (the time, the doctor or the
      // follow-up went) and the API has put it in the wallet: say so, and
      // book from the wallet from here.
      if (paymentReference && fields['card_payment'] === 'credited_to_wallet') {
        this.cardCreditedToWallet(apiErrorMessage(err, 'Your card payment has been added to your VideoMed wallet.'));
        if (fields['scheduled_at']) this.timeRefused(fields['scheduled_at']);
        else if (fields['specialist_id'])
          this.recheckDoctor(() => {
            if (this.parent()) this.dropParent();
          });
        else if (this.parent() && fields['parent_appointment_id']) this.dropParent();
        return;
      }
      // Backstop: the server rejects an underfunded wallet with a 422 flag —
      // flip the balance to a known-short state so the top-up CTA shows.
      // (`wallet: insufficient_funds` is a flag, so it gets words of its own.)
      if (fields['wallet'] === 'insufficient_funds') {
        this.walletBalance.set(Math.max(0, this.amount() - 1));
        this.walletLoaded.set(true);
        this.walletError.set('');
        this.submitError.set(
          'Your wallet balance is too low to book this consultation. Pay by card, or top up your wallet and try again.',
        );
        return;
      }
      // The time was taken meanwhile (or is past the booking window): back to
      // the calendar, refreshed, saying so. Nothing was charged for it — a card
      // payment made for this booking is kept for the new time.
      if (fields['scheduled_at']) {
        this.timeRefused(fields['scheduled_at']);
        return;
      }
      // The server won't take the kept card payment (it doesn't cover the
      // price, or was used already): stop retrying on it, and say what to do.
      // A verification hiccup ("… Please try again.") keeps it for a retry.
      const kept = this.paid();
      const refused = fields['payment'] ?? '';
      if (paymentReference && kept?.reference === paymentReference && refused && !/try again/i.test(refused)) {
        this.paid.set(null);
        this.forgetPendingCard();
        // "Already in your wallet" is said as is; "already used" most likely
        // means this booking went through before the page lost the answer;
        // anything else says where the money goes.
        this.unusedPayment.set(
          /wallet/i.test(refused)
            ? refused
            : /already been used/i.test(refused)
              ? 'This card payment has already been used for a booking — check My appointments before paying again.'
              : this.unusedPaymentNote(kept, refused),
        );
        return;
      }
      // A guest the server refused (the patient's own email, the doctor's, …):
      // back to the guests step, with the reason on that row — not left behind
      // on the confirm step once the row is fixed.
      if (this.takeGuestErrors(fields)) {
        this.submitError.set('');
        this.step.set(4);
        return;
      }
      this.submitError.set(
        apiErrorMessage(err, 'Could not complete your booking. Please try again.'),
      );
      if (fields['specialist_id']) {
        // The doctor stopped taking bookings — or, still listed, this just
        // can't be a follow-up of theirs: whether they are still listed tells.
        this.recheckDoctor(() => {
          if (this.parent()) this.dropParent();
        });
      } else if (this.parent() && fields['parent_appointment_id']) {
        // The consultation can no longer be followed up: the price is the usual
        // fee now, so the patient confirms again at that price.
        this.dropParent();
      }
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Pay the consultation fee directly by card (Paystack pop-up) then book — no
   * wallet top-up required, and the wizard's details are preserved throughout.
   */
  protected async payWithCard(): Promise<void> {
    if (this.funding() || this.submitting() || this.doctorGone()) return;
    if (!this.selectedTime()) {
      this.step.set(1);
      return;
    }
    if (!this.priceReady()) return;
    // Already paid, but the booking was refused (a slot taken, an attachment
    // the server turned down): book again on the same, still unused, payment.
    if (this.paidReference()) {
      void this.confirm(this.paidReference());
      return;
    }
    this.funding.set(true);
    this.fundError.set('');
    this.submitError.set('');
    try {
      // A follow-up is charged its follow-up price for this slot.
      const parent = this.parent();
      const init = await firstValueFrom(
        this.appointments.payInit(
          this.doctorId(),
          this.validGuests().length,
          parent ? { parent_appointment_id: parent.id, scheduled_at: this.selectedTime() } : undefined,
        ),
      );
      const Pop = await loadPaystack();
      const popup = new Pop();
      // Kept for this tab before the pop-up opens: if the page is reloaded or
      // the connection drops after paying, the booking can still complete on it.
      this.rememberPendingCard({
        reference: init.data.reference,
        specialistId: this.doctorId(),
        slot: this.selectedTime(),
        amount: Number(init.data.amount),
        parentId: parent?.id ?? '',
        savedAt: Date.now(),
      });
      popup.resumeTransaction(init.data.access_code, {
        onSuccess: () => {
          this.funding.set(false);
          // An earlier payment this one replaces was never used.
          const earlier = this.paid();
          if (earlier) this.unusedPayment.set(this.unusedPaymentNote(earlier));
          this.paid.set({ reference: init.data.reference, amount: Number(init.data.amount) });
          void this.confirm(init.data.reference);
        },
        onCancel: () => {
          this.funding.set(false);
          this.forgetPendingCard();
          this.fundError.set('Payment cancelled. Your booking details are saved — try again when ready.');
        },
        onError: () => {
          this.funding.set(false);
          this.forgetPendingCard();
          this.fundError.set('The payment could not be completed. Please try again.');
        },
      });
    } catch (err) {
      if (apiErrorFields(err)['payment'] === 'free') {
        // The server says there's nothing to pay (the fee changed since this
        // page loaded): reprice, and this step becomes the free "Confirm
        // booking" one. `payment: free` is a flag, never shown as a message.
        await this.refreshPricing();
        this.funding.set(false);
        if (!this.isFree()) {
          this.fundError.set('This consultation is now free — no payment is needed. Reload the page to book it.');
        }
        return;
      }
      const fields = apiErrorFields(err);
      if (fields['scheduled_at']) {
        // The time went before paying: nothing was charged.
        this.funding.set(false);
        this.timeRefused(fields['scheduled_at']);
        return;
      }
      if (this.parent() && (fields['parent_appointment_id'] || fields['specialist_id'])) {
        // Not a follow-up after all: it is the usual fee now, shown before paying again.
        this.funding.set(false);
        this.dropParent();
        this.fundError.set(apiErrorMessage(err, 'This booking can no longer be a follow-up.'));
        return;
      }
      this.funding.set(false);
      this.fundError.set(apiErrorMessage(err, 'Could not start the card payment. Please try again.'));
      // "Not currently available": the doctor stopped taking bookings.
      if (fields['specialist_id']) this.recheckDoctor();
    }
  }

  /**
   * What to tell the patient about a card payment no booking used. Without a
   * server reason, the payment is one Paystack reported paid (its pop-up's
   * success, or the server confirmed it) — an unused one reaches the wallet
   * automatically. With one, only the server says where the money goes: its
   * reason does when it knows the payment was made ("…added to your VideoMed
   * wallet automatically…", or "contact support"); otherwise (not completed,
   * not found, not this patient's…) no wallet credit is promised — nothing
   * may have been charged at all.
   */
  private unusedPaymentNote(p: { reference: string; amount: number }, reason = ''): string {
    const paidNote =
      `Your earlier card payment of ${this.fmt(p.amount)} (reference ${p.reference}) couldn't be used for this booking` +
      ` — it will be added to your VideoMed wallet automatically within about ${AUTO_CREDIT_MINUTES} minutes.`;
    if (!reason) return `${paidNote} You can still book by paying again or from your wallet.`;
    const said = /wallet automatically|contact support/i.test(reason);
    return (
      `${reason.replace(/\.?$/, '.')} ` +
      (said ? '' : `If your card was charged for reference ${p.reference}, contact support with that reference. `) +
      'You can still book by paying again or from your wallet.'
    );
  }

  /** Reload the specialist's fee, the guest pricing and a follow-up's quote (best effort). */
  private async refreshPricing(): Promise<void> {
    try {
      const parent = this.parent();
      const iso = this.selectedTime();
      const [specialist, pricing, quote] = await Promise.all([
        firstValueFrom(this.specialistsApi.getPublic(this.doctorId())),
        firstValueFrom(this.specialistsApi.pricing()),
        parent && iso ? firstValueFrom(this.appointments.followUpQuote(parent.id, iso)) : Promise.resolve(null),
      ]);
      this.specialist.set(specialist.data);
      this.pricing.set(pricing.data);
      if (quote && parent === this.parent() && iso === this.selectedTime()) this.quote.set({ iso, data: quote.data });
    } catch {
      // Keep the prices we have; the caller explains what to do.
    }
  }

  /**
   * Fund the wallet inline (Paystack pop-up) then book — all without leaving the
   * booking wizard, so the chosen slot, reason, guests and document survive.
   */
  protected async topUpAndBook(): Promise<void> {
    if (this.funding()) return;
    const amount = this.topUpValue();
    if (amount < this.walletShortfall()) {
      this.fundError.set(`Add at least ${this.fmt(this.walletShortfall())} to cover this booking.`);
      return;
    }
    this.funding.set(true);
    this.fundError.set('');
    try {
      const currency = this.pricing()?.currency ?? 'NGN';
      const init = await firstValueFrom(this.wallet.fund(String(amount), currency));
      const Pop = await loadPaystack();
      const popup = new Pop();
      popup.resumeTransaction(init.data.access_code, {
        onSuccess: () => void this.afterFunding(init.data.reference),
        onCancel: () => {
          this.funding.set(false);
          this.fundError.set('Payment cancelled. Your booking details are saved — try again when ready.');
        },
        onError: () => {
          this.funding.set(false);
          this.fundError.set('The payment could not be completed. Please try again.');
        },
      });
    } catch (err) {
      this.funding.set(false);
      this.fundError.set(apiErrorMessage(err, 'Could not start the top-up. Please try again.'));
    }
  }

  /** Verify the top-up, refresh the balance, then book if now covered. */
  private async afterFunding(reference: string): Promise<void> {
    try {
      await firstValueFrom(this.wallet.verify(reference));
      const res = await firstValueFrom(this.wallet.wallet());
      this.walletBalance.set(Number(res.data.balance));
      this.walletLoaded.set(true);
      this.walletError.set('');
      this.topUpAmount.set('');
      if (this.walletSufficient()) {
        this.funding.set(false);
        await this.confirm();
      } else {
        this.funding.set(false);
        this.fundError.set('Your wallet was funded but is still short for this booking. Add a little more.');
      }
    } catch (err) {
      this.funding.set(false);
      this.fundError.set(
        apiErrorMessage(
          err,
          'We could not confirm the payment yet. If you were charged, your wallet will update shortly.',
        ),
      );
    }
  }

  /**
   * `unsavedChangesGuard`: leaving before the booking is made asks first when
   * something would be left behind — a card payment no booking has used yet
   * (or one still going through), files still uploading, or documents
   * uploaded for this booking.
   */
  hasUnsavedChanges(): boolean {
    if (this.booked) return false;
    return !!this.paid() || this.funding() || this.docsBusy() || this.attachedIds().length > 0;
  }

  /** The guard's prompt copy — what leaving would leave behind. */
  readonly leaveCopy = (): LeaveCopy => {
    const paid = this.paid();
    if (paid) {
      return {
        tone: 'warning',
        icon: 'credit-card',
        title: 'Leave without booking?',
        message:
          `Your card payment of ${this.fmt(paid.amount)} hasn't been used for a booking yet. ` +
          `If you leave now, it will be added to your VideoMed wallet automatically within about ${AUTO_CREDIT_MINUTES} minutes.`,
        details: [
          { label: 'Card payment', value: this.fmt(paid.amount) },
          { label: 'Reference', value: paid.reference },
        ],
        confirmLabel: 'Leave without booking',
        cancelLabel: 'Stay and book',
      };
    }
    if (this.funding()) {
      return {
        tone: 'warning',
        icon: 'credit-card',
        title: 'Leave while paying?',
        message: "If the payment still goes through, it won't be used for a booking.",
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay',
      };
    }
    if (this.docsBusy()) {
      return {
        tone: 'warning',
        icon: 'upload',
        title: 'Leave while uploading?',
        message: "Files that haven't finished uploading won't be saved, and nothing has been booked yet.",
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay',
      };
    }
    const n = this.attachedIds().length;
    return {
      tone: 'warning',
      icon: 'calendar-x',
      title: 'Leave without booking?',
      message:
        'Nothing has been booked yet. ' +
        (n === 1
          ? 'The document you uploaded stays in your medical documents.'
          : `The ${n} documents you uploaded stay in your medical documents.`),
      confirmLabel: 'Leave without booking',
      cancelLabel: 'Keep booking',
    };
  };
}
