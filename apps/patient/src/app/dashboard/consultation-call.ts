import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  ILocalTrack,
  ILocalVideoTrack,
  IMicrophoneAudioTrack,
  UID,
} from 'agora-rtc-sdk-ng';
import { AuthService, SessionTimeoutService } from '@supadoc/auth';
import {
  apiErrorFields,
  apiErrorMessage,
  AppointmentsApi,
  DocumentsApi,
  DocumentSharingApi,
  openBlobDocument,
  openPendingTab,
  PatientApi,
  PrescriptionsApi,
  sendCallPresence,
  startCallPresence,
} from '@supadoc/data-access';
import {
  DOCTOR_CALL_UID,
  type AllergyRow,
  type AppointmentDocumentAccessDto,
  type AppointmentDto,
  type CallParticipantDto,
  type ConditionRow,
  type ConsentDto,
  type ConsultationSummaryDto,
  type DocumentAccessRequestDto,
  type DocumentGrantDto,
  type DocumentShareResultDto,
  type HealthProfileDto,
  type LabOrderDto,
  type MedicalDocumentDto,
  type MedicationRow,
  type PatientCarePlanDto,
  type PatientGuestDto,
  type PatientProfileDto,
  type PrescriptionDto,
  type PrescriptionStatus,
  type ReferralDto,
  type TranscriptSegmentDto,
  type VitalReadingDto,
} from '@supadoc/models';
import {
  buildCallTiles,
  CallTilesComponent,
  DialogService,
  callTilesMode,
  type CallUid,
  type CallVideoPlayConfig,
  type CallVideoTrack,
  IconComponent,
  type RemoteParticipant,
  RemoteParticipants,
  SmoothHeightDirective,
} from '@supadoc/ui';
import { type DeviceProblem, deviceProblemText, doctorTitle } from '../call/call-helpers';
import { openLocalMedia } from '../call/call-media';
import { type ApproveOutcome, approveOutcomeLine, ApproveRequestDialog } from './approve-request-dialog';
import { isSharingUnavailable, shareResultLine, SHARING_UNAVAILABLE } from './document-sharing';
import { isOpenProposal, whenLabel } from './follow-up';
import { InviteGuestDialog } from './invite-guest-dialog';
import { ShareConfirmSheet } from './share-confirm-sheet';
import { ShareDialog } from './share-dialog';
import { isAlreadyReviewed, rememberReviewed, wasReviewed } from './review-memory';

type NotesTab = 'notes' | 'prescriptions' | 'labs' | 'followup';
type DocsTab = 'all' | 'labs' | 'imaging' | 'reports';

/** Idle-timer hold key while a consultation is actually going on. */
const CALL_HOLD = 'call';
/**
 * How long a patient alone in the channel keeps the idle timer paused while
 * waiting for the doctor to first arrive (ms). After that the normal idle
 * warning runs again (the hold comes back the moment someone joins).
 */
const FIRST_JOIN_WAIT_MS = 30 * 60_000;
/**
 * Agora retries a lost connection on its own (RECONNECTING) without a time
 * limit; give up after this long (ms) so a dead connection can't keep the idle
 * timer paused. The patient can rejoin.
 */
const RECONNECT_GIVE_UP_MS = 2 * 60_000;
/** How long the "new prescription" toast stays up (ms). */
const RX_TOAST_MS = 10_000;
/** How long an "Open the prescription" fallback link stays up when the link has no expiry (ms). */
const RX_FALLBACK_MS = 5 * 60_000;

/** Why the call ended without the patient pressing End. */
type CallEndReason = 'completed' | 'dropped';

/**
 * Every prescription status reads as an icon AND a word — never colour alone.
 * Classes are the cockpit's dark-surface tones (remapped by the light theme).
 */
const RX_STATUS: Record<PrescriptionStatus, { label: string; icon: string; cls: string }> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-warning/15 text-warning' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-success/15 text-success' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-white/10 text-white/70' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/15 text-alert' },
};

/** In-call notice for a newly sent prescription — never names medicines. */
interface RxToast {
  readonly text: string;
  readonly rx: PrescriptionDto;
}

/** Minimal Web Speech API surface (not in lib.dom types). */
interface SpeechRec {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecCtor = new () => SpeechRec;

interface ChatMessage {
  readonly mine: boolean;
  readonly text: string;
  readonly time: string;
}

/** A record shown in the right-hand Documents & Records panel. */
interface RecordItem {
  readonly title: string;
  readonly date: string;
  readonly kind: DocsTab;
  readonly badge: string;
  readonly url: string | null;
  /** Set for medical-library documents — opened via an authenticated blob. */
  readonly docId?: string;
}

/**
 * Live consultation cockpit (Agora RTC) — the patient's in-call view.
 *
 * Left: the video stage with the call controls, plus the consultation notes
 * tabs and an in-call chat. Everyone in the call has their own tile
 * (`<sd-call-tiles>`, named from the call's `participants`): with one other
 * person it is today's stage (the doctor big, the patient picture-in-picture),
 * with guests too an even grid. "Invite someone" adds a guest without leaving
 * the call. Right: the patient's own health summary, latest vitals and shared
 * records.
 *
 * The video credentials come from GET .../call-token (server-minted RTC token);
 * the health summary is the signed-in patient's real allergies / conditions /
 * medications. Route: /dashboard/call/:id.
 */
@Component({
  selector: 'pat-consultation-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ApproveRequestDialog,
    CallTilesComponent,
    IconComponent,
    InviteGuestDialog,
    ShareConfirmSheet,
    ShareDialog,
    SmoothHeightDirective,
  ],
  host: { class: 'block' },
  styles: [
    `
      /* Tab panels fade in softly when switched (replays when re-rendered). */
      .sd-tab-panel { animation: sdTabIn 200ms cubic-bezier(0.2, 0, 0, 1); }
      @keyframes sdTabIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sd-tab-panel { animation: none; }
      }
    `,
  ],
  template: `
    <!-- New prescription notice (says who sent it and its number — never the medicines) -->
    @if (rxToast(); as t) {
      <div
        class="sd-toast-in fixed inset-x-4 top-4 z-50 flex items-start gap-3 rounded-card border border-cerulean/30 bg-white px-4 py-3 shadow-lg sm:left-auto sm:right-6 sm:top-6 sm:w-full sm:max-w-sm"
        role="status"
      >
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-teal/10 text-teal">
          <sd-icon name="pill" [size]="18" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <p class="font-sans text-body-sm font-medium text-ink">{{ t.text }}</p>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <button
              type="button"
              class="font-sans text-caption font-semibold text-cerulean hover:underline"
              (click)="viewRxFromToast(t.rx)"
            >
              View prescription
            </button>
            <button
              type="button"
              class="font-sans text-caption font-semibold text-slate hover:text-ink"
              (click)="showRxTab()"
            >
              Show in call notes
            </button>
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 text-slate transition-colors hover:text-ink"
          aria-label="Dismiss notice"
          (click)="dismissRxToast()"
        >
          <sd-icon name="x" [size]="18" />
        </button>
      </div>
    }

    <div class="sd-call rounded-card bg-abyss p-3 text-white sm:p-4 lg:p-5" [attr.data-theme]="theme()">
      @if (phase() === 'waiting') {
        <!-- ============================ WAITING ROOM ============================ -->
        <div class="mx-auto flex max-w-3xl flex-col items-center gap-5 py-4 text-center">
          <span class="font-heading text-h5 tracking-tight">
            <span class="text-frost">Video</span><span class="text-sage">Med</span>
          </span>

          <div class="flex flex-col items-center gap-1.5">
            <span class="flex size-20 items-center justify-center rounded-full bg-cerulean/20 font-heading text-h4 font-semibold text-frost">
              {{ doctorInitials() }}
            </span>
            <h1 class="font-heading text-h4 text-white">{{ doctorName() }}</h1>
            @if (doctorSpecialty()) {
              <p class="font-sans text-body-sm text-white/60">{{ doctorSpecialty() }}</p>
            }
            <p class="mt-1 flex items-center gap-1.5 font-sans text-caption text-white/50">
              <sd-icon name="calendar-clock" [size]="14" /> {{ scheduledLabel() }}
            </p>
          </div>

          <!-- Device check -->
          <div class="w-full rounded-card border border-white/10 bg-white/[0.03] p-4">
            <div class="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center">
              <div class="relative aspect-video overflow-hidden rounded-2xl bg-ink">
                <video #previewVideo class="h-full w-full object-cover" playsinline muted></video>
                @if (!camReady()) {
                  <div class="absolute inset-0 flex items-center justify-center text-white/40">
                    <sd-icon name="video-off" [size]="24" />
                  </div>
                }
              </div>
              <div class="flex flex-col gap-3 text-left">
                <div class="flex items-center gap-2">
                  <sd-icon name="video" [size]="16" [class]="camReady() ? 'text-success' : 'text-white/40'" />
                  <span class="font-sans text-body-sm text-white/80">
                    Camera {{ camReady() ? 'ready' : 'unavailable' }}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <sd-icon name="mic" [size]="16" [class]="micReady() ? 'text-success' : 'text-white/40'" />
                  <span class="whitespace-nowrap font-sans text-body-sm text-white/80">Microphone</span>
                  <span class="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      class="block h-full rounded-full bg-success transition-[width] duration-100"
                      [style.width.%]="micLevel() * 100"
                    ></span>
                  </span>
                </div>
                <button
                  type="button"
                  class="flex w-fit items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/80 transition-colors hover:bg-white/10"
                  (click)="testSpeaker()"
                >
                  <sd-icon name="headphones" [size]="14" /> Test speaker
                </button>
              </div>
            </div>
          </div>

          <!-- Consent review -->
          <div class="w-full rounded-card border border-white/10 bg-white/[0.03] p-4 text-left">
            <p class="mb-2 flex items-center gap-1.5 font-sans text-body-sm font-semibold text-white">
              <sd-icon name="shield-check" [size]="16" class="text-frost" /> Before you join
            </p>
            @for (c of consentRows; track c.type) {
              <div class="flex items-center justify-between gap-2 py-1">
                <span class="font-sans text-body-sm text-white/70">{{ c.label }}</span>
                <button
                  type="button"
                  role="switch"
                  [attr.aria-checked]="consentGranted(c.type)"
                  [attr.aria-label]="c.label"
                  class="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60"
                  [class]="consentGranted(c.type) ? 'bg-success' : 'bg-white/15'"
                  [disabled]="consentBusy() === c.type"
                  (click)="toggleConsent(c.type)"
                >
                  <span
                    class="absolute top-0.5 size-5 rounded-full bg-white transition-all"
                    [class]="consentGranted(c.type) ? 'left-[22px]' : 'left-0.5'"
                  ></span>
                </button>
              </div>
            }
            @if (consentError()) {
              <p class="mt-1 font-sans text-caption text-alert" role="alert">{{ consentError() }}</p>
            }
          </div>

          <button
            type="button"
            class="flex w-full max-w-sm items-center justify-center gap-2 rounded-field bg-cerulean px-6 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-cerulean-dark"
            (click)="enterConsultation()"
          >
            <sd-icon name="video" [size]="20" /> Enter consultation
          </button>
          <button
            type="button"
            class="font-sans text-caption text-white/50 transition-colors hover:text-white/80"
            (click)="leave()"
          >
            Back to appointments
          </button>
        </div>
      } @else {
      <!-- One flex column below lg (the main column is display:contents there) so the
           pinned video stays in view down the whole page, not just its own column. -->
      <div class="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
        <!-- ============================ MAIN ============================ -->
        <div class="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
          <!-- Action bar -->
          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <button
              type="button"
              class="flex items-center gap-2 rounded-pill px-2 py-1.5 font-sans text-body-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              (click)="leave()"
            >
              <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
              <span class="hidden sm:inline">Back to Appointments</span>
            </button>

            <span
              class="flex items-center gap-2 rounded-pill bg-white/5 px-3 py-1.5 font-sans text-caption text-white/70"
            >
              <sd-icon name="shield-check" [size]="15" class="text-success" />
              <span class="hidden md:inline">Secure &amp; Encrypted</span>
              <span class="flex items-end gap-0.5" aria-hidden="true">
                <span class="w-0.5 rounded-full bg-success" style="height:6px"></span>
                <span class="w-0.5 rounded-full bg-success" style="height:9px"></span>
                <span class="w-0.5 rounded-full bg-success" style="height:12px"></span>
              </span>
            </span>

            <div class="flex items-center gap-2">
              <button
                type="button"
                class="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-pill border border-white/15 px-3 py-1.5 font-sans text-body-sm text-white/85 transition-colors hover:bg-white/10"
                aria-haspopup="dialog"
                aria-label="Invite someone to this call"
                (click)="invite()"
              >
                <sd-icon name="user-plus" [size]="16" />
                <span class="hidden sm:inline" aria-hidden="true">Invite Someone</span>
              </button>
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                [attr.aria-label]="theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                (click)="toggleTheme()"
              >
                <sd-icon name="lightbulb" [size]="18" />
              </button>
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="More options"
                (click)="moreOpen.set(!moreOpen())"
              >
                <span class="text-body-lg leading-none tracking-widest">⋯</span>
              </button>
            </div>
          </div>

          <!-- A camera / microphone that isn't in the call (above the stage, never over a tile) -->
          @if (status() === 'in-call' && deviceNotice()) {
            <p class="flex items-start gap-2 rounded-card border border-white/10 bg-white/[0.03] px-3 py-2 font-sans text-caption text-white/80" role="status">
              <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-warning" />{{ deviceNotice() }}
            </p>
          }

          <!-- Video stage — pinned to the top while the notes below are read or
               tabs are switched, so the consultation never scrolls out of view. -->
          <div
            class="sd-stage sticky top-2 z-20 [container-name:stage] [container-type:size] aspect-[4/3] max-h-[50vh] w-full overflow-hidden rounded-card bg-ink shadow-[0_12px_32px_rgba(0,0,0,0.35)] sm:aspect-video lg:aspect-[16/10]"
          >
            <!-- Everyone's video: the other person big and you picture-in-picture
                 1:1, an even grid with guests. Always rendered, so a track can be
                 handed over before its tile appears; each tile has its own name,
                 camera-off placeholder and muted badge. -->
            <sd-call-tiles [tiles]="tiles()" [spotlightLabel]="false" [showRole]="true" />

            <!-- Nobody else here: not yet, or everyone has gone -->
            @if (!hasRemoteTile() && status() === 'in-call') {
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-3 pb-16 pl-6 pr-[5.5rem] pt-12 text-center text-white/75 roomy:pt-24 roomy:pb-32 roomy:pr-36"
              >
                @if (remoteLeft()) {
                  <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                    <sd-icon name="user-x" [size]="30" />
                  </span>
                  <p class="font-sans text-body-sm roomy:text-body">{{ leftText() }}</p>
                  <p class="hidden max-w-sm font-sans text-caption text-white/50 roomy:block">
                    If your consultation is finished, press End to leave.
                  </p>
                } @else {
                  <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                    <sd-icon name="user-round" [size]="30" />
                  </span>
                  <p class="font-sans text-body-sm roomy:text-body">
                    Waiting for {{ doctorName() }} to join…
                  </p>
                  <p class="hidden font-sans text-caption text-white/50 roomy:block">
                    {{ doctorSpecialty() }}
                  </p>
                }
              </div>
            }

            <!-- The call ended without the patient pressing End -->
            @if (status() === 'ended') {
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white/85"
                role="status"
              >
                <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                  <sd-icon [name]="endedReason() === 'completed' ? 'circle-check' : 'wifi-off'" [size]="28" />
                </span>
                @if (endedReason() === 'completed') {
                  <p class="max-w-sm font-sans text-body">Your consultation has ended.</p>
                  <p class="max-w-sm font-sans text-caption text-white/60">
                    Your consultation summary, prescriptions and anything else your doctor shares
                    appear in your consultation history.
                  </p>
                } @else {
                  <p class="max-w-sm font-sans text-body">You were disconnected from the call.</p>
                  <p class="max-w-sm font-sans text-caption text-white/60">
                    Check your internet connection, then rejoin. Anything your doctor has shared
                    is in your consultation history.
                  </p>
                }
                <div class="flex flex-wrap items-center justify-center gap-3">
                  @if (endedReason() === 'dropped') {
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark"
                      (click)="rejoin()"
                    >
                      <sd-icon name="refresh-cw" [size]="16" /> Rejoin call
                    </button>
                  }
                  <button
                    type="button"
                    class="min-h-11 rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                    (click)="leave('history')"
                  >
                    View consultation summary
                  </button>
                </div>
              </div>
            }

            <!-- Loading -->
            @if (status() === 'loading') {
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/85"
              >
                <span
                  class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white"
                ></span>
                <p class="font-sans text-body">Connecting to your consultation…</p>
              </div>
            }

            <!-- Error -->
            @if (status() === 'error') {
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white/85"
              >
                <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                  <sd-icon name="video-off" [size]="28" />
                </span>
                <p class="max-w-sm font-sans text-body">{{ errorMessage() }}</p>
                @if (awaitingAcceptance()) {
                  <button
                    type="button"
                    class="min-h-11 rounded-field bg-white px-5 py-2.5 font-sans text-body-sm font-semibold text-ink transition-colors hover:bg-white/90"
                    (click)="leave('proposal')"
                  >
                    Review the follow-up
                  </button>
                }
                <button
                  type="button"
                  class="rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                  (click)="leave()"
                >
                  Back to appointments
                </button>
              </div>
            }

            <!-- Name tag of whoever is on the main stage (1:1; the grid labels every tile) -->
            @if (status() === 'in-call') {
              <!-- …with the recording notice beside it (small stage) or under it -->
              <div
                class="absolute left-4 top-4 z-10 flex max-w-[calc(100%-7rem)] items-center gap-2 roomy:max-w-[calc(100%-8rem)] roomy:flex-col roomy:items-start"
              >
                @if (stageMode() === 'spotlight') {
                  <div class="flex min-w-0 max-w-full items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur">
                    @if (spotlight()?.muted) {
                      <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-alert text-white" aria-hidden="true">
                        <sd-icon name="mic-off" [size]="12" />
                      </span>
                    }
                    <span class="truncate font-sans text-body-sm font-medium text-white">
                      {{ spotlight()?.name ?? doctorName() }}
                    </span>
                  </div>
                }
                <!-- A guest is here but the doctor isn't yet (any stage size, 1:1 or grid) -->
                @if (hasRemoteTile() && !doctorHere()) {
                  <div class="flex min-w-0 max-w-full items-center rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur" role="status">
                    <span class="truncate font-sans text-caption text-white/80">Waiting for {{ doctorName() }}…</span>
                  </div>
                }
                @if (recordingActive()) {
                  <div
                    class="flex min-w-0 shrink-0 items-center gap-1.5 rounded-pill bg-alert/90 px-3 py-1.5 font-sans text-caption font-medium text-white shadow-lg roomy:max-w-full roomy:shrink"
                    role="status"
                    aria-label="This consultation is being recorded"
                  >
                    <span class="size-2 shrink-0 animate-pulse rounded-full bg-white"></span>
                    <span class="roomy:hidden">Rec</span>
                    <span class="hidden min-w-0 truncate roomy:inline">This consultation is being recorded</span>
                  </div>
                }
              </div>

              <!-- HD badge (small stage: the PiP has this corner; the grid has tiles there) -->
              @if (stageMode() === 'spotlight') {
                <div
                  class="absolute right-4 top-4 hidden items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur roomy:flex"
                >
                  <span class="font-label text-caption font-semibold text-white">HD</span>
                  <span class="size-2 rounded-full bg-success"></span>
                </div>
              }


              <!-- Live captions, always clear of the controls and the PiP (on small
                   stages just the newest line, right above the controls) -->
              @if (captionsOn() && latestCaptions().length) {
                <div class="absolute bottom-[4.5rem] left-6 right-[5.5rem] z-20 mx-auto flex max-h-8 max-w-xl flex-col justify-end overflow-hidden rounded-2xl bg-abyss/80 px-4 py-2 text-center backdrop-blur roomy:right-36 roomy:bottom-32 roomy:max-h-20">
                  @for (seg of latestCaptions(); track seg.id) {
                    <p class="font-sans text-caption text-white/90 roomy:text-body-sm">
                      <span class="font-semibold capitalize" [class]="seg.role === 'doctor' ? 'text-frost' : 'text-sage'">{{ seg.role }}:</span>
                      {{ seg.text }}
                    </p>
                  }
                </div>
              }

              <!-- Controls (icon-only and a little smaller on a small stage, so all of them fit) -->
              <div
                class="absolute bottom-3 left-1/2 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-pill bg-abyss/75 px-2 py-2 backdrop-blur roomy:bottom-5 roomy:gap-3 roomy:px-4 roomy:py-2.5"
              >
                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  [attr.aria-label]="micLive() ? 'Mute microphone' : 'Unmute microphone'"
                  (click)="toggleMic()"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 transition-colors"
                    [class]="micLive() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                  >
                    <sd-icon [name]="micLive() ? 'mic' : 'mic-off'" [size]="20" />
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">
                    {{ micLive() ? 'Mute' : 'Unmute' }}
                  </span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  [attr.aria-label]="camLive() ? 'Turn camera off' : 'Turn camera on'"
                  (click)="toggleCam()"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 transition-colors"
                    [class]="camLive() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                  >
                    <sd-icon [name]="camLive() ? 'video' : 'video-off'" [size]="20" />
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">
                    {{ camLive() ? 'Stop Video' : 'Start Video' }}
                  </span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  aria-label="Share screen"
                  (click)="toggleScreen()"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 transition-colors"
                    [class]="screenOn() ? 'bg-sky hover:bg-sky/80' : 'bg-white/15 hover:bg-white/25'"
                  >
                    <sd-icon name="monitor-smartphone" [size]="20" />
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">Share</span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  aria-label="Toggle chat"
                  (click)="chatOpen.set(!chatOpen())"
                >
                  <span
                    class="relative flex size-9 items-center justify-center rounded-full roomy:size-11 transition-colors"
                    [class]="chatOpen() ? 'bg-sky hover:bg-sky/80' : 'bg-white/15 hover:bg-white/25'"
                  >
                    <sd-icon name="message-square" [size]="20" />
                    @if (unreadChat() > 0 && !chatOpen()) {
                      <span class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-alert"></span>
                    }
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">Chat</span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  aria-label="Toggle captions"
                  [attr.title]="!aiConsentGranted() ? 'Turn on AI-transcription consent to use captions' : null"
                  [disabled]="!aiConsentGranted()"
                  (click)="toggleCaptions()"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 font-label text-caption font-bold text-white transition-colors"
                    [class]="captionsOn() ? 'bg-sky hover:bg-sky/80' : 'bg-white/15 hover:bg-white/25'"
                    [class.opacity-40]="!aiConsentGranted()"
                  >
                    CC
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">Captions</span>
                </button>

                <button
                  type="button"
                  class="flex min-h-11 min-w-11 flex-col items-center justify-center gap-1"
                  aria-label="Leave call and view the consultation summary"
                  (click)="leave('history')"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 bg-alert transition-colors hover:bg-alert/80"
                  >
                    <sd-icon name="phone-off" [size]="20" />
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">End</span>
                </button>
              </div>

              <!-- Elapsed timer -->
              <div
                class="absolute bottom-6 right-4 hidden items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur @min-[36rem]/stage:flex"
              >
                <span class="size-1.5 rounded-full bg-alert"></span>
                <span class="font-label text-caption tabular-nums text-white/85">
                  {{ elapsedLabel() }}
                </span>
              </div>
            }
          </div>

          <!-- In-call chat (collapsible) -->
          @if (chatOpen()) {
            <div class="flex flex-col rounded-card border border-white/10 bg-white/[0.03]">
              <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <span class="flex items-center gap-2 font-sans text-body-sm font-semibold text-white">
                  <sd-icon name="message-square" [size]="16" class="text-sky" /> Chat
                </span>
                <button
                  type="button"
                  class="text-white/50 transition-colors hover:text-white"
                  aria-label="Close chat"
                  (click)="chatOpen.set(false)"
                >
                  <sd-icon name="x" [size]="16" />
                </button>
              </div>
              <div class="flex max-h-52 min-h-24 flex-col gap-2 overflow-y-auto px-4 py-3">
                @for (m of messages(); track $index) {
                  <div class="flex flex-col" [class.items-end]="m.mine">
                    <span
                      class="max-w-[80%] rounded-2xl px-3 py-2 font-sans text-body-sm"
                      [class]="m.mine ? 'bg-cerulean text-white' : 'bg-white/10 text-white/90'"
                    >
                      {{ m.text }}
                    </span>
                    <span class="mt-0.5 font-sans text-[10px] text-white/40">{{ m.time }}</span>
                  </div>
                } @empty {
                  <p class="py-4 text-center font-sans text-caption text-white/40">
                    No messages yet. Say hello 👋
                  </p>
                }
              </div>
              <div class="flex items-center gap-2 border-t border-white/10 px-3 py-2.5">
                <input
                  type="text"
                  placeholder="Type a message…"
                  class="min-w-0 flex-1 bg-transparent px-2 font-sans text-body-sm text-white placeholder:text-white/40 focus:outline-none"
                  [value]="draft()"
                  (input)="draft.set($any($event.target).value)"
                  (keydown.enter)="sendMessage()"
                />
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-full bg-cerulean text-white transition-colors hover:bg-cerulean-dark disabled:opacity-40"
                  aria-label="Send message"
                  [disabled]="!draft().trim()"
                  (click)="sendMessage()"
                >
                  <sd-icon name="arrow-right" [size]="16" />
                </button>
              </div>
            </div>
          }

          <!-- Consultation notes -->
          <div class="rounded-card border border-white/10 bg-white/[0.03]">
            <div class="flex gap-1 overflow-x-auto border-b border-white/10 px-2">
              @for (t of notesTabs; track t.key) {
                <button
                  type="button"
                  class="relative whitespace-nowrap px-3 py-3 font-sans text-body-sm transition-colors"
                  [class]="notesTab() === t.key ? 'text-white' : 'text-white/50 hover:text-white/80'"
                  (click)="openNotesTab(t.key)"
                >
                  {{ t.label }}
                  @if (t.key === 'prescriptions' && newRx()) {
                    <span class="absolute right-0 top-2 size-2 rounded-full bg-cerulean" aria-label="New prescription"></span>
                  }
                  @if (notesTab() === t.key) {
                    <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                  }
                </button>
              }
            </div>

            <!-- Height changes ease and each tab fades in, instead of jumping. -->
            <div class="p-4" sdSmoothHeight>
              <div>
              @for (shown of [notesTab()]; track shown) {
              <div class="sd-tab-panel">
              @switch (notesTab()) {
                @case ('notes') {
                  <div class="grid gap-5 sm:grid-cols-2">
                    <div class="flex flex-col gap-4">
                      <div>
                        <h4 class="font-sans text-body-sm font-semibold text-white">
                          Today’s Visit Summary
                        </h4>
                        <p class="mt-1.5 font-sans text-body-sm leading-relaxed text-white/60">
                          {{ visitSummary() }}
                        </p>
                        @if (summaryReady() && summary()?.author) {
                          <p class="mt-1 font-sans text-caption text-white/40">
                            Finalized by {{ summary()?.author }}
                          </p>
                        }
                      </div>
                      @if (assessmentText()) {
                        <div>
                          <h4 class="font-sans text-body-sm font-semibold text-white">Assessment</h4>
                          <p class="mt-1.5 font-sans text-body-sm leading-relaxed text-white/60">
                            {{ assessmentText() }}
                          </p>
                        </div>
                      } @else if (conditions().length) {
                        <div>
                          <h4 class="font-sans text-body-sm font-semibold text-white">Assessment</h4>
                          <ul class="mt-1.5 flex flex-col gap-1">
                            @for (c of conditions(); track c.condition) {
                              <li class="font-sans text-body-sm text-white/60">
                                {{ c.condition }}
                                <span class="text-white/40">– {{ c.status || 'noted' }}</span>
                              </li>
                            }
                          </ul>
                        </div>
                      }
                    </div>

                    <div class="flex flex-col gap-4">
                      <div>
                        <h4 class="font-sans text-body-sm font-semibold text-white">Next Steps</h4>
                        <ul class="mt-1.5 flex list-disc flex-col gap-1 pl-4">
                          @for (s of nextSteps(); track s) {
                            <li class="font-sans text-body-sm text-white/60">{{ s }}</li>
                          }
                        </ul>
                      </div>
                      <button
                        type="button"
                        class="flex items-center justify-between gap-3 rounded-2xl border border-cerulean/40 bg-cerulean/10 px-4 py-3 text-left transition-colors hover:bg-cerulean/20"
                        (click)="goAppointments()"
                      >
                        <span class="flex items-center gap-3">
                          <sd-icon name="calendar-clock" [size]="20" class="text-frost" />
                          <span class="flex flex-col">
                            <span class="font-sans text-body-sm font-medium text-white">
                              {{ scheduledLabel() }}
                            </span>
                            <span class="font-sans text-caption text-white/50">
                              {{ appointment()?.type_label || 'Consultation' }}
                            </span>
                          </span>
                        </span>
                        <sd-icon name="chevron-right" [size]="18" class="text-white/50" />
                      </button>
                    </div>
                  </div>
                }
                @case ('prescriptions') {
                  @if (issuedRx().length) {
                    <div class="flex flex-col gap-3">
                      @for (p of issuedRx(); track p.id) {
                        <div
                          class="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div class="flex min-w-0 items-start gap-3">
                            <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-sky/15 text-sky">
                              <sd-icon name="pill" [size]="18" />
                            </span>
                            <div class="flex min-w-0 flex-col gap-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="font-sans text-body-sm font-semibold text-white">{{ p.number }}</span>
                                <span
                                  class="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 font-sans text-caption font-medium"
                                  [class]="rxStatus(p.status).cls"
                                >
                                  <sd-icon [name]="rxStatus(p.status).icon" [size]="12" />{{ rxStatus(p.status).label }}
                                </span>
                              </div>
                              <span class="font-sans text-caption text-white/60">
                                {{ doctorLabel(p) }}@if (p.valid_until) { · Valid until {{ shortDate(p.valid_until) }} }
                              </span>
                              <span class="font-sans text-[11px] text-white/40">
                                {{ itemsLabel(p) }}@if (p.sent_at) { · Sent {{ rxDate(p.sent_at) }} }
                              </span>
                            </div>
                          </div>
                          <div class="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
                            <button
                              type="button"
                              class="inline-flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption font-semibold text-white/85 transition-colors hover:bg-white/10 disabled:opacity-60"
                              [disabled]="openingRx() === p.id"
                              [attr.aria-label]="'View prescription ' + p.number"
                              (click)="viewRx(p)"
                            >
                              <sd-icon
                                [name]="openingRx() === p.id ? 'loader-circle' : 'eye'"
                                [size]="14"
                                [class.animate-spin]="openingRx() === p.id"
                              />View
                            </button>
                            <!-- The browser blocked the new tab: a direct link (never this tab — it would end the call). -->
                            @if (rxFallback(); as fb) {
                              @if (fb.id === p.id) {
                                <a
                                  [href]="fb.url"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="inline-flex items-center gap-1 rounded-field px-2 py-1.5 font-sans text-caption font-semibold text-sky underline transition-colors hover:text-frost"
                                  [attr.aria-label]="'Open prescription ' + p.number + ' (opens in a new tab)'"
                                >
                                  Open the prescription<sd-icon name="external-link" [size]="13" />
                                </a>
                              }
                            }
                          </div>
                        </div>
                      }
                      @if (rxFallback()) {
                        <p class="flex items-start gap-2 font-sans text-caption text-white/70" role="status">
                          <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
                          Your browser didn’t open a new tab. Use “Open the prescription” — your call keeps running here.
                        </p>
                      }
                      @if (rxError()) {
                        <p class="flex items-start gap-2 font-sans text-caption text-alert" role="alert">
                          <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ rxError() }}
                        </p>
                      }
                      <!-- The details page needs the portal session, which a new tab may not have
                           (sessionStorage sign-ins), and opening it here would end the call. -->
                      <p class="flex items-start gap-2 font-sans text-caption text-white/50">
                        <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
                        Full details are in Prescriptions after your call.
                      </p>
                    </div>
                  } @else if (rxLoadError()) {
                    <p class="flex items-start justify-center gap-2 py-6 text-center font-sans text-body-sm text-alert" role="alert">
                      <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ rxLoadError() }}
                    </p>
                  } @else {
                    <p class="py-5 text-center font-sans text-body-sm text-white/40">
                      No prescriptions yet. If your doctor sends one during this consultation, it will appear here.
                    </p>
                    @if (medications().length) {
                      <h4 class="mt-1 font-sans text-caption font-semibold uppercase tracking-wide text-white/50">
                        Medicines you told us you take
                      </h4>
                      <ul class="flex flex-col divide-y divide-white/10">
                        @for (m of medications(); track $index) {
                          <li class="flex items-center gap-3 py-3">
                            <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-sky/15 text-sky">
                              <sd-icon [name]="isHerbal(m.herbal) ? 'leaf' : 'pill'" [size]="18" />
                            </span>
                            <span class="flex min-w-0 flex-col">
                              <span class="font-sans text-body-sm font-medium text-white">{{ m.name }}</span>
                              <span class="font-sans text-caption text-white/50">
                                {{ m.dosage }}@if (m.frequency) { · {{ m.frequency }} }@if (m.reason) { · for {{ m.reason }} }
                              </span>
                            </span>
                          </li>
                        }
                      </ul>
                    }
                  }
                }
                @case ('labs') {
                  @if (labs().length) {
                    <ul class="flex flex-col gap-2">
                      @for (o of labs(); track o.id) {
                        <li class="rounded-2xl bg-white/[0.04] p-3">
                          <div class="flex items-center justify-between">
                            <span class="flex items-center gap-2 font-sans text-body-sm font-medium text-white">
                              <sd-icon name="clipboard-list" [size]="16" class="text-frost" /> Lab order
                            </span>
                            <span class="rounded-pill bg-warning/15 px-2 py-0.5 font-sans text-[10px] capitalize text-warning">
                              {{ o.status }}
                            </span>
                          </div>
                          <p class="mt-1 font-sans text-body-sm text-white/70">{{ o.tests.join(', ') }}</p>
                          @if (o.author) {
                            <p class="mt-1 font-sans text-caption text-white/40">Ordered by {{ o.author }}</p>
                          }
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="py-6 text-center font-sans text-body-sm text-white/40">
                      No lab orders for this consultation yet.
                    </p>
                  }
                }
                @case ('followup') {
                  <!-- The doctor proposed a follow-up from this call: answered after it -->
                  @for (fu of proposedFollowUps(); track fu.id) {
                    <div class="mb-4 rounded-2xl border border-teal-bright/40 bg-teal-bright/10 px-3 py-3">
                      <p class="flex items-start gap-2 font-sans text-body-sm text-white">
                        <sd-icon name="calendar-plus" [size]="16" class="mt-0.5 shrink-0 text-teal-bright" />
                        Your doctor proposed a follow-up on {{ proposalWhen(fu) }}.
                      </p>
                      <p class="mt-1 pl-6 font-sans text-caption text-white/60">
                        After the call, accept it or choose another time in My Appointments.
                      </p>
                    </div>
                  }
                  @if (carePlan()?.available && (carePlan()?.items?.length ?? 0) > 0) {
                    <div>
                      <h4 class="font-sans text-body-sm font-semibold text-white">Your Care Plan</h4>
                      <ul class="mt-2 flex flex-col gap-1.5">
                        @for (item of carePlan()?.items ?? []; track $index) {
                          <li class="flex items-start gap-2 font-sans text-body-sm text-white/70">
                            <sd-icon name="circle-check" [size]="16" class="mt-0.5 shrink-0 text-sage" />
                            {{ item }}
                          </li>
                        }
                      </ul>
                    </div>
                  } @else {
                    <div class="flex flex-col gap-3">
                      <h4 class="font-sans text-body-sm font-semibold text-white">Follow-up Plan</h4>
                      <ul class="flex list-disc flex-col gap-1 pl-4">
                        @for (s of nextSteps(); track s) {
                          <li class="font-sans text-body-sm text-white/60">{{ s }}</li>
                        }
                      </ul>
                    </div>
                  }
                  @if (referrals().length) {
                    <div class="mt-4 border-t border-white/10 pt-3">
                      <h4 class="mb-2 font-sans text-body-sm font-semibold text-white">Referrals</h4>
                      <ul class="flex flex-col gap-2">
                        @for (r of referrals(); track r.id) {
                          <li class="rounded-2xl bg-white/[0.04] px-3 py-2">
                            <p class="font-sans text-body-sm text-white/85">
                              <span class="capitalize">{{ r.referral_type }}</span> — {{ r.target }}
                            </p>
                            <p class="font-sans text-caption text-white/50">{{ r.reason }}</p>
                          </li>
                        }
                      </ul>
                    </div>
                  }
                }
              }
              </div>
              }
              </div>
            </div>
          </div>
        </div>

        <!-- ============================ RIGHT ============================ -->
        <div class="flex min-w-0 flex-col gap-4">
          <!-- Health summary -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="font-sans text-body font-semibold text-white">Health Summary</h3>
              <button
                type="button"
                class="flex items-center gap-1 font-sans text-caption text-sky transition-colors hover:text-frost"
                (click)="goProfile()"
              >
                View Full Record <sd-icon name="chevron-right" [size]="14" />
              </button>
            </div>

            <div class="grid grid-cols-2 gap-2.5">
              <div class="rounded-2xl bg-white/[0.04] p-3">
                <span class="flex items-center gap-1.5 font-sans text-caption text-alert">
                  <sd-icon name="triangle-alert" [size]="14" /> Allergies
                </span>
                <p class="mt-1 font-sans text-body-sm text-white/85">{{ allergiesLabel() }}</p>
              </div>
              <div class="rounded-2xl bg-white/[0.04] p-3">
                <span class="flex items-center gap-1.5 font-sans text-caption text-sage">
                  <sd-icon name="heart-pulse" [size]="14" /> Conditions
                </span>
                <p class="mt-1 font-sans text-body-sm text-white/85">{{ conditionsLabel() }}</p>
              </div>
              <div class="rounded-2xl bg-white/[0.04] p-3">
                <span class="flex items-center gap-1.5 font-sans text-caption text-sky">
                  <sd-icon name="pill" [size]="14" /> Medications
                </span>
                <p class="mt-1 font-sans text-body-sm text-white/85">{{ medicationsLabel() }}</p>
              </div>
              <div class="rounded-2xl bg-white/[0.04] p-3">
                <span class="flex items-center gap-1.5 font-sans text-caption text-frost">
                  <sd-icon name="calendar-check" [size]="14" /> Last Visit
                </span>
                <p class="mt-1 font-sans text-body-sm text-white/85">{{ lastVisitLabel() }}</p>
              </div>
            </div>
          </div>

          <!-- Latest vitals -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <div class="mb-3 flex items-center justify-between gap-2">
              <h3 class="font-sans text-body font-semibold text-white">Latest Vitals</h3>
              <span class="font-sans text-caption text-white/40">{{ vitalsAsOf() }}</span>
            </div>
            @if (vitals().length) {
              <div class="grid grid-cols-2 gap-2.5">
                @for (v of vitals(); track v.key) {
                  <div class="rounded-2xl bg-white/[0.04] p-3 text-center">
                    <p class="truncate font-sans text-caption text-white/50">{{ v.label }}</p>
                    <p class="mt-0.5 font-heading text-h5 font-semibold text-white">{{ v.value }}</p>
                    <p class="font-sans text-[10px] text-white/40">{{ v.unit }}</p>
                    @if (v.stale) {
                      <p class="mt-1 font-sans text-[10px] text-warning">May be out of date</p>
                    }
                  </div>
                }
              </div>
            } @else {
              <p class="font-sans text-caption text-white/50">
                No readings yet. You can add them in My Profile › Medical Information
                after your visit.
              </p>
            }
          </div>

          <!-- Documents & records (sd-share: readable sharing accents in the light cockpit, styles.css) -->
          <div class="sd-share rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-1 font-sans text-body font-semibold text-white">Documents &amp; Records</h3>
            <p class="sr-only" aria-live="polite" aria-atomic="true">{{ docShareLive() }}</p>
            <!-- What this doctor can see (they only see what the patient shares) -->
            @if (docAccess(); as da) {
              <div class="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p class="font-sans text-caption text-white/70">Shared with {{ docDoctor() }}: {{ sharedCount() }}</p>
                <a href="/dashboard/documents/sharing" target="_blank" rel="noopener" class="inline-flex min-h-11 items-center gap-1 font-sans text-caption font-semibold text-sky transition-colors hover:text-white" aria-label="Manage sharing (opens in a new tab)">
                  Manage<sd-icon name="external-link" [size]="14" />
                </a>
              </div>
            } @else if (docAccessOff()) {
              <p class="mb-3 flex items-start gap-1.5 font-sans text-caption text-white/60">
                <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />{{ sharingOffText }}
              </p>
            } @else if (!docAccessError()) {
              <div class="mb-3"></div>
            }
            @if (docAccessError()) {
              <div class="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p class="flex items-start gap-1.5 font-sans text-caption text-alert" role="alert">
                  <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />Could not {{ docAccess() ? 'refresh' : 'load' }} what you share with {{ docDoctor() }}.
                </p>
                <button type="button" class="inline-flex min-h-11 items-center rounded-field border border-white/15 px-4 font-sans text-caption font-semibold text-white/85 transition-colors hover:bg-white/10" (click)="retryDocAccess()">Try again</button>
              </div>
            }
            @if (pendingDocRequest(); as pr) {
              <div class="mb-3 flex flex-col gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-3" role="status">
                <p class="flex items-start gap-2 font-sans text-body-sm text-white">
                  <sd-icon name="key-round" [size]="16" class="mt-0.5 shrink-0 text-warning" />{{ docDoctor() }} asked to see your documents
                </p>
                <div class="flex flex-wrap gap-2 pl-6">
                  <button type="button" class="inline-flex min-h-11 items-center rounded-field bg-cerulean px-4 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean" (click)="reviewDocRequest.set(pr)">Review</button>
                  <button type="button" class="inline-flex min-h-11 items-center rounded-field border border-white/15 px-4 font-sans text-caption font-semibold text-white/85 transition-colors hover:bg-white/10" (click)="dismissedRequest.set(pr.id)">Not now</button>
                </div>
              </div>
            }
            @if (docShareNotice()) {
              <p class="mb-3 flex items-start gap-1.5 font-sans text-caption text-success">
                <sd-icon name="circle-check" [size]="14" class="mt-0.5 shrink-0" />{{ docShareNotice() }}
              </p>
            }
            <div class="mb-3 flex gap-1 overflow-x-auto">
              @for (t of docsTabs; track t.key) {
                <button
                  type="button"
                  class="whitespace-nowrap rounded-pill px-3 py-1.5 font-sans text-caption transition-colors"
                  [class]="docsTab() === t.key ? 'bg-cerulean text-white' : 'bg-white/[0.04] text-white/60 hover:bg-white/10'"
                  (click)="docsTab.set(t.key)"
                >
                  {{ t.label }}
                </button>
              }
            </div>
            @if (visibleRecords().length) {
              <ul class="flex flex-col divide-y divide-white/10">
                @for (r of visibleRecords(); track r.docId ?? r.title) {
                  <li class="flex flex-col gap-2 py-2.5">
                    <div class="flex items-center gap-3">
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-white/70">
                        <sd-icon [name]="r.kind === 'imaging' ? 'camera' : 'file-text'" [size]="18" />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate font-sans text-body-sm font-medium text-white">{{ r.title }}</span>
                        <span class="flex flex-wrap items-center gap-x-2 font-sans text-caption text-white/45">
                          {{ r.date }}
                          @if (shareState(r); as st) {
                            @if (st === 'shared') {
                              <span class="inline-flex items-center gap-1 rounded-pill bg-white/[0.06] px-2 py-0.5 text-frost"><sd-icon name="share-2" [size]="12" />Shared</span>
                            } @else {
                              <span class="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-white/50"><sd-icon name="lock" [size]="12" />Private</span>
                            }
                          }
                        </span>
                      </span>
                      <span class="rounded bg-white/[0.06] px-1.5 py-0.5 font-label text-[10px] text-white/60">
                        {{ r.badge }}
                      </span>
                      <button
                        type="button"
                        class="flex size-11 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
                        [attr.aria-label]="'Open ' + r.title"
                        [disabled]="!r.url && !r.docId"
                        (click)="download(r)"
                      >
                        <sd-icon name="download" [size]="16" />
                      </button>
                    </div>
                    @if (shareState(r) === 'private' && canShareInCall()) {
                      <button
                        type="button"
                        class="ml-12 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-field border border-white/15 px-3 font-sans text-caption font-semibold text-white/85 transition-colors hover:bg-white/10"
                        [attr.aria-label]="'Share ' + r.title + ' with ' + docDoctor()"
                        (click)="confirmShare.set(r)"
                      >
                        <sd-icon name="share-2" [size]="14" />Share with your doctor
                      </button>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="py-5 text-center font-sans text-body-sm text-white/40">
                No documents in this category.
              </p>
            }
          </div>

          <!-- Privacy & consent -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-1 flex items-center gap-1.5 font-sans text-body font-semibold text-white">
              <sd-icon name="shield-check" [size]="16" class="text-frost" /> Privacy &amp; Consent
            </h3>
            <p class="mb-2 font-sans text-caption text-white/45">
              You choose what happens in this consultation.
            </p>
            @for (c of consentRows; track c.type) {
              <div class="flex items-center justify-between gap-2 py-1.5">
                <span class="font-sans text-body-sm text-white/80">{{ c.label }}</span>
                <button
                  type="button"
                  role="switch"
                  [attr.aria-checked]="consentGranted(c.type)"
                  [attr.aria-label]="c.label"
                  class="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60"
                  [class]="consentGranted(c.type) ? 'bg-success' : 'bg-white/15'"
                  [disabled]="consentBusy() === c.type"
                  (click)="toggleConsent(c.type)"
                >
                  <span
                    class="absolute top-0.5 size-5 rounded-full bg-white transition-all"
                    [class]="consentGranted(c.type) ? 'left-[22px]' : 'left-0.5'"
                  ></span>
                </button>
              </div>
            }
            @if (consentError()) {
              <p class="mt-1 font-sans text-caption text-alert" role="alert">{{ consentError() }}</p>
            }
          </div>

          <!-- Feedback: a review needs a completed consultation, so it is only
               offered once the doctor has ended it. -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4 text-center">
            <p class="font-sans text-body-sm font-medium text-white">How was your consultation?</p>
            @if (canRate()) {
              <div class="mt-2 flex items-center justify-center gap-0.5" role="group" aria-label="Rate your consultation">
                @for (n of stars; track n) {
                  <button
                    type="button"
                    class="flex size-11 items-center justify-center transition-transform hover:scale-110 disabled:hover:scale-100"
                    [attr.aria-label]="'Rate ' + n + ' star' + (n === 1 ? '' : 's')"
                    [attr.aria-pressed]="n === rating()"
                    [disabled]="reviewState() === 'sending' || reviewState() === 'done'"
                    (click)="rate(n)"
                  >
                    <sd-icon
                      name="star"
                      [size]="24"
                      [class]="n <= rating() ? 'text-warning' : 'text-white/25'"
                    />
                  </button>
                }
              </div>
              @switch (reviewState()) {
                @case ('sending') {
                  <p class="mt-1.5 font-sans text-caption text-white/60" role="status">Sending your rating…</p>
                }
                @case ('done') {
                  <p class="mt-1.5 font-sans text-caption text-success" role="status">{{ reviewNote() || 'Thanks for your feedback!' }}</p>
                }
                @case ('error') {
                  <p class="mt-1.5 font-sans text-caption text-alert" role="alert">{{ reviewNote() }}</p>
                }
                @default {
                  <p class="mt-1.5 font-sans text-caption text-white/45">Your feedback helps us improve</p>
                }
              }
            } @else {
              <p class="mt-1.5 font-sans text-caption text-white/45">
                Once your doctor ends the consultation, you can rate it from your consultation history.
              </p>
            }
          </div>
        </div>
      </div>
      }

      <!-- Invite someone, without leaving the call (inside .sd-call so it follows the cockpit theme) -->
      @if (inviteOpen()) {
        <pat-invite-guest-dialog
          [appointmentId]="appointmentId"
          [detailsUrl]="detailsUrl()"
          [walletUrl]="walletUrl()"
          [liveGuestIds]="liveGuestIds()"
          (added)="guestAdded($event)"
          (closed)="inviteOpen.set(false)"
        />
      }

      <!-- Document sharing with this doctor, in the cockpit's colours -->
      @if (confirmShare(); as r) {
        @if (docAccess(); as da) {
          <pat-share-confirm-sheet
            [documentId]="r.docId ?? ''"
            [documentTitle]="r.title"
            [doctorId]="da.specialist.id"
            [doctorName]="da.specialist.name"
            [appointment]="da.appointment"
            (done)="docShared($event)"
            (more)="shareMore.set(r.docId ?? null)"
            (closed)="confirmShare.set(null)"
          />
        }
      }
      @if (shareMore() !== null && docAccess(); as da) {
        <pat-share-dialog
          [preselectDoctorIds]="[da.specialist.id]"
          [preselectDocumentIds]="shareMore() ? [shareMore() ?? ''] : []"
          [lockDoctor]="true"
          [appointment]="da.appointment"
          [answersRequest]="pendingDocRequest()"
          initialDuration="after_24h"
          surface="call"
          theme="call"
          (done)="docShared($event)"
          (closed)="shareMore.set(null)"
        />
      }
      @if (reviewDocRequest(); as rq) {
        <pat-approve-request-dialog [request]="rq" theme="call" (done)="docRequestAnswered($event)" (closed)="reviewDocRequest.set(null)" />
      }
    </div>
  `,
})
export class ConsultationCall implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);
  private readonly patientApi = inject(PatientApi);
  private readonly documentsApi = inject(DocumentsApi);
  private readonly prescriptionsApi = inject(PrescriptionsApi);
  /** Paused while connected so the idle timeout never signs a patient out mid-call. */
  private readonly session = inject(SessionTimeoutService);
  /** Bearer token for the presence heartbeat (a raw fetch, outside the interceptors). */
  private readonly auth = inject(AuthService);
  /** "Leave the consultation?" before a live call is left. */
  private readonly dialogs = inject(DialogService);

  private readonly previewVideo = viewChild<ElementRef<HTMLVideoElement>>('previewVideo');
  /** The stage's video tiles (rendered once the patient enters the call). */
  private readonly stageTiles = viewChild(CallTilesComponent);

  // ---- Call state ----
  protected readonly status = signal<'loading' | 'in-call' | 'ended' | 'error'>('loading');
  protected readonly errorMessage = signal('');
  /** Why the call ended on its own (set with status 'ended'). */
  protected readonly endedReason = signal<CallEndReason>('dropped');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly screenOn = signal(false);
  /** The microphone / camera opened (a missing or blocked one leaves an audio-only or listen-only call). */
  private readonly hasMic = signal(false);
  private readonly hasCam = signal(false);
  /** Why a camera / microphone isn't in the call ('' when both are). */
  protected readonly deviceNotice = signal('');
  /** The microphone / camera is on and actually open (what the call buttons show). */
  protected readonly micLive = computed(() => this.micOn() && this.hasMic());
  protected readonly camLive = computed(() => this.camOn() && this.hasCam());
  /** Everyone else who was in the call has left it. */
  protected readonly remoteLeft = signal(false);
  /** Someone other than the doctor (a guest) has been in this connection. */
  private readonly guestSeen = signal(false);
  protected readonly moreOpen = signal(false);
  protected readonly elapsed = signal(0);

  // ---- Who is on the stage ----
  /** Everyone who may be in the call, by Agora uid (names only) — from the call token and each heartbeat. */
  private readonly participants = signal<readonly CallParticipantDto[]>([]);
  /** The other people connected (per uid: video, audio, speaking). */
  private readonly remoteList = signal<readonly RemoteParticipant[]>([]);
  private readonly remotes = new RemoteParticipants((list) => this.remoteList.set(list));
  private unbindRemotes?: () => void;
  /** The uid the patient joined as ('self' when Agora assigned one). */
  private readonly selfUid = signal<CallUid>('self');
  /** Video handed to the stage, by uid — replayed if the tiles are (re)created. */
  private readonly videos = new Map<string, { uid: CallUid; track: CallVideoTrack; config?: CallVideoPlayConfig }>();
  /** Guest ids in the call now (the heartbeat's presence). */
  protected readonly liveGuestIds = signal<readonly string[]>([]);
  protected readonly inviteOpen = signal(false);

  /** Who to name on each tile: the call's participants, or at least the doctor from the appointment. */
  private readonly roster = computed(() => {
    const list = this.participants();
    return list.length ? list : [{ uid: DOCTOR_CALL_UID, role: 'doctor' as const, name: this.doctorName() }];
  });
  protected readonly tiles = computed(() =>
    buildCallTiles({
      remotes: this.remoteList(),
      roster: this.roster(),
      self:
        this.status() === 'in-call'
          ? {
              uid: this.selfUid(),
              role: 'patient',
              name: this.patientName(),
              hasVideo: this.screenOn() || (this.camOn() && this.hasCam()),
              muted: !(this.micOn() && this.hasMic()),
            }
          : null,
    }),
  );
  protected readonly stageMode = computed(() => callTilesMode(this.tiles()));
  /** The other person on the 1:1 stage (null while nobody else is here). */
  protected readonly spotlight = computed(() => this.tiles().find((t) => !t.self) ?? null);
  protected readonly hasRemoteTile = computed(() => this.spotlight() !== null);
  /** The doctor is connected (by their uid in the participants). */
  protected readonly doctorHere = computed(() => {
    const doctorUid = this.roster().find((p) => p.role === 'doctor')?.uid ?? DOCTOR_CALL_UID;
    return this.remoteList().some((r) => String(r.uid) === String(doctorUid));
  });
  protected readonly leftText = computed(() =>
    this.guestSeen() ? 'Everyone else has left the call' : `${this.doctorName()} has left the call`,
  );
  private readonly patientName = computed(() => {
    const p = this.patient();
    return [p?.first_name, p?.last_name].filter(Boolean).join(' ') || 'You';
  });
  /** The appointment page / wallet, opened from the invite dialog in a new tab (the call keeps running). */
  protected detailsUrl(): string {
    return this.router.serializeUrl(this.router.createUrlTree(['/dashboard/appointments', this.appointmentId]));
  }

  protected walletUrl(): string {
    return this.router.serializeUrl(this.router.createUrlTree(['/dashboard/wallet']));
  }

  /** Cockpit light/dark theme (chrome only; the video stage stays dark). */
  protected readonly theme = signal<'dark' | 'light'>(this.readTheme());

  protected toggleTheme(): void {
    const next = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    try {
      localStorage.setItem('videomed.call.theme', next);
    } catch {
      /* preference is best-effort */
    }
  }

  private readTheme(): 'dark' | 'light' {
    try {
      return localStorage.getItem('videomed.call.theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  // ---- Chat ----
  protected readonly chatOpen = signal(false);
  protected readonly draft = signal('');
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly unreadChat = signal(0);

  // ---- Panels ----
  protected readonly notesTab = signal<NotesTab>('notes');
  protected readonly docsTab = signal<DocsTab>('all');
  protected readonly rating = signal(0);
  /** The star rating, sent as a review once the doctor has completed the visit. */
  protected readonly reviewState = signal<'idle' | 'sending' | 'done' | 'error'>('idle');
  /** The thanks / "already rated" / error line under the stars. */
  protected readonly reviewNote = signal('');

  protected readonly notesTabs: ReadonlyArray<{ key: NotesTab; label: string }> = [
    { key: 'notes', label: 'Consultation Notes' },
    { key: 'prescriptions', label: 'Prescriptions' },
    { key: 'labs', label: 'Lab Orders' },
    { key: 'followup', label: 'Follow-up Plan' },
  ];
  protected readonly docsTabs: ReadonlyArray<{ key: DocsTab; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'labs', label: 'Lab Results' },
    { key: 'imaging', label: 'Imaging' },
    { key: 'reports', label: 'Reports' },
  ];
  protected readonly stars = [1, 2, 3, 4, 5];
  protected readonly consentRows: ReadonlyArray<{ type: ConsentDto['type']; label: string }> = [
    { type: 'recording', label: 'Allow recording' },
    { type: 'ai_transcription', label: 'AI transcription' },
    { type: 'data_sharing', label: 'Share with care team' },
  ];

  // ---- Data ----
  protected readonly appointment = signal<AppointmentDto | null>(null);
  /**
   * A review needs a completed consultation (the API refuses anything else),
   * so the stars are offered only once the doctor has ended it.
   */
  protected readonly canRate = computed(
    () => this.status() === 'ended' && this.endedReason() === 'completed' && this.appointment()?.status === 'completed',
  );
  private readonly patient = signal<PatientProfileDto | null>(null);
  private readonly health = signal<HealthProfileDto | null>(null);
  // The doctor's finalized write-up (available:false until they sign it).
  protected readonly summary = signal<ConsultationSummaryDto | null>(null);
  // Prescriptions the doctor has issued for this consultation.
  protected readonly issuedRx = signal<PrescriptionDto[]>([]);
  protected readonly labs = signal<LabOrderDto[]>([]);
  protected readonly carePlan = signal<PatientCarePlanDto | null>(null);
  protected readonly referrals = signal<ReferralDto[]>([]);
  /** Follow-ups the doctor proposed from this call, waiting for the patient's answer. */
  protected readonly proposedFollowUps = signal<AppointmentDto[]>([]);
  /** This is a follow-up proposal the patient hasn't accepted — there is no call to join yet. */
  protected readonly awaitingAcceptance = signal(false);
  /** A prescription arrived during the call while the patient was on another tab. */
  protected readonly newRx = signal(false);
  /** Guards the newRx badge so the first (baseline) fetch never flags pre-existing scripts. */
  private rxInitialized = false;
  /** Prescription ids already seen, so only genuinely new ones are announced. */
  private readonly knownRx = new Set<string>();
  /** The first prescriptions fetch failed (so "none yet" isn't shown for a failure). */
  protected readonly rxLoadError = signal('');
  /** Opening a prescription PDF failed. */
  protected readonly rxError = signal('');
  /** Id of the prescription whose PDF link is being fetched. */
  protected readonly openingRx = signal('');
  /** The browser blocked the PDF tab: offer this signed link instead (never this tab). */
  protected readonly rxFallback = signal<{ id: string; url: string } | null>(null);
  private rxFallbackTimer?: ReturnType<typeof setTimeout>;
  /** "Dr X sent you prescription GVM-RX-…" notice. */
  protected readonly rxToast = signal<RxToast | null>(null);
  private rxToastTimer?: ReturnType<typeof setTimeout>;
  protected readonly consents = signal<ConsentDto[]>([]);
  protected readonly consentBusy = signal<string>('');
  protected readonly consentError = signal('');
  protected readonly recordingActive = signal(false);
  // Live captions / patient-side transcription.
  protected readonly captionsOn = signal(false);
  protected readonly captions = signal<TranscriptSegmentDto[]>([]);
  protected readonly speechSupported = signal(this.detectSpeech());
  protected readonly aiConsentGranted = computed(
    () => this.consents().find((c) => c.type === 'ai_transcription')?.granted ?? false,
  );

  // ---- Derived: people ----
  protected readonly doctorName = computed(
    () => this.appointment()?.specialist?.name ?? 'your specialist',
  );
  protected readonly doctorSpecialty = computed(
    () => this.appointment()?.specialist?.specialty ?? '',
  );
  protected readonly doctorInitials = computed(() =>
    this.doctorName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  // ---- Derived: health summary ----
  private readonly allergies = computed<AllergyRow[]>(
    () => this.health()?.medical?.allergies ?? [],
  );
  protected readonly conditions = computed<ConditionRow[]>(
    () => this.health()?.medical?.conditions ?? [],
  );
  protected readonly medications = computed<MedicationRow[]>(
    () => this.health()?.medical?.medications ?? [],
  );
  protected readonly allergiesLabel = computed(() =>
    this.allergies().length
      ? this.allergies().map((a) => a.allergen).join(', ')
      : 'None recorded',
  );
  protected readonly conditionsLabel = computed(() =>
    this.conditions().length
      ? this.conditions().map((c) => c.condition).join(', ')
      : 'None recorded',
  );
  protected readonly medicationsLabel = computed(() =>
    this.medications().length
      ? this.medications().map((m) => m.name).join(', ')
      : 'None recorded',
  );
  protected readonly lastVisitLabel = computed(() => {
    const hist = this.health()?.medical?.history ?? [];
    const latest = hist[0];
    return latest ? `${latest.condition}${latest.year ? ' · ' + latest.year : ''}` : '—';
  });

  // Prefer the doctor's finalized note; fall back to the patient's booking reason.
  protected readonly visitSummary = computed(
    () =>
      this.summary()?.subjective?.trim() ||
      this.appointment()?.notes?.trim() ||
      'Your consultation notes will appear here once your specialist finalizes them.',
  );
  protected readonly assessmentText = computed(() => this.summary()?.assessment?.trim() ?? '');
  protected readonly summaryReady = computed(() => this.summary()?.available === true);
  protected readonly nextSteps = computed<string[]>(() => {
    const plan = this.summary()?.plan?.trim();
    if (plan) {
      return plan
        .split(/\r?\n|\.\s+/)
        .map((s) => s.trim().replace(/\.$/, ''))
        .filter(Boolean)
        .slice(0, 6);
    }
    const steps: string[] = [];
    if (this.medications().length) steps.push('Continue current medications as prescribed');
    if (this.conditions().length) steps.push('Monitor and log symptoms at home');
    steps.push('Book a follow-up if symptoms persist');
    return steps;
  });

  /** A proposed follow-up's start, "Tue 21 Oct, 3:00 PM" in local time. */
  protected proposalWhen(a: AppointmentDto): string {
    return whenLabel(a.scheduled_at);
  }

  protected readonly scheduledLabel = computed(() => {
    const iso = this.appointment()?.scheduled_at;
    if (!iso) return 'Upcoming appointment';
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? 'Upcoming appointment'
      : new Intl.DateTimeFormat('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(d);
  });

  protected readonly elapsedLabel = computed(() => {
    const t = this.elapsed();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
  });

  // Vitals: the patient's latest reading of each type (GET /api/portal/me/vitals,
  // loaded once in-call) — never fabricated values.
  protected readonly vitals = signal<VitalReadingDto[]>([]);
  protected readonly vitalsAsOf = computed(() => {
    const times = this.vitals()
      .map((v) => Date.parse(v.taken_at ?? ''))
      .filter((t) => !Number.isNaN(t));
    if (!times.length) return 'Not yet recorded';
    return `As of ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(Math.max(...times))}`;
  });
  /** The patient's medical-document library (loaded once in-call). */
  private readonly libraryDocs = signal<MedicalDocumentDto[]>([]);

  // ---- Document sharing with this consultation's doctor ----
  // No new interval: the 15 s appointment poll carries `pending_document_request`;
  // what the doctor can see is read at start, after the patient's own share
  // actions, when that request changes, and (passively) when a share ends.
  private readonly sharingApi = inject(DocumentSharingApi);
  protected readonly docAccess = signal<AppointmentDocumentAccessDto | null>(null);
  /** 503 `sharing_unavailable`: sharing is switched off. */
  protected readonly docAccessOff = signal(false);
  /** The last read failed some other way (shown with "Try again"). */
  protected readonly docAccessError = signal(false);
  protected readonly sharingOffText = SHARING_UNAVAILABLE;
  /** A private row's "Share with your doctor" (the confirm sheet). */
  protected readonly confirmShare = signal<RecordItem | null>(null);
  /** The full Share dialog ('' = no document preselected). */
  protected readonly shareMore = signal<string | null>(null);
  protected readonly reviewDocRequest = signal<DocumentAccessRequestDto | null>(null);
  /** "Not now": hidden for this visit only. */
  protected readonly dismissedRequest = signal<string | null>(null);
  protected readonly docShareNotice = signal('');
  protected readonly docShareLive = signal('');
  private docAccessTimer?: ReturnType<typeof setTimeout>;
  /** The pending request id the poll last carried (undefined until the first poll). */
  private lastDocRequestId: string | null | undefined = undefined;
  protected readonly docDoctor = computed(() =>
    doctorTitle(this.docAccess()?.specialist.name ?? this.appointment()?.specialist.name),
  );
  private readonly visibleDocIds = computed(
    () => new Set((this.docAccess()?.visible_documents ?? []).map((d) => d.id)),
  );
  /** "Shared with Dr X: 3 | all | none". */
  protected readonly sharedCount = computed(() => {
    const a = this.docAccess()?.access;
    if (!a || a.state === 'none') return 'none';
    if (a.state === 'paused') return 'paused';
    return a.scope === 'all' ? 'all' : String(a.document_count);
  });
  protected readonly canShareInCall = computed(() => !!this.docAccess()?.can_share);
  /** The doctor's pending request: from the poll when the API sends it, else from the panel's read. */
  protected readonly pendingDocRequest = computed<DocumentAccessRequestDto | null>(() => {
    const fromPoll = this.appointment()?.pending_document_request;
    const r = fromPoll !== undefined ? fromPoll : (this.docAccess()?.pending_request ?? null);
    if (!r || r.status !== 'pending' || r.id === this.dismissedRequest()) return null;
    return r;
  });
  /** A new (or answered) request on the poll: read what the doctor can see again, passively. */
  private readonly watchDocRequest = effect(() => {
    const id = this.appointment()?.pending_document_request?.id ?? null;
    untracked(() => {
      if (this.lastDocRequestId !== undefined && id !== this.lastDocRequestId) void this.loadDocAccess(true);
      this.lastDocRequestId = id;
    });
  });

  /** A library row's sharing chip relative to this doctor (null: not a library file, or unknown). */
  protected shareState(r: RecordItem): 'shared' | 'private' | null {
    if (!r.docId || !this.docAccess()) return null;
    return this.visibleDocIds().has(r.docId) ? 'shared' : 'private';
  }

  private async loadDocAccess(passive = false): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    clearTimeout(this.docAccessTimer);
    try {
      const res = await firstValueFrom(this.sharingApi.forAppointment(this.appointmentId, { passive }));
      this.docAccess.set(res.data);
      this.docAccessOff.set(false);
      this.docAccessError.set(false);
      const at = res.data.access.next_change_at ? Date.parse(res.data.access.next_change_at) : NaN;
      if (!isNaN(at)) {
        const delay = Math.min(Math.max(at - Date.now() + 1000, 1000), 24 * 60 * 60_000);
        this.docAccessTimer = setTimeout(() => void this.loadDocAccess(true), delay);
      }
    } catch (err: unknown) {
      if (isSharingUnavailable(err)) {
        this.docAccessOff.set(true);
        this.docAccess.set(null);
        this.docAccessError.set(false);
        return;
      }
      // Offline, a server hiccup…: say so with "Try again" (what was shown,
      // if anything, stays — it may be out of date). A signed-out session
      // stays quiet: the session layer handles that.
      if (this.auth.isAuthenticated()) this.docAccessError.set(true);
    }
  }

  /** "Try again" after the panel could not read what the doctor can see. */
  protected retryDocAccess(): void {
    this.docAccessError.set(false);
    void this.loadDocAccess();
  }

  private docSay(text: string): void {
    this.docShareNotice.set(text);
    this.docShareLive.set(text);
  }

  protected docShared(result: DocumentShareResultDto | DocumentGrantDto): void {
    this.docSay('outcomes' in result ? shareResultLine(result) : 'Changes saved.');
    if ('outcomes' in result && result.approved_request_ids.length > 0) {
      this.dismissedRequest.set(result.approved_request_ids[0]);
    }
    void this.loadDocAccess();
  }

  protected docRequestAnswered(outcome: ApproveOutcome): void {
    if (outcome.kind !== 'stale') this.dismissedRequest.set(outcome.request.id);
    const line = approveOutcomeLine(outcome);
    if (line) this.docSay(line);
    void this.loadDocAccess();
  }

  private readonly records = computed<RecordItem[]>(() => {
    const list: RecordItem[] = [];
    const doc = this.appointment()?.document_url ?? null;
    if (doc) {
      list.push({
        title: 'Booking attachment',
        date: 'This appointment',
        kind: 'reports',
        badge: 'FILE',
        url: this.patientApi.assetUrl(doc),
      });
    }
    for (const d of this.libraryDocs()) {
      list.push({
        title: d.title,
        date: this.rxDate(d.created_at),
        kind: this.docKind(d.document_type),
        badge: d.extension.toUpperCase(),
        url: null,
        docId: d.id,
      });
    }
    return list;
  });

  private docKind(type: string): DocsTab {
    if (['xray_report', 'ct_scan_report', 'mri_report', 'ultrasound_report', 'echocardiogram_report', 'radiology_report'].includes(type)) {
      return 'imaging';
    }
    if (['laboratory_test_report', 'blood_test_report', 'urine_test_report', 'pathology_report', 'histopathology_report', 'biopsy_report', 'genetic_test_report'].includes(type)) {
      return 'labs';
    }
    return 'reports';
  }
  protected readonly visibleRecords = computed(() => {
    const tab = this.docsTab();
    const all = this.records();
    return tab === 'all' ? all : all.filter((r) => r.kind === tab);
  });

  // ---- Waiting room / device test ----
  protected readonly phase = signal<'waiting' | 'live'>('waiting');
  protected readonly micLevel = signal(0); // 0..1 for the level meter
  protected readonly camReady = signal(false);
  protected readonly micReady = signal(false);
  private previewStream?: MediaStream;
  private audioCtx?: AudioContext;
  private meterRaf?: number;

  // ---- Agora ----
  private client?: IAgoraRTCClient;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  private screenTrack?: ILocalVideoTrack;
  private timer?: ReturnType<typeof setInterval>;
  private recordingPoll?: ReturnType<typeof setInterval>;
  private metricsTimer?: ReturnType<typeof setInterval>;
  private captionsPoll?: ReturnType<typeof setInterval>;
  private clinicalPoll?: ReturnType<typeof setInterval>;

  /**
   * Warn before a refresh/close during a live call — reloading drops the patient
   * from the consultation. Armed only while actually in-call.
   */
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (this.status() === 'in-call' && !this.left) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  private recognition?: SpeechRec;
  private netUplink = 0;
  private netDownlink = 0;
  protected appointmentId = '';
  /** The patient pressed End / left the page — final. */
  private left = false;

  // ---- Is a consultation actually going on? (drives the idle-timer hold) ----
  /** Joined to the Agora channel (false again once the call ends or drops). */
  private connected = false;
  /** Whether this page currently holds the idle timer. */
  private holding = false;
  /** Everyone else in the channel right now. */
  private readonly remoteUids = new Set<UID>();
  /** Someone else has been in the channel during this connection. */
  private remoteSeen = false;
  /** The bounded wait for the doctor to first arrive ran out. */
  private firstWaitOver = false;
  private firstWaitTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** The doctor closed the appointment (completed / cancelled). */
  private consultationClosed = false;
  /** Stops the "in the call" heartbeat; set only while one is running. */
  private heartbeatStop?: () => void;

  constructor() {
    // The stage (and its tiles) appears once the patient enters the call: play
    // any video handed over before then — or again if the tiles are re-created.
    effect(() => {
      const tiles = this.stageTiles();
      if (!tiles) return;
      untracked(() => {
        for (const v of this.videos.values()) tiles.attach(v.uid, v.track, v.config);
      });
    });
  }

  ngAfterViewInit(): void {
    this.appointmentId = this.route.snapshot.paramMap.get('id') ?? '';
    window.addEventListener('beforeunload', this.onBeforeUnload);
    // Load the record context up front so the waiting room can show the doctor,
    // and start the device check — but don't join Agora until the patient enters.
    void this.loadContext();
    void this.startDeviceTest();
  }

  /** Patient leaves the waiting room and joins the live consultation. */
  protected enterConsultation(): void {
    if (this.phase() === 'live') return;
    this.stopDeviceTest();
    this.phase.set('live');
    void this.joinCall();
  }

  private async joinCall(): Promise<void> {
    // A fresh connection (first join, or a rejoin after a drop).
    this.resetRemotes();
    this.deviceNotice.set('');
    let client: IAgoraRTCClient | undefined;
    try {
      const { data } = await firstValueFrom(this.appointments.callToken(this.appointmentId));
      if (this.left) return; // left while the token was on its way
      if (data.participants?.length) this.participants.set(data.participants);

      client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      const self = client;
      this.client = self;
      // Per-uid state for the tiles: one person's camera going off never touches anyone else's.
      this.unbindRemotes = this.remotes.bind(self);

      // Presence, not just video: the doctor (or a guest) may join with the camera off.
      self.on('user-joined', (user) => this.onRemoteJoined(self, user.uid));
      self.on('user-left', (user) => {
        this.hideVideo(user.uid);
        this.onRemoteLeft(self, user.uid);
      });
      self.on('user-published', async (user, mediaType) => {
        this.onRemoteJoined(self, user.uid);
        try {
          await self.subscribe(user, mediaType);
        } catch {
          return; // they left or unpublished meanwhile
        }
        if (self !== this.client) return;
        if (mediaType === 'video' && user.videoTrack) this.showVideo(user.uid, user.videoTrack);
        else if (mediaType === 'audio') user.audioTrack?.play();
      });
      self.on('user-unpublished', (user, mediaType) => {
        if (mediaType === 'video') this.hideVideo(user.uid);
      });
      // Long consultations outlive a single token — re-mint and renew in place.
      self.on('token-privilege-will-expire', () => void this.renewToken());
      // Renewal didn't land in time, or Agora dropped us for good (it retries
      // network blips itself, as RECONNECTING): the call is over on this side.
      self.on('token-privilege-did-expire', () => this.callEnded(self, 'dropped'));
      self.on('connection-state-change', (state) => {
        if (state === 'DISCONNECTED') this.callEnded(self, 'dropped');
        else if (state === 'RECONNECTING') this.watchReconnect(self);
        else if (state === 'CONNECTED') this.clearReconnectWatch();
      });
      self.on('network-quality', (s) => {
        this.netUplink = s.uplinkNetworkQuality ?? 0;
        this.netDownlink = s.downlinkNetworkQuality ?? 0;
      });

      // uid 0 from the backend means "wildcard token" → join with null so Agora
      // assigns the uid; any non-zero uid (the patient is 1) is honoured as-is.
      this.selfUid.set(data.uid === 0 ? 'self' : data.uid);
      await self.join(
        data.app_id,
        data.channel,
        data.token ?? null,
        data.uid === 0 ? null : data.uid,
      );
      if (this.left || this.client !== self) return; // left / dropped mid-join
      // Connected: a consultation has long stretches without input, so pause the
      // idle timeout while it is actually going on (see syncHold).
      this.connected = true;
      if (this.remoteUids.size === 0) this.startFirstWait();
      this.syncHold();
      self.enableAudioVolumeIndicator(); // who is speaking, for the grid's rings

      // Each device on its own when both together fail: a missing or blocked
      // camera still leaves an audio-only call (and the other way round).
      const media = await openLocalMedia({ audio: true, video: true });
      if (this.left || this.client !== self) {
        // The call ended while the browser asked for the camera — don't leave it on.
        media.mic?.close();
        media.cam?.close();
        return;
      }
      this.micTrack = media.mic ?? undefined;
      this.camTrack = media.cam ?? undefined;
      this.hasMic.set(!!media.mic);
      this.hasCam.set(!!media.cam);
      this.deviceNotice.set(this.mediaNotice(media.camProblem, media.micProblem));

      if (this.camTrack) this.showVideo(this.selfUid(), this.camTrack); // plays once your tile renders
      const tracks = [this.micTrack, this.camTrack].filter((t): t is IMicrophoneAudioTrack | ICameraVideoTrack => !!t);
      if (tracks.length) await self.publish(tracks);
      if (this.left || this.client !== self) return;

      this.status.set('in-call');
      this.startHeartbeat();
      this.startTimer();
      if (this.holding) this.startLivePolls();
    } catch (err) {
      if (this.left || (client && this.client !== client)) return; // already handled
      // Not in a working call — let the idle timeout run again.
      this.connected = false;
      this.stopHeartbeat();
      this.syncHold();
      this.session.release(CALL_HOLD);
      this.clearFirstWait();
      this.clearReconnectWatch();
      const failed = this.client;
      this.client = undefined;
      void this.releaseMedia(failed);
      // A doctor's follow-up proposal has no call until the patient accepts it
      // (`status: proposed` is a flag, so it gets words of its own).
      const awaiting = apiErrorFields(err)['status'] === 'proposed';
      this.awaitingAcceptance.set(awaiting);
      this.errorMessage.set(
        awaiting
          ? 'Accept this follow-up first — there is no call to join until you do.'
          : apiErrorMessage(err, 'We couldn’t start the call. Please try again.'),
      );
      this.status.set('error');
    }
  }

  // ---- Is the consultation still going on? ----

  /**
   * Hold the idle timer only while a consultation is actually going on: joined
   * and someone else is in the call, or (for a bounded time) waiting for the
   * doctor to first arrive. The moment the others leave, the call drops or the
   * patient leaves, the hold is released and the normal idle warning runs again
   * — an ended call left open on a shared computer must still time out. The
   * in-call polling follows the hold, so it doesn't keep the server session warm
   * either.
   */
  private syncHold(): void {
    const want =
      this.connected &&
      !this.left &&
      (this.remoteUids.size > 0 || (!this.remoteSeen && !this.firstWaitOver));
    if (want === this.holding) return;
    this.holding = want;
    if (want) {
      this.session.hold(CALL_HOLD);
      if (this.status() === 'in-call') this.startLivePolls();
    } else {
      this.session.release(CALL_HOLD);
      this.stopLivePolls();
    }
  }

  private onRemoteJoined(client: IAgoraRTCClient, uid: UID): void {
    if (client !== this.client || !this.connectedOrJoining()) return;
    this.remoteUids.add(uid);
    this.remoteSeen = true;
    const doctorUid = this.roster().find((p) => p.role === 'doctor')?.uid ?? DOCTOR_CALL_UID;
    if (String(uid) !== String(doctorUid)) this.guestSeen.set(true);
    this.remoteLeft.set(false);
    this.clearFirstWait();
    this.syncHold();
  }

  private onRemoteLeft(client: IAgoraRTCClient, uid: UID): void {
    if (client !== this.client || !this.remoteUids.delete(uid)) return;
    if (this.remoteUids.size > 0) return;
    // Everyone else has gone: the consultation is over unless they come back.
    this.remoteLeft.set(true);
    this.syncHold();
    if (this.consultationClosed) {
      this.callEnded(client, 'completed');
      return;
    }
    // Pick up anything issued at the end, and whether the doctor closed the visit.
    void this.refreshClinical();
    void this.checkConsultationClosed();
  }

  /** Before `connected` flips, Agora already reports who is in the channel. */
  private connectedOrJoining(): boolean {
    return !this.left && this.status() !== 'ended';
  }

  private startFirstWait(): void {
    this.clearFirstWait();
    this.firstWaitTimer = setTimeout(() => {
      this.firstWaitTimer = undefined;
      this.firstWaitOver = true;
      this.syncHold();
    }, FIRST_JOIN_WAIT_MS);
  }

  private clearFirstWait(): void {
    clearTimeout(this.firstWaitTimer);
    this.firstWaitTimer = undefined;
  }

  /** Agora is retrying a lost connection: end the call if it doesn't come back. */
  private watchReconnect(client: IAgoraRTCClient): void {
    if (client !== this.client || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.callEnded(client, 'dropped');
    }, RECONNECT_GIVE_UP_MS);
  }

  private clearReconnectWatch(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * Has the doctor closed the appointment? Then the call is over as soon as
   * nobody else is in it (a doctor still in the channel may be saying goodbye).
   */
  private async checkConsultationClosed(): Promise<void> {
    // Signed out mid-call (the page leaves once the call ends): nothing to ask the API.
    if (!this.auth.isAuthenticated()) return;
    try {
      const res = await firstValueFrom(this.appointments.getMine(this.appointmentId));
      this.appointment.set(res.data);
      if (res.data.status !== 'completed' && res.data.status !== 'cancelled' && res.data.status !== 'missed') return;
      this.consultationClosed = true;
      if (this.connected && this.remoteUids.size === 0 && this.client) {
        this.callEnded(this.client, 'completed');
      }
    } catch {
      /* try again on the next poll */
    }
  }

  /**
   * The call ended without the patient pressing End: Agora dropped the
   * connection (or the token lapsed), or the consultation was closed and nobody
   * else is left. Release the hold and stop the in-call polling right away, free
   * the camera and microphone, and keep the page (and its notes) readable.
   */
  private callEnded(client: IAgoraRTCClient, reason: CallEndReason): void {
    if (client !== this.client || this.left || !this.connected) return;
    this.connected = false;
    this.stopHeartbeat();
    this.syncHold();
    this.clearFirstWait();
    this.clearReconnectWatch();
    this.stopLivePolls();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopCaptions();
    this.client = undefined;
    void this.releaseMedia(client);
    this.resetRemotes();
    this.screenOn.set(false);
    this.recordingActive.set(false);
    this.inviteOpen.set(false);
    this.endedReason.set(reason);
    this.status.set('ended');
    if (reason === 'completed' && wasReviewed(this.appointmentId)) {
      this.reviewState.set('done');
      this.reviewNote.set('You have already rated this consultation — thank you.');
    }
    // One last look, so the notes show everything issued during the visit.
    void this.refreshClinical();
  }

  /**
   * Tell the API the patient is in the call, so appointment lists (theirs and
   * the doctor's) can show it. Each answer names everyone who may be in the
   * call (a guest invited meanwhile gets their name on their tile) and which
   * guests are here; a refusal (410 — the consultation was closed) ends the
   * call once nobody else is in it. Restarted after a rejoin; never two at once.
   */
  private startHeartbeat(): void {
    if (this.heartbeatStop) return;
    const url = this.appointments.presenceUrl(this.appointmentId);
    const client = this.client;
    this.heartbeatStop = startCallPresence((s) => {
      // Signed out mid-call: a beat without a token is only refused (and logged) — skip it.
      if (!this.auth.isAuthenticated()) return;
      sendCallPresence(url, s, this.authHeader(), {
        onBeat: (beat) => {
          if (client !== this.client) return;
          if (beat.participants?.length) this.participants.set(beat.participants);
          this.liveGuestIds.set(beat.presence?.guests ?? []);
        },
        onRefused: () => {
          if (client === this.client) void this.checkConsultationClosed();
        },
      });
    });
  }

  /** Stop the heartbeat, saying "out" (a no-op when none is running). */
  private stopHeartbeat(): void {
    this.heartbeatStop?.();
    this.heartbeatStop = undefined;
  }

  /** Read on every beat — the access token may have been refreshed mid-call. */
  private authHeader(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** "Rejoin call" after a dropped connection. */
  protected rejoin(): void {
    if (this.left || this.status() !== 'ended' || this.endedReason() !== 'dropped') return;
    this.micOn.set(true);
    this.camOn.set(true);
    this.errorMessage.set('');
    this.status.set('loading');
    void this.joinCall();
  }

  /** Close the local tracks and leave the channel (best-effort). */
  private async releaseMedia(client: IAgoraRTCClient | undefined): Promise<void> {
    const tracks = [this.micTrack, this.camTrack, this.screenTrack];
    this.micTrack = undefined;
    this.camTrack = undefined;
    this.screenTrack = undefined;
    this.hasMic.set(false);
    this.hasCam.set(false);
    this.hideVideo(this.selfUid());
    try {
      for (const t of tracks) t?.close();
      await client?.leave();
    } catch {
      /* releasing devices — nothing actionable on failure */
    }
  }

  // ---- Video tiles ----

  /** Forget everyone else (a new connection, or the call ended). */
  private resetRemotes(): void {
    this.unbindRemotes?.();
    this.unbindRemotes = undefined;
    this.remotes.clear();
    this.remoteUids.clear();
    this.remoteSeen = false;
    this.firstWaitOver = false;
    this.remoteLeft.set(false);
    this.guestSeen.set(false);
    this.liveGuestIds.set([]);
    for (const v of [...this.videos.values()]) {
      if (String(v.uid) !== String(this.selfUid())) this.hideVideo(v.uid);
    }
  }

  /** Play a uid's video in its tile (now, or once the tile renders). */
  private showVideo(uid: CallUid, track: CallVideoTrack, config?: CallVideoPlayConfig): void {
    this.videos.set(String(uid), { uid, track, config });
    this.stageTiles()?.attach(uid, track, config);
  }

  private hideVideo(uid: CallUid): void {
    this.videos.delete(String(uid));
    this.stageTiles()?.detach(uid);
  }

  /** Why the patient is in the call without their camera and/or microphone ('' when not). */
  private mediaNotice(cam: DeviceProblem | null, mic: DeviceProblem | null): string {
    if (cam && mic) return `You joined without camera or microphone. ${deviceProblemText('microphone', mic)}`;
    if (cam) return `You joined with audio only. ${deviceProblemText('camera', cam)}`;
    if (mic) return `Your doctor can’t hear you. ${deviceProblemText('microphone', mic)}`;
    return '';
  }

  /** Open a device that wasn't available when the call started (the camera / mic button). */
  private async openMissing(kind: 'mic' | 'cam'): Promise<void> {
    const client = this.client;
    const media = await openLocalMedia({ audio: kind === 'mic', video: kind === 'cam' });
    if (this.left || !client || client !== this.client || !this.connected) {
      media.mic?.close();
      media.cam?.close();
      return;
    }
    if (kind === 'mic') {
      if (!media.mic) {
        this.deviceNotice.set(deviceProblemText('microphone', media.micProblem ?? 'failed'));
        this.micOn.set(false);
        return;
      }
      this.micTrack = media.mic;
      this.hasMic.set(true);
    } else {
      if (!media.cam) {
        this.deviceNotice.set(deviceProblemText('camera', media.camProblem ?? 'failed'));
        this.camOn.set(false);
        return;
      }
      this.camTrack = media.cam;
      this.hasCam.set(true);
      if (!this.screenOn()) this.showVideo(this.selfUid(), media.cam);
    }
    this.deviceNotice.set('');
    // While sharing the screen, the camera waits until sharing stops.
    const track: ILocalTrack | undefined = kind === 'mic' ? media.mic ?? undefined : this.screenOn() ? undefined : media.cam ?? undefined;
    try {
      if (track) await client.publish(track);
    } catch {
      this.deviceNotice.set('Your device opened but couldn’t be shared. Switch it off and on to try again.');
    }
  }

  /** "Invite someone": the in-call dialog (wallet or free; card on the appointment page). */
  protected invite(): void {
    this.inviteOpen.set(true);
  }

  /** A guest was just invited: name their tile straight away (before the next heartbeat). */
  protected guestAdded(g: PatientGuestDto): void {
    if (!g.id || g.uid === null) return;
    const entry: CallParticipantDto = { uid: g.uid, role: 'guest', name: g.display_name || g.name, id: g.id };
    this.participants.update((list) => [...(list.length ? list : this.roster()).filter((p) => p.uid !== entry.uid), entry]);
  }

  private async loadContext(): Promise<void> {
    try {
      const appt = await firstValueFrom(this.appointments.getMine(this.appointmentId));
      this.appointment.set(appt.data);
    } catch {
      /* leave placeholders */
    }
    try {
      const me = await firstValueFrom(this.patientApi.me());
      this.patient.set(me.data);
    } catch {
      /* optional */
    }
    try {
      const hp = await firstValueFrom(this.patientApi.healthProfile());
      this.health.set(hp.data);
    } catch {
      /* optional */
    }
    try {
      const vitals = await firstValueFrom(this.patientApi.vitals());
      this.vitals.set(vitals.data.latest ?? []);
    } catch {
      /* optional — the panel says "Not yet recorded" */
    }
    try {
      const docs = await firstValueFrom(this.documentsApi.list({ per_page: 100 }));
      this.libraryDocs.set(docs.data ?? []);
    } catch {
      /* library optional in-call */
    }
    // Which of them this doctor can see (chips, Share, the doctor's request).
    await this.loadDocAccess();
    await this.refreshClinical();
    try {
      const cs = await firstValueFrom(this.appointments.consents(this.appointmentId));
      this.consents.set(cs.data ?? []);
    } catch {
      /* none */
    }
  }

  /**
   * Re-fetch the clinical artefacts the doctor issues during the visit
   * (prescriptions, lab orders, care plan, referrals, summary). Polled while the
   * call is live so the patient sees a new prescription in place — without the
   * page reload that would tear down the call. Flags a badge on the Prescriptions
   * tab when a new script arrives and the patient isn't already looking at it.
   */
  private async refreshClinical(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    try {
      const rx = await firstValueFrom(this.appointments.prescriptions(this.appointmentId));
      const list = rx.data ?? [];
      const fresh = list.filter((p) => !this.knownRx.has(p.id));
      for (const p of list) this.knownRx.add(p.id);
      this.issuedRx.set(list);
      this.rxLoadError.set('');
      // Only announce prescriptions that arrive AFTER the first successful fetch
      // establishes a baseline — scripts sent before the patient joined (or
      // present after a mid-call reload) never light the badge or the toast.
      if (this.rxInitialized && fresh.length > 0) this.announceRx(fresh);
      this.rxInitialized = true;
    } catch (err) {
      // A failed poll keeps the list already shown; with nothing shown yet, say why.
      if (this.issuedRx().length === 0) {
        this.rxLoadError.set(apiErrorMessage(err, 'Could not load your prescriptions.'));
      }
    }
    try {
      const lo = await firstValueFrom(this.appointments.labOrders(this.appointmentId));
      this.labs.set(lo.data ?? []);
    } catch {
      /* none */
    }
    try {
      const cp = await firstValueFrom(this.appointments.carePlan(this.appointmentId));
      this.carePlan.set(cp.data);
    } catch {
      /* not published */
    }
    try {
      const rf = await firstValueFrom(this.appointments.referrals(this.appointmentId));
      this.referrals.set(rf.data ?? []);
    } catch {
      /* none */
    }
    try {
      const fu = await firstValueFrom(this.appointments.followUps(this.appointmentId));
      this.proposedFollowUps.set((fu.data ?? []).filter((a) => isOpenProposal(a)));
    } catch {
      /* none */
    }
    try {
      const s = await firstValueFrom(this.appointments.consultationSummary(this.appointmentId));
      this.summary.set(s.data);
    } catch {
      /* summary not finalized yet */
    }
  }

  /**
   * Flag the Prescriptions tab and show a notice for newly sent prescriptions.
   * The notice names the doctor and the prescription number only — never the
   * medicines or the reason.
   */
  private announceRx(fresh: PrescriptionDto[]): void {
    if (this.notesTab() !== 'prescriptions') this.newRx.set(true);
    // The most recently sent one (patients only ever see sent prescriptions).
    const newest = fresh.reduce((a, b) => ((b.sent_at ?? '') > (a.sent_at ?? '') ? b : a));
    const text =
      fresh.length === 1
        ? `${this.doctorLabel(newest)} sent you prescription ${newest.number}`
        : `${this.doctorLabel(newest)} sent you ${fresh.length} new prescriptions`;
    this.rxToast.set({ text, rx: newest });
    clearTimeout(this.rxToastTimer);
    this.rxToastTimer = setTimeout(() => this.rxToast.set(null), RX_TOAST_MS);
  }

  protected dismissRxToast(): void {
    clearTimeout(this.rxToastTimer);
    this.rxToast.set(null);
  }

  /** Toast "Show in call notes": open the Prescriptions tab. */
  protected showRxTab(): void {
    this.dismissRxToast();
    this.openNotesTab('prescriptions');
  }

  /** Toast "View prescription": open the PDF (errors surface on the Prescriptions tab). */
  protected viewRxFromToast(rx: PrescriptionDto): void {
    this.viewRx(rx);
    this.dismissRxToast();
    this.openNotesTab('prescriptions');
  }

  /**
   * Open the prescription PDF in a new tab (the call keeps running here). The
   * tab is opened synchronously on the click so popup blockers allow it, then
   * pointed at the short-lived signed link. This tab is never navigated — that
   * would end the call — so if the new tab was blocked or closed, the row offers
   * a direct "Open the prescription" link instead.
   */
  protected viewRx(rx: PrescriptionDto): void {
    if (this.openingRx()) return;
    const pending = openPendingTab({ allowSameTab: false });
    this.openingRx.set(rx.id);
    this.rxError.set('');
    this.clearRxFallback();
    this.prescriptionsApi.link(rx.id, false).subscribe({
      next: (res) => {
        const url = this.prescriptionsApi.fileUrl(res.data);
        if (!pending.go(url)) this.showRxFallback(rx.id, url, res.data.expires_at);
        this.openingRx.set('');
      },
      error: (err: unknown) => {
        pending.fail();
        this.openingRx.set('');
        this.rxError.set(apiErrorMessage(err, 'Could not open the prescription. Please try again.'));
      },
    });
  }

  /** Offer the signed link until it expires (it is useless after that). */
  private showRxFallback(id: string, url: string, expiresAt: string | undefined): void {
    this.rxFallback.set({ id, url });
    const left = expiresAt ? Date.parse(expiresAt) - Date.now() : NaN;
    const ms = Number.isFinite(left) && left > 0 ? Math.min(left, RX_FALLBACK_MS) : RX_FALLBACK_MS;
    clearTimeout(this.rxFallbackTimer);
    this.rxFallbackTimer = setTimeout(() => this.rxFallback.set(null), ms);
  }

  private clearRxFallback(): void {
    clearTimeout(this.rxFallbackTimer);
    this.rxFallback.set(null);
  }

  protected rxStatus(status: PrescriptionStatus): { label: string; icon: string; cls: string } {
    return RX_STATUS[status] ?? RX_STATUS.active;
  }

  /** "Dr Ada Obi" — the prescriber, with the title added when it isn't already there. */
  protected doctorLabel(rx: PrescriptionDto): string {
    const name = (
      rx.prescriber ||
      rx.prescriber_details?.name ||
      this.appointment()?.specialist?.name ||
      ''
    ).trim();
    if (!name) return 'Your doctor';
    return /^(dr|prof)\b/i.test(name) ? name : `Dr ${name}`;
  }

  /** "2 medicines" — a count only; medicine names stay on the prescription itself. */
  protected itemsLabel(rx: PrescriptionDto): string {
    const n = rx.items_count ?? rx.items?.length ?? 0;
    return `${n} ${n === 1 ? 'medicine' : 'medicines'}`;
  }

  /** `YYYY-MM-DD` → "12 Oct 2026". */
  protected shortDate(ymd: string): string {
    const d = new Date(`${ymd.slice(0, 10)}T00:00:00`);
    return isNaN(d.getTime())
      ? ymd
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  /** Profile medication rows store herbal as a string flag. */
  protected isHerbal(flag: string | undefined): boolean {
    return /^(1|yes|true)$/i.test((flag ?? '').trim());
  }

  protected consentGranted(type: ConsentDto['type']): boolean {
    return this.consents().find((c) => c.type === type)?.granted ?? false;
  }

  protected async toggleConsent(type: ConsentDto['type']): Promise<void> {
    if (this.consentBusy()) return;
    this.consentBusy.set(type);
    this.consentError.set('');
    try {
      const res = await firstValueFrom(
        this.appointments.setConsent(this.appointmentId, type, !this.consentGranted(type)),
      );
      this.consents.set(res.data ?? []);
    } catch (err) {
      // Keep the prior state, but say why the change didn't stick.
      this.consentError.set(apiErrorMessage(err, 'Could not update your consent.'));
    } finally {
      this.consentBusy.set('');
    }
  }

  private async renewToken(): Promise<void> {
    try {
      const { data } = await firstValueFrom(this.appointments.callToken(this.appointmentId));
      if (data.participants?.length) this.participants.set(data.participants);
      if (data.token) await this.client?.renewToken(data.token);
    } catch {
      /* the SDK re-fires the event; a transient failure isn't fatal yet */
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
  }

  /** In-call polling — runs only while the consultation holds the idle timer. */
  private startLivePolls(): void {
    this.startRecordingPoll();
    this.startMetricsReport();
    this.startClinicalPoll();
  }

  private stopLivePolls(): void {
    if (this.recordingPoll) clearInterval(this.recordingPoll);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.clinicalPoll) clearInterval(this.clinicalPoll);
    this.recordingPoll = undefined;
    this.metricsTimer = undefined;
    this.clinicalPoll = undefined;
  }

  /** Poll whether the doctor has started recording so the patient always knows. */
  private startRecordingPoll(): void {
    if (this.recordingPoll) return;
    const check = async (): Promise<void> => {
      if (!this.auth.isAuthenticated()) return;
      try {
        const res = await firstValueFrom(this.appointments.recordings(this.appointmentId));
        this.recordingActive.set(res.data?.active === true);
      } catch {
        /* leave as-is */
      }
    };
    void check();
    this.recordingPoll = setInterval(() => void check(), 12000);
  }

  /**
   * Poll the doctor-issued clinical artefacts every 15s so a prescription (or lab
   * order, care plan, referral) issued mid-call appears without a page reload —
   * and whether the doctor has closed the appointment.
   */
  private startClinicalPoll(): void {
    if (this.clinicalPoll) return;
    this.clinicalPoll = setInterval(() => {
      void this.refreshClinical();
      void this.checkConsultationClosed();
    }, 15000);
  }

  /** Open a Notes-panel tab, clearing the "new prescription" badge when relevant. */
  protected openNotesTab(tab: NotesTab): void {
    this.notesTab.set(tab);
    if (tab === 'prescriptions') this.newRx.set(false);
  }

  /** Report an RTC quality sample every 15s so the back-office can monitor calls. */
  private startMetricsReport(): void {
    if (this.metricsTimer) return;
    const report = (): void => {
      if (!this.client || !this.auth.isAuthenticated()) return;
      let rtt: number | null = null;
      try {
        const stats = this.client.getRTCStats();
        rtt = stats?.RTT && stats.RTT > 0 ? Math.round(stats.RTT) : null;
      } catch {
        /* stats unavailable */
      }
      this.appointments
        .reportMetric(this.appointmentId, {
          uplink: this.netUplink,
          downlink: this.netDownlink,
          rtt,
        })
        .subscribe({ next: () => undefined, error: () => undefined });
    };
    this.metricsTimer = setInterval(report, 15000);
  }

  // ---- Live captions / patient transcription ----
  private detectSpeech(): boolean {
    const w = window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
    return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
  }

  protected toggleCaptions(): void {
    if (this.captionsOn()) {
      this.stopCaptions();
      return;
    }
    if (!this.aiConsentGranted()) return;
    this.captionsOn.set(true);
    void this.loadCaptions();
    this.captionsPoll = setInterval(() => void this.loadCaptions(), 6000);
    if (this.speechSupported()) this.startCaptionRecognition();
  }

  protected latestCaptions(): TranscriptSegmentDto[] {
    return this.captions().slice(-2);
  }

  private async loadCaptions(): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    try {
      const res = await firstValueFrom(this.appointments.transcript(this.appointmentId));
      this.captions.set(res.data ?? []);
    } catch {
      /* leave prior */
    }
  }

  private startCaptionRecognition(): void {
    const w = window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            this.appointments
              .appendTranscript(this.appointmentId, text)
              .subscribe({ next: () => undefined, error: () => undefined });
          }
        }
      }
    };
    rec.onend = () => {
      if (this.captionsOn()) {
        try {
          rec.start();
        } catch {
          /* already restarting */
        }
      }
    };
    rec.onerror = () => {
      /* transient */
    };
    this.recognition = rec;
    try {
      rec.start();
    } catch {
      /* ignore double-start */
    }
  }

  private stopCaptions(): void {
    this.captionsOn.set(false);
    this.stopCaptionRecognition();
    if (this.captionsPoll) clearInterval(this.captionsPoll);
    this.captionsPoll = undefined;
  }

  private stopCaptionRecognition(): void {
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
    this.recognition = undefined;
  }

  protected async toggleMic(): Promise<void> {
    if (!this.micTrack) {
      // Not available when the call started: try to open it now.
      if (this.connected) {
        this.micOn.set(true);
        await this.openMissing('mic');
      }
      return;
    }
    const on = !this.micOn();
    await this.micTrack.setEnabled(on);
    this.micOn.set(on);
  }

  protected async toggleCam(): Promise<void> {
    const cam = this.camTrack;
    if (!cam) {
      if (this.connected) {
        this.camOn.set(true);
        await this.openMissing('cam');
      }
      return;
    }
    const on = !this.camOn();
    await cam.setEnabled(on);
    this.camOn.set(on);
    if (!on || this.screenOn()) return;
    // Back on: play it in your tile again, and share it if it isn't (it was off when sharing stopped).
    this.hideVideo(this.selfUid());
    this.showVideo(this.selfUid(), cam);
    const client = this.client;
    if (client && !client.localTracks.includes(cam as ILocalTrack)) {
      try {
        await client.publish(cam);
      } catch {
        /* the next toggle tries again */
      }
    }
  }

  protected async toggleScreen(): Promise<void> {
    if (!this.client) return;
    try {
      if (this.screenOn()) {
        // Stop sharing: drop the screen track, re-publish the camera.
        if (this.screenTrack) {
          await this.client.unpublish(this.screenTrack);
          this.screenTrack.close();
          this.screenTrack = undefined;
        }
        const cam = this.camTrack;
        if (cam) {
          // A camera switched off is published when it is switched back on.
          if (cam.enabled) await this.client.publish(cam);
          this.showVideo(this.selfUid(), cam);
        } else {
          this.hideVideo(this.selfUid());
        }
        this.screenOn.set(false);
      } else {
        const track = (await AgoraRTC.createScreenVideoTrack({}, 'disable')) as ILocalVideoTrack;
        if (this.camTrack && this.client.localTracks.includes(this.camTrack as ILocalTrack)) {
          await this.client.unpublish(this.camTrack);
        }
        this.screenTrack = track;
        await this.client.publish(track);
        // Your own tile shows what you share (whole, not cropped).
        this.showVideo(this.selfUid(), track, { fit: 'contain' });
        // The browser's own "Stop sharing" ends the track — mirror it in our UI.
        track.on('track-ended', () => void this.toggleScreen());
        this.screenOn.set(true);
      }
    } catch {
      // User dismissed the picker, or the browser blocked capture — stay as-is.
      this.screenOn.set(false);
    }
  }

  protected sendMessage(): void {
    const text = this.draft().trim();
    if (!text) return;
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date());
    this.messages.update((list) => [...list, { mine: true, text, time }]);
    this.draft.set('');
  }

  /** Send the star rating as the consultation's review (once it is completed). */
  protected async rate(n: number): Promise<void> {
    if (!this.canRate() || this.reviewState() === 'sending' || this.reviewState() === 'done') return;
    this.rating.set(n);
    this.reviewState.set('sending');
    this.reviewNote.set('');
    try {
      await firstValueFrom(this.appointments.review(this.appointmentId, n));
      rememberReviewed(this.appointmentId);
      this.reviewState.set('done');
      this.reviewNote.set('Thanks for your feedback!');
    } catch (err: unknown) {
      if (isAlreadyReviewed(err)) {
        rememberReviewed(this.appointmentId);
        this.reviewState.set('done');
        this.reviewNote.set('You have already rated this consultation — thank you.');
        return;
      }
      this.reviewState.set('error');
      this.reviewNote.set(apiErrorMessage(err, 'Could not send your rating. Please try again.'));
    }
  }

  protected download(r: RecordItem): void {
    if (r.docId) {
      openBlobDocument(this.documentsApi.fileBlob(r.docId));
    } else if (r.url) {
      window.open(r.url, '_blank', 'noopener');
    }
  }

  protected rxDate(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  protected goProfile(): void {
    void this.router.navigate(['/dashboard/profile']);
  }

  protected goAppointments(): void {
    void this.router.navigate(['/dashboard/appointments']);
  }

  /** In the live call right now — leaving drops the patient from it. */
  private inLiveCall(): boolean {
    return this.status() === 'in-call' && !this.left;
  }

  /** Asked before a live call is left (End, Back, the sidebar, the browser's Back button). */
  private confirmLeaveCall(): Promise<boolean> {
    return this.dialogs.confirmLeave({
      title: 'Leave the consultation?',
      message: `You can rejoin while ${doctorTitle(this.appointment()?.specialist?.name)} is still in the call.`,
      confirmLabel: 'Leave call',
      cancelLabel: 'Stay',
      tone: 'warning',
      icon: 'phone-off',
    });
  }

  /**
   * `unsavedChangesGuard` (route `call/:id`): navigating away mid-call — a
   * sidebar link, the browser's Back button — asks first. Signing out (or the
   * idle timeout) always wins over the question.
   */
  canLeave(): boolean | Promise<boolean> {
    return this.inLiveCall() ? this.confirmLeaveCall() : true;
  }

  /**
   * Leave the call (asked first while in it). End and the "ended" screen go to
   * this visit in the consultation history (its summary, prescriptions and
   * rating); Back and the error screen go back to the appointments.
   */
  protected async leave(to: 'appointments' | 'history' | 'proposal' = 'appointments'): Promise<void> {
    if (this.inLiveCall() && !(await this.confirmLeaveCall())) return;
    await this.teardown();
    if (to === 'history') {
      void this.router.navigate(this.appointmentId ? ['/dashboard/history', this.appointmentId] : ['/dashboard/history']);
    } else if (to === 'proposal' && this.appointmentId) {
      // A follow-up proposal not accepted yet: where it is answered.
      void this.router.navigate(['/dashboard/appointments', this.appointmentId]);
    } else {
      void this.router.navigate(['/dashboard/appointments']);
    }
  }

  // ---- Device test (waiting room) ----
  private async startDeviceTest(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this.previewStream = stream;
      this.camReady.set(stream.getVideoTracks().length > 0);
      this.micReady.set(stream.getAudioTracks().length > 0);
      const el = this.previewVideo()?.nativeElement;
      if (el) {
        el.srcObject = stream;
        el.muted = true;
        void el.play().catch(() => undefined);
      }
      this.startMeter(stream);
    } catch {
      this.camReady.set(false);
      this.micReady.set(false);
    }
  }

  private startMeter(stream: MediaStream): void {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.audioCtx = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = (): void => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        this.micLevel.set(Math.min(1, peak / 90));
        this.meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter is best-effort */
    }
  }

  protected testSpeaker(): void {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        void ctx.close();
      }, 500);
    } catch {
      /* best-effort */
    }
  }

  private stopDeviceTest(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = undefined;
    try {
      void this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.audioCtx = undefined;
    this.previewStream?.getTracks().forEach((t) => t.stop());
    this.previewStream = undefined;
    const el = this.previewVideo()?.nativeElement;
    if (el) el.srcObject = null;
  }

  private async teardown(): Promise<void> {
    this.left = true;
    this.connected = false;
    this.stopHeartbeat();
    // Out of the call: the idle timeout runs again.
    this.holding = false;
    this.session.release(CALL_HOLD);
    clearTimeout(this.rxToastTimer);
    clearTimeout(this.rxFallbackTimer);
    this.clearFirstWait();
    this.clearReconnectWatch();
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.stopDeviceTest();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopLivePolls();
    this.stopCaptions();
    // Forget the client first, so its own DISCONNECTED event is ignored.
    const client = this.client;
    this.client = undefined;
    this.resetRemotes();
    await this.releaseMedia(client);
  }

  ngOnDestroy(): void {
    // Safety net: always drop the idle-timer hold, however the page is left.
    this.session.release(CALL_HOLD);
    clearTimeout(this.docAccessTimer);
    void this.teardown();
  }
}
