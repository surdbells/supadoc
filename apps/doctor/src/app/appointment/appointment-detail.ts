import { NgTemplateOutlet } from '@angular/common';
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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { type Observable, tap } from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  AvailabilityCalendarStore,
  DoctorApi,
  injectCallPresence,
  nowLocalInput,
  openBlobDocument,
  openClinicalDocument,
  todayLocal,
} from '@supadoc/data-access';
import type {
  AppointmentDto,
  CarePlanDto,
  ClinicalDocumentKind,
  ClinicalNoteDto,
  ConsentDto,
  CopilotDraftDto,
  DoctorAppointmentDto,
  DoctorPatientRecordDto,
  DoctorRecordingStateDto,
  LabOrderDto,
  MedicalCertificateDto,
  MedicalDocumentDto,
  MessageDto,
  RecordingFileDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
} from '@supadoc/models';
import {
  AlertComponent,
  BookingCalendarComponent,
  CallPresenceComponent,
  IconComponent,
  MessageThreadComponent,
  shortDayLabel,
} from '@supadoc/ui';
import { MedicationItem, VisitStatusBadge } from '../patients/patient-record-ui';
import { RxPanel } from '../prescriptions/rx-panel';
import { ClinicalAi } from './clinical/clinical-ai';
import { ClinicalCarePlan } from './clinical/clinical-care-plan';
import { CERTIFICATE_BACKDATE_DAYS, ClinicalCertificates } from './clinical/clinical-certificates';
import { ClinicalConsents } from './clinical/clinical-consents';
import { ClinicalLabs } from './clinical/clinical-labs';
import { ClinicalNote, type NoteSaveMode } from './clinical/clinical-note';
import { ClinicalRecording } from './clinical/clinical-recording';
import { ClinicalReferrals } from './clinical/clinical-referrals';
import { ClinicalBadge, ClinicalHeader } from './clinical/clinical-ui';
import { FollowUpPlanner } from './follow-up-planner';
import {
  doctorStatusLabel,
  followUpPriceLabel,
  followUpState,
  type FollowUpState,
  IN_CALL_LEAD_MINUTES,
  isClosedProposal,
  isOpenProposal,
  whenLabel,
  withdrewProposal,
} from './follow-ups';

type PrimaryTab = 'overview' | 'history' | 'documents' | 'visits' | 'clinical';

type TabKey =
  | 'notes'
  | 'messages'
  | 'prescriptions'
  | 'labs'
  | 'care'
  | 'followups'
  | 'referrals'
  | 'certificates'
  | 'consents'
  | 'recording'
  | 'ai';

interface Tab {
  readonly key: TabKey;
  readonly label: string;
  readonly icon: string;
}

const TABS: Tab[] = [
  { key: 'notes', label: 'Clinical note', icon: 'file-text' },
  { key: 'messages', label: 'Messages', icon: 'message-square' },
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab orders', icon: 'clipboard-list' },
  { key: 'care', label: 'Care plan', icon: 'list-checks' },
  { key: 'followups', label: 'Follow-ups', icon: 'calendar-plus' },
  { key: 'referrals', label: 'Referrals', icon: 'share-2' },
  { key: 'certificates', label: 'Certificates', icon: 'id-card' },
  { key: 'consents', label: 'Consents', icon: 'shield-check' },
  { key: 'recording', label: 'Recording', icon: 'circle-play' },
  { key: 'ai', label: 'Transcript & AI', icon: 'sparkles' },
];

/** A Clinical tools sub-tab button: the primary tabs' pill, stacked into a rail on desktop. */
const SUB_TAB =
  'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 lg:rounded-field lg:py-2.5';

/** Time until a start, e.g. short "9d 4h 38m" / long "Starts in 9 days, 4 hours and 38 minutes". */
interface TimeLeft {
  short: string;
  long: string;
}

/** Days, hours and minutes left (`ms` from now), or null once under a minute. */
function timeLeft(ms: number): TimeLeft | null {
  const total = Math.floor(ms / 60000);
  if (total < 1) return null;
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const short = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const words = [
    d > 0 ? unit(d, 'day') : '',
    h > 0 ? unit(h, 'hour') : '',
    m > 0 ? unit(m, 'minute') : '',
  ].filter(Boolean);
  const long = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
  return { short, long: `Starts in ${long}` };
}

/**
 * A consultation's Schedule Details (route `/appointments/:id`) — the design's
 * pre-consultation patient briefing (Overview / Medical History / Documents /
 * Past Visits) plus a "Clinical tools" tab that preserves all out-of-call
 * authoring (notes, prescriptions, labs, referrals, certificates, recording, AI).
 * Each Clinical tools sub-tab is a presentational child in `./clinical/`; this
 * component keeps all of their state, loading and API calls.
 */
@Component({
  selector: 'doc-appointment-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The reschedule calendar's data (the follow-up planner has its own).
  providers: [AvailabilityCalendarStore],
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AlertComponent,
    BookingCalendarComponent,
    CallPresenceComponent,
    IconComponent,
    MessageThreadComponent,
    RxPanel,
    ClinicalAi,
    ClinicalBadge,
    ClinicalCarePlan,
    ClinicalCertificates,
    ClinicalConsents,
    ClinicalHeader,
    ClinicalLabs,
    ClinicalNote,
    ClinicalRecording,
    ClinicalReferrals,
    FollowUpPlanner,
    MedicationItem,
    VisitStatusBadge,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-center justify-between">
        <h1 class="font-heading text-h3 text-ink">Schedule Details</h1>
        <a [routerLink]="backLink()" class="flex min-h-11 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" /> Back
        </a>
      </div>

      @if (apptError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="calendar-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ apptError() }}</p>
        </div>
      } @else if (appt(); as a) {
        <!-- Summary + Quick actions -->
        <section class="grid gap-6 rounded-card border border-cloud bg-white p-6 lg:grid-cols-[1fr_auto]">
          <div class="flex flex-col gap-4">
            <div class="flex items-start gap-4">
              <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-lg font-semibold text-cerulean">{{ initialsFor(a.patient_name) }}</span>
              <div class="flex flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2.5">
                  <span class="font-heading text-h4 text-cerulean">{{ a.patient_name }}</span>
                  <doc-visit-status-badge [status]="a.status" [label]="statusLabel(a)" />
                  <sd-call-presence [presence]="presence()[a.id]" viewer="doctor" size="md" />
                </div>
                @if (age() !== null) { <span class="font-sans text-body-sm text-slate">{{ age() }} years</span> }
              </div>
            </div>

            <div class="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(a.scheduled_at) }}</span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="video" [size]="16" class="text-slate" />{{ a.type_label }}</span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(a.scheduled_at) }}</span>
              @if (patientRecord()?.patient?.phone) {
                <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="phone" [size]="16" class="text-slate" />{{ patientRecord()?.patient?.phone }}</span>
              }
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <span class="font-sans text-body-sm text-slate">Fee: <span class="font-semibold text-ink">{{ a.follow_up_pricing ? followUpPrice(a) : money(a.amount) }}</span></span>
              @if (a.status === 'proposed') {
                <!-- Nothing is charged until the patient accepts. -->
                <span class="inline-flex items-center gap-1 rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-semibold text-slate"><sd-icon name="hourglass" [size]="13" />{{ isFree(a.amount) ? 'Nothing to pay' : 'Paid when accepted' }}</span>
              } @else if (a.payment_status === 'paid') {
                <span class="inline-flex items-center gap-1 rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-sage"><sd-icon name="circle-check" [size]="13" />Paid</span>
              } @else if (!(a.status === 'cancelled' && a.proposed_by === 'doctor')) {
                <!-- (A proposal that closed was never owed anything.) -->
                <span class="inline-flex items-center gap-1 rounded-pill bg-warning/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-ink"><sd-icon name="circle-alert" [size]="13" />Unpaid</span>
              }
            </div>

            <!-- This consultation is a follow-up: where it came from, and how the proposal stands. -->
            @if (a.parent; as parent) {
              @let fu = followUp(a);
              <div class="flex flex-col gap-2 rounded-field border border-cloud bg-glacier px-4 py-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <a [routerLink]="['/appointments', parent.id]" class="inline-flex min-h-11 items-center gap-1.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40">
                    <sd-icon name="history" [size]="16" />Follow-up of the {{ shortDate(parent.scheduled_at) }} consultation<sd-icon name="chevron-right" [size]="16" />
                  </a>
                  <doc-clinical-badge [tone]="fu.tone" [icon]="fu.icon" [label]="fu.label" />
                </div>
                <p class="font-sans text-caption text-slate">{{ followUpOrigin(a) }}</p>
                @if (a.follow_up_note) {
                  <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink"><span class="font-semibold text-slate">Your note to the patient:</span> {{ a.follow_up_note }}</p>
                }
                @if (a.decline_reason) {
                  <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink"><span class="font-semibold text-slate">Patient's reason for declining:</span> {{ a.decline_reason }}</p>
                }
              </div>
            }

            <!-- People the patient invited to the call: names only (their emails stay with the patient). -->
            @if (a.guests?.length) {
              <div class="flex flex-col gap-2 border-t border-cloud pt-3">
                <span class="font-sans text-caption text-slate">Guests joining the call ({{ a.guests.length }}):</span>
                <ul class="flex flex-wrap gap-2">
                  @for (g of a.guests; track g.id ?? $index) {
                    <li class="inline-flex max-w-full items-center gap-1.5 rounded-pill bg-glacier px-3 py-1 font-sans text-caption font-medium text-ink">
                      <sd-icon name="user-round" [size]="13" class="shrink-0 text-slate" />
                      <span class="truncate">{{ g.name }}</span>
                      @if (guestInCall(a.id, g.id)) {
                        <span class="inline-flex shrink-0 items-center gap-1 font-semibold text-success">
                          <span class="size-1.5 rounded-full bg-success" aria-hidden="true"></span>In the call
                        </span>
                      }
                    </li>
                  }
                </ul>
                <span class="font-sans text-caption text-slate">Guests see and hear the call only — never the patient's record.</span>
              </div>
            }

            @if (a.notes) {
              <div class="flex flex-col gap-1 border-t border-cloud pt-3">
                <span class="font-sans text-caption text-slate">Reason for Consultation:</span>
                <span class="font-sans text-body-sm text-ink">{{ a.notes }}</span>
              </div>
            }
          </div>

          <div class="flex w-full min-w-0 flex-col gap-3 lg:w-64">
            <span class="font-heading text-body-lg text-ink">Quick actions</span>
            @if (a.status === 'proposed') {
              <!-- A proposal is not a booking: no call until the patient accepts. -->
              <p class="flex items-start gap-2 rounded-field bg-warning/15 px-3 py-2 font-sans text-caption text-ink">
                <sd-icon name="hourglass" [size]="16" class="mt-0.5 shrink-0" />
                @if (proposalOpen()) {
                  <span>Awaiting the patient's reply — it closes {{ when(a.expires_at) }}. There is no call until they accept.</span>
                } @else {
                  <span>This proposal closed without a reply, and the time is open again.</span>
                }
              </p>
              @if (proposalOpen()) {
                @if (!withdrawAsk()) {
                  <button #withdrawButton type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-field border border-alert/50 px-5 py-3 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="actionBusy()" (click)="askWithdraw()">
                    <sd-icon name="undo-2" [size]="18" />Withdraw proposal
                  </button>
                } @else {
                  <div class="flex flex-col gap-3 rounded-field border border-cloud p-3" role="group" aria-labelledby="withdraw-ask-title" aria-describedby="withdraw-ask-desc" (keydown.escape)="cancelWithdraw()">
                    <p #withdrawTitle id="withdraw-ask-title" tabindex="-1" class="font-sans text-body-sm font-semibold text-ink outline-none">Withdraw this proposal?</p>
                    <p id="withdraw-ask-desc" class="font-sans text-caption text-slate">The patient is told it was withdrawn, and the time opens again on your schedule.</p>
                    <div class="flex flex-wrap gap-2">
                      <button type="button" class="min-h-11 flex-1 rounded-field bg-alert px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-alert/90 disabled:opacity-60" [disabled]="actionBusy()" (click)="withdrawProposal()">{{ actionBusy() ? 'Withdrawing…' : 'Withdraw' }}</button>
                      <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-slate transition-colors hover:border-cerulean hover:text-cerulean disabled:opacity-60" [disabled]="actionBusy()" (click)="cancelWithdraw()">Keep it</button>
                    </div>
                  </div>
                }
              }
            } @else if (a.status === 'pending' || a.status === 'rescheduled') {
              <button type="button" class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="actionBusy()" (click)="confirm()">
                <sd-icon name="circle-check" [size]="18" />{{ actionBusy() ? 'Working…' : 'Confirm appointment' }}
              </button>
            } @else if (closedProposal()) {
              <!-- Declined, withdrawn or expired: it never became a consultation, so there is no call to show. -->
              <p class="flex items-start gap-2 rounded-field bg-cloud px-3 py-2 font-sans text-caption text-ink">
                <sd-icon name="calendar-off" [size]="16" class="mt-0.5 shrink-0 text-slate" />
                <span>{{ closedProposalText(a) }}</span>
              </p>
            } @else {
              <button type="button" class="flex items-center justify-center gap-2 rounded-field px-5 py-3 font-sans text-body-sm font-semibold transition-colors"
                [class]="joinState().enabled ? 'bg-cerulean text-white hover:bg-ocean' : 'bg-cerulean/40 text-white cursor-not-allowed'"
                [disabled]="!joinState().enabled" [attr.title]="joinState().startsIn?.long ?? null" (click)="join(a)">
                <sd-icon name="video" [size]="18" class="shrink-0" />
                @if (joinState().startsIn; as left) {
                  <span class="flex flex-col items-start leading-tight">
                    <span>{{ joinState().label }}</span>
                    <span class="font-sans text-caption font-normal text-white/85">Starts in {{ left.short }}</span>
                  </span>
                } @else {
                  {{ joinState().label }}
                }
              </button>
              @if (joinState().enabled && patientWaiting()) {
                <p class="rounded-field bg-success/10 px-3 py-2 text-center font-sans text-caption font-semibold text-success" role="status">The patient is waiting in the call</p>
              }
              @if (a.join_blocked; as blocked) {
                <p class="flex flex-col gap-1 rounded-field bg-warning/15 px-3 py-2 font-sans text-caption text-ink" role="status">
                  <span class="flex items-start gap-1.5"><sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />{{ blocked.message }}</span>
                  <a [routerLink]="blocked.code === 'terms_required' ? '/onboarding/terms' : '/account-status'" class="inline-flex min-h-11 items-center gap-1 font-semibold text-cerulean hover:text-ocean">
                    {{ blocked.code === 'terms_required' ? 'Read and accept the terms' : 'See your account status' }}<sd-icon name="chevron-right" [size]="14" />
                  </a>
                </p>
              }
            }
            <!-- A visit that ended without End in the call: close it here (asks first). -->
            @if (canComplete()) {
              @if (!completeAsk()) {
                <button #completeButton type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-field border border-sage px-5 py-3 font-sans text-body-sm font-semibold text-sage transition-colors hover:bg-sage/5 disabled:opacity-60" [disabled]="actionBusy()" (click)="askComplete()">
                  <sd-icon name="circle-check" [size]="18" />Mark consultation completed
                </button>
              } @else {
                <div class="flex flex-col gap-3 rounded-field border border-cloud p-3" role="group" aria-labelledby="complete-ask-title" aria-describedby="complete-ask-desc">
                  <p #completeTitle id="complete-ask-title" tabindex="-1" class="font-sans text-body-sm font-semibold text-ink outline-none">Mark this consultation completed?</p>
                  <p id="complete-ask-desc" class="font-sans text-caption text-slate">It moves to your history and the patient is told the consultation has ended. You can still finish the note and prescriptions here.</p>
                  <div class="flex flex-wrap gap-2">
                    <button type="button" class="min-h-11 flex-1 rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="actionBusy()" (click)="complete()">{{ actionBusy() ? 'Saving…' : 'Mark completed' }}</button>
                    <button type="button" class="min-h-11 flex-1 rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-slate transition-colors hover:border-cerulean hover:text-cerulean disabled:opacity-60" [disabled]="actionBusy()" (click)="cancelComplete()">Not yet</button>
                  </div>
                </div>
              }
            }
            @if (completedNotice()) {
              <p #completedNote tabindex="-1" class="flex items-center gap-2 rounded-field bg-sage/10 px-3 py-2 font-sans text-caption font-semibold text-sage outline-none" role="status">
                <sd-icon name="circle-check" [size]="16" class="shrink-0" />Consultation completed — it's now in your history.
              </p>
            }
            @if (withdrawNotice(); as n) {
              <p #withdrawnNote tabindex="-1" class="flex items-center gap-2 rounded-field px-3 py-2 font-sans text-caption font-semibold outline-none" role="status"
                [class]="n.tone === 'success' ? 'bg-sage/10 text-sage' : 'bg-frost/50 text-cerulean'">
                <sd-icon [name]="n.tone === 'success' ? 'circle-check' : 'info'" [size]="16" class="shrink-0" />{{ n.text }}
              </p>
            }
            <!-- In progress or completed: offer the patient a follow-up (Clinical tools → Follow-ups). -->
            @if (canFollowUp()) {
              <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-field border border-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30" (click)="openFollowUps()">
                <sd-icon name="calendar-plus" [size]="18" />Schedule follow-up
              </button>
            }
            <div class="flex gap-3">
              @if (canReschedule(a.status)) {
                <button #rescheduleButton type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border px-4 py-2.5 font-sans text-body-sm font-semibold transition-colors hover:border-cerulean hover:text-cerulean"
                  [class]="rescheduleOpen() ? 'border-cerulean bg-frost/40 text-cerulean' : 'border-cloud text-slate'"
                  [attr.aria-expanded]="rescheduleOpen()" aria-controls="reschedule-panel" (click)="toggleReschedule()">
                  <sd-icon name="refresh-cw" [size]="16" />Reschedule
                </button>
              }
              @if (canCancel(a.status)) {
                <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border border-alert/50 px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="actionBusy()" (click)="decline()">
                  <sd-icon name="ban" [size]="16" />Cancel
                </button>
              }
            </div>
            @if (actionError() && !rescheduleOpen()) { <p #actionErrorEl tabindex="-1" role="alert" class="rounded-field bg-alert/10 px-3 py-2 font-label text-caption text-alert outline-none">{{ actionError() }}</p> }
          </div>

          <!-- Reschedule: the doctor's own calendar (the times a patient could book), full width under the summary. -->
          @if (rescheduleOpen()) {
            <div id="reschedule-panel" class="flex min-w-0 flex-col gap-4 border-t border-cloud pt-6 lg:col-span-2" role="group" aria-labelledby="reschedule-title">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 #rescheduleTitle id="reschedule-title" tabindex="-1" class="font-heading text-body-lg text-ink outline-none">Choose a new time</h2>
                  <p class="font-sans text-caption text-slate">
                    @if (rescheduleUseManual()) {
                      Type a time that is on your availability, no sooner than patients can book (usually an hour ahead).
                    } @else {
                      Your open times (your lead time, blocks and bookings applied).
                    }
                  </p>
                </div>
                <button type="button" class="flex min-h-11 items-center gap-1 rounded-field px-3 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" (click)="toggleReschedule()">
                  <sd-icon name="x" [size]="16" />Close
                </button>
              </div>

              @if (!rescheduleUseManual()) {
                @if (cal.error(); as calError) {
                  <!-- A day's times (or another month) didn't load: the calendar stays, with a retry. -->
                  <p class="flex flex-wrap items-center gap-x-2 font-sans text-caption text-alert" role="alert">
                    <span class="flex items-start gap-1.5"><sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ calError }}</span>
                    <button type="button" class="inline-flex min-h-11 items-center font-semibold text-cerulean transition-colors hover:text-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" (click)="cal.refresh()">Try again</button>
                  </p>
                }
                <sd-booking-calendar
                  [days]="cal.days()"
                  [month]="cal.month()"
                  (monthChange)="cal.setMonth($event)"
                  [selectedDate]="cal.selectedDate()"
                  (selectedDateChange)="cal.selectDate($event)"
                  [slots]="cal.slots()"
                  [(value)]="rescheduleSlot"
                  [loading]="cal.loading()"
                  [slotsLoading]="cal.slotsLoading()"
                  [min]="cal.min()"
                  [max]="cal.max()"
                  [nextAvailable]="cal.nextAvailable()"
                  [timeZone]="cal.tz()"
                  [timeZoneLabel]="cal.timeZoneLabel()"
                  [weekStartsOn]="cal.weekStartsOn()"
                  [disabled]="actionBusy()"
                >
                  <p calendarEmpty class="font-sans text-caption text-slate">
                    Need a time that isn't open here?
                    <button type="button" class="inline-flex min-h-11 items-center font-semibold text-cerulean hover:text-ocean" (click)="setRescheduleManual(true)">Enter another time</button>
                  </p>
                </sd-booking-calendar>
                @if (cal.max(); as last) {
                  <p class="font-sans text-caption text-slate">Your calendar shows up to {{ dayLabel(last) }} — for a later time, or one that isn't shown, use “Enter another time”.</p>
                }
              } @else {
                @if (rescheduleCalendarFailed()) {
                  <p class="flex items-start gap-1.5 font-sans text-caption text-alert"><sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ cal.error() }} Enter a time that's on your availability.</p>
                } @else if (rescheduleNoOpenTimes()) {
                  <p class="font-sans text-caption text-slate">You have no open times{{ cal.max() ? ' up to ' + dayLabel(cal.max()) : '' }}.</p>
                }
                <label class="flex max-w-sm flex-col gap-1.5">
                  <span class="font-sans text-caption font-semibold text-slate">New date &amp; time</span>
                  <input type="datetime-local" step="1800" class="min-h-11 w-full min-w-0 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" [min]="rescheduleMin()" [value]="rescheduleAt()" (input)="rescheduleAt.set($any($event.target).value)" />
                  <span class="font-sans text-caption text-slate">Must be on your availability, no sooner than patients can book (usually an hour ahead).</span>
                </label>
              }
              @if (!rescheduleNoOpenTimes()) {
                @if (rescheduleUseManual()) {
                  <button type="button" class="min-h-11 w-fit font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" (click)="useRescheduleCalendar()">
                    Choose from your calendar
                  </button>
                } @else {
                  <button type="button" class="min-h-11 w-fit font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" (click)="setRescheduleManual(true)">
                    Enter another time
                  </button>
                }
              }

              <div class="flex flex-col gap-3 border-t border-cloud pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p class="font-sans text-caption text-slate" aria-live="polite">
                  @if (rescheduleChosenLabel(); as chosen) {
                    New time: <span class="font-semibold text-ink">{{ chosen }}</span>.
                  }
                  {{ a.guests?.length ? 'The patient and their guests are emailed the new time.' : 'The patient is emailed the new time.' }}
                </p>
                <button type="button" class="min-h-11 shrink-0 rounded-field bg-cerulean px-5 py-2 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="actionBusy()" (click)="submitReschedule()">{{ actionBusy() ? 'Saving…' : 'Save new time' }}</button>
              </div>
              @if (actionError()) { <p role="alert" class="rounded-field bg-alert/10 px-3 py-2 font-label text-caption text-alert">{{ actionError() }}</p> }
            </div>
          }
        </section>

        <!-- Primary tabs -->
        <div class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-1">
          @for (t of primaryTabs; track t.key) {
            <button type="button" class="whitespace-nowrap rounded-pill px-5 py-2 font-sans text-body-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [class]="primary() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
              (click)="setPrimary(t.key)">{{ t.label }}</button>
          }
        </div>

        @switch (primary()) {
          <!-- ===== Overview ===== -->
          @case ('overview') {
            @if (loadingRecord()) {
              <div class="sd-shimmer h-40 rounded-card"></div>
            } @else if (recordError()) {
              <ng-container [ngTemplateOutlet]="recordFailed" />
            } @else if (medications().length === 0) {
              <ng-container [ngTemplateOutlet]="unavailable" />
            } @else {
              <div class="flex flex-col gap-6">
                <section class="flex flex-col gap-3">
                  <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="pill" [size]="20" class="text-cerulean" />Current Medication</h2>
                  @if (medications().length) {
                    <!-- Same medication row as the patient record (dose · frequency, reason, Herbal chip). -->
                    <ul class="flex flex-col divide-y divide-cloud rounded-card border border-cloud bg-white">
                      @for (m of medications(); track $index) {
                        <li class="px-4 py-3"><doc-medication-item [med]="m" /></li>
                      }
                    </ul>
                  } @else {
                    <p class="rounded-card bg-glacier px-4 py-3 font-sans text-body-sm text-slate">No medications recorded.</p>
                  }
                </section>
              </div>
            }
          }

          <!-- ===== Medical History ===== -->
          @case ('history') {
            @if (loadingRecord()) {
              <div class="sd-shimmer h-40 rounded-card"></div>
            } @else if (recordError()) {
              <ng-container [ngTemplateOutlet]="recordFailed" />
            } @else if (conditions().length === 0 && allergies().length === 0 && pastHistory().length === 0) {
              <ng-container [ngTemplateOutlet]="unavailable" />
            } @else {
              <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="pill" [size]="18" class="text-cerulean" />Chronic Conditions</h3>
                  @if (conditions().length) {
                    <div class="flex flex-wrap gap-2">
                      @for (c of conditions(); track $index) { <span class="rounded-pill bg-frost px-3 py-1 font-sans text-caption font-medium text-cerulean">{{ c.condition }}</span> }
                    </div>
                  } @else { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
                </section>
                <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="triangle-alert" [size]="18" class="text-alert" />Allergies</h3>
                  @if (allergies().length) {
                    <div class="flex flex-wrap gap-2">
                      @for (al of allergies(); track $index) { <span class="rounded-pill bg-alert/10 px-3 py-1 font-sans text-caption font-medium text-alert">{{ al.allergen }}</span> }
                    </div>
                  } @else { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
                </section>
                <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="clipboard-list" [size]="18" class="text-cerulean" />Past Medical History</h3>
                  @if (pastHistory().length) {
                    <ul class="flex flex-col gap-2">
                      @for (h of pastHistory(); track $index) {
                        <li class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="check" [size]="16" class="mt-0.5 shrink-0 text-cerulean" /><span>{{ h.year ? h.year + ' - ' : '' }}{{ h.condition }}{{ h.note ? ' (' + h.note + ')' : '' }}</span></li>
                      }
                    </ul>
                  } @else { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
                </section>
              </div>
            }
          }

          <!-- ===== Documents ===== -->
          @case ('documents') {
            <div class="flex flex-col gap-4">
              @if (patientDocs().length > 0) {
                <div class="flex flex-wrap items-center gap-3">
                  <div class="relative min-w-[220px] flex-1">
                    <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
                    <input class="w-full rounded-field border border-cloud bg-white py-2.5 pl-9 pr-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none" placeholder="Search Document" [value]="docSearch()" (input)="docSearch.set($any($event.target).value)" />
                  </div>
                </div>
              }
              @if (loadingDocs()) {
                <div class="sd-shimmer h-24 rounded-card"></div>
              } @else if (docsError()) {
                <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
                  <sd-icon name="wifi-off" [size]="32" class="text-alert" />
                  <p class="font-sans text-body-sm text-slate">{{ docsError() }}</p>
                </div>
              } @else if (filteredDocs().length === 0) {
                <div class="flex flex-col items-center gap-3 py-16 text-center">
                  <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="file-text" [size]="34" /></span>
                  <p class="font-sans text-body-sm text-slate">{{ docSearch() ? 'No documents match your search.' : 'No document yet' }}</p>
                </div>
              } @else {
                <ul class="flex flex-col gap-3">
                  @for (d of filteredDocs(); track d.id) {
                    <li>
                      <button type="button" class="flex w-full items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/40" (click)="openPatientDoc(d)">
                        <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="file-text" [size]="20" /></span>
                        <div class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                          <span class="font-sans text-caption text-slate">{{ d.extension || d.mime_type }} · {{ d.size_label }}</span>
                        </div>
                        <span class="hidden font-sans text-body-sm text-slate sm:block">{{ d.type_label }}</span>
                        <span class="hidden font-sans text-caption text-slate md:block">{{ shortDate(d.created_at) }}</span>
                        <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="d.uploader_role === 'patient' ? 'bg-sage/15 text-sage' : 'bg-warning/15 text-warning'">{{ d.uploader_role === 'patient' ? 'Patient-upload' : 'Doctor-uploaded' }}</span>
                        <sd-icon name="chevron-right" [size]="20" class="shrink-0 text-slate" />
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
          }

          <!-- ===== Past Visits ===== -->
          @case ('visits') {
            @if (loadingRecord()) {
              <div class="sd-shimmer h-32 rounded-card"></div>
            } @else if (recordError()) {
              <ng-container [ngTemplateOutlet]="recordFailed" />
            } @else if (pastVisits().length === 0) {
              <div class="flex flex-col items-center gap-3 py-16 text-center">
                <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="calendar-off" [size]="34" /></span>
                <p class="font-sans text-body-sm text-slate">No past visit</p>
              </div>
            } @else {
              <ul class="flex flex-col gap-4">
                @for (v of pastVisits(); track v.id) {
                  <li class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex items-center gap-3">
                      <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean"><sd-icon name="stethoscope" [size]="18" /></span>
                      <div class="flex flex-col">
                        <span class="font-heading text-body font-semibold text-ink">{{ v.specialist.name }}</span>
                        <span class="font-sans text-caption text-slate">{{ v.specialist.specialty }}</span>
                      </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(v.scheduled_at) }}</span>
                      <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(v.scheduled_at) }}</span>
                    </div>
                    <doc-visit-status-badge [status]="v.status" [label]="visitLabel(v)" />
                  </li>
                }
              </ul>
            }
          }

          <!-- ===== Clinical tools (preserved authoring) ===== -->
          @case ('clinical') {
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start">
              <!-- Sub-tabs: the primary tabs' pill bar (scrolls sideways on small screens), stacked into a rail on desktop. -->
              <nav class="min-w-0 lg:sticky lg:top-6" aria-label="Clinical tools">
                <div class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-1 lg:w-full lg:flex-col lg:overflow-visible lg:rounded-card lg:p-2">
                  @for (t of tabs; track t.key) {
                    <button type="button" class="${SUB_TAB}"
                      [class]="tab() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink lg:hover:bg-glacier'"
                      [attr.aria-current]="tab() === t.key ? 'true' : null"
                      (click)="select(t.key)">
                      <sd-icon [name]="t.icon" [size]="16" class="shrink-0" />{{ t.label }}
                    </button>
                  }
                </div>
              </nav>

              <div #clinicalPane tabindex="-1" class="flex min-w-0 flex-col gap-6 outline-none">
                @switch (tab()) {
                  @case ('notes') {
                    <doc-clinical-note
                      [state]="noteState()"
                      [note]="note()"
                      [values]="noteValues()"
                      [loadError]="noteLoadError()"
                      [error]="sectionError()"
                      [saving]="savingNote()"
                      [savingMode]="noteSaveMode()"
                      (valueChange)="setNote($event.key, $event.value)"
                      (save)="saveNote($event)"
                      (retry)="reloadNote()"
                    />
                  }
                  @case ('messages') {
                    <doc-clinical-header icon="message-square" heading="Secure messages" helper="Async, non-urgent messages with the patient. Not for emergencies." />
                    <section class="rounded-card border border-cloud bg-white p-3 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-4" aria-label="Message thread">
                      <div class="h-[58vh] min-h-[22rem]">
                        <sd-message-thread viewerRole="doctor" [messages]="messages()" [loading]="messagesLoading()" [sending]="sendingMessage()" placeholder="Message the patient…" emptyText="No messages yet. Send the first message to your patient." (send)="sendMessage($event)" />
                      </div>
                    </section>
                    @if (sectionError()) { <sd-alert tone="error">{{ sectionError() }}</sd-alert> }
                  }
                  @case ('prescriptions') {
                    <!-- Prescribe against this consultation (during or after the call). -->
                    <doc-rx-panel [patientId]="a.patient_id" [appointmentId]="id" />
                  }
                  @case ('labs') {
                    <doc-clinical-labs
                      [orders]="labOrders()"
                      [(tests)]="labTests"
                      [(priority)]="labPriority"
                      [(instructions)]="labInstructions"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (placeOrder)="orderLab()"
                    />
                  }
                  @case ('care') {
                    <doc-clinical-care-plan
                      [items]="careItems()"
                      [plan]="carePlan()"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (addStep)="addCare()"
                      (removeStep)="removeCare($event)"
                      (stepChange)="setCare($event.index, $event.value)"
                      (publish)="saveCare()"
                    />
                  }
                  @case ('followups') {
                    <!-- Owns its loading and API calls (slots, price, proposals). -->
                    <doc-follow-up-planner
                      [appointmentId]="id"
                      [specialistId]="a.specialist.id"
                      [parentStatus]="a.status"
                      [parentScheduledAt]="a.scheduled_at"
                    />
                  }
                  @case ('referrals') {
                    <doc-clinical-referrals
                      [referrals]="referrals()"
                      [(type)]="refType"
                      [(priority)]="refPriority"
                      [(target)]="refTarget"
                      [(reason)]="refReason"
                      [(summary)]="refSummary"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (create)="createReferral()"
                      (openDocument)="openDoc('referral', $event)"
                    />
                  }
                  @case ('certificates') {
                    <doc-clinical-certificates
                      [certificates]="certificates()"
                      [earliestFrom]="certMinFrom()"
                      [(type)]="certType"
                      [(diagnosis)]="certDiagnosis"
                      [(from)]="certFrom"
                      [(to)]="certTo"
                      [(statement)]="certStatement"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (issue)="issueCertificate()"
                      (openDocument)="openDoc('certificate', $event)"
                    />
                  }
                  @case ('consents') {
                    <doc-clinical-consents [consents]="consents()" />
                  }
                  @case ('recording') {
                    <doc-clinical-recording
                      [state]="recording()"
                      [files]="recordingFiles()"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (startRecording)="startRecording()"
                      (stopRecording)="stopRecording()"
                    />
                  }
                  @case ('ai') {
                    <doc-clinical-ai
                      [transcript]="transcript()"
                      [draft]="copilot()"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (generate)="generateCopilot()"
                    />
                  }
                }
              </div>
            </div>
          }
        }
      } @else {
        <div class="sd-shimmer h-40 rounded-card"></div>
      }
    </div>

    <ng-template #unavailable>
      <div class="flex flex-col items-center gap-3 py-16 text-center">
        <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="file-text" [size]="34" /></span>
        <p class="font-sans text-body-sm text-slate">Information unavailable</p>
      </div>
    </ng-template>

    <ng-template #recordFailed>
      <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
        <sd-icon name="wifi-off" [size]="32" class="text-alert" />
        <p class="font-sans text-body-sm text-slate">{{ recordError() }}</p>
      </div>
    </ng-template>
  `,
})
export class DoctorAppointmentDetail implements OnInit {
  private readonly api = inject(DoctorApi);
  /** The doctor's own booking calendar, for Reschedule. */
  protected readonly cal = inject(AvailabilityCalendarStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  protected readonly tabs = TABS;
  protected readonly primaryTabs: ReadonlyArray<{ key: PrimaryTab; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'history', label: 'Medical History' },
    { key: 'documents', label: 'Documents' },
    { key: 'visits', label: 'Past Visits' },
    { key: 'clinical', label: 'Clinical tools' },
  ];
  protected readonly primary = signal<PrimaryTab>('overview');
  /** The prescribing panel (Clinical tools → Prescriptions), when it is on screen. */
  private readonly rxPanel = viewChild(RxPanel);

  /** The appointment id (route param) — also the consultation the prescriptions belong to. */
  protected id = '';
  protected readonly appt = signal<DoctorAppointmentDto | null>(null);
  protected readonly apptError = signal('');
  /** Ticks so time-derived state (Join button, Past Visits) re-evaluates. */
  private readonly now = signal(Date.now());

  // Patient briefing
  protected readonly patientRecord = signal<DoctorPatientRecordDto | null>(null);
  protected readonly loadingRecord = signal(true);
  protected readonly recordError = signal('');
  protected readonly patientDocs = signal<MedicalDocumentDto[]>([]);
  protected readonly loadingDocs = signal(true);
  protected readonly docsError = signal('');
  protected readonly docSearch = signal('');

  protected readonly age = computed(() => this.ageFrom(this.patientRecord()?.patient?.date_of_birth));
  protected readonly medications = computed(() => this.patientRecord()?.medical?.medications ?? []);
  protected readonly conditions = computed(() => this.patientRecord()?.medical?.conditions ?? []);
  protected readonly allergies = computed(() => this.patientRecord()?.medical?.allergies ?? []);
  protected readonly pastHistory = computed(() => this.patientRecord()?.medical?.history ?? []);
  protected readonly pastVisits = computed(() =>
    (this.patientRecord()?.appointments ?? []).filter(
      (a) => a.id !== this.id && new Date(a.scheduled_at).getTime() < this.now(),
    ),
  );
  protected readonly filteredDocs = computed(() => {
    const q = this.docSearch().trim().toLowerCase();
    const docs = this.patientDocs();
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.type_label.toLowerCase().includes(q)) : docs;
  });

  /**
   * The Join-call button. The doctor can join at any time before the visit is
   * completed or cancelled; until the start it also says how long is left.
   */
  protected readonly joinState = computed<{ label: string; enabled: boolean; startsIn: TimeLeft | null }>(() => {
    const a = this.appt();
    if (!a) return { label: 'Join Call', enabled: false, startsIn: null };
    // (The template shows a closed proposal's own line instead of this button.)
    if (isClosedProposal(a)) return { label: 'Proposal closed', enabled: false, startsIn: null };
    if (a.status === 'completed' || a.status === 'cancelled') return { label: 'Consultation ended', enabled: false, startsIn: null };
    if (a.status === 'proposed') return { label: 'No call until accepted', enabled: false, startsIn: null };
    // The doctor may not start clinical work now (e.g. owes the practitioner terms): no link.
    if (a.join_blocked) return { label: 'Join Call', enabled: false, startsIn: null };
    const startsIn = timeLeft(new Date(a.scheduled_at).getTime() - this.now());
    return { label: startsIn ? 'Join Call' : 'Join Call Now', enabled: true, startsIn };
  });

  /** Who is in each consultation's call right now (polled). */
  protected readonly presence = injectCallPresence(() => this.api.presence());
  /** The patient has joined this consultation's call and is waiting for the doctor. */
  protected readonly patientWaiting = computed(() => {
    const a = this.appt();
    return !!a && this.presence()[a.id]?.patient === true;
  });
  /** One of the patient's guests is in this consultation's call now (presence lists guests by id). */
  protected guestInCall(appointmentId: string, guestId: string | null): boolean {
    return !!guestId && (this.presence()[appointmentId]?.guests ?? []).includes(guestId);
  }

  /** A finished (or cancelled) visit belongs to the history; an open one to the schedule. */
  protected readonly backLink = computed(() => {
    const s = this.appt()?.status;
    return s === 'completed' || s === 'cancelled' ? '/appointments/history' : '/schedule';
  });

  // Lifecycle actions
  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal('');
  /**
   * "Mark consultation completed": a confirmed visit whose time has come (for
   * one that ended without End in the call). The API also allows it earlier
   * while the doctor is in the call — that is the cockpit's End.
   */
  protected readonly canComplete = computed(() => {
    const a = this.appt();
    return !!a && a.status === 'confirmed' && new Date(a.scheduled_at).getTime() <= this.now();
  });
  /** The confirmation step is showing. */
  protected readonly completeAsk = signal(false);
  /** Just completed here — says so (the actions that went away explain nothing). */
  protected readonly completedNotice = signal(false);
  private readonly completeButton = viewChild<ElementRef<HTMLButtonElement>>('completeButton');
  private readonly completeTitle = viewChild<ElementRef<HTMLElement>>('completeTitle');
  private readonly completedNote = viewChild<ElementRef<HTMLElement>>('completedNote');

  // Follow-ups
  /** "Schedule follow-up": a completed consultation, or a confirmed one under way (or about to be). */
  protected readonly canFollowUp = computed(() => {
    const a = this.appt();
    if (!a) return false;
    if (a.status === 'completed') return true;
    return a.status === 'confirmed' && new Date(a.scheduled_at).getTime() <= this.now() + IN_CALL_LEAD_MINUTES * 60_000;
  });
  /** This appointment is a proposal the patient can still answer. */
  protected readonly proposalOpen = computed(() => {
    const a = this.appt();
    return !!a && isOpenProposal(a, this.now());
  });
  /** This appointment is a proposal that closed without being accepted (never a consultation). */
  protected readonly closedProposal = computed(() => {
    const a = this.appt();
    return !!a && isClosedProposal(a);
  });
  /** "Withdraw this proposal?" is showing. */
  protected readonly withdrawAsk = signal(false);
  /** Withdrawn here — the payload doesn't say how a closed proposal closed. */
  protected readonly withdrawnHere = signal(false);
  /** What Withdraw did: withdrew it, or found it had already closed. */
  protected readonly withdrawNotice = signal<{ text: string; tone: 'success' | 'info' } | null>(null);
  private readonly withdrawButton = viewChild<ElementRef<HTMLButtonElement>>('withdrawButton');
  private readonly withdrawTitle = viewChild<ElementRef<HTMLElement>>('withdrawTitle');
  private readonly withdrawnNote = viewChild<ElementRef<HTMLElement>>('withdrawnNote');
  private readonly actionErrorEl = viewChild<ElementRef<HTMLElement>>('actionErrorEl');
  private readonly clinicalPane = viewChild<ElementRef<HTMLElement>>('clinicalPane');

  protected readonly rescheduleOpen = signal(false);
  /** The picked time's ISO start, from the calendar (null: none). */
  protected readonly rescheduleSlot = signal<string | null>(null);
  /** Typing a time instead (e.g. one the calendar doesn't show, or past its last day). */
  protected readonly rescheduleManual = signal(false);
  /** The typed time — a local datetime-local value. */
  protected readonly rescheduleAt = signal('');
  /** The typed time's earliest value: now, on the half hour. */
  protected readonly rescheduleMin = signal('');
  /** The calendar loaded and its whole range (about a year) has no open time. */
  protected readonly rescheduleNoOpenTimes = computed(
    () => this.cal.range() !== null && this.cal.nextAvailable() === null,
  );
  /**
   * The calendar couldn't be loaded at all (no month ever arrived). A day's
   * times or a later month failing is shown inline instead, with a retry.
   */
  protected readonly rescheduleCalendarFailed = computed(() => this.cal.error() !== null && this.cal.max() === null);
  /** The typed input shows when chosen, or when the calendar has nothing to pick (or failed to load). */
  protected readonly rescheduleUseManual = computed(
    () => this.rescheduleManual() || this.rescheduleCalendarFailed() || this.rescheduleNoOpenTimes(),
  );
  /** The new time as the doctor will read it, e.g. "Thu 16 Oct, 9:30 AM" ('' until one is chosen). */
  protected readonly rescheduleChosenLabel = computed(() => {
    const raw = this.rescheduleUseManual() ? this.rescheduleAt() : this.rescheduleSlot();
    const d = raw ? new Date(raw) : null;
    return d && !isNaN(d.getTime())
      ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d)
      : '';
  });
  private readonly rescheduleTitle = viewChild<ElementRef<HTMLElement>>('rescheduleTitle');
  private readonly rescheduleButton = viewChild<ElementRef<HTMLButtonElement>>('rescheduleButton');

  // Clinical tools (nested)
  protected readonly tab = signal<TabKey>('notes');
  private readonly loaded = new Set<TabKey>();
  protected readonly sectionBusy = signal(false);
  protected readonly sectionError = signal('');

  protected readonly note = signal<ClinicalNoteDto | null>(null);
  /**
   * The saved note's load state. The editor (and Save / Finalize) only appear
   * once it is 'ready', so a blank editor can never overwrite a saved note.
   */
  protected readonly noteState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  protected readonly noteLoadError = signal('');
  private readonly noteDraft = signal<Record<string, string>>({ subjective: '', objective: '', assessment: '', plan: '' });
  protected readonly noteValues = this.noteDraft.asReadonly();
  protected readonly savingNote = signal(false);
  /** Which note button started the in-flight save (only drives its spinner). */
  protected readonly noteSaveMode = signal<NoteSaveMode | null>(null);
  protected readonly finalized = computed(() => this.note()?.status === 'finalized');

  protected readonly messages = signal<MessageDto[]>([]);
  protected readonly messagesLoading = signal(false);
  protected readonly sendingMessage = signal(false);

  protected readonly labOrders = signal<LabOrderDto[]>([]);
  protected readonly labTests = signal('');
  protected readonly labPriority = signal<'routine' | 'urgent'>('routine');
  protected readonly labInstructions = signal('');

  protected readonly careItems = signal<string[]>([]);
  /** The last loaded / published care plan (published state + who / when) — display only. */
  protected readonly carePlan = signal<CarePlanDto | null>(null);

  protected readonly referrals = signal<ReferralDto[]>([]);
  protected readonly refType = signal<ReferralDto['referral_type']>('specialist');
  protected readonly refTarget = signal('');
  protected readonly refReason = signal('');
  protected readonly refSummary = signal('');
  protected readonly refPriority = signal<'routine' | 'urgent'>('routine');

  protected readonly certificates = signal<MedicalCertificateDto[]>([]);
  protected readonly certType = signal<MedicalCertificateDto['type']>('sick_leave');
  protected readonly certStatement = signal('');
  protected readonly certDiagnosis = signal('');
  protected readonly certFrom = signal('');
  protected readonly certTo = signal('');
  /** The API's earliest leave start (clinic calendar), from the certificates list; '' until it loads. */
  protected readonly certEarliestFrom = signal('');

  protected readonly consents = signal<ConsentDto[]>([]);
  protected readonly recording = signal<DoctorRecordingStateDto | null>(null);
  protected readonly recordingFiles = signal<RecordingFileDto[]>([]);
  protected readonly transcript = signal<TranscriptSegmentDto[]>([]);
  protected readonly copilot = signal<CopilotDraftDto | null>(null);

  constructor() {
    // Load a Clinical tools sub-tab whenever it becomes VISIBLE — including the
    // default Notes sub-tab when the Clinical tools tab itself is opened.
    effect(() => {
      if (this.primary() !== 'clinical') return;
      const tab = this.tab();
      untracked(() => this.ensureLoaded(tab));
    });
    // The Recording tab's "N guests haven't agreed" goes stale as guests come
    // and go: re-read it when the guests in this call change (once it has loaded).
    const guestsHere = computed(() => [...(this.presence()[this.id]?.guests ?? [])].sort().join(','));
    effect(() => {
      guestsHere();
      untracked(() => {
        if (this.loaded.has('recording')) this.refreshRecording();
      });
    });
  }

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';

    // Keep time-derived UI (Join button countdown, Past Visits) fresh without a
    // reload — a memoized computed only re-runs when a signal it reads changes.
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(tick));

    this.loadAppointment(true);

    this.docsError.set('');
    this.api
      .patientDocuments(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.patientDocs.set(r.data); this.loadingDocs.set(false); },
        error: (err: unknown) => {
          this.docsError.set(apiErrorMessage(err, "Could not load the patient's documents."));
          this.loadingDocs.set(false);
        },
      });
  }

  /**
   * The appointment, by id (whatever its date — the schedule list only
   * carries the days around today). `initial` also loads the patient's record
   * and reports a failure; a later re-read (after an action raced the
   * patient's answer) only refreshes what is on screen.
   */
  private loadAppointment(initial = false): void {
    this.api
      .appointment(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.appt.set(res.data);
          if (initial) this.loadRecord(res.data.patient_id);
        },
        error: (err: unknown) => {
          if (initial) this.apptError.set(apiErrorMessage(err, 'Could not load the appointment.'));
        },
      });
  }

  private loadRecord(patientId: string): void {
    this.recordError.set('');
    this.api
      .patient(patientId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.patientRecord.set(r.data); this.loadingRecord.set(false); },
        error: (err: unknown) => {
          this.recordError.set(apiErrorMessage(err, "Could not load the patient's record."));
          this.loadingRecord.set(false);
        },
      });
  }

  protected openPatientDoc(doc: MedicalDocumentDto): void {
    // Popup-safe: open the tab synchronously on the click, then swap in the blob
    // once the bytes arrive (a post-await window.open is blocked by Safari etc.).
    openBlobDocument(this.api.patientDocumentBlob(this.id, doc.id));
  }

  /** Route guard hook: never drop an unsaved prescription when leaving the page. */
  canLeave(): boolean | Promise<boolean> {
    return this.rxPanel()?.canLeave() ?? true;
  }

  /** Switching primary tabs unmounts Clinical tools — confirm unsaved prescription edits first. */
  protected async setPrimary(key: PrimaryTab): Promise<void> {
    if (this.primary() === 'clinical' && key !== 'clinical' && !(await (this.rxPanel()?.canLeave() ?? true))) return;
    this.primary.set(key);
  }

  protected async select(tab: TabKey): Promise<void> {
    if (this.tab() === 'prescriptions' && tab !== 'prescriptions' && !(await (this.rxPanel()?.canLeave() ?? true))) return;
    this.tab.set(tab);
    this.sectionError.set('');
    // Re-clicking the open tab retries a failed load (the effect only sees changes).
    this.ensureLoaded(tab);
  }

  /** Load a sub-tab's data once (a failed load is forgotten, so it retries). */
  private ensureLoaded(tab: TabKey): void {
    if (this.loaded.has(tab)) return;
    this.loaded.add(tab);
    this.loadTab(tab);
  }

  private loadTab(tab: TabKey): void {
    switch (tab) {
      case 'notes':
        this.loadNote();
        break;
      case 'messages':
        this.messagesLoading.set(true);
        this.api.messages(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.messages.set(r.data); this.messagesLoading.set(false); }, error: (err: unknown) => { this.messagesLoading.set(false); this.tabLoadFailed('messages', err, 'Could not load the messages.'); } });
        break;
      // 'prescriptions': <doc-rx-panel> loads (and refreshes) its own list.
      case 'labs':
        this.api.listLabOrders(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.labOrders.set(r.data), error: () => undefined });
        break;
      case 'care':
        // Not silent: an empty editor after a failed load would let "Publish" overwrite the real plan.
        this.api.getCarePlan(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.careItems.set(r.data.items ?? []); this.carePlan.set(r.data); }, error: (err: unknown) => this.tabLoadFailed('care', err, 'Could not load the care plan.') });
        break;
      case 'referrals':
        this.api.listReferrals(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.referrals.set(r.data), error: () => undefined });
        break;
      case 'certificates':
        this.loadCertificates();
        break;
      case 'consents':
        this.api.consents(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.consents.set(r.data), error: () => undefined });
        break;
      case 'recording':
        this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined });
        this.api.recordingFiles(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recordingFiles.set(r.data.files), error: () => undefined });
        break;
      case 'ai':
        this.api.transcript(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.transcript.set(r.data), error: () => undefined });
        this.api.copilot(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.copilot.set(r.data.draft), error: () => undefined });
        break;
    }
  }

  /**
   * A clinical tab's initial load failed: show the real error (only if that tab
   * is still open) and forget it was loaded, so re-selecting the tab retries.
   */
  private tabLoadFailed(tab: TabKey, err: unknown, fallback: string): void {
    this.loaded.delete(tab);
    if (this.tab() === tab) this.sectionError.set(apiErrorMessage(err, fallback));
  }

  // ----- Notes -----
  private loadNote(): void {
    this.noteState.set('loading');
    this.noteLoadError.set('');
    this.api.getNote(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.note.set(r.data);
        this.noteDraft.set({ subjective: r.data.subjective ?? '', objective: r.data.objective ?? '', assessment: r.data.assessment ?? '', plan: r.data.plan ?? '' });
        this.noteState.set('ready');
      },
      error: (err: unknown) => {
        this.loaded.delete('notes');
        this.noteLoadError.set(apiErrorMessage(err, 'Could not load the clinical note. Please try again.'));
        this.noteState.set('error');
      },
    });
  }
  protected reloadNote(): void { this.ensureLoaded('notes'); }
  protected setNote(key: string, value: string): void { this.noteDraft.update((d) => ({ ...d, [key]: value })); }
  protected saveNote(finalize: boolean): void {
    // Never save over a note that has not loaded (it would replace the saved copy).
    if (this.noteState() !== 'ready' || this.savingNote()) return;
    this.savingNote.set(true); this.sectionError.set('');
    this.noteSaveMode.set(finalize ? 'finalize' : 'draft');
    const d = this.noteDraft();
    const input = { subjective: d['subjective'], objective: d['objective'], assessment: d['assessment'], plan: d['plan'] };
    const call = finalize ? this.api.finalizeNote(this.id, input) : this.api.saveNote(this.id, input);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.note.set(r.data); this.savingNote.set(false); }, error: (err: unknown) => { this.sectionError.set(apiErrorMessage(err, 'Could not save the note.')); this.savingNote.set(false); } });
  }

  // ----- Messages -----
  protected sendMessage(body: string): void {
    this.sendingMessage.set(true); this.sectionError.set('');
    this.api.sendMessage(this.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.messages.update((list) => [...list, r.data]); this.sendingMessage.set(false); }, error: (err) => { this.sectionError.set(apiErrorMessage(err, 'Could not send the message.')); this.sendingMessage.set(false); } });
  }

  // ----- Labs -----
  protected orderLab(): void {
    const tests = this.labTests().split('\n').map((t) => t.trim()).filter(Boolean);
    if (tests.length === 0) { this.sectionError.set('Add at least one test.'); return; }
    this.runSection(this.api.createLabOrder(this.id, { tests, priority: this.labPriority(), instructions: this.labInstructions() || null }), () => {
      this.labTests.set(''); this.labInstructions.set('');
      this.api.listLabOrders(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.labOrders.set(r.data), error: () => undefined });
    }, 'Could not place the lab order.');
  }

  // ----- Care plan -----
  protected addCare(): void { this.careItems.update((list) => [...list, '']); }
  protected removeCare(i: number): void { this.careItems.update((list) => list.filter((_, idx) => idx !== i)); }
  protected setCare(i: number, value: string): void { this.careItems.update((list) => list.map((v, idx) => (idx === i ? value : v))); }
  protected saveCare(): void {
    const items = this.careItems().map((v) => v.trim()).filter(Boolean);
    this.runSection(this.api.saveCarePlan(this.id, items), (r) => {
      const plan = r.data as CarePlanDto;
      this.careItems.set(plan.items ?? items);
      this.carePlan.set(plan);
    }, 'Could not publish the care plan.');
  }

  // ----- Referrals -----
  protected createReferral(): void {
    if (this.refTarget().trim() === '' || this.refReason().trim() === '') { this.sectionError.set('Please complete the referral.'); return; }
    this.runSection(this.api.createReferral(this.id, { referral_type: this.refType(), target: this.refTarget(), reason: this.refReason(), clinical_summary: this.refSummary() || null, priority: this.refPriority() }), () => {
      this.refTarget.set(''); this.refReason.set(''); this.refSummary.set('');
      this.api.listReferrals(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.referrals.set(r.data), error: () => undefined });
    }, 'Could not create the referral.');
  }

  // ----- Certificates + documents -----
  protected issueCertificate(): void {
    if (this.certStatement().trim() === '') { this.sectionError.set('Add a certifying statement.'); return; }
    if (this.certType() === 'sick_leave' && (this.certFrom() === '' || this.certTo() === '')) { this.sectionError.set('Set the leave period.'); return; }
    if (this.certType() === 'sick_leave' && this.certFrom() < this.certMinFrom()) { this.sectionError.set(`Leave can start at most ${CERTIFICATE_BACKDATE_DAYS} days ago.`); return; }
    if (this.certType() === 'sick_leave' && this.certTo() < this.certFrom()) { this.sectionError.set('The end date cannot be before the start date.'); return; }
    this.runSection(this.api.createCertificate(this.id, { type: this.certType(), statement: this.certStatement(), diagnosis: this.certDiagnosis() || null, from_date: this.certType() === 'sick_leave' ? this.certFrom() : null, to_date: this.certType() === 'sick_leave' ? this.certTo() : null }).pipe(tap({ error: () => this.loadCertificates() })), () => {
      this.certStatement.set(''); this.certDiagnosis.set(''); this.certFrom.set(''); this.certTo.set('');
      this.loadCertificates();
    }, 'Could not issue the certificate.');
  }

  /** The issued list, plus the API's leave-start floor (a page left open past midnight picks up the new one). */
  private loadCertificates(): void {
    this.api.listCertificates(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.certificates.set(r.data); this.certEarliestFrom.set(r.meta?.earliest_from_date ?? ''); },
      error: () => undefined,
    });
  }

  /**
   * The leave-start floor for the picker and the pre-check: the API's date (clinic
   * calendar), or, until it loads, a day looser than the browser's own so no date
   * the API accepts is hidden. The API rejects anything earlier with its message.
   */
  protected certMinFrom(): string {
    return this.certEarliestFrom() || todayLocal(-CERTIFICATE_BACKDATE_DAYS - 1);
  }

  protected openDoc(kind: ClinicalDocumentKind, docId: string): void {
    openClinicalDocument(this.api.document(this.id, kind, docId));
  }

  // ----- Recording -----
  private refreshRecording(): void {
    this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined });
  }
  protected startRecording(): void {
    // Refreshed on a refusal too: e.g. a guest in the call hasn't agreed yet (shown on the tab).
    this.runSection(this.api.startRecording(this.id).pipe(tap({ error: () => this.refreshRecording() })), () => this.refreshRecording(), 'Could not start recording — check the patient has granted recording consent.');
  }
  protected stopRecording(): void {
    this.runSection(this.api.stopRecording(this.id), () => {
      this.refreshRecording();
      this.api.recordingFiles(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recordingFiles.set(r.data.files), error: () => undefined });
    }, 'Could not stop the recording.');
  }

  // ----- AI -----
  protected generateCopilot(): void {
    this.runSection(this.api.generateCopilot(this.id), (r) => this.copilot.set(r.data as CopilotDraftDto), 'Could not generate a draft — AI or transcription consent may be unavailable.');
  }

  private runSection<T>(call: Observable<T>, onSuccess: (res: T) => void, errorMessage = 'Something went wrong. Please try again.'): void {
    // One section call at a time: a disabled <sd-button> still lets a click
    // reach its host element, so its look alone can't stop a double submit.
    if (this.sectionBusy()) return;
    this.sectionBusy.set(true); this.sectionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (res) => { onSuccess(res); this.sectionBusy.set(false); }, error: (err: unknown) => { this.sectionError.set(apiErrorMessage(err, errorMessage)); this.sectionBusy.set(false); } });
  }

  protected join(a: DoctorAppointmentDto): void {
    // No link on an unaccepted follow-up proposal — there is no call to join yet.
    const url = a.join_url;
    if (!url) return;
    const marker = '/call/join/';
    const idx = url.indexOf(marker);
    const token = idx >= 0 ? url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = url;
  }

  // ----- Lifecycle actions -----
  protected canReschedule(s: string): boolean { return ['pending', 'confirmed', 'rescheduled'].includes(s); }
  protected canCancel(s: string): boolean { return ['pending', 'confirmed', 'rescheduled'].includes(s); }
  protected toggleReschedule(): void {
    this.rescheduleOpen.update((v) => !v);
    this.actionError.set('');
    if (this.rescheduleOpen()) {
      this.loadRescheduleCalendar();
      afterNextRender(() => this.rescheduleTitle()?.nativeElement.focus(), { injector: this.injector });
    } else {
      afterNextRender(() => this.rescheduleButton()?.nativeElement.focus(), { injector: this.injector });
    }
  }
  /**
   * Fresh times on every open — the doctor's own calendar (lead time, blocks
   * and bookings applied; up to a year ahead, not held to the patient booking
   * window, and shown while bookings are switched off); a later or unlisted
   * time is typed instead.
   */
  private loadRescheduleCalendar(): void {
    const a = this.appt();
    if (!a) return;
    this.rescheduleSlot.set(null);
    this.rescheduleAt.set('');
    this.rescheduleManual.set(false);
    this.rescheduleMin.set(nowLocalInput(30));
    if (this.cal.specialistId() === a.specialist.id) this.cal.refresh();
    else this.cal.load(a.specialist.id, undefined, { scope: 'doctor' });
  }
  protected setRescheduleManual(manual: boolean): void {
    this.rescheduleManual.set(manual);
    this.rescheduleMin.set(nowLocalInput(30));
    this.actionError.set('');
  }
  /** Back from the typed time to the calendar, reloaded (so one that failed to load gets another go). */
  protected useRescheduleCalendar(): void {
    this.setRescheduleManual(false);
    this.cal.refresh();
  }
  protected confirm(): void { this.runAction(this.api.confirm(this.id)); }
  protected askComplete(): void {
    this.actionError.set('');
    this.completeAsk.set(true);
    afterNextRender(() => this.completeTitle()?.nativeElement.focus(), { injector: this.injector });
  }
  protected cancelComplete(): void {
    this.completeAsk.set(false);
    afterNextRender(() => this.completeButton()?.nativeElement.focus(), { injector: this.injector });
  }
  /** Mark the consultation completed (already completed counts as done). */
  protected complete(): void {
    this.runAction(this.api.complete(this.id), () => {
      this.completeAsk.set(false);
      this.completedNotice.set(true);
      afterNextRender(() => this.completedNote()?.nativeElement.focus(), { injector: this.injector });
    });
  }
  protected decline(): void {
    const guests = this.appt()?.guests?.length ?? 0;
    const told = guests ? ` The patient's ${guests === 1 ? 'guest is' : `${guests} guests are`} told it is cancelled too.` : '';
    if (!window.confirm(`Cancel this appointment? Any payment will be refunded to the patient.${told}`)) return;
    this.runAction(this.api.decline(this.id));
  }

  // ----- Follow-ups -----
  /** Clinical tools → Follow-ups, brought into view (asks first if a prescription is unsaved). */
  protected async openFollowUps(): Promise<void> {
    await this.setPrimary('clinical');
    if (this.primary() !== 'clinical') return;
    await this.select('followups');
    if (this.tab() !== 'followups') return;
    afterNextRender(() => {
      const pane = this.clinicalPane()?.nativeElement;
      pane?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      pane?.focus({ preventScroll: true });
    }, { injector: this.injector });
  }
  protected askWithdraw(): void {
    this.actionError.set('');
    this.withdrawAsk.set(true);
    afterNextRender(() => this.withdrawTitle()?.nativeElement.focus(), { injector: this.injector });
  }
  protected cancelWithdraw(): void {
    if (this.actionBusy()) return;
    this.withdrawAsk.set(false);
    afterNextRender(() => this.withdrawButton()?.nativeElement.focus(), { injector: this.injector });
  }
  /** Withdraw this unanswered proposal: the patient is told and the slot reopens. */
  protected withdrawProposal(): void {
    this.withdrawNotice.set(null);
    this.runAction(
      this.api.withdrawFollowUp(this.id),
      (res) => {
        this.withdrawAsk.set(false);
        if (withdrewProposal(res)) {
          this.withdrawnHere.set(true);
          this.withdrawNotice.set({ text: 'Proposal withdrawn — the patient has been told.', tone: 'success' });
        } else {
          // The patient declined it, or it expired, a moment before: show how it closed.
          this.withdrawNotice.set({ text: 'This proposal had already closed — the patient declined it or it expired.', tone: 'info' });
          this.loadAppointment();
        }
        afterNextRender(() => this.withdrawnNote()?.nativeElement.focus(), { injector: this.injector });
      },
      () => {
        // E.g. the patient accepted it a moment ago: show the appointment as it is now,
        // and move focus from the confirm step (which goes away) to the error.
        this.withdrawAsk.set(false);
        this.loadAppointment();
        afterNextRender(() => this.actionErrorEl()?.nativeElement.focus(), { injector: this.injector });
      },
    );
  }
  protected submitReschedule(): void {
    let iso = this.rescheduleSlot() ?? '';
    const manual = this.rescheduleUseManual();
    if (manual) {
      if (this.rescheduleAt().trim() === '') { this.actionError.set('Choose a new date and time.'); return; }
      const at = new Date(this.rescheduleAt());
      if (isNaN(at.getTime())) { this.actionError.set('Enter a valid date and time.'); return; }
      if (at.getTime() <= Date.now()) { this.actionError.set('Choose a time in the future.'); return; }
      iso = at.toISOString();
    } else if (iso === '') {
      this.actionError.set('Pick a day, then one of its open times.');
      return;
    }
    this.runAction(
      this.api.reschedule(this.id, iso),
      () => {
        this.rescheduleOpen.set(false);
        afterNextRender(() => this.rescheduleButton()?.nativeElement.focus(), { injector: this.injector });
      },
      (err) => {
        // The time went meanwhile (taken, blocked, too soon): show the calendar as it is now.
        if (!manual && apiErrorFields(err)['scheduled_at']) {
          this.rescheduleSlot.set(null);
          this.cal.refresh();
        }
      },
    );
  }
  private runAction(
    call: Observable<SuccessResponse<AppointmentDto>>,
    onOk?: (res: SuccessResponse<AppointmentDto>) => void,
    onError?: (err: unknown) => void,
  ): void {
    this.actionBusy.set(true); this.actionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.appt.update((a) => (a ? { ...a, status: res.data.status, status_label: res.data.status_label, scheduled_at: res.data.scheduled_at, follow_up_outcome: res.data.follow_up_outcome } : a)); this.actionBusy.set(false); onOk?.(res); },
      error: (err: unknown) => { this.actionError.set(apiErrorMessage(err, 'Could not update the appointment.')); this.actionBusy.set(false); onError?.(err); },
    });
  }

  // ----- Helpers -----
  /** The header badge: "Awaiting patient" for a proposal, how a closed one closed, else the API's label. */
  protected statusLabel(a: DoctorAppointmentDto): string {
    return a.status === 'cancelled' && this.withdrawnHere() ? 'Withdrawn' : doctorStatusLabel(a, this.now());
  }
  protected visitLabel(v: AppointmentDto): string { return doctorStatusLabel(v, this.now()); }
  protected followUp(a: DoctorAppointmentDto): FollowUpState {
    return followUpState(a, this.now(), this.withdrawnHere() ? new Set([a.id]) : undefined);
  }
  /** Who made this follow-up, and what happens next. */
  protected followUpOrigin(a: DoctorAppointmentDto): string {
    if (a.proposed_by === 'patient') return 'Booked by the patient as a follow-up.';
    if (a.status === 'proposed') return 'You proposed this follow-up. The patient accepts it (paying any fee), chooses another of your times, or declines.';
    return 'You proposed this follow-up.';
  }
  /** A closed proposal's line in place of the Join button: how it closed, and that the time is free. */
  protected closedProposalText(a: DoctorAppointmentDto): string {
    const how = this.followUp(a).label;
    const lead = how === 'Declined' ? 'The patient declined this proposal'
      : how === 'Withdrawn' ? 'You withdrew this proposal'
      : 'This proposal closed without being accepted';
    const ahead = new Date(a.scheduled_at).getTime() > this.now();
    return `${lead}, so there was no consultation.${ahead ? ' The time is open again on your schedule.' : ''}`;
  }
  protected followUpPrice(a: DoctorAppointmentDto): string { return followUpPriceLabel(a); }
  protected isFree(amount: string): boolean { return Number(amount) <= 0; }
  protected when(iso: string | null | undefined): string { return whenLabel(iso); }
  protected initialsFor(name: string): string { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  protected money(amount: string): string { const n = Number(amount); return '₦' + (isNaN(n) ? '0' : n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
  protected dateLabel(iso: string): string { return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  protected time(iso: string): string { return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  protected shortDate(iso: string): string { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  /** A calendar date ('YYYY-MM-DD', no zone shift), e.g. "Thu 16 Oct". */
  protected dayLabel(ymd: string | null): string { return ymd ? shortDayLabel(ymd) : ''; }
  private ageFrom(dob: string | null | undefined): number | null {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age >= 0 && age < 130 ? age : null;
  }
}
