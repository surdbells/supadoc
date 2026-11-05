import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  signal,
  TemplateRef,
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
  LabRequestsApi,
  PatientApi,
  PrescriptionsApi,
  sendCallNudge,
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
  type PatientLabRequestSummaryDto,
  type PatientGuestDto,
  type PatientProfileDto,
  type PrescriptionDto,
  type PrescriptionStatus,
  type ReferralDto,
  type TranscriptSegmentDto,
  type UploadedDocumentDto,
  type VitalReadingDto,
} from '@supadoc/models';
import {
  buildCallTiles,
  ButtonComponent,
  type CallChoiceChange,
  type CallControl,
  type CallControlId,
  CallControlsComponent,
  CallQualityComponent,
  CallSelfTileComponent,
  type CallSelfViewMode,
  type CallSetting,
  CallTilesComponent,
  type CallVideoFit,
  DialogService,
  callTilesMode,
  type CallUid,
  type CallVideoPlayConfig,
  type CallVideoTrack,
  IconComponent,
  type RemoteParticipant,
  RemoteParticipants,
  SmoothHeightDirective,
  type CallTile,
} from '@supadoc/ui';
import { CallPeerTileComponent, DocumentViewerService } from '@supadoc/viewer';
import { type DeviceProblem, deviceProblemText, doctorTitle } from '../call/call-helpers';
import { openLocalMedia } from '../call/call-media';
import { type ApproveOutcome, approveOutcomeLine, ApproveRequestDialog } from './approve-request-dialog';
import { doctorTimeLabel } from './doctor-time';
import { drLast, isSharingUnavailable, shareResultLine, SHARING_UNAVAILABLE } from './document-sharing';
import { DocumentUploadDialog } from './document-upload-dialog';
import { isOpenProposal, whenLabel } from './follow-up';
import { InviteGuestDialog } from './invite-guest-dialog';
import { labChip, testsLabel } from './lab-ui';
import { ShareConfirmSheet } from './share-confirm-sheet';
import { ShareDialog } from './share-dialog';
import { isAlreadyReviewed, rememberReviewed, wasReviewed } from './review-memory';
import { deviceZone, myDocumentSource, myPrescriptionSource, openerOf } from './viewer-sources';

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

/** From sm (640px) your own camera is a picture-in-picture on the stage; below, a tile in the control row (D18). */
const WIDE_QUERY = '(min-width: 640px)';
/** A phone held sideways: the controls become a rail beside the video (desktops keep the grid). */
const RAIL_QUERY = '(orientation: landscape) and (max-height: 500px) and (max-width: 1023.98px)';
/**
 * A phone held sideways: the height of the stage's column beside the rail (the
 * video, and under it the captions and the new-prescription card while they
 * show). Fixed, so those take their room from the video: the dock and the rail
 * never move and nothing below shifts. The screen under the 48px top bar (as the
 * stage was), less the banners above the dock (--rail-above, measured). Never
 * shorter than one column of four 44px controls beside it (the rail packs its
 * controls and settings into columns of that height), so their bottoms line up:
 * three 8px gaps, py-2 and the border = 218px (as in the doctor's call). The
 * rail is given the same height.
 */
const RAIL_COLUMN = 'h-[max(13.625rem,calc(100dvh_-_4.5rem_-_var(--rail-above,0px)))]';
/**
 * The most of the screen's height the dock may take and still stick to the top
 * (below lg, held upright). Taller (its bar on three or four rows on a short
 * phone) it scrolls with the page, so the notes under it keep their room.
 */
const DOCK_STICKY_MAX = 0.6;
/** Per-device choices (best-effort). */
const FIT_KEY = 'videomed.call.fit';
const SELF_KEY = 'videomed.call.self';
/** The video fit: fill the frame (the default) or the whole picture. */
const FIT_OPTIONS = [
  { value: 'contain', label: 'Fit', ariaLabel: 'Fit whole picture' },
  { value: 'cover', label: 'Fill', ariaLabel: 'Fill the frame' },
] as const;

/** A record shown in the right-hand Documents & Records panel. */
interface RecordItem {
  readonly title: string;
  readonly date: string;
  readonly kind: DocsTab;
  readonly badge: string;
  /** Set for medical-library documents — opened in the document viewer (an authenticated blob). */
  readonly docId?: string;
  /** The library document, or null for an older booking attachment that only has a URL (it can't be opened here). */
  readonly doc: MedicalDocumentDto | null;
}

/**
 * Live consultation cockpit (Agora RTC) — the patient's in-call view, full
 * screen (the route is immersive).
 *
 * A top bar (Leave, the doctor, the timer, real connection quality, the
 * recording notice, Invite, the cockpit theme), then the video DOCK: the stage
 * and its control bar (`sd-call-controls`) below it — never over the video.
 * Only the video, the name tag and (from sm) your picture-in-picture are on the
 * stage; below sm (a phone held upright) your camera is a small tile at the
 * start of the control row (D18). The stage is as wide as the notes card under it; the main video
 * fills it (or, chosen in the bar, shows whole), and captions sit in a strip under it. Every
 * control and setting is in the bar — nothing behind a menu. Below lg the dock sticks to the top while
 * the notes and the cards scroll; from lg the page doesn't scroll and each
 * column scrolls inside.
 *
 * Everyone in the call has their own tile (`<sd-call-tiles>`, named from the
 * call's `participants`): 1:1, or an even grid with guests. "Invite someone"
 * adds a guest without leaving. Right: Documents & Records first — with
 * "Upload & share" (that doctor, no end date, only what they can open; the
 * doctor is nudged over Agora at once) — then the health summary, latest
 * vitals and consent. There is no chat (D19): it reached nobody.
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
    ButtonComponent,
    CallPeerTileComponent,
    CallControlsComponent,
    CallQualityComponent,
    CallSelfTileComponent,
    CallTilesComponent,
    DocumentUploadDialog,
    IconComponent,
    InviteGuestDialog,
    NgTemplateOutlet,
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
    <!-- The document viewer's call band (§3.3). Any document opened while this page lives opens
         in the shared viewer, a modal over the call: the viewer renders this band above its
         header, always cockpit-dark (.sd-call[data-theme=dark]). The cockpit is inert behind
         the modal, so the band mirrors its call-level live regions and banners, with their
         actions, and keeps Mute and End in reach. -->
    <ng-template #viewerBar>
      <button
        type="button"
        class="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-field px-2.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/10"
        (click)="backToCall()"
      >
        <sd-icon name="arrow-left" [size]="18" /><span class="max-sm:sr-only" data-band-label>Back to call</span>
      </button>
      <span class="min-w-0 flex-1 truncate font-sans text-caption text-white/70">{{ viewerPeerName() }} · {{ elapsedLabel() }}</span>
      <span class="inline-flex shrink-0 empty:hidden" role="status">@if (recordingActive()) {<span class="inline-flex items-center gap-1.5 rounded-pill bg-alert-ink px-2.5 py-1 font-sans text-caption font-medium text-white"><span class="size-2 shrink-0 rounded-full bg-white" aria-hidden="true"></span>Recording</span>}</span>
      @if (inLive()) {
        <span class="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-field px-2.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/10"
            (click)="toggleMic()"
          >
            <sd-icon [name]="micLive() ? 'mic' : 'mic-off'" [size]="18" /><span class="max-sm:sr-only" data-band-label>{{ micLive() ? 'Mute' : 'Unmute' }}</span>
          </button>
          <!-- Icon-only, like the cockpit's own End: a white label on bg-alert is 4.23:1 (under 4.5 for
               caption text); the white icon is a graphic (3:1). -->
          <button
            type="button"
            class="inline-flex size-11 shrink-0 items-center justify-center rounded-field bg-alert text-white transition-colors hover:bg-alert-ink"
            aria-label="End call"
            (click)="leaveFromViewer()"
          >
            <sd-icon name="phone-off" [size]="18" />
          </button>
        </span>
      }
      @if (reconnecting()) {
        <p class="flex basis-full items-start gap-1.5 font-sans text-caption text-white" role="alert">
          <sd-icon name="loader-circle" [size]="14" class="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" />Reconnecting to the call…
        </p>
      }
      @if (status() === 'in-call' && remoteLeft()) {
        <p class="basis-full font-sans text-caption text-white/80" role="status">{{ leftText() }}</p>
      }
      @if (rxToast(); as t) {
        <span class="flex basis-full items-center gap-2 font-sans text-caption text-white" role="status">
          <sd-icon name="pill" [size]="14" class="shrink-0" />New prescription
          <button
            type="button"
            class="inline-flex min-h-9 items-center rounded-field px-2.5 font-semibold text-frost transition-colors hover:bg-white/10 hover:text-white"
            [attr.aria-label]="'View prescription ' + t.rx.number"
            (click)="viewRxFromToast(t.rx)"
          >
            View
          </button>
        </span>
      }
      <span class="sr-only" aria-live="polite" aria-atomic="true">{{ docShareLive() }}</span>
    </ng-template>
    <!-- The doctor's live video as the viewer's picture-in-picture (handed over from the stage, §3.4). -->
    <ng-template #viewerPeer>
      <sd-call-peer-tile [tile]="viewerPeerTile()" [track]="viewerPeerTrack()" />
    </ng-template>

    <!-- New prescription notice (says who sent it and its number — never the medicines).
         Never over the stage: the bottom of the screen below lg, the top of the right
         column (beside the video) from lg up. On a phone held sideways the toast would
         cover the video and the rail's End, so there it is a card under the video, in
         the stage's fixed-height column beside the rail: it takes its room from the
         video, and the dock, the rail and End stay where they are. -->
    <ng-template #rxNotice let-t>
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
        class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:text-ink"
        aria-label="Dismiss notice"
        (click)="dismissRxToast()"
      >
        <sd-icon name="x" [size]="18" />
      </button>
    </ng-template>
    @if (rxToast(); as t) {
      @if (!rail()) {
        <div
          #rxToastEl
          class="sd-toast-in fixed inset-x-3 bottom-3 z-40 flex items-start gap-3 rounded-card border border-cerulean/30 bg-white px-4 py-3 shadow-lg lg:inset-x-auto lg:bottom-auto lg:right-4 lg:top-[4.5rem] lg:w-[360px] 2xl:w-[400px]"
          role="status"
          data-testid="call-rx-toast"
        >
          <ng-container [ngTemplateOutlet]="rxNotice" [ngTemplateOutletContext]="{ $implicit: t }" />
        </div>
      }
    }

    <!-- Full screen (the route is immersive): a top bar, then the video dock and the panels. -->
    <div class="sd-call flex min-h-dvh flex-col bg-abyss text-white" [class]="rootClass()" [attr.data-theme]="theme()">
      @if (phase() === 'waiting') {
        <!-- ============================ WAITING ROOM ============================ -->
        <div class="px-3 py-4 sm:px-4 lg:py-6">
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
            <p class="mt-1 flex items-center gap-1.5 font-sans text-caption text-white/60">
              <sd-icon name="calendar-clock" [size]="14" /> {{ scheduledLabel() }}
            </p>
            @if (scheduledDoctorTime(); as dt) {
              <p class="font-sans text-caption text-white/60">· {{ dt }}</p>
            }
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
            class="min-h-11 px-3 font-sans text-caption text-white/60 transition-colors hover:text-white/80"
            (click)="leave()"
          >
            Back to appointments
          </button>
        </div>
        </div>
      } @else {
      <!-- ============================ TOP BAR ============================ -->
      <header
        class="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 sm:gap-3 sm:px-4"
        [class]="rail() ? 'h-12' : 'h-14'"
      >
        <button
          type="button"
          class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
          aria-label="Leave call"
          (click)="leave()"
        >
          <sd-icon name="arrow-left" [size]="20" />
        </button>
        <div class="flex min-w-0 flex-1 flex-col">
          <h1 class="truncate font-sans text-body-sm font-semibold text-white">{{ doctorName() }}</h1>
          @if (doctorSpecialty() || doctorNow()) {
            <p class="truncate font-sans text-caption text-white/70">
              {{ doctorSpecialty() }}@if (doctorNow(); as dn) {<span class="hidden md:inline">{{ doctorSpecialty() ? ' · ' : '' }}{{ dn }} now</span>}
            </p>
          }
        </div>
        <span role="timer" aria-label="Call duration" class="shrink-0 font-label text-caption tabular-nums text-white/80">{{
          elapsedLabel()
        }}</span>
        <!-- Real connection quality (Agora's network-quality), never a static graphic -->
        <sd-call-quality [quality]="netQuality()" />
        <!-- Agora encrypts media in transit; it is not end-to-end (D24). -->
        <span class="hidden shrink-0 items-center gap-1 font-sans text-caption text-white/70 lg:inline-flex">
          <sd-icon name="shield-check" [size]="14" class="text-frost" />Encrypted
        </span>
        <!-- The recording notice for screen readers: always in the page, so the words
             are announced when recording starts (the visual chip below is hidden from them). -->
        <span class="sr-only" role="status" data-testid="call-recording-status">{{
          recordingActive() ? 'This consultation is being recorded.' : ''
        }}</span>
        @if (recordingActive()) {
          <span
            class="flex shrink-0 items-center gap-1.5 rounded-pill bg-alert-ink px-2.5 py-1 font-sans text-caption font-medium text-white"
            aria-hidden="true"
          >
            <span class="size-2 shrink-0 animate-pulse rounded-full bg-white motion-reduce:animate-none" aria-hidden="true"></span>
            <span class="sm:hidden" aria-hidden="true">Rec</span>
            <span class="hidden sm:inline" aria-hidden="true">Recording</span>
          </span>
        }
        <!-- In the dock's settings below sm -->
        <button
          type="button"
          class="hidden min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-pill border border-white/15 px-3 font-sans text-body-sm text-white/85 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost sm:inline-flex"
          aria-haspopup="dialog"
          aria-label="Invite someone to this call"
          (click)="invite()"
        >
          <sd-icon name="user-plus" [size]="16" />
          <span class="hidden xl:inline" aria-hidden="true">Invite someone</span>
        </button>
        <button
          type="button"
          class="hidden size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost sm:inline-flex"
          [attr.aria-label]="theme() === 'dark' ? 'Switch to the light cockpit' : 'Switch to the dark cockpit'"
          (click)="toggleTheme()"
        >
          <sd-icon name="lightbulb" [size]="18" />
        </button>
      </header>

      <!-- ============================ BODY ============================
           Below lg one column: the dock (sticky), the notes, then the cards. From lg a
           non-scrolling cockpit: the dock and notes left, the cards right, each column
           scrolling inside. -->
      <div
        class="flex flex-col gap-3 px-3 pb-6 sm:px-4 lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-4 lg:p-4 2xl:grid-cols-[minmax(0,1fr)_400px]"
      >
        <!-- ============================ LEFT ============================
             display:contents below lg, so the sticky dock stays in view down the whole
             page (its containing block is the body, not this column). -->
        <div
          class="contents lg:flex lg:min-h-0 lg:min-w-0 lg:flex-col lg:gap-3 lg:overflow-y-auto"
          data-testid="call-left"
        >
          <!-- The banners above the dock, measured: a phone held sideways takes their
               height (--rail-above, with the gap after them) from the stage's column, so
               the dock still ends on the first screen. Box-less otherwise (display:
               contents), and on a phone held sideways only while something shows. -->
          <div #banners [class]="bannersClass()" data-testid="call-banners">
            <!-- A camera / microphone that isn't in the call (outside the dock, never over a tile) -->
            @if (status() === 'in-call' && deviceNotice()) {
              <p class="mt-3 flex items-start gap-2 rounded-card border border-white/10 bg-white/[0.03] px-3 py-2 font-sans text-caption text-white/80 lg:mt-0" role="status">
                <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-warning" />{{ deviceNotice() }}
              </p>
            }
          </div>

          <!-- ============================ DOCK ============================
               The stage and its control bar: one dark unit (both cockpit themes). Only the
               video, the name tag and (from sm) your picture-in-picture are on the stage.
               A column (the controls under the video); on a phone held sideways a row:
               the stage's column, then the controls as a rail beside it. -->
          <section #dock [class]="dockClass()" aria-label="Video call" data-testid="call-dock">
            <!-- The stage's column beside the rail (display: contents otherwise): a fixed
                 height, the video filling what the captions and the new-prescription card
                 under it leave. Never inside an @if: the tiles keep the tracks handed to them. -->
            <div [class]="stageColumnClass()" data-testid="call-stage-column">
              <div
                class="sd-stage relative overflow-hidden rounded-card bg-ink [container-name:stage] [container-type:size]"
                [class]="stageClass()"
                data-testid="call-stage"
              >
                <!-- Everyone's video: the other person big (filling the frame, or the whole
                     picture: the bar's Video fit) and, from sm, you picture-in-picture; an even grid with
                     guests. Always rendered, so a track can be handed over before its tile
                     appears. Below sm your camera is the tile in the control row instead. -->
                <sd-call-tiles
                  [tiles]="tiles()"
                  [spotlightLabel]="false"
                  [showRole]="true"
                  [mainFit]="fit()"
                  [selfView]="selfMode()"
                />

                <!-- Nobody else here: not yet, or everyone has gone -->
                @if (!hasRemoteTile() && status() === 'in-call') {
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 pb-6 pt-12 text-center text-white/75">
                    @if (remoteLeft()) {
                      <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                        <sd-icon name="user-x" [size]="30" />
                      </span>
                      <p class="font-sans text-body-sm roomy:text-body">{{ leftText() }}</p>
                      <p class="hidden max-w-sm font-sans text-caption text-white/60 roomy:block">
                        If your consultation is finished, press End to leave.
                      </p>
                    } @else {
                      <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                        <sd-icon name="user-round" [size]="30" />
                      </span>
                      <p class="font-sans text-body-sm roomy:text-body">
                        Waiting for {{ doctorName() }} to join…
                      </p>
                      <p class="hidden font-sans text-caption text-white/60 roomy:block">
                        {{ doctorSpecialty() }}
                      </p>
                    }
                  </div>
                }

                <!-- The call ended without the patient pressing End -->
                @if (status() === 'ended') {
                  <div
                    class="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-4 text-center text-white/85 outline-none"
                    role="status"
                    tabindex="-1"
                    aria-labelledby="call-ended-title"
                    data-testid="call-ended"
                  >
                    <span class="hidden size-16 shrink-0 items-center justify-center rounded-full bg-white/10 tall:flex">
                      <sd-icon [name]="endedReason() === 'completed' ? 'circle-check' : 'wifi-off'" [size]="28" />
                    </span>
                    @if (endedReason() === 'completed') {
                      <p id="call-ended-title" class="max-w-sm font-sans text-body">Your consultation has ended.</p>
                      <p class="hidden max-w-sm font-sans text-caption text-white/60 roomy:block">
                        Your consultation summary, prescriptions and anything else your doctor shares
                        appear in your consultation history.
                      </p>
                    } @else {
                      <p id="call-ended-title" class="max-w-sm font-sans text-body">You were disconnected from the call.</p>
                      <p class="hidden max-w-sm font-sans text-caption text-white/60 roomy:block">
                        Check your internet connection, then rejoin. Anything your doctor has shared
                        is in your consultation history.
                      </p>
                    }
                    <div class="flex flex-wrap items-center justify-center gap-3">
                      @if (endedReason() === 'dropped') {
                        <button
                          type="button"
                          class="flex min-h-11 items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark"
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
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/85" role="status">
                    <span class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white motion-reduce:animate-none" aria-hidden="true"></span>
                    <p class="font-sans text-body">Connecting to your consultation…</p>
                  </div>
                }

                <!-- Error -->
                @if (status() === 'error') {
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-4 text-center text-white/85">
                    <span class="hidden size-16 shrink-0 items-center justify-center rounded-full bg-white/10 tall:flex">
                      <sd-icon name="video-off" [size]="28" />
                    </span>
                    <p class="max-w-sm font-sans text-body">{{ errorMessage() }}</p>
                    <div class="flex flex-wrap items-center justify-center gap-3">
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
                        class="min-h-11 rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                        (click)="leave()"
                      >
                        Back to appointments
                      </button>
                    </div>
                  </div>
                }

                <!-- Name tag of whoever is on the main stage (1:1; the grid labels every tile),
                     and "waiting for the doctor" while only a guest is here -->
                @if (status() === 'in-call') {
                  <div class="absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
                    @if (stageMode() === 'spotlight' && hasRemoteTile()) {
                      <div class="flex min-w-0 max-w-full items-center gap-1.5 rounded-pill bg-abyss/70 px-3 py-1.5 backdrop-blur">
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
                    @if (hasRemoteTile() && !doctorHere()) {
                      <div class="flex min-w-0 max-w-full items-center rounded-pill bg-abyss/70 px-3 py-1.5 backdrop-blur" role="status">
                        <span class="truncate font-sans text-caption text-white/85">Waiting for {{ doctorName() }}…</span>
                      </div>
                    }
                  </div>
                }
              </div>

              <!-- Captions: under the video, never over a face (not a live region — the audio carries them) -->
              @if (status() === 'in-call' && captionsOn()) {
                <div
                  class="flex max-h-[4.5rem] min-h-12 shrink-0 flex-col justify-end overflow-hidden rounded-card bg-ink px-4 py-2 font-sans text-body text-white"
                  data-testid="call-captions"
                >
                  @for (seg of latestCaptions(); track seg.id) {
                    <p class="line-clamp-1">
                      <span class="font-semibold capitalize" [class]="seg.role === 'doctor' ? 'text-frost' : 'text-white'">{{ seg.role }}:</span>
                      {{ seg.text }}
                    </p>
                  } @empty {
                    <p class="text-white/70">Captions will appear here.</p>
                  }
                </div>
              }

              <!-- A new prescription on a phone held sideways: under the video, beside the
                   rail. The bottom toast would cover the video and the rail's End there;
                   above the dock it would push the rail off the screen. A light card in the
                   cockpit: styles.css keeps its light-surface tones when the portal is dark. -->
              @if (rail()) {
                @if (rxToast(); as t) {
                  <div
                    class="sd-rx-card sd-toast-in flex min-w-0 items-start gap-3 rounded-card border border-cerulean/30 bg-white px-4 py-3 shadow-lg"
                    role="status"
                    data-testid="call-rx-inline"
                  >
                    <ng-container [ngTemplateOutlet]="rxNotice" [ngTemplateOutletContext]="{ $implicit: t }" />
                  </div>
                }
              }
            </div>

            <!-- The control bar (below the video; a rail beside it on a phone held sideways).
                 Below sm your camera preview is the small tile at its start (D18). -->
            @if (status() === 'in-call') {
              <div [class]="controlRowClass()" data-testid="call-control-row">
                @if (!wide() && !rail() && selfTile(); as me) {
                  <sd-call-self-tile
                    [tile]="me"
                    [track]="selfVideo()?.track ?? null"
                    [playConfig]="selfVideo()?.config"
                    [hidden]="hidePreview()"
                  />
                }
                <div [class]="controlsBoxClass()">
                  <sd-call-controls
                    [controls]="controls()"
                    [settings]="settings()"
                    [layout]="rail() ? 'rail' : 'bar'"
                    (pressed)="onControl($event)"
                    (choiceChange)="onChoice($event)"
                  />
                </div>
              </div>
            }
          </section>

          <!-- Consultation notes (APG tabs: arrows, Home / End; a "New" pill, not colour alone) -->
          <section
            class="rounded-card border border-white/10 bg-white/[0.03] lg:min-h-[8rem] lg:flex-1 lg:overflow-y-auto"
            aria-label="Consultation notes"
          >
            <div class="flex gap-1 overflow-x-auto border-b border-white/10 px-2" role="tablist" aria-label="Consultation notes">
              @for (t of notesTabs; track t.key) {
                <button
                  type="button"
                  role="tab"
                  class="relative inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap px-3 py-3 font-sans text-body-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-frost"
                  [class]="notesTab() === t.key ? 'text-white' : 'text-white/70 hover:text-white'"
                  [id]="'call-notes-tab-' + t.key"
                  [attr.aria-selected]="notesTab() === t.key"
                  [attr.aria-controls]="'call-notes-panel'"
                  [tabIndex]="notesTab() === t.key ? 0 : -1"
                  (click)="openNotesTab(t.key)"
                  (keydown)="onNotesTabKey($event)"
                >
                  {{ t.label }}
                  @if (t.key === 'prescriptions' && newRx()) {
                    <span class="rounded-pill bg-cerulean/15 px-1.5 py-0.5 font-sans text-caption font-semibold text-frost">New<span class="sr-only"> prescription</span></span>
                  }
                  @if (notesTab() === t.key) {
                    <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean" aria-hidden="true"></span>
                  }
                </button>
              }
            </div>

            <!-- Height changes ease and each tab fades in, instead of jumping. -->
            <div
              id="call-notes-panel"
              class="p-4"
              role="tabpanel"
              tabindex="0"
              [attr.aria-labelledby]="'call-notes-tab-' + notesTab()"
              sdSmoothHeight
            >
              <div>
              <!-- Keyed (not tracked by identity): each tab remounts its panel for the fade, without the NG0956 dev warning. -->
              @for (shown of [notesTab()]; track 'tab:' + shown) {
              <div class="sd-tab-panel">
              @switch (notesTab()) {
                @case ('notes') {
                  <div class="grid gap-5 sm:grid-cols-2">
                    <div class="flex flex-col gap-4">
                      <div>
                        <h2 class="font-sans text-body-sm font-semibold text-white">
                          Today’s Visit Summary
                        </h2>
                        <p class="mt-1.5 font-sans text-body-sm leading-relaxed text-white/60">
                          {{ visitSummary() }}
                        </p>
                        @if (summaryReady() && summary()?.author) {
                          <p class="mt-1 font-sans text-caption text-white/60">
                            Finalized by {{ summary()?.author }}
                          </p>
                        }
                      </div>
                      @if (assessmentText()) {
                        <div>
                          <h2 class="font-sans text-body-sm font-semibold text-white">Assessment</h2>
                          <p class="mt-1.5 font-sans text-body-sm leading-relaxed text-white/60">
                            {{ assessmentText() }}
                          </p>
                        </div>
                      } @else if (conditions().length) {
                        <div>
                          <h2 class="font-sans text-body-sm font-semibold text-white">Assessment</h2>
                          <ul class="mt-1.5 flex flex-col gap-1">
                            @for (c of conditions(); track c.condition) {
                              <li class="font-sans text-body-sm text-white/60">
                                {{ c.condition }}
                                <span class="text-white/60">– {{ c.status || 'noted' }}</span>
                              </li>
                            }
                          </ul>
                        </div>
                      }
                    </div>

                    <div class="flex flex-col gap-4">
                      <div>
                        <h2 class="font-sans text-body-sm font-semibold text-white">Next Steps</h2>
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
                              <span class="font-sans text-[11px] text-white/60">
                                {{ itemsLabel(p) }}@if (p.sent_at) { · Sent {{ rxDate(p.sent_at) }} }
                              </span>
                            </div>
                          </div>
                          <div class="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
                            <!-- The document viewer, a modal over the call (the call keeps running behind it). -->
                            <button
                              type="button"
                              class="inline-flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption font-semibold text-white/85 transition-colors hover:bg-white/10 disabled:opacity-60"
                              [attr.aria-label]="'View prescription ' + p.number"
                              (click)="viewRx(p, $event)"
                            >
                              <sd-icon name="eye" [size]="14" />View
                            </button>
                          </div>
                        </div>
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
                    <p class="py-5 text-center font-sans text-body-sm text-white/60">
                      No prescriptions yet. If your doctor sends one during this consultation, it will appear here.
                    </p>
                    @if (medications().length) {
                      <h2 class="mt-1 font-sans text-caption font-semibold uppercase tracking-wide text-white/50">
                        Medicines you told us you take
                      </h2>
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
                  @if (labRequests().length || labs().length) {
                    <ul class="flex flex-col gap-2">
                      <!-- Lab requests: answered after the call, in Lab Tests (no navigation from the call) -->
                      @for (lr of labRequests(); track lr.id) {
                        <li class="rounded-2xl bg-white/[0.04] p-3" data-testid="call-lab-request">
                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm font-medium text-white">
                              <sd-icon name="flask-conical" [size]="16" class="shrink-0 text-frost" />
                              <span class="break-all">{{ lr.number }}</span>
                            </span>
                            <span class="inline-flex shrink-0 items-center gap-1 rounded-pill bg-white/10 px-2 py-0.5 font-sans text-caption text-white/85">
                              <sd-icon [name]="labChipOf(lr).icon" [size]="12" />{{ labChipOf(lr).label }}
                            </span>
                          </div>
                          <p class="mt-1 font-sans text-caption text-white/70">{{ labTests(lr.items_count) }}</p>
                        </li>
                      }
                      @for (o of labs(); track o.id) {
                        <li class="rounded-2xl bg-white/[0.04] p-3">
                          <div class="flex items-center justify-between">
                            <span class="flex items-center gap-2 font-sans text-body-sm font-medium text-white">
                              <sd-icon name="clipboard-list" [size]="16" class="text-frost" /> Lab order
                            </span>
                            <!-- Legacy orders are read-only: never the raw stored status. -->
                            <span class="rounded-pill bg-white/10 px-2 py-0.5 font-sans text-caption text-white/85" data-testid="call-lab-order-status">
                              Ordered
                            </span>
                          </div>
                          <p class="mt-1 font-sans text-body-sm text-white/70">{{ o.tests.join(', ') }}</p>
                          @if (o.author) {
                            <p class="mt-1 font-sans text-caption text-white/60">Ordered by {{ o.author }}</p>
                          }
                        </li>
                      }
                    </ul>
                    @if (labRequests().length) {
                      <p class="mt-3 flex items-start gap-2 font-sans text-caption text-white/60">
                        <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
                        Open Lab Tests after your call to review and accept.
                      </p>
                    }
                  } @else {
                    <p class="py-6 text-center font-sans text-body-sm text-white/60">
                      No lab requests for this consultation yet.
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
                      <h2 class="font-sans text-body-sm font-semibold text-white">Your Care Plan</h2>
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
                      <h2 class="font-sans text-body-sm font-semibold text-white">Follow-up Plan</h2>
                      <ul class="flex list-disc flex-col gap-1 pl-4">
                        @for (s of nextSteps(); track s) {
                          <li class="font-sans text-body-sm text-white/60">{{ s }}</li>
                        }
                      </ul>
                    </div>
                  }
                  @if (referrals().length) {
                    <div class="mt-4 border-t border-white/10 pt-3">
                      <h2 class="mb-2 font-sans text-body-sm font-semibold text-white">Referrals</h2>
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
          </section>
        </div>

        <!-- ============================ RIGHT ============================
             The Figma card stack (D20): Documents & Records first (in-call Upload & share),
             then Health Summary, Latest Vitals, Privacy & Consent. Feedback only once the
             call has ended, at the top. -->
        <aside class="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:overflow-y-auto" aria-label="Your records and consent">
          <!-- Feedback: a review needs a completed consultation, so it is only
               offered once the doctor has ended it. -->
          @if (status() === 'ended') {
            <section class="rounded-card border border-white/10 bg-white/[0.03] p-4 text-center" aria-labelledby="call-feedback-title">
              <h2 id="call-feedback-title" class="font-sans text-body-sm font-medium text-white">How was your consultation?</h2>
              @if (canRate()) {
                <div class="mt-2 flex items-center justify-center gap-0.5" role="group" aria-label="Rate your consultation">
                  @for (n of stars; track n) {
                    <button
                      type="button"
                      class="flex size-11 items-center justify-center transition-transform hover:scale-110 disabled:hover:scale-100 motion-reduce:transition-none"
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
                    <p class="mt-1.5 font-sans text-caption text-white/60">Your feedback helps us improve</p>
                  }
                }
              } @else {
                <p class="mt-1.5 font-sans text-caption text-white/60">
                  Once your doctor ends the consultation, you can rate it from your consultation history.
                </p>
              }
            </section>
          }

          <!-- Documents & records (sd-share: readable sharing accents in the light cockpit, styles.css) -->
          <section class="sd-share rounded-card border border-white/10 bg-white/[0.03] p-4" aria-labelledby="call-docs-title">
            <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 id="call-docs-title" tabindex="-1" class="font-sans text-body font-semibold text-white outline-none">Documents &amp; Records</h2>
              @if (docAccess()?.can_share && !docAccessOff()) {
                <sd-button size="sm" (click)="uploadOpen.set(true)">
                  <sd-icon name="upload" [size]="16" />Upload &amp; share
                </sd-button>
              }
            </div>
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
            <div class="mb-3 flex gap-1 overflow-x-auto" role="group" aria-label="Show documents">
              @for (t of docsTabs; track t.key) {
                <button
                  type="button"
                  class="min-h-9 whitespace-nowrap rounded-pill px-3 py-1.5 font-sans text-caption transition-colors"
                  [class]="docsTab() === t.key ? 'bg-cerulean text-white' : 'bg-white/[0.04] text-white/70 hover:bg-white/10'"
                  [attr.aria-pressed]="docsTab() === t.key"
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
                        <span class="flex flex-wrap items-center gap-x-2 font-sans text-caption text-white/60">
                          {{ r.date }}
                          @if (shareState(r); as st) {
                            @if (st === 'shared') {
                              <span class="inline-flex items-center gap-1 rounded-pill bg-white/[0.06] px-2 py-0.5 text-frost"><sd-icon name="share-2" [size]="12" />Shared</span>
                            } @else {
                              <span class="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-white/60"><sd-icon name="lock" [size]="12" />Private</span>
                            }
                          }
                        </span>
                      </span>
                      <span class="rounded bg-white/[0.06] px-1.5 py-0.5 font-label text-[10px] text-white/70">
                        {{ r.badge }}
                      </span>
                      @if (r.doc) {
                        <!-- The document viewer, a modal over the call: never a tab or a navigation (either would end the call). -->
                        <button
                          type="button"
                          class="flex size-11 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                          [attr.aria-label]="'Open ' + r.title"
                          (click)="viewRecord(r, $event)"
                        >
                          <sd-icon name="eye" [size]="16" />
                        </button>
                      }
                    </div>
                    @if (!r.doc) {
                      <p class="ml-12 font-sans text-caption text-white/60">This older attachment can't be opened here. Contact support for a copy.</p>
                    }
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
              <p class="py-5 text-center font-sans text-body-sm text-white/60">
                No documents in this category.
              </p>
            }
          </section>

          <!-- Health summary -->
          <section class="rounded-card border border-white/10 bg-white/[0.03] p-4" aria-labelledby="call-health-title">
            <div class="mb-3 flex items-center justify-between">
              <h2 id="call-health-title" class="font-sans text-body font-semibold text-white">Health Summary</h2>
              <button
                type="button"
                class="flex min-h-11 items-center gap-1 font-sans text-caption text-sky transition-colors hover:text-frost"
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
          </section>

          <!-- Latest vitals -->
          <section class="rounded-card border border-white/10 bg-white/[0.03] p-4" aria-labelledby="call-vitals-title">
            <div class="mb-3 flex items-center justify-between gap-2">
              <h2 id="call-vitals-title" class="font-sans text-body font-semibold text-white">Latest Vitals</h2>
              <span class="font-sans text-caption text-white/60">{{ vitalsAsOf() }}</span>
            </div>
            @if (vitals().length) {
              <div class="grid grid-cols-2 gap-2.5">
                @for (v of vitals(); track v.key) {
                  <div class="rounded-2xl bg-white/[0.04] p-3 text-center">
                    <p class="truncate font-sans text-caption text-white/60">{{ v.label }}</p>
                    <p class="mt-0.5 font-heading text-h5 font-semibold text-white">{{ v.value }}</p>
                    <p class="font-sans text-[10px] text-white/60">{{ v.unit }}</p>
                    @if (v.stale) {
                      <p class="mt-1 font-sans text-[10px] text-warning">May be out of date</p>
                    }
                  </div>
                }
              </div>
            } @else {
              <p class="font-sans text-caption text-white/60">
                No readings yet. You can add them in My Profile › Medical Information
                after your visit.
              </p>
            }
          </section>

          <!-- Privacy & consent (the dock's Privacy brings focus here) -->
          <section id="call-privacy" class="rounded-card border border-white/10 bg-white/[0.03] p-4" aria-labelledby="call-privacy-title">
            <h2 id="call-privacy-title" tabindex="-1" class="mb-1 flex items-center gap-1.5 font-sans text-body font-semibold text-white outline-none">
              <sd-icon name="shield-check" [size]="16" class="text-frost" /> Privacy &amp; Consent
            </h2>
            <p class="mb-2 font-sans text-caption text-white/60">
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
          </section>
        </aside>
      </div>
      }

      <!-- In-call Upload & share: that doctor, no end date, only what they can open in VideoMed -->
      @if (uploadOpen() && docAccess(); as da) {
        <pat-document-upload-dialog
          [presetDoctorId]="da.specialist.id"
          [appointment]="da.appointment"
          [lockDoctor]="true"
          surface="call"
          theme="call"
          fixedDuration="indefinite"
          acceptKinds="viewable"
          [maxFiles]="5"
          doneLabel="Done"
          (uploaded)="onCallUpload($event)"
          (closed)="uploadOpen.set(false)"
        />
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
  private readonly labApi = inject(LabRequestsApi);
  /** Paused while connected so the idle timeout never signs a patient out mid-call. */
  private readonly session = inject(SessionTimeoutService);
  /** Bearer token for the presence heartbeat (a raw fetch, outside the interceptors). */
  private readonly auth = inject(AuthService);
  /** "Leave the consultation?" before a live call is left. */
  private readonly dialogs = inject(DialogService);
  /** The shared document viewer: records and prescriptions open in it, a modal over the call (§3). */
  private readonly viewer = inject(DocumentViewerService);

  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  /** The viewer's call band and picture-in-picture (registered with the viewer, §3.2). */
  private readonly viewerBarTpl = viewChild.required('viewerBar', { read: TemplateRef });
  private readonly viewerPeerTpl = viewChild.required('viewerPeer', { read: TemplateRef });
  private readonly previewVideo = viewChild<ElementRef<HTMLVideoElement>>('previewVideo');
  /** The stage's video tiles (rendered once the patient enters the call). */
  private readonly stageTiles = viewChild(CallTilesComponent);
  /** The dock (sticky below lg) and the prescription toast: the page keeps focus clear of them (2.4.11). */
  private readonly dockEl = viewChild<ElementRef<HTMLElement>>('dock');
  private readonly toastEl = viewChild<ElementRef<HTMLElement>>('rxToastEl');
  /** The banners above the dock: their height is taken from the rail's stage column. */
  private readonly bannersEl = viewChild<ElementRef<HTMLElement>>('banners');

  // ---- The dock: layout, your own view, the video fit ----
  /** From sm up (the self view is a picture-in-picture on the stage). */
  protected readonly wide = signal(this.mediaMatches(WIDE_QUERY));
  /** A phone held sideways: the controls are a rail beside the video. */
  protected readonly rail = signal(this.mediaMatches(RAIL_QUERY));
  /** How the other person's video fills the stage (the dock's Video fit: fill by default), per device. */
  protected readonly fit = signal<CallVideoFit>(this.readFit());
  /** "Hide my preview" (the dock's settings), per device: your camera still goes to the doctor. */
  protected readonly hidePreview = signal(this.readHidePreview());
  /**
   * Where your own camera shows: the stage's picture-in-picture, the control-row
   * tile, or nowhere. A phone held sideways uses the picture-in-picture at any
   * width: its stage is wide (the corner is free, as from sm up), and the rail
   * has no room for the 64px tile above its controls.
   */
  protected readonly selfMode = computed<CallSelfViewMode>(() =>
    this.hidePreview() ? 'hidden' : this.wide() || this.rail() ? 'pip' : 'external',
  );
  /** Your own local video (camera, or the screen you share) for the control-row tile. */
  protected readonly selfVideo = signal<{ track: CallVideoTrack; config?: CallVideoPlayConfig } | null>(null);
  /** Agora's network quality, the worse of up- and downlink (null before the first report). */
  protected readonly netQuality = signal<number | null>(null);
  /** The browser can share a screen (phones can't: the control is left out). */
  private readonly canShareScreen =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  protected readonly rootClass = computed(() => (this.phase() === 'live' ? 'lg:h-dvh lg:overflow-hidden' : ''));
  /**
   * The dock: as wide as the column, so the stage and its bar line up with the
   * notes card under them (below lg, the page's content width). From lg the
   * page doesn't scroll: the dock may shrink (min-h-0), and only its stage
   * gives way, so the notes card keeps its 8rem and the column needs no scroll.
   */
  protected readonly dockClass = computed(() =>
    this.rail()
      ? 'sd-dock flex flex-row items-stretch gap-2 pt-2'
      : 'sd-dock sticky top-0 z-20 flex flex-col gap-2 bg-abyss pt-2 [@media(max-height:500px)]:static lg:static lg:min-h-0 lg:pt-0',
  );
  /**
   * The banners above the dock (the device notice): box-less (display: contents)
   * except on a phone held sideways, where they are one measured box, gone while
   * empty so no gap is added above the dock (see observeBanners).
   */
  protected readonly bannersClass = computed(() => (this.rail() ? 'shrink-0 empty:hidden' : 'contents'));
  /**
   * A phone held sideways: the stage's column beside the rail, a fixed height
   * (RAIL_COLUMN). The video takes the first row; the captions and the
   * new-prescription card (when they show) take rows under it, so they shrink
   * the video, not the page. Box-less otherwise.
   */
  protected readonly stageColumnClass = computed(() =>
    this.rail()
      ? `grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-2 ${RAIL_COLUMN}`
      : 'contents',
  );
  /**
   * The stage is always the column's full width; the video fills it (or is
   * letterboxed in it: Video fit). Its height: below lg 4:3 (16:9 from sm) of
   * that width, at most 45dvh; from lg 16:9 of it, giving way (flex shrink) to
   * whatever the column can't spare; beside a rail, the column's first row.
   */
  protected readonly stageClass = computed(() =>
    this.rail()
      ? 'h-full w-full'
      : 'w-full aspect-[4/3] max-h-[45dvh] sm:aspect-video lg:max-h-none lg:min-h-0',
  );
  /**
   * The bar under the video, or (a phone held sideways) the rail beside it:
   * exactly as tall as the stage's column (RAIL_COLUMN), never by its content,
   * so the controls measure that height and pack into as many columns as it
   * needs (End stays on the screen), and as wide as those columns.
   */
  protected readonly controlRowClass = computed(() =>
    this.rail()
      ? `flex min-h-0 shrink-0 flex-col items-center gap-2 rounded-card border border-white/10 bg-ink px-1 py-2 ${RAIL_COLUMN}`
      : 'flex shrink-0 items-center gap-2 rounded-card border border-white/10 bg-ink px-2 py-2',
  );
  /** The bar's `callbar` container (its labels show from 34rem); a rail's box sizes to its columns instead. */
  protected readonly controlsBoxClass = computed(() =>
    this.rail()
      ? 'flex min-h-0 flex-1 justify-center'
      : 'min-w-0 flex-1 [container-name:callbar] [container-type:inline-size]',
  );

  /** The dock's controls (labels never change on the toggles; mic and camera say what they do). */
  protected readonly controls = computed<CallControl[]>(() => {
    const mic = this.micLive();
    const cam = this.camLive();
    const captions = this.captionsOn();
    const noConsent = !this.aiConsentGranted() && !captions;
    return [
      { id: 'mic', label: mic ? 'Mute' : 'Unmute', icon: mic ? 'mic' : 'mic-off', tone: mic ? 'default' : 'off' },
      { id: 'cam', label: cam ? 'Stop video' : 'Start video', icon: cam ? 'video' : 'video-off', tone: cam ? 'default' : 'off' },
      {
        id: 'share',
        label: 'Share screen',
        icon: 'monitor-smartphone',
        pressed: this.screenOn(),
        tone: this.screenOn() ? 'active' : 'default',
        hidden: !this.canShareScreen,
      },
      {
        id: 'captions',
        label: 'Captions',
        icon: 'captions',
        pressed: captions,
        tone: captions ? 'active' : 'default',
        disabled: noConsent,
        reason: noConsent ? 'Turn on captions consent in Privacy & consent first.' : null,
      },
      { id: 'end', label: 'End', ariaLabel: 'End call', icon: 'phone-off', tone: 'danger' },
    ];
  });

  /**
   * The dock's settings, after its controls (never behind a menu): the video
   * fit, your preview, Privacy & consent, and below sm (where the top bar has no
   * room for them) Invite and the cockpit theme.
   */
  protected readonly settings = computed<CallSetting[]>(() => {
    const items: CallSetting[] = [
      { id: 'fit', label: 'Video fit', value: this.fit(), options: FIT_OPTIONS },
      { id: 'self', label: 'Hide my preview', icon: 'eye-off', pressed: this.hidePreview() },
      { id: 'privacy', label: 'Privacy', ariaLabel: 'Privacy & consent', icon: 'shield-check' },
    ];
    if (!this.wide()) {
      items.push(
        { id: 'invite', label: 'Invite', ariaLabel: 'Invite someone to this call', icon: 'user-plus' },
        { id: 'theme', label: 'Light cockpit', icon: 'lightbulb', pressed: this.theme() === 'light' },
      );
    }
    return items;
  });

  /** Your own tile (from the call's tiles): the control-row preview below sm. */
  protected readonly selfTile = computed(() => this.tiles().find((t) => t.self) ?? null);

  // ---- In-call Upload & share ----
  protected readonly uploadOpen = signal(false);
  /** Files just shared from this call: "Shared" before the next read says so. */
  private readonly justShared = signal<ReadonlySet<string>>(new Set());
  private lastCallShareAt = 0;

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

  /** Fill the frame unless the whole picture was chosen on this device. */
  private readFit(): CallVideoFit {
    try {
      return localStorage.getItem(FIT_KEY) === 'contain' ? 'contain' : 'cover';
    } catch {
      return 'cover';
    }
  }

  private readHidePreview(): boolean {
    try {
      return localStorage.getItem(SELF_KEY) === 'hidden';
    } catch {
      return false;
    }
  }

  private remember(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* preference is best-effort */
    }
  }

  private mediaMatches(query: string): boolean {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  }

  /** Follows a media query for the page's life. */
  private watchMedia(query: string, apply: (matches: boolean) => void): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent): void => apply(e.matches);
    mql.addEventListener?.('change', onChange);
    this.destroyRef.onDestroy(() => mql.removeEventListener?.('change', onChange));
  }

  // ---- The dock's controls and settings ----

  /** A control or a setting's button in the dock was pressed. */
  protected onControl(id: CallControlId): void {
    switch (id) {
      case 'mic':
        void this.toggleMic();
        break;
      case 'cam':
        void this.toggleCam();
        break;
      case 'share':
        void this.toggleScreen();
        break;
      case 'captions':
        this.toggleCaptions();
        break;
      case 'end':
        void this.leave('history');
        break;
      case 'self':
        this.moveSelfView(() => this.hidePreview.update((h) => !h));
        this.remember(SELF_KEY, this.hidePreview() ? 'hidden' : 'shown');
        break;
      case 'privacy':
        this.focusPrivacy();
        break;
      case 'invite':
        this.invite();
        break;
      case 'theme':
        this.toggleTheme();
        break;
    }
  }

  /** A segmented setting in the dock changed (the video fit). */
  protected onChoice(change: CallChoiceChange): void {
    if (change.id === 'fit' && (change.value === 'contain' || change.value === 'cover')) this.setFit(change.value);
  }

  protected setFit(fit: CallVideoFit): void {
    this.fit.set(fit);
    this.remember(FIT_KEY, fit);
  }

  /** The dock's Privacy: the Privacy & consent card's heading, scrolled into view and focused. */
  private focusPrivacy(): void {
    afterNextRender(
      () => {
        const heading = this.document.getElementById('call-privacy-title');
        heading?.scrollIntoView?.({ block: 'start' });
        heading?.focus();
      },
      { injector: this.injector },
    );
  }

  /**
   * Change where your own video plays (the stage's picture-in-picture, the
   * control-row tile, or nowhere), handing the track over first: an Agora
   * track plays in one element at a time, and stopping one playback stops the
   * other. The tiles only hold your track while it plays as their
   * picture-in-picture; the control-row tile takes it from `selfVideo`.
   */
  private moveSelfView(change: () => void): void {
    const before = this.selfMode();
    change();
    const after = this.selfMode();
    if (before === after) return;
    const self = this.videos.get(String(this.selfUid()));
    const tiles = this.stageTiles();
    if (after === 'pip') {
      if (self && tiles) tiles.attach(self.uid, self.track, self.config);
    } else {
      tiles?.detach(this.selfUid());
    }
  }

  /** Notes tabs (APG): arrows move and select, Home / End the ends. */
  protected onNotesTabKey(event: KeyboardEvent): void {
    const keys = this.notesTabs.map((t) => t.key);
    const at = keys.indexOf(this.notesTab());
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (at + 1) % keys.length;
        break;
      case 'ArrowLeft':
        next = (at - 1 + keys.length) % keys.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = keys.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.openNotesTab(keys[next]);
    afterNextRender(() => this.document.getElementById(`call-notes-tab-${keys[next]}`)?.focus(), {
      injector: this.injector,
    });
  }

  /**
   * Keeps the focused element clear of the sticky dock and the bottom toast
   * (WCAG 2.4.11): `scroll-padding` on the page, from their sizes. Nothing
   * when the dock isn't sticky (lg, a short screen, a dock taller than
   * DOCK_STICKY_MAX of the screen) or isn't given (a phone held sideways).
   */
  private syncScrollPadding(dock: HTMLElement | null, toast: HTMLElement | null): void {
    const win = this.document.defaultView;
    const root = this.document.documentElement;
    if (!win) return;
    if (dock) {
      // Too tall to stay in view: it scrolls with the page (set inline, so the check below sees it at once).
      const room = root.clientHeight;
      dock.style.position = room > 0 && dock.getBoundingClientRect().height > room * DOCK_STICKY_MAX ? 'static' : '';
    }
    const sticky = !!dock && win.getComputedStyle(dock).position === 'sticky';
    root.style.scrollPaddingTop = sticky && dock ? `${Math.ceil(dock.getBoundingClientRect().height)}px` : '';
    let bottom = '';
    if (toast) {
      const r = toast.getBoundingClientRect();
      // Only a toast along the bottom edge covers what scrolls under it.
      if (r.height > 0 && r.bottom >= win.innerHeight - 24) bottom = `${Math.ceil(r.height) + 12}px`;
    }
    root.style.scrollPaddingBottom = bottom;
  }

  /**
   * The banners above the dock as --rail-above (their height and, while they
   * show, the page's gap after them): a phone held sideways takes it from the
   * stage's column (RAIL_COLUMN), so the dock still ends on the first screen.
   * Set on their parent, which holds the dock, here rather than bound, so the
   * column follows in the same frame. Returns the disconnect.
   */
  private observeBanners(banners: HTMLElement): () => void {
    const page = banners.parentElement;
    if (!page || typeof ResizeObserver !== 'function') return () => undefined;
    const observer = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1]?.contentRect.height ?? 0;
      const above = h > 0 ? Math.ceil(h + this.gapAfter(banners)) : 0;
      page.style.setProperty('--rail-above', `${above}px`);
    });
    observer.observe(banners);
    return () => observer.disconnect();
  }

  /** The row gap of the flex box `el` sits in (its display: contents parents skipped). */
  private gapAfter(el: HTMLElement): number {
    const win = this.document.defaultView;
    let box = el.parentElement;
    while (box && win?.getComputedStyle(box).display === 'contents') box = box.parentElement;
    const gap = box && win ? parseFloat(win.getComputedStyle(box).rowGap) : 0;
    return Number.isFinite(gap) ? gap : 0;
  }

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
    { key: 'labs', label: 'Lab requests' },
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
  /** Lab requests the doctor sent for this consultation (answered after the call, in Lab Tests). */
  protected readonly labRequests = signal<PatientLabRequestSummaryDto[]>([]);
  /** A lab request's chip (icon + words; the cockpit draws it in its own neutral tone). */
  protected readonly labChipOf = labChip;
  protected readonly labTests = testsLabel;
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

  /** "9:00 AM CST Dr Ade's time" for the booked time, when the doctor's clock differs (the lobby). */
  protected readonly scheduledDoctorTime = computed(() => {
    const a = this.appointment();
    return a ? doctorTimeLabel(a.scheduled_at, a.specialist) : null;
  });

  /** Changes every 30 s of the call (a computed only notifies on a new value). */
  private readonly halfMinute = computed(() => Math.floor(this.elapsed() / 30));
  /** The doctor's clock now (top bar, from md), when it differs — refreshed every 30 s of the call. */
  protected readonly doctorNow = computed(() => {
    const tick = this.halfMinute();
    const a = this.appointment();
    return a && tick >= 0 ? doctorTimeLabel(Date.now(), a.specialist) : null;
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
    return this.visibleDocIds().has(r.docId) || this.justShared().has(r.docId) ? 'shared' : 'private';
  }

  private async loadDocAccess(passive = false): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    clearTimeout(this.docAccessTimer);
    try {
      const started = Date.now();
      const res = await firstValueFrom(this.sharingApi.forAppointment(this.appointmentId, { passive }));
      this.docAccess.set(res.data);
      // A read that started after the last in-call share is the truth now.
      if (started >= this.lastCallShareAt) this.justShared.set(new Set());
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
    // The doctor re-reads at once (the nudge carries nothing but "docs").
    sendCallNudge(this.client, 'docs');
  }

  protected docRequestAnswered(outcome: ApproveOutcome): void {
    if (outcome.kind !== 'stale') this.dismissedRequest.set(outcome.request.id);
    const line = approveOutcomeLine(outcome);
    if (line) this.docSay(line);
    void this.loadDocAccess();
    if (outcome.kind === 'approved') sendCallNudge(this.client, 'docs');
  }

  /**
   * One file stored from the call's Upload & share: in the list at once (with
   * "Shared"), what the doctor can see re-read, said out loud — and, when it
   * reached the doctor, an Agora nudge so their call re-reads now rather than
   * at its next 10 s poll.
   */
  protected onCallUpload(doc: UploadedDocumentDto): void {
    this.libraryDocs.update((list) => [doc, ...list.filter((d) => d.id !== doc.id)]);
    const shared = doc.share_outcome === 'shared' || doc.share_outcome === 'partly_shared';
    if (shared) {
      this.justShared.update((ids) => new Set([...ids, doc.id]));
      this.lastCallShareAt = Date.now();
    }
    void this.loadDocAccess();
    const who = this.docDoctor();
    const Who = who.charAt(0).toUpperCase() + who.slice(1);
    switch (doc.share_outcome) {
      case 'shared':
      case 'partly_shared':
        this.docSay(`${Who} can now see “${doc.title}”.`);
        break;
      case 'sharing_unavailable':
        this.docSay(`Saved to your records. Sharing is unavailable right now, so ${who} can't see it yet.`);
        break;
      default:
        this.docSay(`Saved to your records. ${Who} can't see it.`);
    }
    if (shared) sendCallNudge(this.client, 'docs');
  }

  private readonly records = computed<RecordItem[]>(() => {
    const list: RecordItem[] = [];
    // An older booking attachment prod-migrate step 7 couldn't file into the library (not a
    // canonical appointment-docs file): listed so the patient knows it exists, never opened.
    if (this.appointment()?.document_url) {
      list.push({ title: 'Booking attachment', date: 'This appointment', kind: 'reports', badge: 'FILE', doc: null });
    }
    for (const d of this.libraryDocs()) {
      list.push({
        title: d.title,
        date: this.rxDate(d.created_at),
        kind: this.docKind(d.document_type),
        badge: d.extension.toUpperCase(),
        docId: d.id,
        doc: d,
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
    if (this.inLive()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  private recognition?: SpeechRec;
  private netUplink = 0;
  private netDownlink = 0;
  protected appointmentId = '';
  /** The patient pressed End / left the page — final. A signal, so `inLive` follows it. */
  private readonly left = signal(false);
  /** In the live call right now (the viewer's band shows Mute / End, and print asks first). */
  protected readonly inLive = computed(() => this.status() === 'in-call' && !this.left());
  /** Agora is retrying a lost connection (the viewer's band says so; the cockpit shows the stage). */
  protected readonly reconnecting = signal(false);

  // ---- The document viewer's picture-in-picture (§3.4) ----
  /** The viewer holds the doctor's video (between willOpen and didClose). */
  private readonly viewerHasPeer = signal(false);
  /** The doctor's uid as it was when the viewer took their video. */
  private viewerPeerUid: string | null = null;
  /** The doctor's current video track, played by the viewer's tile (never also on the stage). */
  protected readonly viewerPeerTrack = signal<CallVideoTrack | null>(null);
  /** The peer is the doctor (guests never are). */
  private readonly peerUid = computed(() => this.roster().find((p) => p.role === 'doctor')?.uid ?? DOCTOR_CALL_UID);
  /** "Dr Ade" in the band and the PiP's Move label. */
  protected readonly viewerPeerName = computed(() => drLast(this.appointment()?.specialist?.name) || 'Your doctor');
  /**
   * The doctor's tile (name, camera, microphone) for the picture-in-picture, under
   * their full name as on the stage ("Dr Bayo Ade"): the initials come from it
   * ("BA"), where the short "Dr Ade" gave just "A".
   */
  protected readonly viewerPeerTile = computed<CallTile>(() => {
    const uid = this.peerUid();
    const tile = this.tiles().find((t) => !t.self && String(t.uid) === String(uid));
    const full = this.appointment()?.specialist?.name?.trim();
    const name = full ? doctorTitle(full) : this.viewerPeerName();
    return tile ? { ...tile, name } : { uid, name, role: 'doctor', hasVideo: false, muted: false };
  });

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
    // Your own only while it is their picture-in-picture (else the row tile has it).
    effect(() => {
      const tiles = this.stageTiles();
      if (!tiles) return;
      untracked(() => this.replayOnStage(tiles));
    });

    // The shared document viewer (§3): every open while this page lives gets the call band and
    // the doctor's picture-in-picture. Registered once the templates exist; gone with the page.
    afterNextRender(() => {
      const unregister = this.viewer.registerCall({
        bar: this.viewerBarTpl(),
        peer: this.viewerPeerTpl(),
        peerName: this.viewerPeerName,
        tone: this.theme,
        live: this.inLive,
        sharingScreen: this.screenOn,
        recording: this.recordingActive,
        stopSharing: () => void this.toggleScreen(),
        willOpen: () => this.handPeerToViewer(),
        didClose: () => this.takePeerBack(),
      });
      this.destroyRef.onDestroy(unregister);
    });
    // The call is over (the other side ended it, the connection dropped, or the patient left):
    // the viewer closes with it. When the call ended under an open viewer, focus goes to the
    // ended screen (§3.5), even though the opener (a record row, the Prescriptions tab's View)
    // is still on the page: the screen appeared while the page was inert behind the modal, so
    // nothing announced it. The patient leaving navigates away instead.
    effect(() => {
      const ended = this.status() === 'ended';
      if (!ended && !this.left()) return;
      untracked(() => {
        const wasOpen = this.viewer.isOpen();
        this.viewer.close();
        // After the render that closes the dialog natively (the browser hands focus back to
        // the opener then); sd-dialog's and the viewer's own restores only act on lost focus.
        if (ended && wasOpen) afterNextRender(() => this.focusEndedScreen(), { injector: this.injector });
      });
    });

    // Phone ↔ tablet width, or a phone turned sideways (the rail), moves your own
    // view; the track is handed over before the page re-renders, so it never
    // plays in two places.
    this.watchMedia(WIDE_QUERY, (m) => this.moveSelfView(() => this.wide.set(m)));
    this.watchMedia(RAIL_QUERY, (m) => this.moveSelfView(() => this.rail.set(m)));

    // Focus never hides under the sticky dock or the bottom toast (2.4.11). On a
    // phone held sideways there is neither (the dock is a row in the page, a new
    // prescription a card under the video): nothing is padded and the dock isn't
    // watched. The banners' observer resizes it there (--rail-above), and a
    // second observer on it, at the banners' depth (siblings), would be a
    // ResizeObserver loop ("completed with undelivered notifications").
    effect((onCleanup) => {
      const dock = this.rail() ? null : (this.dockEl()?.nativeElement ?? null);
      const toast = this.toastEl()?.nativeElement ?? null;
      const win = this.document.defaultView;
      if (!win) return;
      const sync = (): void => this.syncScrollPadding(dock, toast);
      sync();
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
      if (dock) observer?.observe(dock);
      if (toast) observer?.observe(toast);
      win.addEventListener('resize', sync);
      onCleanup(() => {
        observer?.disconnect();
        win.removeEventListener('resize', sync);
        if (dock) dock.style.position = '';
      });
    });
    this.destroyRef.onDestroy(() => {
      const root = this.document.documentElement;
      root.style.scrollPaddingTop = '';
      root.style.scrollPaddingBottom = '';
    });

    // A phone held sideways: the banners above the dock come off the stage's
    // column (--rail-above). They render once the patient enters the call; the
    // observer goes with them (and with the page).
    effect((onCleanup) => {
      const banners = this.bannersEl()?.nativeElement;
      if (banners) onCleanup(this.observeBanners(banners));
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
    this.reconnecting.set(false);
    this.netQuality.set(null);
    let client: IAgoraRTCClient | undefined;
    try {
      const { data } = await firstValueFrom(this.appointments.callToken(this.appointmentId));
      if (this.left()) return; // left while the token was on its way
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
        if (self === this.client) this.reconnecting.set(state === 'RECONNECTING');
      });
      self.on('network-quality', (s) => {
        this.netUplink = s.uplinkNetworkQuality ?? 0;
        this.netDownlink = s.downlinkNetworkQuality ?? 0;
        if (self !== this.client) return;
        // The worse of the two; 0 means "not known yet" (it never outranks a real value).
        const known = [this.netUplink, this.netDownlink].filter((q) => q > 0);
        this.netQuality.set(known.length ? Math.max(...known) : null);
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
      if (this.left() || this.client !== self) return; // left / dropped mid-join
      // Connected: a consultation has long stretches without input, so pause the
      // idle timeout while it is actually going on (see syncHold).
      this.connected = true;
      if (this.remoteUids.size === 0) this.startFirstWait();
      this.syncHold();
      self.enableAudioVolumeIndicator(); // who is speaking, for the grid's rings

      // Each device on its own when both together fail: a missing or blocked
      // camera still leaves an audio-only call (and the other way round).
      const media = await openLocalMedia({ audio: true, video: true });
      if (this.left() || this.client !== self) {
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
      if (this.left() || this.client !== self) return;

      this.status.set('in-call');
      this.startHeartbeat();
      this.startTimer();
      if (this.holding) this.startLivePolls();
    } catch (err) {
      if (this.left() || (client && this.client !== client)) return; // already handled
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
      !this.left() &&
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
    // Pick up anything issued at the end, and whether the doctor closed the visit
    // (background reads: passive).
    void this.refreshClinical(true);
    void this.checkConsultationClosed();
  }

  /** Before `connected` flips, Agora already reports who is in the channel. */
  private connectedOrJoining(): boolean {
    return !this.left() && this.status() !== 'ended';
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
   * Always a background read (the poll, Agora's events, a refused heartbeat):
   * passive, never activity.
   */
  private async checkConsultationClosed(): Promise<void> {
    // Signed out mid-call (the page leaves once the call ends): nothing to ask the API.
    if (!this.auth.isAuthenticated()) return;
    try {
      const res = await firstValueFrom(this.appointments.getMine(this.appointmentId, { passive: true }));
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
    if (client !== this.client || this.left() || !this.connected) return;
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
    this.reconnecting.set(false);
    this.netQuality.set(null);
    this.inviteOpen.set(false);
    this.endedReason.set(reason);
    this.status.set('ended');
    if (reason === 'completed' && wasReviewed(this.appointmentId)) {
      this.reviewState.set('done');
      this.reviewNote.set('You have already rated this consultation — thank you.');
    }
    // One last look, so the notes show everything issued during the visit (passive).
    void this.refreshClinical(true);
  }

  /**
   * Tell the API the patient is in the call, so appointment lists (theirs and
   * the doctor's) can show it. Each answer names everyone who may be in the
   * call (a guest invited meanwhile gets their name on their tile) and which
   * guests are here; a refusal (410 — the consultation was closed) ends the
   * call once nobody else is in it. Restarted after a rejoin; never two at once.
   * Each beat is passive (`sendCallPresence` marks a beat with a bearer token
   * `X-SD-Passive`): the call's hold, not the heartbeat, keeps the session alive.
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
    if (this.left() || this.status() !== 'ended' || this.endedReason() !== 'dropped') return;
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

  /**
   * Play a uid's video in its tile (now, or once the tile renders). Your own
   * goes to the stage only as its picture-in-picture; the control-row tile
   * plays it from `selfVideo` otherwise (never both at once).
   */
  private showVideo(uid: CallUid, track: CallVideoTrack, config?: CallVideoPlayConfig): void {
    this.videos.set(String(uid), { uid, track, config });
    // The document viewer holds the doctor's video: its picture-in-picture plays it, never the stage too.
    if (this.viewerOwnsPeer(uid)) {
      this.viewerPeerTrack.set(track);
      return;
    }
    const self = String(uid) === String(this.selfUid());
    if (self) this.selfVideo.set({ track, config });
    if (!self || this.selfMode() === 'pip') this.stageTiles()?.attach(uid, track, config);
    else this.stageTiles()?.detach(uid);
  }

  private hideVideo(uid: CallUid): void {
    this.videos.delete(String(uid));
    if (this.viewerOwnsPeer(uid)) {
      this.viewerPeerTrack.set(null);
      return;
    }
    if (String(uid) === String(this.selfUid())) this.selfVideo.set(null);
    this.stageTiles()?.detach(uid);
  }

  /**
   * Play every video handed over so far on (re-created) stage tiles. Your own
   * only while it is their picture-in-picture (else the row tile has it); the
   * doctor's not while the document viewer's picture-in-picture plays it.
   */
  private replayOnStage(tiles: Pick<CallTilesComponent, 'attach'>): void {
    const self = String(this.selfUid());
    for (const v of this.videos.values()) {
      if (String(v.uid) === self && this.selfMode() !== 'pip') continue;
      if (this.viewerOwnsPeer(v.uid)) continue;
      tiles.attach(v.uid, v.track, v.config);
    }
  }

  // ---- The document viewer's picture-in-picture (§3.4) ----

  /** The one gate for every stage attach / detach of a remote: the viewer holds the doctor's video. */
  private viewerOwnsPeer(uid: CallUid): boolean {
    return this.viewerHasPeer() && String(uid) === this.viewerPeerUid;
  }

  /**
   * The viewer opened (every check passed): stop the doctor's video on the
   * stage first, then give it to the picture-in-picture, which plays it once
   * rendered — so it never plays in two places.
   */
  private handPeerToViewer(): void {
    const uid = String(this.peerUid());
    this.viewerPeerUid = uid;
    this.viewerHasPeer.set(true);
    this.stageTiles()?.detach(uid);
    this.viewerPeerTrack.set(this.videos.get(uid)?.track ?? null);
  }

  /**
   * The viewer closed, and its picture-in-picture is gone (its tile stopped the
   * track): play the doctor's current video on the stage again — re-read, as
   * they may have re-published, or left, meanwhile.
   */
  private takePeerBack(): void {
    const uid = this.viewerPeerUid;
    this.viewerHasPeer.set(false);
    this.viewerPeerTrack.set(null);
    this.viewerPeerUid = null;
    const v = uid ? this.videos.get(uid) : undefined;
    if (v) this.stageTiles()?.attach(v.uid, v.track, v.config);
  }

  /**
   * Your camera came back on: play it again where it shows. The row tile only
   * replays on a new track, so it gets none for one render, then this one.
   */
  private replaySelf(track: CallVideoTrack): void {
    const uid = this.selfUid();
    this.hideVideo(uid);
    if (this.selfMode() === 'pip') {
      this.showVideo(uid, track);
      return;
    }
    afterNextRender(
      () => {
        if (this.camTrack === track && !this.screenOn()) this.showVideo(uid, track);
      },
      { injector: this.injector },
    );
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
    if (this.left() || !client || client !== this.client || !this.connected) {
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
   * `passive` for every re-read but the page's first load (the poll, Agora's
   * events, the call ending): background reads never extend the idle session.
   */
  private async refreshClinical(passive = false): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    const id = this.appointmentId;
    const options = passive ? { passive: true } : undefined;
    try {
      const rx = await firstValueFrom(this.appointments.prescriptions(id, options));
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
      const lo = await firstValueFrom(this.appointments.labOrders(id, options));
      this.labs.set(lo.data ?? []);
    } catch {
      /* none */
    }
    try {
      const lr = await firstValueFrom(this.labApi.mine({ appointment_id: id, per_page: 50 }, options));
      this.labRequests.set(lr.data ?? []);
    } catch {
      /* none (a failed poll keeps the list shown) */
    }
    try {
      const cp = await firstValueFrom(this.appointments.carePlan(id, options));
      this.carePlan.set(cp.data);
    } catch {
      /* not published */
    }
    try {
      const rf = await firstValueFrom(this.appointments.referrals(id, options));
      this.referrals.set(rf.data ?? []);
    } catch {
      /* none */
    }
    try {
      const fu = await firstValueFrom(this.appointments.followUps(id, options));
      this.proposedFollowUps.set((fu.data ?? []).filter((a) => isOpenProposal(a)));
    } catch {
      /* none */
    }
    try {
      const s = await firstValueFrom(this.appointments.consultationSummary(id, options));
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

  /**
   * "View prescription" (the toast, or the viewer's band while it is open):
   * the prescription in the document viewer — replacing the document on
   * screen when the viewer is open — and its row in the Prescriptions tab.
   */
  protected viewRxFromToast(rx: PrescriptionDto): void {
    this.viewRx(rx);
    this.dismissRxToast();
    this.openNotesTab('prescriptions');
  }

  /**
   * A prescription in the shared document viewer, a modal over the call (the
   * call keeps running, and the viewer's band keeps Mute and End in reach):
   * the Prescriptions tab's list, at this one. Never a tab or a navigation of
   * this page — either would end the call.
   */
  protected viewRx(rx: PrescriptionDto, event?: Event): void {
    const list = this.issuedRx().some((p) => p.id === rx.id) ? this.issuedRx() : [rx];
    const zone = deviceZone();
    this.viewer.open(
      list.map((p) => myPrescriptionSource(this.prescriptionsApi, p, zone)),
      {
        index: Math.max(0, list.findIndex((p) => p.id === rx.id)),
        opener: openerOf(event),
        fallbackFocus: () => this.viewerFallbackFocus('call-notes-tab-prescriptions'),
        listLabel: 'your prescriptions',
      },
    );
  }

  /**
   * A record's eye: the document viewer over the records listed now (All /
   * Reports / Labs / Imaging), at this one. An older attachment that only has
   * a URL is not in the list (it can't be opened here).
   */
  protected viewRecord(r: RecordItem, event?: Event): void {
    const docs = this.visibleRecords()
      .map((x) => x.doc)
      .filter((d): d is MedicalDocumentDto => d !== null);
    if (!r.doc) return;
    const zone = deviceZone();
    this.viewer.open(
      docs.map((d) => myDocumentSource(this.documentsApi, d, zone)),
      {
        index: Math.max(0, docs.findIndex((d) => d.id === r.doc?.id)),
        opener: openerOf(event),
        fallbackFocus: () => this.viewerFallbackFocus('call-docs-title'),
        listLabel: 'your records',
      },
    );
  }

  /** Where focus goes when the viewer closes and its opener is gone: the ended screen, else `id`. */
  private viewerFallbackFocus(id: string): HTMLElement | null {
    if (this.status() === 'ended') {
      const ended = this.document.querySelector<HTMLElement>('[data-testid="call-ended"]');
      if (ended) return ended;
    }
    return this.document.getElementById(id);
  }

  /** The call ended under the viewer: focus the ended screen, unless another dialog (e.g. "Leave the consultation?") holds it. */
  private focusEndedScreen(): void {
    if (this.status() !== 'ended' || this.viewer.isOpen()) return;
    if (this.document.activeElement?.closest('dialog[open]')) return;
    this.document.querySelector<HTMLElement>('[data-testid="call-ended"]')?.focus();
  }

  /** The band's "Back to call": close the viewer (focus goes back to what opened it). */
  protected backToCall(): void {
    this.viewer.close();
  }

  /** The band's End: out of full screen first, then the usual "Leave the consultation?" (it stacks above the viewer). */
  protected leaveFromViewer(): void {
    if (this.document.fullscreenElement) void this.document.exitFullscreen?.().catch(() => undefined);
    void this.leave('history');
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

  /** token-privilege-will-expire (hourly): a fresh RTC token — asked for by the SDK, so passive. */
  private async renewToken(): Promise<void> {
    try {
      const { data } = await firstValueFrom(this.appointments.callToken(this.appointmentId, { passive: true }));
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

  /**
   * In-call polling — runs only while the consultation holds the idle timer.
   * Every request it makes is passive (`X-SD-Passive`): the hold itself keeps
   * a live call's session alive (`SessionTimeoutService` touches the server
   * every few minutes while held), so the polls never need to — and a call
   * screen left open after the call never keeps an idle session alive.
   */
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
        const res = await firstValueFrom(this.appointments.recordings(this.appointmentId, { passive: true }));
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
      void this.refreshClinical(true);
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
        .reportMetric(
          this.appointmentId,
          {
            uplink: this.netUplink,
            downlink: this.netDownlink,
            rtt,
          },
          { passive: true },
        )
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
    this.captionsPoll = setInterval(() => void this.loadCaptions(true), 6000);
    if (this.speechSupported()) this.startCaptionRecognition();
  }

  protected latestCaptions(): TranscriptSegmentDto[] {
    return this.captions().slice(-2);
  }

  /** The captions; `passive` for the 6 s poll (turning captions on is the patient's own request). */
  private async loadCaptions(passive = false): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    try {
      const res = await firstValueFrom(
        this.appointments.transcript(this.appointmentId, passive ? { passive: true } : undefined),
      );
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
    this.replaySelf(cam);
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
    return this.inLive();
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
    this.left.set(true);
    this.connected = false;
    this.stopHeartbeat();
    // Out of the call: the idle timeout runs again.
    this.holding = false;
    this.session.release(CALL_HOLD);
    clearTimeout(this.rxToastTimer);
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
