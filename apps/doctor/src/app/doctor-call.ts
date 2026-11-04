import { NgTemplateOutlet } from '@angular/common';
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
  type Signal,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, type Subscription, tap } from 'rxjs';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  ILocalTrack,
  ILocalVideoTrack,
  IMicrophoneAudioTrack,
} from 'agora-rtc-sdk-ng';
import { type CanLeave, isSessionEndError, SessionTimeoutService, StaffAuthService } from '@supadoc/auth';
import {
  ApiService,
  apiErrorCode,
  apiErrorMessage,
  type CallPresenceState,
  DoctorApi,
  doctorStandingCode,
  dualTime,
  formatInZone,
  isDoctorStandingCode,
  isValidTimeZone,
  onCallNudge,
  participantByUid,
  sendCallPresence,
  startCallPresence,
  timeLabel,
  todayLocal,
} from '@supadoc/data-access';
import {
  type CallParticipantDto,
  type CallPresenceBeatDto,
  type CallPresenceDto,
  type CallRefusalCode,
  type ConsentDto,
  type CopilotDraftDto,
  type DoctorAccessRequestDto,
  type DoctorDocumentAccessDto,
  type DoctorSharedDocumentDto,
  type DoctorStandingCode,
  type JoinInfoDto,
  type LabOrderDto,
  type MedicalCertificateDto,
  PATIENT_CALL_UID,
  type ReferralDto,
  type TranscriptSegmentDto,
  type VitalReadingDto,
} from '@supadoc/models';
import {
  buildCallTiles,
  type CallControl,
  type CallControlId,
  CallControlsComponent,
  type CallMenuItem,
  CallQualityComponent,
  CallSelfTileComponent,
  type CallSelfViewMode,
  CALL_SELF_VIEW_CLASS_DOCTOR,
  type CallTilesMode,
  CallTilesComponent,
  type CallVideoFit,
  type CallUid,
  callTilesMode,
  DialogComponent,
  DialogService,
  type LeaveCopy,
  IconComponent,
  type RemoteParticipant,
  RemoteParticipants,
  shortDayLabel,
  SmoothHeightDirective,
} from '@supadoc/ui';
import { environment } from '../environments/environment';
import { CERTIFICATE_BACKDATE_DAYS } from './appointment/clinical/clinical-certificates';
import {
  accessBanner,
  byNewestShare,
  CALL_HIDDEN_POLL_MS,
  CALL_LIVE_POLL_MS,
  CALL_SIGNED_OUT,
  callEmptyCopy,
  callHeaderLine,
  diffNewDocs,
  type DocAlert,
  docAlertLines,
  EMPTY_NEW_DOCS,
  isStaleRequestCode,
  isViewableDoc,
  LOAD_FAILED,
  type NewDocsState,
  nextRefreshDelay,
  NOT_SHARED,
  NUDGE_DEBOUNCE_MS,
  NUDGE_MIN_INTERVAL_MS,
  openErrorCopy,
  POLL_SLACK_MS,
  REQUEST_SENT,
  REQUEST_WITHDRAWN,
  requestErrorCopy,
  sharedAgoText,
  unavailableBanner,
  WITHDRAW_FAILED,
  WITHDRAW_PROMPT,
} from './appointment/document-access';
import { FollowUpPlanner } from './appointment/follow-up-planner';
import { RequestAccessDialog } from './appointment/request-access-dialog';
import { draftIsNewer, type NoteDraftPayload, NoteDraftStore } from './appointment/note-draft';
import { callHoldWanted, FIRST_WAIT_HOLD_MS } from './call-hold';
import { DoctorClock } from './doctor-clock';
import { focusAfterDialogs } from './focus-after-dialog';
import { RxPanel } from './prescriptions/rx-panel';
import { UNSAVED_RX_LEAVE } from './prescriptions/rx-shared';
import {
  certificatePrompt,
  finalizeNotePrompt,
  labOrderPrompt,
  carePlanPrompt,
  referralPrompt,
  STOP_RECORDING_PROMPT,
} from './appointment/clinical/clinical-prompts';
import {
  ProtectedDocumentViewer,
  type ProtectedDocumentFile,
  type ProtectedViewerState,
} from './viewer/protected-document-viewer';

/** Load state of something the editor must not overwrite before it has loaded. */
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** 'document': the viewer's temporary tab (wide and mid). */
type NotesTab = 'notes' | 'prescriptions' | 'labs' | 'followup' | 'copilot' | 'document';
/** Narrow screens: the section under the video. */
type CallSection = 'notes' | 'patient' | 'documents' | 'people';
/** Mid screens: the side panel's tab. */
type SideTab = 'patient' | 'documents' | 'people';
/** Video size (More › Small / Medium / Large). */
type VideoSize = 's' | 'm' | 'l';

/** The new-document alert hides after this long (the badge stays). */
const DOC_ALERT_MS = 15_000;
const VIDEO_SIZE_KEY = 'videomed.call.video-size';
/** The old "More room" switch: on means a small video. */
const OLD_MORE_ROOM_KEY = 'videomed.call.more-room';
const FIT_KEY = 'videomed.call.fit';
const SELF_KEY = 'videomed.call.self';
const CHART_OPEN_KEY = 'videomed.call.chart-open';
const CHART_SECTIONS: readonly string[] = ['vitals', 'conditions', 'medications', 'history'];
/** The stage's height at wide and mid, per video size. */
const STAGE_HEIGHT: Record<VideoSize, string> = {
  l: 'clamp(320px, calc(100dvh - 16rem), 900px)',
  m: 'clamp(260px, calc(52dvh - 3rem), 640px)',
  s: 'clamp(200px, 32dvh, 360px)',
};

/** A remembered choice (best effort: storage may be blocked). */
function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference is best-effort */
  }
}

/** The video size, migrating the old "More room" switch (on = small). */
function readVideoSize(): VideoSize {
  const size = readStored<VideoSize | ''>(VIDEO_SIZE_KEY, ['s', 'm', 'l'], '');
  if (size) return size;
  return readStored(OLD_MORE_ROOM_KEY, ['1', '0'], '0') === '1' ? 's' : 'm';
}

/** The chart sections left open (all, the first time). */
function readChartOpen(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(CHART_OPEN_KEY);
    if (raw) {
      const list: unknown = JSON.parse(raw);
      if (Array.isArray(list)) return new Set(list.filter((x): x is string => typeof x === 'string' && CHART_SECTIONS.includes(x)));
    }
  } catch {
    /* storage blocked or garbled: the default */
  }
  return new Set(CHART_SECTIONS);
}

/** A chart disclosure's button (the whole card header). */
const CHART_TOGGLE =
  'flex min-h-11 w-full items-center gap-2 rounded-card px-4 py-3 text-left font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-frost';
/** A button in the new-document alert. */
const ALERT_BUTTON =
  'inline-flex min-h-11 items-center gap-1.5 rounded-field bg-white/10 px-3 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost';

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
  abort(): void;
}
type SpeechRecCtor = new () => SpeechRec;
type RecordsTab = 'documents' | 'imaging' | 'labs';

/**
 * The uid the cloud recorder joins the channel as while a recording runs
 * (the API's AgoraRecordingService::RECORDER_UID). Not a person: it never
 * gets a tile, a participants row or a place in the count.
 */
const RECORDER_UID = '525252';

/** At most one extra heartbeat (to refresh the participants) this often. */
const ROSTER_REFRESH_MS = 3_000;

/** The call screen's hold on the portal idle timeout (see `SessionTimeoutService.hold`). */
const CALL_HOLD = 'call';

/** Shown beside the note while it is kept on this device for a signed-out doctor. */
const NOTE_KEPT_ON_DEVICE = 'Saved on this device — sign in to sync';

/**
 * A token renewal that failed for a passing reason (network, server) is tried
 * again this often, this many times: Agora warns only once, 30 s before the
 * token runs out.
 */
const RENEW_RETRY_MS = 5_000;
const RENEW_RETRIES = 5;

/** Someone other than the doctor, as the participants panel lists them. */
interface CallPerson {
  readonly key: string;
  readonly name: string;
  readonly initials: string;
  readonly role: 'patient' | 'guest';
  /** Guests: their guest id (null for one not on the list yet). */
  readonly id: string | null;
  /** Connected to the call now (Agora). */
  readonly inCall: boolean;
  readonly muted: boolean;
  readonly cameraOff: boolean;
  /** Guests: accepted the recording + privacy notice; null when not known yet. */
  readonly consented: boolean | null;
}

/** A button in the End consultation dialog (the confirm dialog's look; `aria-disabled` keeps it focusable while busy). */
const END_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-field px-4 py-3 font-sans text-body font-semibold ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-(--sd-dialog-surface) aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

/**
 * A failed raw-`fetch()` call shaped like an API error (HTTP status + the parsed
 * body's `message` / `errors`), so `apiErrorMessage` can pick the real reason.
 */
function fetchError(status: number, body: unknown): Error {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; errors?: unknown };
  return Object.assign(new Error(typeof b.message === 'string' ? b.message : ''), {
    status,
    errors: b.errors,
  });
}

/** The HTTP status of an API error (`ApiError.statusCode` / `HttpErrorResponse.status`), else 0. */
function errorStatus(err: unknown): number {
  const e = (err && typeof err === 'object' ? err : {}) as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : 0;
}

/** `fetch()` whose network failure (offline, DNS, CORS) rejects as status 0. */
async function rawFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw fetchError(0, null);
  }
}

/**
 * Doctor consultation cockpit (route `/call/:token`). The signed call-access JWT
 * from the schedule is the credential — it resolves via the public join endpoint
 * to the Agora room plus the patient's clinical summary. Left: the patient chart.
 * Centre: the video (one tile per person: 1:1 the patient on the main stage and
 * the doctor picture-in-picture; with the patient's guests an even grid, patient
 * first), call controls and SOAP notes. Right: records and participants.
 */
@Component({
  selector: 'doc-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    CallControlsComponent,
    CallQualityComponent,
    CallSelfTileComponent,
    CallTilesComponent,
    DialogComponent,
    FollowUpPlanner,
    IconComponent,
    ProtectedDocumentViewer,
    RequestAccessDialog,
    RxPanel,
    SmoothHeightDirective,
  ],
  host: {
    class: 'sd-call block min-h-dvh bg-abyss text-white',
    '[attr.data-theme]': 'theme()',
    // Signing in to the portal happens in another tab — re-check on return.
    '(window:focus)': 'recheckPortalSignIn()',
    '(document:pointerdown)': 'onDocPointer($event)',
    '(document:visibilitychange)': 'onVisibility()',
  },
  styles: [
    `
      /* Tab panels fade in softly when switched (the animation replays when a
         panel is re-rendered or un-hidden), so changing tabs never "snaps". */
      .sd-tab-panel { animation: sdTabIn 200ms cubic-bezier(0.2, 0, 0, 1); }
      @keyframes sdTabIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sd-tab-panel { animation: none; }
      }

      /* The prescribing panel is a light "paper" surface in both cockpit
         themes. The light theme's global .sd-call .text-white override would
         turn its white-on-colour button text dark — keep it white there. */
      :host([data-theme='light']) ::ng-deep .sd-rx-zone .text-white { color: #ffffff; }

      /* The light cockpit's "New" pill: cerulean-dark on its pale tint (AA). */
      :host([data-theme='light']) .sd-new-pill { color: var(--color-cerulean-dark); }

      /* White on cerulean (about 4.8:1) for the new-document badges and every solid
         cerulean button outside the dock: the light theme's global .text-white rule
         would make that text dark (about 2.6:1). */
      :host([data-theme='light']) .sd-badge,
      :host([data-theme='light']) .bg-cerulean.text-white { color: #ffffff; }
    `,
  ],
  template: `
    <!-- relative: contains absolutely positioned bits (e.g. screen-reader-only labels deep in
         the tools panel) so they can never make the desktop cockpit scroll as a page.
         Inert while the narrow viewer sheet covers it (Tab can't wander under the sheet;
         the sheet's own bar keeps Back to call, Mute and End). -->
    <div class="relative flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden" [attr.inert]="sheetOpen() ? '' : null">
      <!-- Top bar: who, their allergies, how the call is going. Nothing here covers the video. -->
      <header class="relative z-30 flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/10 px-2 py-1.5 sm:px-4">
        <!-- Leaves without ending: the visit stays open and the doctor can rejoin. -->
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
          aria-label="Leave the call without ending it (you can rejoin)"
          (click)="leave()"
        >
          <sd-icon name="arrow-left" [size]="20" />
        </button>
        <span class="hidden shrink-0 font-heading text-h5 tracking-tight sm:inline">
          <span class="text-frost">Video</span><span class="text-sage">Med</span>
        </span>
        <p class="min-w-0 flex-1 basis-28 truncate font-sans text-body-sm font-semibold text-white">
          {{ headerPatient() }}
          @if (headerPatientTime(); as pt) {
            <span class="hidden font-normal text-white/70 2xl:inline"> · {{ pt }}</span>
          }
        </p>
        <!-- Allergies: always in view (the full list for screen readers, truncated on screen). -->
        @if (allergyNames().length) {
          <span
            class="inline-flex min-w-0 max-w-[9rem] shrink items-center gap-1 rounded-pill border border-alert/60 bg-alert/15 px-2.5 py-1 font-sans text-caption font-semibold sm:max-w-[18rem]"
            [class.text-white]="theme() !== 'light'"
            [class.text-alert-ink]="theme() === 'light'"
          >
            <sd-icon name="triangle-alert" [size]="14" class="shrink-0 text-alert" />
            <span class="truncate" aria-hidden="true">Allergies: {{ allergyNames().join(', ') }}</span>
            <span class="sr-only">Allergies: {{ allergyNames().join(', ') }}</span>
          </span>
        } @else if (info()?.patient) {
          <span class="shrink-0 font-sans text-caption text-white/70">No known allergies</span>
        }
        <span role="timer" class="flex shrink-0 items-center gap-1.5 rounded-pill bg-white/5 px-3 py-1.5 font-sans text-caption text-white/80">
          <span class="size-1.5 rounded-full bg-alert" aria-hidden="true"></span>
          <span class="hidden sm:inline">Secure call ·</span>
          <span class="font-label tabular-nums">{{ elapsedLabel() }}</span>
        </span>
        <sd-call-quality class="shrink-0" [quality]="quality()" />
        <span class="hidden shrink-0 items-center gap-1 font-sans text-caption text-white/70 md:inline-flex">
          <sd-icon name="lock" [size]="14" />Encrypted
        </span>
        <div class="relative shrink-0">
          <button
            #peopleButton
            type="button"
            class="flex min-h-11 items-center gap-1.5 rounded-pill bg-white/5 px-3 font-sans text-caption text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
            [attr.aria-expanded]="layout() === 'wide' ? peopleShown() : peopleOpen()"
            [attr.aria-controls]="layout() === 'wide' ? 'call-people-list' : (peopleOpen() ? 'call-people-popover' : null)"
            (click)="onPeopleButton()"
          >
            <sd-icon name="users" [size]="14" />{{ participantCount() }}<span class="sr-only"> in the call: participants</span>
          </button>
          @if (peopleOpen() && layout() !== 'wide') {
            <div
              id="call-people-popover"
              role="dialog"
              aria-label="Participants"
              class="absolute right-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-card border border-white/10 bg-abyss p-4 shadow-raised"
              (keydown.escape)="closePeople(true)"
            >
              <ng-container [ngTemplateOutlet]="participantsTpl" />
            </div>
          }
        </div>
        <!-- The recording state in words (the dock's Record keeps its label). -->
        <span role="status" class="shrink-0">
          @if (recordingActive()) {
            <span class="flex items-center gap-1.5 rounded-pill bg-alert/20 px-3 py-1.5 font-sans text-caption font-semibold text-white">
              <span class="size-2 rounded-full bg-alert motion-safe:animate-pulse"></span>Recording
            </span>
          }
        </span>
        <button
          type="button"
          class="hidden size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost sm:flex"
          [attr.aria-label]="theme() === 'dark' ? 'Switch to light cockpit' : 'Switch to dark cockpit'"
          (click)="toggleTheme()"
        >
          <sd-icon [name]="theme() === 'dark' ? 'sun' : 'moon'" [size]="18" />
        </button>
      </header>
      @if (recordingError()) {
        <p class="border-b border-alert/20 bg-alert/10 px-4 py-2 text-center font-sans text-caption text-white" role="alert">
          {{ recordingError() }}
        </p>
      }
      <!-- The API stopped taking this call (cancelled, or ended elsewhere): say so,
           and leave when the doctor is ready (notes and prescriptions stay open). -->
      @if (callClosed()) {
        <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-center" role="alert">
          <span class="flex items-center gap-1.5 font-sans text-caption text-warning">
            <sd-icon name="circle-alert" [size]="14" class="shrink-0" />{{ callClosed() }}
          </span>
          @if (joinStanding(); as code) {
            <!-- Refused mid-call for the doctor's standing: where to put it right. -->
            <button
              type="button"
              class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
              (click)="openStanding()"
            >
              {{ code === 'terms_required' ? 'Read and accept the terms' : 'See your account status' }}
            </button>
          }
          <button
            type="button"
            class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
            (click)="leave()"
          >
            Leave the call
          </button>
        </div>
      } @else if (rejoining() || connectionLost()) {
        <!-- Dropped from the video (the call's token ran out and couldn't be renewed):
             rejoining by itself, else Rejoin. Notes and prescriptions stay as they are. -->
        <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-center" role="alert">
          <span class="flex items-center gap-1.5 font-sans text-caption text-warning">
            <sd-icon
              [name]="rejoining() ? 'loader-circle' : 'circle-alert'"
              [size]="14"
              [class]="rejoining() ? 'shrink-0 motion-safe:animate-spin' : 'shrink-0'"
            />{{ rejoining() ? 'Reconnecting to the call…' : 'You were disconnected from the call.' }}
          </span>
          @if (connectionLost()) {
            <button
              type="button"
              class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
              (click)="rejoin()"
            >
              Rejoin
            </button>
          }
        </div>
      }

      <!-- Cockpit. DOM order = reading order: the video, the tools, then the chart,
           records and participants (grid areas place them; never order-*). -->
      <main [class]="gridClass()" [style.--stage-h]="stageHeight()" [style.--stage-max]="stageMax()">
        <!-- ===================== DOCK: the video and its controls ===================== -->
        <section #dock class="sd-dock flex min-w-0 flex-col gap-2" [class]="dockClass()" aria-label="Video call">
          <div
            class="sd-stage relative shrink-0 overflow-hidden rounded-card bg-ink [container-name:stage] [container-type:size] motion-reduce:transition-none"
            [class]="stageClass()"
          >
            <!-- One tile per person, keyed by Agora uid: 1:1 the patient (or whoever is
                 there) fills the stage, whole (contain) unless "fill the frame" is chosen;
                 from a third person an even grid. The doctor's own camera is the PiP from
                 640px up; on a phone it is a small tile at the start of the control row. -->
            <sd-call-tiles
              [tiles]="tiles()"
              [selfViewClass]="selfViewClass"
              [showRole]="showRoles()"
              [mainFit]="fit()"
              [selfView]="selfMode()"
            />

            @if (people().length === 0 && status() === 'in-call') {
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white/85">
                <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 roomy:flex">
                  <sd-icon name="user-round" [size]="30" />
                </span>
                <p class="font-sans text-body-sm roomy:text-body">Waiting for {{ patientName() }} to join…</p>
              </div>
            }

            @if (status() === 'loading') {
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/85" role="status">
                <span class="size-10 rounded-full border-2 border-white/20 border-t-white motion-safe:animate-spin"></span>
                <p class="font-sans text-body">Connecting to the consultation…</p>
              </div>
            }

            @if (status() === 'error') {
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-4 text-center text-white/85">
                <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-white/10">
                  <sd-icon name="video-off" [size]="28" />
                </span>
                <p class="max-w-sm font-sans text-body" role="alert">{{ errorMessage() }}</p>
                @if (joinStanding(); as code) {
                  <!-- Refused for the doctor's standing: where to put it right. -->
                  <button
                    type="button"
                    class="min-h-11 rounded-field bg-white px-5 py-2.5 font-sans text-body-sm font-semibold text-abyss transition-colors hover:bg-white/90"
                    (click)="openStanding()"
                  >
                    {{ code === 'terms_required' ? 'Read and accept the terms' : 'See your account status' }}
                  </button>
                }
                <button
                  type="button"
                  class="min-h-11 rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                  (click)="leave('schedule')"
                >
                  Back to schedule
                </button>
              </div>
            }
          </div>

          @if (status() === 'in-call') {
            <!-- The controls sit under the video, never on it. -->
            <div class="flex items-center gap-2 rounded-card border border-white/10 bg-ink px-2 py-2">
              @if (selfMode() === 'external' && selfTile(); as st) {
                <sd-call-self-tile [tile]="st" [track]="selfTrack()" [playConfig]="selfPlayConfig()" />
              }
              <div class="min-w-0 flex-1 [container-name:callbar] [container-type:inline-size]">
                <sd-call-controls
                  [controls]="controls()"
                  [menu]="menu()"
                  ariaLabel="Call controls"
                  (pressed)="onControl($event)"
                  (menuSelect)="onMenu($event)"
                />
              </div>
            </div>
          }
          @if (layout() !== 'narrow') {
            <ng-container [ngTemplateOutlet]="docAlertTpl" />
          }
        </section>

        <!-- Narrow screens: one section at a time under the video. -->
        @if (layout() === 'narrow') {
          <div role="tablist" aria-label="Sections" class="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10">
            @for (s of sectionTabs; track s.key) {
              <button
                type="button"
                role="tab"
                [id]="'call-section-' + s.key"
                class="relative flex min-h-11 items-center gap-1.5 whitespace-nowrap px-3 font-sans text-body-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-frost"
                [class]="section() === s.key ? 'text-white' : 'text-white/70 hover:text-white'"
                [attr.aria-selected]="section() === s.key"
                [attr.aria-controls]="s.panel"
                [attr.tabindex]="section() === s.key ? 0 : -1"
                (click)="section.set(s.key)"
                (keydown)="onTabKey($event, 'section')"
              >
                {{ s.label }}
                @if (s.key === 'documents' && newDocCount()) {
                  <span class="sd-badge min-w-5 rounded-pill bg-cerulean px-1.5 text-center font-sans text-caption font-semibold text-white">{{ newDocCount() }}<span class="sr-only"> new</span></span>
                }
                @if (section() === s.key) {
                  <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                }
              </button>
            }
          </div>
        }

        <!-- ===================== CONSULTATION TOOLS ===================== -->
        <section
          id="call-tools"
          aria-label="Consultation tools"
          class="flex min-w-0 flex-col rounded-card border border-white/10 bg-white/[0.03]"
          [class]="toolsClass()"
          [hidden]="layout() === 'narrow' && section() !== 'notes'"
          [attr.role]="layout() === 'narrow' ? 'tabpanel' : null"
          [attr.aria-labelledby]="layout() === 'narrow' ? 'call-section-notes' : null"
        >
          <div class="flex shrink-0 items-center gap-1 border-b border-white/10 px-2">
            <div role="tablist" aria-label="Consultation tools" class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              @for (t of toolTabs(); track t.key) {
                <button
                  type="button"
                  role="tab"
                  [id]="'call-tab-' + t.key"
                  class="relative min-h-11 max-w-[14rem] shrink-0 truncate whitespace-nowrap px-3 font-sans text-body-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-frost"
                  [class]="notesTab() === t.key ? 'text-white' : 'text-white/70 hover:text-white'"
                  [attr.aria-selected]="notesTab() === t.key"
                  aria-controls="call-tools-panel"
                  [attr.tabindex]="notesTab() === t.key ? 0 : -1"
                  (click)="notesTab.set(t.key)"
                  (keydown)="onTabKey($event, 'tools')"
                >
                  {{ t.label }}
                  @if (notesTab() === t.key) {
                    <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                  }
                </button>
              }
            </div>
            @if (viewerDoc() && layout() !== 'narrow') {
              <button
                type="button"
                class="flex size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
                aria-label="Close document"
                (click)="closeViewer()"
              >
                <sd-icon name="x" [size]="16" />
              </button>
            }
          </div>

            <!-- Desktop: scrolls inside the panel. Everywhere: height changes ease
                 (sdSmoothHeight) and each tab fades in, instead of jumping. -->
            <div id="call-tools-panel" role="tabpanel" class="relative" [class]="toolsBodyClass()" [attr.aria-labelledby]="'call-tab-' + notesTab()">
              <div sdSmoothHeight [hidden]="docTabShown()">
              <div>
              <!-- Schedule follow-up (Follow-ups tab, above the care plan). Once opened
                   it stays mounted for the rest of the call — hidden on the other
                   tabs — so a half-chosen time and note survive a tab switch; it
                   refreshes its slots and replies each time the tab shows again. -->
              @if (followUpMounted() && rxAppointmentId(); as apptId) {
                <div class="sd-tab-panel mb-4" [class.hidden]="notesTab() !== 'followup'">
                  @if (!portalSignedIn()) {
                    <div class="mb-3 flex flex-col gap-2 rounded-2xl bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                      <span class="flex items-start gap-2 font-sans text-caption text-warning">
                        <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                        <span>You are signed out of the doctor portal. Sign in again in a new tab (this call keeps going) to propose or withdraw a follow-up, or edit the care plan.</span>
                      </span>
                      <button
                        type="button"
                        class="flex w-fit shrink-0 items-center gap-1.5 rounded-field bg-cerulean px-3 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark"
                        (click)="openPortalSignIn()"
                      >
                        <sd-icon name="external-link" [size]="14" /> Sign in again
                      </button>
                    </div>
                  }
                  <!-- Light "paper" surface: the follow-up planner uses the portal palette. The call is a
                       confirmed consultation; its start says whether a follow-up can be proposed yet (a past one never blocks). -->
                  <div class="sd-rx-zone rounded-card bg-glacier p-3 text-ink sm:p-4">
                    <doc-follow-up-planner
                      [appointmentId]="apptId"
                      parentStatus="confirmed"
                      [parentScheduledAt]="info()?.scheduled_at ?? ''"
                      [active]="notesTab() === 'followup'"
                      [newTab]="true"
                    />
                  </div>
                </div>
              }
              @for (shown of [notesTab()]; track shown) {
              <div class="sd-tab-panel">
              @switch (notesTab()) {
                @case ('notes') {
                  <!-- Documentation header: status + auto-save + finalize -->
                  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2">
                      <span class="font-sans text-body-sm font-semibold text-white">SOAP Note</span>
                      @if (noteFinalized()) {
                        <span class="flex items-center gap-1 rounded-pill bg-success/15 px-2 py-0.5 font-sans text-[10px] font-semibold text-success">
                          <sd-icon name="lock" [size]="11" /> Signed &amp; locked
                        </span>
                      } @else {
                        <span class="rounded-pill bg-white/[0.06] px-2 py-0.5 font-sans text-[10px] text-white/50">Draft</span>
                      }
                    </div>
                    <div class="flex items-center gap-3">
                      @if (noteSaved()) {
                        <span class="font-sans text-caption text-white/45">{{ noteSaved() }}</span>
                      }
                      @if (!noteFinalized() && canDocument()) {
                        <button
                          type="button"
                          class="rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                          [disabled]="finalizing() || noteLoad() !== 'ready'"
                          (click)="finalizeNote()"
                        >
                          {{ finalizing() ? 'Finalizing…' : 'Finalize & sign' }}
                        </button>
                      }
                    </div>
                  </div>

                  @if (!canDocument()) {
                    <div class="mb-3 flex flex-col gap-2 rounded-2xl bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="status">
                      <span class="flex items-start gap-2 font-sans text-caption text-warning">
                        <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                        @if (noteEditable()) {
                          <span>
                            You are signed out of the doctor portal. Keep writing — the note is kept on this device and
                            saved to the record when you sign in again (in a new tab — this call keeps going).
                          </span>
                        } @else {
                          <span>Sign in to the doctor portal to document this consultation.</span>
                        }
                      </span>
                      <button
                        type="button"
                        class="flex w-fit shrink-0 items-center gap-1.5 rounded-field bg-cerulean px-3 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark"
                        (click)="openPortalSignIn()"
                      >
                        <sd-icon name="external-link" [size]="14" /> Sign in
                      </button>
                    </div>
                  }
                  @if (noteLoad() === 'loading') {
                    <p class="mb-3 flex items-center gap-2 font-sans text-caption text-white/60" role="status">
                      <span class="size-3 animate-spin rounded-full border-2 border-white/20 border-t-white/70"></span>
                      Loading the saved note…
                    </p>
                  } @else if (noteLoad() === 'error') {
                    <!-- Editing stays locked: a blank editor would auto-save over the real note. -->
                    <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-alert/10 px-3 py-2" role="alert">
                      <span class="flex min-w-0 flex-1 items-start gap-1.5 font-sans text-caption text-alert">
                        <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />
                        <span>{{ noteError() }} Editing is paused so the saved note is not overwritten.</span>
                      </span>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1 font-sans text-caption text-white/85 transition-colors hover:bg-white/10"
                        (click)="retryLoadNote()"
                      >
                        <sd-icon name="refresh-cw" [size]="13" /> Try again
                      </button>
                    </div>
                  } @else if (noteError()) {
                    <p class="mb-3 font-sans text-caption text-alert">{{ noteError() }}</p>
                  }

                  <div class="grid gap-4 lg:grid-cols-2">
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-white/60">Subjective</span>
                      <textarea
                        rows="3"
                        placeholder="Patient-reported symptoms and history…"
                        class="resize-y rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 font-sans text-body-sm text-white placeholder:text-white/35 read-only:opacity-70 focus:border-cerulean focus:outline-none"
                        [value]="subjective()"
                        [readOnly]="!noteEditable()"
                        (input)="subjective.set($any($event.target).value); scheduleSave()"
                      ></textarea>
                    </label>
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-white/60">Objective</span>
                      <textarea
                        rows="3"
                        placeholder="Examination findings, vitals…"
                        class="resize-y rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 font-sans text-body-sm text-white placeholder:text-white/35 read-only:opacity-70 focus:border-cerulean focus:outline-none"
                        [value]="objective()"
                        [readOnly]="!noteEditable()"
                        (input)="objective.set($any($event.target).value); scheduleSave()"
                      ></textarea>
                    </label>
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-white/60">Assessment</span>
                      <textarea
                        rows="3"
                        placeholder="Diagnosis, differential…"
                        class="resize-y rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 font-sans text-body-sm text-white placeholder:text-white/35 read-only:opacity-70 focus:border-cerulean focus:outline-none"
                        [value]="assessment()"
                        [readOnly]="!noteEditable()"
                        (input)="assessment.set($any($event.target).value); scheduleSave()"
                      ></textarea>
                    </label>
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-white/60">Plan</span>
                      <textarea
                        rows="3"
                        placeholder="Treatment, investigations, follow-up…"
                        class="resize-y rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 font-sans text-body-sm text-white placeholder:text-white/35 read-only:opacity-70 focus:border-cerulean focus:outline-none"
                        [value]="plan()"
                        [readOnly]="!noteEditable()"
                        (input)="plan.set($any($event.target).value); scheduleSave()"
                      ></textarea>
                    </label>
                  </div>

                  <div class="mt-4">
                    <p id="call-tools-label" class="mb-2 font-sans text-caption font-semibold text-white/70">Tools</p>
                    <div class="flex flex-wrap gap-2" role="group" aria-labelledby="call-tools-label">
                      @for (tool of tools; track tool.label) {
                        <button
                          type="button"
                          class="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-white/10 bg-white/[0.04] px-3 font-sans text-caption text-white/85 transition-colors hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
                          (click)="useTool(tool.label)"
                        >
                          <sd-icon [name]="tool.icon" [size]="16" class="text-frost" />{{ tool.label }}
                        </button>
                      }
                    </div>
                    @if (toolNote()) {
                      <p class="mt-2 font-sans text-caption text-white/45">{{ toolNote() }}</p>
                    }
                  </div>
                }
                @case ('prescriptions') {
                  <!-- Once mounted, the prescribing panel lives outside this @switch (below). -->
                  @if (!rxMounted()) {
                  @if (!portalSignedIn()) {
                    <!-- Opened from an emailed join link without a portal session. -->
                    <div class="flex flex-col items-center gap-3 px-2 py-8 text-center">
                      <span class="flex size-14 items-center justify-center rounded-full bg-white/[0.06] text-frost">
                        <sd-icon name="lock" [size]="24" />
                      </span>
                      <p class="max-w-sm font-sans text-body-sm font-semibold text-white">
                        Sign in to the doctor portal to write prescriptions
                      </p>
                      <p class="max-w-sm font-sans text-caption text-white/50">
                        The sign-in page opens in a new tab, so this call keeps going. Come back to this tab when you have signed in.
                      </p>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark"
                        (click)="openPortalSignIn()"
                      >
                        <sd-icon name="external-link" [size]="14" /> Sign in to the doctor portal
                      </button>
                    </div>
                  } @else if (rxPatientError()) {
                    <div class="flex flex-col items-center gap-3 px-2 py-8 text-center">
                      <sd-icon name="circle-alert" [size]="26" class="text-alert" />
                      <p class="max-w-sm font-sans text-body-sm text-alert">{{ rxPatientError() }}</p>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/80 transition-colors hover:bg-white/10"
                        (click)="retryRxPatient()"
                      >
                        <sd-icon name="refresh-cw" [size]="14" /> Try again
                      </button>
                    </div>
                  } @else if (status() === 'error' && !info()) {
                    <p class="py-6 text-center font-sans text-body-sm text-white/50">
                      Prescriptions are available once this consultation's details have loaded.
                    </p>
                  } @else {
                    <div class="flex flex-col gap-2" aria-busy="true">
                      <span class="sr-only">Loading prescriptions…</span>
                      <div class="sd-shimmer h-14 rounded-2xl bg-white/[0.04]"></div>
                      <div class="sd-shimmer h-14 rounded-2xl bg-white/[0.04]"></div>
                    </div>
                  }
                  }
                }
                @case ('labs') {
                  @if (!canDocument()) {
                    <p class="mb-3 rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">
                      Sign in to the doctor portal to order tests.
                    </p>
                  }
                  <div class="flex flex-col gap-3">
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-white/60">Tests (one per line)</span>
                      <textarea
                        rows="3"
                        placeholder="Complete Blood Count&#10;Lipid Panel"
                        class="resize-y rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                        [value]="labTests()"
                        (input)="labTests.set($any($event.target).value)"
                      ></textarea>
                    </label>
                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label class="flex flex-col gap-1.5">
                        <span class="font-sans text-caption font-semibold text-white/60">Priority</span>
                        <select
                          class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none"
                          [value]="labPriority()"
                          (change)="labPriority.set($any($event.target).value)"
                        >
                          <option value="routine" class="bg-ink">Routine</option>
                          <option value="urgent" class="bg-ink">Urgent</option>
                        </select>
                      </label>
                      <label class="flex flex-col gap-1.5">
                        <span class="font-sans text-caption font-semibold text-white/60">Instructions</span>
                        <input
                          placeholder="Fasting required, etc."
                          class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                          [value]="labInstructions()"
                          (input)="labInstructions.set($any($event.target).value)"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      class="flex w-fit items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                      [disabled]="labBusy() || !canDocument()"
                      (click)="issueLab()"
                    >
                      <sd-icon name="check" [size]="14" /> {{ labBusy() ? 'Sending…' : 'Sign & send order' }}
                    </button>
                    @if (labError()) {
                      <p class="font-sans text-caption text-alert">{{ labError() }}</p>
                    }
                  </div>
                  @if (issuedLabs().length) {
                    <div class="mt-4 border-t border-white/10 pt-3">
                      <p class="mb-2 font-sans text-caption font-semibold text-white/60">Ordered</p>
                      <ul class="flex flex-col gap-2">
                        @for (o of issuedLabs(); track o.id) {
                          <li class="flex items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                            <sd-icon name="clipboard-list" [size]="16" class="text-frost" />
                            <span class="flex-1 font-sans text-body-sm text-white/85">{{ o.tests.join(', ') }}</span>
                            <span
                              class="rounded-pill px-2 py-0.5 font-sans text-[10px] capitalize"
                              [class]="o.priority === 'urgent' ? 'bg-alert/15 text-alert' : 'bg-white/[0.06] text-white/60'"
                            >{{ o.priority }}</span>
                          </li>
                        }
                      </ul>
                    </div>
                  }
                }
                @case ('followup') {
                  @if (!followUpMounted()) {
                    @if (!portalSignedIn()) {
                      <!-- Opened from an emailed join link without a portal session. -->
                      <div class="mb-4 flex flex-col gap-2 rounded-2xl bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                        <span class="flex items-start gap-2 font-sans text-caption text-warning">
                          <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                          <span>Sign in to the doctor portal to schedule a follow-up or build a care plan. The sign-in page opens in a new tab, so this call keeps going.</span>
                        </span>
                        <button
                          type="button"
                          class="flex w-fit shrink-0 items-center gap-1.5 rounded-field bg-cerulean px-3 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark"
                          (click)="openPortalSignIn()"
                        >
                          <sd-icon name="external-link" [size]="14" /> Sign in to the doctor portal
                        </button>
                      </div>
                    } @else {
                      <p class="mb-4 font-sans text-caption text-white/50">
                        Scheduling a follow-up is available once this consultation's details have loaded.
                      </p>
                    }
                  } @else if (!canDocument() && portalSignedIn()) {
                    <p class="mb-3 rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">
                      Sign in to the doctor portal to build a care plan.
                    </p>
                  }
                  <div class="mb-2 flex items-center justify-between">
                    <span class="font-sans text-body-sm font-semibold text-white">Care Plan</span>
                    @if (carePlanSaved()) {
                      <span class="font-sans text-caption text-white/45">{{ carePlanSaved() }}</span>
                    }
                  </div>
                  @if (carePlanLoad() === 'loading') {
                    <p class="mb-2 flex items-center gap-2 font-sans text-caption text-white/60" role="status">
                      <span class="size-3 animate-spin rounded-full border-2 border-white/20 border-t-white/70"></span>
                      Loading the care plan…
                    </p>
                  } @else if (carePlanLoad() === 'error') {
                    <!-- Publishing stays locked: an empty editor would replace the real plan. -->
                    <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-alert/10 px-3 py-2" role="alert">
                      <span class="flex min-w-0 flex-1 items-start gap-1.5 font-sans text-caption text-alert">
                        <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />
                        <span>{{ carePlanError() }} Editing is paused so the published plan is not overwritten.</span>
                      </span>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1 font-sans text-caption text-white/85 transition-colors hover:bg-white/10"
                        (click)="retryLoadCarePlan()"
                      >
                        <sd-icon name="refresh-cw" [size]="13" /> Try again
                      </button>
                    </div>
                  }
                  <div class="flex flex-col gap-2">
                    @for (item of carePlanItems(); track $index) {
                      <div class="flex items-center gap-2">
                        <sd-icon name="circle-check" [size]="16" class="shrink-0 text-sage" />
                        <input
                          placeholder="e.g. Monitor blood pressure daily"
                          class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 read-only:opacity-70 focus:border-cerulean focus:outline-none"
                          [value]="item"
                          [readOnly]="!carePlanEditable()"
                          (input)="updateCareItem($index, $any($event.target).value)"
                        />
                        @if (carePlanItems().length > 1 && carePlanEditable()) {
                          <button
                            type="button"
                            class="shrink-0 text-white/40 transition-colors hover:text-alert"
                            aria-label="Remove item"
                            (click)="removeCareItem($index)"
                          >
                            <sd-icon name="trash-2" [size]="15" />
                          </button>
                        }
                      </div>
                    }
                    <div class="mt-1 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
                        [disabled]="!carePlanEditable()"
                        (click)="addCareItem()"
                      >
                        <sd-icon name="plus" [size]="14" /> Add item
                      </button>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                        [disabled]="carePlanBusy() || !carePlanEditable()"
                        (click)="saveCarePlan()"
                      >
                        <sd-icon name="check" [size]="14" /> Save &amp; publish
                      </button>
                    </div>
                    @if (carePlanError() && carePlanLoad() !== 'error') {
                      <p class="font-sans text-caption text-alert">{{ carePlanError() }}</p>
                    }
                  </div>

                  <!-- Referral -->
                  <div id="call-referral" class="mt-4 scroll-mt-4 border-t border-white/10 pt-3">
                    <p class="mb-2 font-sans text-body-sm font-semibold text-white">Referral</p>
                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <select
                        class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none"
                        [value]="refType()"
                        (change)="refType.set($any($event.target).value)"
                      >
                        <option value="specialist" class="bg-ink">Specialist</option>
                        <option value="hospital" class="bg-ink">Hospital</option>
                        <option value="laboratory" class="bg-ink">Laboratory</option>
                        <option value="imaging" class="bg-ink">Imaging</option>
                      </select>
                      <input placeholder="Target (e.g. Cardiology)"
                        class="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                        [value]="refTarget()" (input)="refTarget.set($any($event.target).value)" />
                    </div>
                    <input placeholder="Reason for referral"
                      class="mt-2 w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                      [value]="refReason()" (input)="refReason.set($any($event.target).value)" />
                    <div class="mt-2 flex items-center gap-2">
                      <select
                        class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white focus:border-cerulean focus:outline-none"
                        [value]="refPriority()" (change)="refPriority.set($any($event.target).value)"
                      >
                        <option value="routine" class="bg-ink">Routine</option>
                        <option value="urgent" class="bg-ink">Urgent</option>
                      </select>
                      <button type="button"
                        class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                        [disabled]="refBusy() || !canDocument()" (click)="createReferral()">
                        <sd-icon name="check" [size]="14" /> {{ refBusy() ? 'Creating…' : 'Create referral' }}
                      </button>
                    </div>
                    @if (refError()) {
                      <p class="mt-1 font-sans text-caption text-alert">{{ refError() }}</p>
                    }
                    @if (referrals().length) {
                      <ul class="mt-3 flex flex-col gap-2">
                        @for (r of referrals(); track r.id) {
                          <li class="rounded-2xl bg-white/[0.04] px-3 py-2">
                            <p class="font-sans text-body-sm text-white/85">
                              <span class="capitalize">{{ r.referral_type }}</span> → {{ r.target }}
                              @if (r.priority === 'urgent') {
                                <span class="ml-1 rounded-pill bg-alert/15 px-1.5 py-0.5 font-sans text-[10px] text-alert">Urgent</span>
                              }
                            </p>
                            <p class="font-sans text-caption text-white/50">{{ r.reason }}</p>
                          </li>
                        }
                      </ul>
                    }
                  </div>

                  <!-- Certificate -->
                  <div id="call-certificate" class="mt-4 scroll-mt-4 border-t border-white/10 pt-3">
                    <p class="mb-2 font-sans text-body-sm font-semibold text-white">Medical Certificate</p>
                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <select
                        class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none"
                        [value]="certType()" (change)="certType.set($any($event.target).value)"
                      >
                        <option value="sick_leave" class="bg-ink">Sick leave</option>
                        <option value="fitness" class="bg-ink">Fitness / return to work</option>
                        <option value="general" class="bg-ink">General</option>
                      </select>
                      <input placeholder="Diagnosis (optional)"
                        class="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                        [value]="certDiagnosis()" (input)="certDiagnosis.set($any($event.target).value)" />
                    </div>
                    @if (certType() === 'sick_leave') {
                      <div class="mt-2 grid grid-cols-2 gap-2">
                        <label class="flex flex-col gap-1"><span class="font-sans text-[10px] text-white/45">From</span>
                          <input type="date" class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none" [min]="certMinFrom()" [value]="certFrom()" (input)="certFrom.set($any($event.target).value)" /></label>
                        <label class="flex flex-col gap-1"><span class="font-sans text-[10px] text-white/45">To</span>
                          <input type="date" class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none" [min]="certFrom() || certMinFrom()" [value]="certTo()" (input)="certTo.set($any($event.target).value)" /></label>
                      </div>
                    }
                    <textarea rows="2" placeholder="Certifying statement (e.g. unfit for work and requires rest)"
                      class="mt-2 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                      [value]="certStatement()" (input)="certStatement.set($any($event.target).value)"></textarea>
                    <div class="mt-2 flex items-center gap-2">
                      <button type="button"
                        class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                        [disabled]="certBusy() || !canDocument()" (click)="issueCertificate()">
                        <sd-icon name="check" [size]="14" /> {{ certBusy() ? 'Issuing…' : 'Issue certificate' }}
                      </button>
                    </div>
                    @if (certError()) {
                      <p class="mt-1 font-sans text-caption text-alert">{{ certError() }}</p>
                    }
                    @if (issuedCerts().length) {
                      <ul class="mt-3 flex flex-col gap-2">
                        @for (c of issuedCerts(); track c.id) {
                          <li class="rounded-2xl bg-white/[0.04] px-3 py-2">
                            <p class="font-sans text-body-sm text-white/85">{{ c.type_label }}</p>
                            @if (c.from_date && c.to_date) {
                              <p class="font-sans text-caption text-white/50">{{ c.from_date }} → {{ c.to_date }}</p>
                            }
                          </li>
                        }
                      </ul>
                    }
                  </div>
                }
                @case ('copilot') {
                  <!-- Live transcription -->
                  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span class="font-sans text-body-sm font-semibold text-white">Live transcription</span>
                    <button
                      type="button"
                      class="flex items-center gap-1.5 rounded-field px-3 py-1.5 font-sans text-caption font-semibold transition-colors disabled:opacity-50"
                      [class]="transcribing() ? 'bg-alert/20 text-alert hover:bg-alert/30' : 'bg-cerulean text-white hover:bg-cerulean-dark'"
                      [disabled]="!canDocument() || (!transcribing() && (!aiConsent() || !speechSupported()))"
                      (click)="toggleTranscription()"
                    >
                      <span class="size-2 rounded-full" [class]="transcribing() ? 'animate-pulse bg-alert' : 'bg-white/70'"></span>
                      {{ transcribing() ? 'Stop' : 'Start' }} transcription
                    </button>
                  </div>
                  @if (consentsError()) {
                    <p class="mb-3 font-sans text-caption text-alert">{{ consentsError() }}</p>
                  } @else if (!aiConsent()) {
                    <p class="mb-3 rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">
                      Live transcription needs the patient's AI‑transcription consent.
                    </p>
                  } @else if (!speechSupported()) {
                    <p class="mb-3 rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">
                      This browser doesn't support speech recognition (try Chrome).
                    </p>
                  }

                  <div class="max-h-52 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                    @for (seg of transcript(); track seg.id) {
                      <p class="mb-1.5 font-sans text-body-sm">
                        <span class="font-semibold capitalize" [class]="seg.role === 'doctor' ? 'text-frost' : 'text-sage'">{{ seg.role }}:</span>
                        <span class="text-white/80"> {{ seg.text }}</span>
                      </p>
                    } @empty {
                      <p class="py-4 text-center font-sans text-caption text-white/40">
                        Transcript appears here once transcription starts.
                      </p>
                    }
                  </div>

                  <!-- AI copilot -->
                  <div class="mt-4 border-t border-white/10 pt-3">
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span class="flex items-center gap-1.5 font-sans text-body-sm font-semibold text-white">
                        <sd-icon name="sparkles" [size]="15" class="text-frost" /> AI copilot
                      </span>
                      @if (copilotConfigured()) {
                        <button
                          type="button"
                          class="rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                          [disabled]="copilotBusy() || !aiConsent()"
                          (click)="generateDraft()"
                        >
                          {{ copilotBusy() ? 'Generating…' : 'Generate AI draft' }}
                        </button>
                      }
                    </div>
                    @if (!copilotConfigured()) {
                      <p class="rounded-2xl bg-white/[0.04] px-3 py-2 font-sans text-caption text-white/50">
                        AI drafting isn't enabled on this environment.
                      </p>
                    }
                    @if (copilotError()) {
                      <p class="mt-1 font-sans text-caption text-alert">{{ copilotError() }}</p>
                    }
                    @if (copilotDraft(); as d) {
                      <div class="mt-2 rounded-2xl border border-frost/30 bg-frost/5 p-3">
                        <p class="mb-2 flex items-center gap-1.5 font-sans text-caption font-semibold text-frost">
                          <sd-icon name="sparkles" [size]="12" /> AI DRAFT — review before saving
                        </p>
                        @if (d.summary) {
                          <p class="mb-2 font-sans text-body-sm text-white/80">{{ d.summary }}</p>
                        }
                        <div class="grid gap-2 sm:grid-cols-2">
                          @if (d.assessment) {
                            <div>
                              <p class="font-sans text-caption font-semibold text-white/60">Assessment</p>
                              <p class="font-sans text-body-sm text-white/75">{{ d.assessment }}</p>
                            </div>
                          }
                          @if (d.plan) {
                            <div>
                              <p class="font-sans text-caption font-semibold text-white/60">Plan</p>
                              <p class="font-sans text-body-sm text-white/75">{{ d.plan }}</p>
                            </div>
                          }
                        </div>
                        @if (d.diagnoses.length || d.medications.length) {
                          <div class="mt-2 flex flex-wrap gap-1.5">
                            @for (x of d.diagnoses; track x) {
                              <span class="rounded-pill bg-white/[0.06] px-2 py-0.5 font-sans text-[10px] text-white/70">{{ x }}</span>
                            }
                            @for (x of d.medications; track x) {
                              <span class="rounded-pill bg-sky/15 px-2 py-0.5 font-sans text-[10px] text-sky">{{ x }}</span>
                            }
                          </div>
                        }
                        <button
                          type="button"
                          class="mt-3 flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/85 transition-colors hover:bg-white/10 disabled:opacity-50"
                          [disabled]="!noteEditable()"
                          (click)="useDraftInNote()"
                        >
                          <sd-icon name="arrow-right" [size]="14" /> Use in SOAP note
                        </button>
                      </div>
                    }
                  </div>
                }
              }
              </div>
              }

              <!-- Prescribing panel. Once opened it stays mounted for the rest of
                   the call — hidden on the other tabs, kept while the portal
                   session is signed out — so a half-written prescription is
                   never thrown away by a tab switch or a re-sign-in. -->
              @if (rxMounted() && rxPatientId(); as pid) {
                <div class="sd-tab-panel" [class.hidden]="notesTab() !== 'prescriptions'">
                  @if (!portalSignedIn()) {
                    <div class="mb-3 flex flex-col gap-2 rounded-2xl bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                      <span class="flex items-start gap-2 font-sans text-caption text-warning">
                        <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                        <span>
                          You are signed out of the doctor portal. Your prescription is kept here —
                          sign in again in a new tab (this call keeps going), then come back to save or send it.
                        </span>
                      </span>
                      <button
                        type="button"
                        class="flex w-fit shrink-0 items-center gap-1.5 rounded-field bg-cerulean px-3 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark"
                        (click)="openPortalSignIn()"
                      >
                        <sd-icon name="external-link" [size]="14" /> Sign in again
                      </button>
                    </div>
                  }
                  <!-- Light "paper" surface: the prescribing components use the portal palette. -->
                  <div class="sd-rx-zone rounded-card bg-glacier p-3 text-ink sm:p-4">
                    <doc-rx-panel
                      [patientId]="pid"
                      [appointmentId]="rxAppointmentId()"
                      [compact]="true"
                      [inCall]="true"
                      [disabled]="!portalSignedIn()"
                    />
                  </div>
                </div>
              }
              </div>
              </div>

              <!-- The shared document, view-only, in its own tab (wide / mid): the video stays
                   in view. It fills the tools panel (its toolbar stays in sight; the pages
                   scroll inside it), and stays mounted behind the other tabs. -->
              @if (viewerFile(); as vf) {
                @if (viewerDoc() && layout() !== 'narrow') {
                  <div class="flex min-h-[20rem] flex-1 flex-col" [hidden]="notesTab() !== 'document'">
                    <doc-protected-document-viewer
                      class="flex-1 overflow-hidden rounded-b-card"
                      mode="docked"
                      [tone]="theme()"
                      [file]="vf"
                      [state]="viewerState()"
                      [errorText]="viewerError()"
                      [watermark]="viewerWatermark()"
                      [inCall]="inLiveCall()"
                      (closed)="closeViewer()"
                      (printRequested)="onViewerPrint()"
                    />
                  </div>
                }
              }
            </div>
        </section>

        <!-- ===================== SIDE: chart, records, participants =====================
             One wrapper, so several asides never share a grid area: at wide it is
             display:contents (chart left, records right); at mid it is the one "side"
             item with its own tabs; at narrow the section switcher above picks one. -->
        <div [class]="sideClass()">
          @if (layout() === 'mid') {
            <div role="tablist" aria-label="Side panel" class="flex shrink-0 gap-1 border-b border-white/10">
              @for (s of sideTabs; track s.key) {
                <button
                  type="button"
                  role="tab"
                  [id]="'call-side-' + s.key"
                  class="relative flex min-h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-2 font-sans text-body-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-frost"
                  [class]="sideTab() === s.key ? 'text-white' : 'text-white/70 hover:text-white'"
                  [attr.aria-selected]="sideTab() === s.key"
                  [attr.aria-controls]="s.panel"
                  [attr.tabindex]="sideTab() === s.key ? 0 : -1"
                  (click)="sideTab.set(s.key)"
                  (keydown)="onTabKey($event, 'side')"
                >
                  {{ s.label }}
                  @if (s.key === 'documents' && newDocCount()) {
                    <span class="sd-badge min-w-5 rounded-pill bg-cerulean px-1.5 text-center font-sans text-caption font-semibold text-white">{{ newDocCount() }}<span class="sr-only"> new</span></span>
                  }
                  @if (sideTab() === s.key) {
                    <span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                  }
                </button>
              }
            </div>
          }

          <!-- ===================== PATIENT CHART ===================== -->
          <aside
            #chartCol
            id="call-chart"
            aria-label="Patient chart"
            class="flex min-w-0 flex-col gap-4"
            [class]="chartClass()"
            [hidden]="panelHidden('patient')"
            [attr.role]="layout() === 'wide' ? null : 'tabpanel'"
            [attr.aria-labelledby]="layout() === 'mid' ? 'call-side-patient' : layout() === 'narrow' ? 'call-section-patient' : null"
          >
            <!-- Who, and their allergies: first, and pinned while the chart scrolls. -->
            <div #allergyCard class="z-10 rounded-card border border-white/10 bg-abyss p-4" [class.sticky]="layout() !== 'narrow'" [class.top-0]="layout() !== 'narrow'">
              <div class="flex items-center gap-3">
                <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-cerulean/20 font-heading text-body font-semibold text-frost" aria-hidden="true">
                  {{ patientInitials() }}
                </span>
                <div class="min-w-0">
                  <p class="truncate font-heading text-body font-semibold text-white">{{ patientName() }}</p>
                  @if (patientMeta()) {
                    <p class="font-sans text-caption text-white/70">{{ patientMeta() }}</p>
                  }
                  @if (headerPatientTime(); as pt) {
                    <p class="font-sans text-caption text-white/70">{{ pt }}</p>
                  }
                </div>
              </div>
              <div class="mt-4 rounded-2xl bg-alert/10 p-3">
                <span class="flex items-center gap-1.5 font-sans text-caption font-semibold text-alert">
                  <sd-icon name="triangle-alert" [size]="14" /> Allergies
                </span>
                <p class="mt-1 font-sans text-body-sm text-white/85">{{ allergiesLabel() }}</p>
              </div>
            </div>

            <!-- Vitals (latest reading of each type, from the join payload) -->
            <div class="rounded-card border border-white/10 bg-white/[0.03]">
              <h3>
                <button type="button" class="${CHART_TOGGLE}" [attr.aria-expanded]="isChartOpen('vitals')" aria-controls="call-chart-vitals" (click)="toggleChart('vitals')">
                  <sd-icon name="activity" [size]="15" class="shrink-0 text-frost" />
                  <span class="flex-1">Vitals ({{ vitals().length }})</span>
                  <sd-icon name="chevron-down" [size]="16" class="shrink-0 text-white/70 transition-transform motion-reduce:transition-none" [class.rotate-180]="isChartOpen('vitals')" />
                </button>
              </h3>
              @if (isChartOpen('vitals')) {
                <div id="call-chart-vitals" class="px-4 pb-4">
                  @if (vitalsAsOf()) {
                    <p class="mb-2 font-sans text-caption text-white/70">{{ vitalsAsOf() }}</p>
                  }
                  @if (vitals().length) {
                    <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
                      @for (v of vitals(); track v.key) {
                        <div class="flex min-w-0 flex-col gap-0.5 rounded-xl bg-white/[0.04] p-2" [attr.title]="vitalTitle(v)">
                          <p class="truncate font-sans text-caption text-white/70">{{ v.label }}</p>
                          <p class="font-heading text-body font-semibold text-white">
                            {{ v.value }}
                            <span class="font-sans text-caption font-normal text-white/70">{{ v.unit }}</span>
                          </p>
                          @if ((v.flag && v.flag.level !== 'normal') || v.recorded_by === 'patient' || v.stale) {
                            <p class="flex flex-wrap gap-1">
                              <!-- Out of the typical adult range only; normal readings stay quiet. -->
                              @if (v.flag && v.flag.level !== 'normal') {
                                <span
                                  class="rounded-pill px-1.5 font-sans text-caption font-semibold"
                                  [class]="v.flag.level === 'high' || v.flag.level === 'critical' ? 'bg-alert/20 text-alert' : 'bg-warning/15 text-warning'"
                                >{{ v.flag.label }}</span>
                              }
                              @if (v.recorded_by === 'patient') {
                                <span class="rounded-pill bg-sky/15 px-1.5 font-sans text-caption text-sky">Self-reported</span>
                              }
                              @if (v.stale) {
                                <span class="rounded-pill bg-warning/15 px-1.5 font-sans text-caption text-warning">Out of date</span>
                              }
                            </p>
                          }
                        </div>
                      }
                    </div>
                    @if (vitalAlerts().length) {
                      <ul class="mt-2 flex flex-col gap-1">
                        @for (v of vitalAlerts(); track v.key) {
                          <li class="flex items-start gap-1.5 font-sans text-caption text-alert">
                            <sd-icon [name]="v.flag?.level === 'critical' ? 'triangle-alert' : 'circle-alert'" [size]="12" class="mt-0.5 shrink-0" />
                            <span>{{ v.label }} is {{ v.flag?.label }} <span class="text-white/70">({{ v.flag?.advice }})</span></span>
                          </li>
                        }
                      </ul>
                    }
                    <p class="mt-1.5 font-sans text-caption text-white/60">Flags use typical adult ranges.</p>
                  } @else {
                    <p class="font-sans text-caption text-white/70">
                      No readings on file yet. Readings the patient adds, or that you record on a
                      prescription, appear here.
                    </p>
                  }
                </div>
              }
            </div>

            <!-- Conditions -->
            <div class="rounded-card border border-white/10 bg-white/[0.03]">
              <h3>
                <button type="button" class="${CHART_TOGGLE}" [attr.aria-expanded]="isChartOpen('conditions')" aria-controls="call-chart-conditions" (click)="toggleChart('conditions')">
                  <sd-icon name="heart-pulse" [size]="15" class="shrink-0 text-sage" />
                  <span class="flex-1">Current Conditions ({{ conditions().length }})</span>
                  <sd-icon name="chevron-down" [size]="16" class="shrink-0 text-white/70 transition-transform motion-reduce:transition-none" [class.rotate-180]="isChartOpen('conditions')" />
                </button>
              </h3>
              @if (isChartOpen('conditions')) {
                <div id="call-chart-conditions" class="px-4 pb-4">
                  @if (conditions().length) {
                    <ul class="flex flex-col gap-1.5">
                      @for (c of conditions(); track c.condition) {
                        <li class="flex items-center justify-between gap-2 font-sans text-body-sm text-white/85">
                          <span>{{ c.condition }}</span>
                          <span class="size-2 shrink-0 rounded-full bg-sage" aria-hidden="true"></span>
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="font-sans text-body-sm text-white/70">None recorded.</p>
                  }
                </div>
              }
            </div>

            <!-- Medications -->
            <div class="rounded-card border border-white/10 bg-white/[0.03]">
              <h3>
                <button type="button" class="${CHART_TOGGLE}" [attr.aria-expanded]="isChartOpen('medications')" aria-controls="call-chart-medications" (click)="toggleChart('medications')">
                  <sd-icon name="pill" [size]="15" class="shrink-0 text-sky" />
                  <span class="flex-1">Medications ({{ medications().length }})</span>
                  <sd-icon name="chevron-down" [size]="16" class="shrink-0 text-white/70 transition-transform motion-reduce:transition-none" [class.rotate-180]="isChartOpen('medications')" />
                </button>
              </h3>
              @if (isChartOpen('medications')) {
                <div id="call-chart-medications" class="px-4 pb-4">
                  @if (medications().length) {
                    <ul class="flex flex-col gap-2">
                      @for (m of medications(); track m.name) {
                        <li class="flex items-center justify-between gap-2">
                          <span class="font-sans text-body-sm text-white/85">{{ m.name }}</span>
                          <span class="font-sans text-caption text-white/70">{{ m.dosage }}</span>
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="font-sans text-body-sm text-white/70">None recorded.</p>
                  }
                </div>
              }
            </div>

            <!-- Medical History -->
            <div class="rounded-card border border-white/10 bg-white/[0.03]">
              <h3>
                <button type="button" class="${CHART_TOGGLE}" [attr.aria-expanded]="isChartOpen('history')" aria-controls="call-chart-history" (click)="toggleChart('history')">
                  <sd-icon name="clipboard-list" [size]="15" class="shrink-0 text-frost" />
                  <span class="flex-1">Medical History ({{ history().length }})</span>
                  <sd-icon name="chevron-down" [size]="16" class="shrink-0 text-white/70 transition-transform motion-reduce:transition-none" [class.rotate-180]="isChartOpen('history')" />
                </button>
              </h3>
              @if (isChartOpen('history')) {
                <div id="call-chart-history" class="px-4 pb-4">
                  @if (history().length) {
                    <ul class="flex flex-col gap-2">
                      @for (h of history(); track $index) {
                        <li class="flex flex-col">
                          <span class="font-sans text-body-sm text-white/85">
                            {{ h.condition }}@if (h.year) { <span class="text-white/70"> · {{ h.year }}</span> }
                          </span>
                          @if (h.note) {
                            <span class="font-sans text-caption text-white/70">{{ h.note }}</span>
                          }
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="font-sans text-body-sm text-white/70">None recorded.</p>
                  }
                </div>
              }
            </div>

            @if (info()?.patient?.id) {
              <button
                type="button"
                class="flex min-h-11 items-center justify-center gap-2 rounded-field border border-white/15 py-2.5 font-sans text-body-sm font-semibold text-white/85 transition-colors hover:bg-white/10"
                (click)="openRecord()"
              >
                <sd-icon name="file-text" [size]="16" /> View Full EMR
              </button>
            }
          </aside>

          <!-- ===================== SHARED DOCUMENTS (Medical Records) ===================== -->
          <aside
            id="call-records"
            aria-label="Shared documents"
            class="flex min-w-0 flex-col gap-4"
            [class]="recordsClass()"
            [hidden]="panelHidden('documents')"
            [attr.role]="layout() === 'wide' ? null : 'tabpanel'"
            [attr.aria-labelledby]="layout() === 'mid' ? 'call-side-documents' : layout() === 'narrow' ? 'call-section-documents' : null"
          >
            <div class="rounded-card border border-white/10 bg-white/[0.03] p-4" [attr.aria-busy]="docsLoading() || null">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <!-- Focus lands here when a request's Send / Withdraw button gives way to its
                     result, and when the viewer closes after its opener has gone. -->
                <h3 #docsHeading id="call-records-heading" tabindex="-1" class="font-sans text-body font-semibold text-white outline-none">Medical Records</h3>
                @if (newDocCount()) {
                  <span class="sd-new-pill rounded-pill bg-cerulean/15 px-2 py-0.5 font-sans text-caption font-semibold text-frost">{{ newDocCount() }} new</span>
                  <button type="button" class="ml-auto min-h-11 rounded-field px-1 font-sans text-caption font-semibold text-frost underline-offset-2 hover:underline" (click)="markAllSeen()">Mark all seen</button>
                }
              </div>
              @if (!portalSignedIn()) {
                <!-- Joined by an emailed link (or the portal session ended): nothing is fetched. -->
                <div class="mt-3 flex flex-col items-start gap-2 rounded-2xl bg-white/[0.04] px-3 py-2.5">
                  <p class="flex items-start gap-1.5 font-sans text-caption text-white/80">
                    <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />{{ docsSignedOut }}
                  </p>
                  <button
                    type="button"
                    class="inline-flex min-h-11 items-center gap-1.5 rounded-field px-1 font-sans text-caption font-semibold text-frost underline underline-offset-2"
                    (click)="openPortalSignIn()"
                  >
                    <sd-icon name="external-link" [size]="14" /> Sign in (opens a new tab)
                  </button>
                </div>
              } @else {
                @if (docsHeaderLine(); as line) {
                  <p class="mt-0.5 flex items-center gap-1.5 font-sans text-caption text-white/70">
                    <sd-icon [name]="docAccess()?.access?.state === 'active' ? 'shield-check' : 'lock'" [size]="13" class="shrink-0" />{{ line }}
                  </p>
                }
                <!-- Where your request stands, and asking to extend / for more (compact). -->
                @if (callDocBanner(); as b) {
                  @if (b.access.state === 'ends_soon' || b.access.action?.kind === 'more') {
                    <div class="mt-3 flex flex-col items-start gap-1.5 rounded-2xl bg-white/[0.04] px-3 py-2.5">
                      @if (b.access.state === 'ends_soon' && b.access.detail) {
                        <p class="flex items-start gap-1.5 font-sans text-caption text-white/80"><sd-icon name="hourglass" [size]="14" class="mt-0.5 shrink-0 text-warning" />{{ b.access.detail }}</p>
                      }
                      @if (b.access.action; as act) {
                        <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field bg-white/10 px-3 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/15" (click)="openDocRequest()">
                          <sd-icon [name]="act.icon" [size]="14" />{{ act.label }}
                        </button>
                      }
                    </div>
                  }
                  @if (b.request; as r) {
                    <div class="mt-3 flex flex-col items-start gap-1.5 rounded-2xl bg-white/[0.04] px-3 py-2.5">
                      <p class="flex items-start gap-1.5 font-sans text-caption text-white/80">
                        <sd-icon [name]="r.icon" [size]="14" class="mt-0.5 shrink-0" [class]="r.tone === 'warning' ? 'text-warning' : 'text-frost'" />{{ r.text }}
                      </p>
                      @if (r.action; as act) {
                        <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field bg-white/10 px-3 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/15 disabled:opacity-60" [disabled]="withdrawingRequest()" (click)="withdrawDocRequest()">
                          <sd-icon [name]="act.icon" [size]="14" />{{ withdrawingRequest() ? 'Withdrawing…' : act.label }}
                        </button>
                      }
                    </div>
                  }
                }
                <div class="mb-3 mt-3 flex gap-1 overflow-x-auto" role="group" aria-label="Show">
                  @for (t of recordsTabs; track t.key) {
                    <button
                      type="button"
                      class="min-h-11 whitespace-nowrap rounded-pill px-3 font-sans text-caption transition-colors"
                      [class]="recordsTab() === t.key ? 'bg-cerulean text-white' : 'bg-white/[0.04] text-white/80 hover:bg-white/10'"
                      [attr.aria-pressed]="recordsTab() === t.key"
                      (click)="recordsTab.set(t.key)"
                    >
                      {{ t.label }}
                    </button>
                  }
                </div>
                @if (docsLoading() && !docAccess()) {
                  <div class="flex flex-col gap-2" aria-hidden="true">
                    @for (i of [1, 2]; track i) { <div class="sd-shimmer h-12 rounded-2xl bg-white/[0.04]"></div> }
                  </div>
                } @else if (docsFailed() || callDocBanner()?.access?.state === 'unavailable') {
                  <div class="flex flex-col items-center gap-2 py-6 text-center">
                    <sd-icon name="triangle-alert" [size]="26" class="text-alert" />
                    <p class="font-sans text-caption text-white" role="alert">{{ docsLoadFailed }}</p>
                    <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field bg-white/10 px-3 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/15 disabled:opacity-60" [disabled]="docsLoading()" (click)="retryDocumentAccess()">
                      <sd-icon name="refresh-cw" [size]="14" />Try again
                    </button>
                  </div>
                } @else if (sortedDocs().length) {
                  <ul class="flex flex-col gap-2">
                    @for (d of sortedDocs(); track d.id) {
                      @let unseen = newDocIds().has(d.id);
                      <li>
                        <button
                          type="button"
                          class="flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
                          [class]="unseen ? 'border-white/10 border-l-2 border-l-cerulean bg-cerulean/10' : 'border-white/10 bg-white/[0.03]'"
                          [attr.data-doc-id]="d.id"
                          (click)="openPatientDoc(d, $event.currentTarget)"
                        >
                          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-white/80" aria-hidden="true">
                            <sd-icon [name]="docIcon(d)" [size]="16" />
                          </span>
                          <span class="flex min-w-0 flex-1 flex-col">
                            <span class="flex min-w-0 items-center gap-1.5">
                              <span class="truncate font-sans text-body-sm text-white">{{ d.title }}</span>
                              @if (unseen) {
                                <span class="sd-new-pill shrink-0 rounded-pill bg-cerulean/15 px-1.5 font-sans text-caption font-semibold text-frost">New</span>
                              }
                            </span>
                            <span class="truncate font-sans text-caption text-white/70">{{ d.type_label }} · {{ d.extension.toUpperCase() }} · {{ d.size_label }}</span>
                            <span class="truncate font-sans text-caption text-white/70">{{ sharedAgo(d) }}</span>
                            @if (d.viewable === false) {
                              <span class="font-sans text-caption text-white/70">Preview not available</span>
                            }
                          </span>
                          <span class="shrink-0 rounded-pill px-2 py-0.5 font-sans text-caption" [class]="d.uploader_role === 'patient' ? 'bg-sage/15 text-sage' : 'bg-frost/15 text-frost'">{{ d.uploader_role === 'patient' ? 'Patient' : 'Clinician' }}</span>
                          <sd-icon name="eye" [size]="16" class="shrink-0 text-white/70" />
                        </button>
                      </li>
                    }
                  </ul>
                } @else if (docAccess(); as acc) {
                  @let empty = docsEmpty(acc.access.state);
                  <div class="flex flex-col items-center gap-2 py-6 text-center">
                    <sd-icon [name]="acc.access.state === 'active' ? 'folder-open' : 'lock'" [size]="26" class="text-white/50" />
                    <p class="font-sans text-caption font-semibold text-white/80">{{ empty.title }}</p>
                    @if (empty.body) {
                      <p class="font-sans text-caption text-white/70">{{ empty.body }}</p>
                    }
                    @if (recordsTab() === 'documents' && callDocBanner()?.access?.action?.kind === 'request') {
                      <button type="button" class="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-field bg-white/10 px-3 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/15" (click)="openDocRequest()">
                        <sd-icon name="key-round" [size]="14" />Request access
                      </button>
                    }
                  </div>
                }
              }
              @if (docOpenError()) {
                <p class="mt-3 flex items-start gap-1.5 font-sans text-caption text-white" role="alert">
                  <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0 text-alert" /> {{ docOpenError() }}
                </p>
              }
            </div>

            @if (layout() === 'wide') {
              <!-- Participants: a disclosure under the records at wide. -->
              <div class="rounded-card border border-white/10 bg-white/[0.03]">
                <h3>
                  <button type="button" class="${CHART_TOGGLE}" [attr.aria-expanded]="peopleShown()" aria-controls="call-people-list" (click)="peopleShown.set(!peopleShown())">
                    <sd-icon name="users" [size]="15" class="shrink-0 text-frost" />
                    <span class="flex-1">Participants ({{ participantCount() }})</span>
                    <sd-icon name="chevron-down" [size]="16" class="shrink-0 text-white/70 transition-transform motion-reduce:transition-none" [class.rotate-180]="peopleShown()" />
                  </button>
                </h3>
                @if (peopleShown()) {
                  <div id="call-people-list" class="px-4 pb-4">
                    <ng-container [ngTemplateOutlet]="participantsTpl" />
                  </div>
                }
              </div>
            }
          </aside>

          @if (layout() !== 'wide') {
            <aside
              id="call-people"
              aria-label="Participants"
              class="flex min-w-0 flex-col"
              [class]="layout() === 'mid' ? 'min-h-0 flex-1 overflow-y-auto' : ''"
              [hidden]="panelHidden('people')"
              role="tabpanel"
              [attr.aria-labelledby]="layout() === 'mid' ? 'call-side-people' : 'call-section-people'"
            >
              <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
                <h3 class="mb-3 font-sans text-body-sm font-semibold text-white">Participants ({{ participantCount() }})</h3>
                <ng-container [ngTemplateOutlet]="participantsTpl" />
              </div>
            </aside>
          }
        </div>
      </main>
    </div>

    <!-- The one live region for documents ("Request sent.", "Ada shared a new document…").
         Outside every panel that can be hidden (the records aside at mid and narrow) and
         outside the cockpit that goes inert under the narrow viewer, so it is always read out. -->
    <p class="sr-only" aria-live="polite">{{ docAnnounce() }}</p>

    <!-- Narrow screens: the new-document alert floats at the bottom (never over the video). -->
    @if (layout() === 'narrow') {
      <!-- Dark in both cockpit themes, like the dock it belongs to. Inert under the viewer sheet. -->
      <div class="sd-dock" [attr.inert]="sheetOpen() ? '' : null">
        <ng-container [ngTemplateOutlet]="docAlertTpl" />
      </div>
    }

    <!-- Narrow screens: the document fills the screen; the call keeps going under it. -->
    @if (viewerFile(); as vf) {
      @if (viewerDoc() && layout() === 'narrow') {
      <div class="fixed inset-0 z-50 flex flex-col bg-abyss">
        <doc-protected-document-viewer
          class="min-h-0 flex-1"
          mode="sheet"
          [tone]="theme()"
          [file]="vf"
          [state]="viewerState()"
          [errorText]="viewerError()"
          [watermark]="viewerWatermark()"
          [inCall]="inLiveCall()"
          (closed)="closeViewer()"
          (printRequested)="onViewerPrint()"
        >
          <div viewerBar class="sd-dock flex shrink-0 items-center gap-2 border-b border-white/10 bg-ink px-2 py-1.5">
            <button type="button" class="flex min-h-11 items-center gap-1.5 rounded-field px-2 font-sans text-body-sm font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-frost" (click)="closeViewer()">
              <sd-icon name="arrow-left" [size]="18" />Back to call
            </button>
            <span class="min-w-0 flex-1 truncate font-sans text-caption text-white/70">{{ patientName() }} · {{ elapsedLabel() }}</span>
            @if (status() === 'in-call') {
              <button type="button" class="flex size-11 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-frost" [class]="micOn() ? 'bg-white/10 hover:bg-white/20' : 'bg-alert hover:bg-alert/85'" [attr.aria-label]="micOn() ? 'Mute' : 'Unmute'" (click)="toggleMic()">
                <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="18" />
              </button>
              <button type="button" class="flex size-11 items-center justify-center rounded-full bg-alert transition-colors hover:bg-alert/85 focus-visible:outline-2 focus-visible:outline-frost" aria-label="End consultation" (click)="askEnd()">
                <sd-icon name="phone-off" [size]="18" />
              </button>
            }
          </div>
        </doc-protected-document-viewer>
      </div>
      }
    }

    <!-- The participants list (wide: a disclosure in the records; mid: the People tab;
         narrow: the People section; below xl also the header's popover). -->
    <ng-template #participantsTpl>
      <ul class="flex flex-col gap-3">
        <li class="flex items-center gap-3">
          <span class="flex size-9 items-center justify-center rounded-full bg-cerulean/20 font-heading text-caption font-semibold text-frost" aria-hidden="true">
            {{ doctorInitials() }}
          </span>
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-sans text-body-sm text-white">{{ doctorName() }} (You)</span>
            <span class="font-sans text-caption text-white/70">Host</span>
          </span>
          <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="15" [class]="micOn() ? 'text-white/70' : 'text-alert'" aria-hidden="true" />
          @if (!micOn()) { <span class="sr-only">Microphone off</span> }
          <sd-icon [name]="camOn() ? 'video' : 'video-off'" [size]="15" [class]="camOn() ? 'text-white/70' : 'text-alert'" aria-hidden="true" />
          @if (!camOn()) { <span class="sr-only">Camera off</span> }
        </li>
        <!-- The patient, then their guests (names only), live from the call itself. -->
        @for (p of others(); track p.key) {
          <li class="flex items-center gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 font-heading text-caption font-semibold text-white/85" aria-hidden="true">
              {{ p.initials }}
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-sans text-body-sm text-white">{{ p.name }}</span>
              <span class="truncate font-sans text-caption text-white/70">
                {{ p.role === 'patient' ? 'Patient' : 'Guest' }} ·
                <span [class]="p.inCall ? 'text-success' : ''">{{ p.inCall ? 'In the call' : 'Not joined yet' }}</span>
              </span>
              @if (p.role === 'guest' && recordingConfigured() && !legacyRoster()) {
                <span class="flex items-center gap-1 font-sans text-caption" [class]="p.consented ? 'text-success' : 'text-warning'">
                  <sd-icon [name]="p.consented ? 'shield-check' : 'shield-alert'" [size]="12" class="shrink-0" />
                  {{ p.consented ? 'Agreed to recording' : (p.consented === null ? 'Recording consent not known yet' : 'Hasn’t agreed to recording') }}
                </span>
              }
            </span>
            @if (p.inCall && p.muted) {
              <sd-icon name="mic-off" [size]="15" class="shrink-0 text-alert" aria-hidden="true" />
              <span class="sr-only">Microphone off</span>
            }
            @if (p.inCall && p.cameraOff) {
              <sd-icon name="video-off" [size]="15" class="shrink-0 text-alert" aria-hidden="true" />
              <span class="sr-only">Camera off</span>
            }
            <span class="size-2 shrink-0 rounded-full" [class]="p.inCall ? 'bg-success' : 'bg-white/25'" aria-hidden="true"></span>
          </li>
        }
      </ul>
      <div class="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
        <div class="flex items-center gap-2">
          @if (consentsError()) {
            <sd-icon name="shield-check" [size]="15" class="shrink-0 text-alert" />
            <span class="font-sans text-caption text-white">{{ consentsError() }}</span>
          } @else {
            <sd-icon name="shield-check" [size]="15" [class]="recordingConsent() ? 'text-success' : 'text-white/50'" />
            <span class="font-sans text-caption text-white/80">
              Recording consent:
              <span [class]="recordingConsent() ? 'text-success' : 'text-white/70'">{{ recordingConsent() ? 'granted' : 'not granted' }}</span>
            </span>
          }
        </div>
        <!-- Guests agree in their lobby; the whole channel is recorded, so each one in the call must have. -->
        @if (recordingConfigured() && hasGuests() && !legacyRoster()) {
          <div class="flex items-start gap-2">
            <sd-icon
              [name]="guestsWithoutConsent() ? 'shield-alert' : 'shield-check'"
              [size]="15"
              class="mt-px shrink-0"
              [class]="guestsWithoutConsent() ? 'text-warning' : 'text-white/50'"
            />
            <span class="font-sans text-caption" [class]="guestsWithoutConsent() ? 'text-warning' : 'text-white/80'">{{ guestConsentLabel() }}</span>
          </div>
        }
      </div>
    </ng-template>

    <!-- The new-document alert: below the controls (wide / mid), floating at the bottom
         (narrow). Not a live region (announceDocs says it); focus never moves to it. -->
    <ng-template #docAlertTpl>
      @if (docAlertView(); as al) {
        <div
          #docAlertEl
          role="group"
          aria-label="New document"
          tabindex="-1"
          class="flex items-start gap-3 outline-none rounded-card border border-cerulean/40 bg-ink px-4 py-3 shadow-raised"
          [class]="layout() === 'narrow' ? 'fixed inset-x-3 bottom-3 z-40' : ''"
          (mouseenter)="holdAlert(true)"
          (mouseleave)="holdAlert(false)"
          (focusin)="holdAlert(true)"
          (focusout)="onAlertFocusOut($event)"
          (keydown.escape)="dismissAlert()"
        >
          <sd-icon name="bell" [size]="18" class="mt-0.5 shrink-0 text-frost" />
          <div class="min-w-0 flex-1">
            <p class="font-sans text-body-sm font-semibold text-white">{{ al.title }}</p>
            @if (al.detail) {
              <p class="truncate font-sans text-caption text-white/80">{{ al.detail }}</p>
            }
            <div class="mt-2 flex flex-wrap gap-2">
              @if (al.signedOut) {
                <button type="button" class="${ALERT_BUTTON}" (click)="openPortalSignIn()">
                  <sd-icon name="external-link" [size]="14" />Sign in
                </button>
              } @else {
                @if (al.doc; as doc) {
                  @if (doc.viewable !== false) {
                    <button type="button" class="${ALERT_BUTTON}" (click)="openPatientDoc(doc, $event.currentTarget)">
                      <sd-icon name="eye" [size]="14" />View
                    </button>
                  }
                }
                <button type="button" class="${ALERT_BUTTON}" (click)="showInRecords()">Show in records</button>
              }
            </div>
          </div>
          <button
            type="button"
            class="-mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-frost"
            aria-label="Dismiss new document alert"
            (click)="dismissAlert()"
          >
            <sd-icon name="x" [size]="16" />
          </button>
        </div>
      }
    </ng-template>

    <!-- End consultation: close the visit for everyone, or just leave (can rejoin).
         The design-system dialog (top layer, focus kept inside, Esc / scrim = Cancel,
         nothing closes it while ending); its own colour tokens, so the cockpit's
         light / dark theme overrides never reach it. -->
    <sd-dialog
      [open]="endOpen()"
      layout="plain"
      size="sm"
      dialogRole="alertdialog"
      labelledBy="end-consult-title"
      describedBy="end-consult-desc"
      [busy]="ending()"
      (closed)="cancelEnd()"
    >
      <div class="flex flex-col gap-4 px-5 pt-6 pb-2 sm:px-6" [attr.aria-busy]="ending() || null">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="flex size-14 items-center justify-center rounded-full bg-(--sd-dialog-danger-soft) text-(--sd-dialog-danger-text)" aria-hidden="true">
            <sd-icon name="phone-off" [size]="26" />
          </span>
          <h2 id="end-consult-title" class="font-heading text-h5 text-(--sd-dialog-strong)">End consultation for everyone?</h2>
          <p id="end-consult-desc" class="font-sans text-body-sm text-(--sd-dialog-muted)">
            This marks the visit completed and moves it to your history. {{ patientName() }}’s call ends
            too{{ hasGuests() ? ' (and their guests’)' : '' }}, and they can then see what you shared with them and rate the visit.
          </p>
        </div>
        @if (canDocument() && !noteFinalized()) {
          <p class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-warning-soft) px-3.5 py-2.5 font-sans text-caption text-(--sd-dialog-text)">
            <sd-icon name="file-text" [size]="16" class="mt-0.5 shrink-0 text-(--sd-dialog-warning-text)" />
            Your consultation note isn’t finalized yet — you can finish it on the appointment page.
          </p>
        }
        @if (!portalSignedIn()) {
          <div class="flex flex-col gap-1 rounded-[12px] bg-(--sd-dialog-info-soft) px-3.5 py-2.5 font-sans text-caption text-(--sd-dialog-text)">
            <p>Sign in to the doctor portal to end the consultation from here — or just leave and mark it completed later from the appointment page.</p>
            <button type="button" class="min-h-11 w-fit rounded-field px-1 font-semibold text-(--sd-dialog-info-text) underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)" (click)="openPortalSignIn()">
              Sign in (opens a new tab)
            </button>
          </div>
        }
        @if (endError()) {
          <p class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-danger-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-danger-text)" role="alert">
            <sd-icon name="circle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ endError() }}
          </p>
        }
        <p class="sr-only" aria-live="polite">{{ ending() ? 'Ending the consultation…' : '' }}</p>
      </div>
      <div dialogFooter class="flex shrink-0 flex-col gap-2 px-5 pt-4 pb-5 sm:px-6 sm:pb-6">
        <button
          type="button"
          class="${END_BUTTON} bg-(--sd-dialog-danger) text-(--sd-dialog-on-accent) hover:bg-(--sd-dialog-danger-hover)"
          [attr.aria-disabled]="ending() || !portalSignedIn() || null"
          (click)="endConsultation()"
        >
          @if (ending()) {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Ending…
          } @else {
            End consultation
          }
        </button>
        <button
          type="button"
          class="${END_BUTTON} border border-(--sd-dialog-field) bg-(--sd-dialog-surface) text-(--sd-dialog-text) hover:bg-(--sd-dialog-hover)"
          [attr.aria-disabled]="ending() || null"
          (click)="leaveFromEndDialog()"
        >
          Just leave — I’ll come back
        </button>
        <!-- The safe choice takes focus (an urgent, destructive prompt). -->
        <button
          type="button"
          data-autofocus
          class="${END_BUTTON} border border-(--sd-dialog-border) bg-(--sd-dialog-surface) text-(--sd-dialog-muted) hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-text)"
          [attr.aria-disabled]="ending() || null"
          (click)="cancelEnd()"
        >
          Cancel
        </button>
      </div>
    </sd-dialog>

    <!-- Ask the patient to share documents (or to keep sharing) — over the portal session. -->
    @if (appointmentIdForDocs(); as apptId) {
      <doc-request-access-dialog
        theme="call"
        [open]="docRequestOpen()"
        [appointmentId]="apptId"
        [patientName]="patientName()"
        [kind]="callDocBanner()?.requestKind ?? 'access'"
        (closed)="docRequestOpen.set(false)"
        (sent)="onDocRequestSent($event)"
        (refused)="loadDocumentAccess('refresh')"
        (afterClose)="focusDocsIfAsked()"
      />
    }
  `,
})
export class DoctorCall implements AfterViewInit, OnDestroy, CanLeave {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(StaffAuthService);
  private readonly api = inject(ApiService);
  private readonly doctorApi = inject(DoctorApi);
  private readonly session = inject(SessionTimeoutService);
  private readonly drafts = inject(NoteDraftStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  // ---- Layout (per breakpoint) ----
  /** At least 1280px: chart | dock + tools | records. */
  private readonly wideMq = this.media('(min-width: 1280px)');
  /** At least 1024px: dock + tools | one tabbed side panel. */
  private readonly midMq = this.media('(min-width: 1024px)');
  /** Below 640px: the doctor's own camera is a small tile in the control row, not on the video. */
  protected readonly phone = this.media('(max-width: 639.98px)');
  protected readonly layout = computed<'wide' | 'mid' | 'narrow'>(() =>
    this.wideMq() ? 'wide' : this.midMq() ? 'mid' : 'narrow',
  );
  /** Narrow: which section shows under the video. */
  protected readonly section = signal<CallSection>('notes');
  /** Mid: which side panel shows. */
  protected readonly sideTab = signal<SideTab>('patient');
  protected readonly sectionTabs: ReadonlyArray<{ key: CallSection; label: string; panel: string }> = [
    { key: 'notes', label: 'Notes', panel: 'call-tools' },
    { key: 'patient', label: 'Patient', panel: 'call-chart' },
    { key: 'documents', label: 'Documents', panel: 'call-records' },
    { key: 'people', label: 'People', panel: 'call-people' },
  ];
  protected readonly sideTabs: ReadonlyArray<{ key: SideTab; label: string; panel: string }> = [
    { key: 'patient', label: 'Patient', panel: 'call-chart' },
    { key: 'documents', label: 'Documents', panel: 'call-records' },
    { key: 'people', label: 'People', panel: 'call-people' },
  ];
  /** The header's participants popover (below xl). */
  protected readonly peopleOpen = signal(false);
  /** The participants disclosure in the records column (wide). */
  protected readonly peopleShown = signal(true);
  private readonly peopleButton = viewChild<ElementRef<HTMLElement>>('peopleButton');

  protected readonly gridClass = computed(() => {
    switch (this.layout()) {
      case 'wide':
        return "grid min-h-0 flex-1 gap-4 p-4 grid-cols-[272px_minmax(0,1fr)_336px] 2xl:grid-cols-[300px_minmax(0,1fr)_380px] grid-rows-[auto_minmax(0,1fr)] [grid-template-areas:'chart_dock_records''chart_tools_records']";
      case 'mid':
        return "grid min-h-0 flex-1 gap-4 p-4 grid-cols-[minmax(0,1fr)_340px] grid-rows-[auto_minmax(0,1fr)] [grid-template-areas:'dock_side''tools_side']";
      default:
        return 'flex flex-col gap-3 p-3';
    }
  });
  protected readonly dockClass = computed(() =>
    this.layout() === 'narrow' ? 'sticky top-0 z-20 bg-abyss pt-1 [@media(max-height:500px)]:static' : '[grid-area:dock]',
  );
  protected readonly stageClass = computed(() =>
    this.layout() === 'narrow'
      ? 'mx-auto w-full aspect-[4/3] max-w-[calc(var(--stage-max)*4/3)] sm:aspect-video sm:max-w-[calc(var(--stage-max)*16/9)]'
      : 'w-full h-[var(--stage-h)] transition-[height] duration-300 ease-out',
  );
  protected readonly toolsClass = computed(() => (this.layout() === 'narrow' ? '' : 'min-h-0 [grid-area:tools]'));
  /** Wide / mid with the Document tab chosen: the viewer fills the tools panel. */
  protected readonly docTabShown = computed(() => this.layout() !== 'narrow' && this.notesTab() === 'document' && !!this.viewerDoc());
  protected readonly toolsBodyClass = computed(() => {
    if (this.layout() === 'narrow') return 'p-4';
    return this.docTabShown() ? 'flex min-h-0 flex-1 flex-col overflow-y-auto p-0' : 'min-h-0 flex-1 overflow-y-auto p-4';
  });
  protected readonly sideClass = computed(() =>
    this.layout() === 'mid' ? 'flex min-h-0 min-w-0 flex-col gap-3 [grid-area:side]' : 'contents',
  );
  protected readonly chartClass = computed(() => {
    switch (this.layout()) {
      case 'wide':
        return 'min-h-0 overflow-y-auto pr-1 [grid-area:chart]';
      case 'mid':
        return 'min-h-0 flex-1 overflow-y-auto';
      default:
        return '';
    }
  });
  protected readonly recordsClass = computed(() => {
    switch (this.layout()) {
      case 'wide':
        return 'min-h-0 overflow-y-auto pr-1 [grid-area:records]';
      case 'mid':
        return 'min-h-0 flex-1 overflow-y-auto';
      default:
        return '';
    }
  });
  /** A side panel that isn't the chosen one (mid: the side tab; narrow: the section). */
  protected panelHidden(panel: SideTab): boolean {
    const layout = this.layout();
    if (layout === 'wide') return false;
    return layout === 'mid' ? this.sideTab() !== panel : this.section() !== panel;
  }

  // ---- The video: size, fit and my own preview (remembered per device) ----
  protected readonly videoSize = signal<VideoSize>(readVideoSize());
  protected readonly fit = signal<CallVideoFit>(readStored(FIT_KEY, ['contain', 'cover'], 'contain'));
  protected readonly selfHidden = signal(readStored(SELF_KEY, ['hidden', 'shown'], 'shown') === 'hidden');
  protected readonly selfMode = computed<CallSelfViewMode>(() =>
    this.selfHidden() ? 'hidden' : this.phone() ? 'external' : 'pip',
  );
  protected readonly selfTile = computed(() => this.tiles().find((t) => t.self) ?? null);
  /** My camera (or the shared screen) for the phone's control-row tile. */
  protected readonly selfTrack = signal<ICameraVideoTrack | ILocalVideoTrack | null>(null);
  protected readonly selfPlayConfig = computed(() => (this.screenOn() ? { fit: 'contain' as const } : undefined));
  protected readonly stageHeight = computed(() => STAGE_HEIGHT[this.videoSize()]);
  protected readonly stageMax = computed(() => (this.videoSize() === 's' ? '28dvh' : '45dvh'));
  /** Connection quality from Agora (the worse of up- and downlink; 0 or null: not known yet). */
  protected readonly quality = signal<number | null>(null);
  private readonly canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  protected readonly controls = computed<CallControl[]>(() => {
    const blocked = this.recordingBlocked();
    return [
      { id: 'mic', label: this.micOn() ? 'Mute' : 'Unmute', icon: this.micOn() ? 'mic' : 'mic-off', tone: this.micOn() ? 'default' : 'off' },
      { id: 'cam', label: this.camOn() ? 'Stop video' : 'Start video', icon: this.camOn() ? 'video' : 'video-off', tone: this.camOn() ? 'default' : 'off' },
      {
        id: 'share',
        label: 'Share screen',
        icon: 'monitor-smartphone',
        pressed: this.screenOn(),
        tone: this.screenOn() ? 'active' : 'default',
        overflow: 'menu',
        hidden: !this.canShareScreen,
      },
      {
        id: 'record',
        label: 'Record',
        icon: this.recordingActive() ? 'circle-stop' : 'circle',
        pressed: this.recordingActive(),
        tone: this.recordingActive() ? 'active' : 'default',
        overflow: 'menu',
        hidden: !this.recordingConfigured(),
        disabled: this.recordingBusy() || blocked !== '',
        reason: blocked || null,
      },
      {
        id: 'documents',
        label: 'Documents',
        icon: 'file-text',
        badge: this.newDocCount() || null,
        hidden: this.layout() !== 'mid',
      },
      { id: 'more', label: 'More', icon: 'ellipsis' },
      { id: 'end', label: 'End', ariaLabel: 'End consultation', icon: 'phone-off', tone: 'danger' },
    ];
  });

  protected readonly menu = computed<CallMenuItem[]>(() => {
    const size = this.videoSize();
    const items: CallMenuItem[] = [
      { id: 'size-s', label: 'Small video', icon: 'minimize-2', checked: size === 's', group: 'size' },
      { id: 'size-m', label: 'Medium video', icon: 'video', checked: size === 'm', group: 'size' },
      { id: 'size-l', label: 'Large video', icon: 'maximize-2', checked: size === 'l', group: 'size' },
      { id: 'fit-contain', label: 'Video: fit whole picture', checked: this.fit() === 'contain', group: 'fit' },
      { id: 'fit-cover', label: 'Video: fill the frame', checked: this.fit() === 'cover', group: 'fit' },
      { id: 'self', label: 'Hide my preview', icon: 'eye-off', checked: this.selfHidden() },
    ];
    if (this.layout() === 'narrow') {
      items.push({ id: 'theme', label: this.theme() === 'dark' ? 'Light cockpit' : 'Dark cockpit', icon: this.theme() === 'dark' ? 'sun' : 'moon' });
    }
    return items;
  });

  // ---- New documents in the call ----
  private newDocsState: NewDocsState = EMPTY_NEW_DOCS;
  /** Shared since the call's first read and not opened yet (the pills and badges). */
  protected readonly newDocIds = signal<ReadonlySet<string>>(new Set());
  protected readonly newDocCount = computed(() => this.newDocIds().size);
  /** The alert under the controls (or floating, narrow); the badge outlives it. */
  protected readonly docAlert = signal<DocAlert | null>(null);
  /** A nudge arrived while signed out of the portal: say so instead. */
  protected readonly docAlertSignedOut = signal(false);
  protected readonly docAlertView = computed(() => {
    if (this.docAlertSignedOut()) {
      return {
        title: 'The patient shared a new document.',
        detail: 'Sign in to the doctor portal to see it (opens a new tab).',
        doc: null,
        signedOut: true,
      };
    }
    const alert = this.docAlert();
    if (!alert) return null;
    const lines = docAlertLines(alert, this.patientFirstName(), this.screenOn());
    return { ...lines, doc: alert.count === 1 ? alert.doc : null, signedOut: false };
  });
  private readonly docAlertEl = viewChild<ElementRef<HTMLElement>>('docAlertEl');
  private alertTimer?: ReturnType<typeof setTimeout>;
  private alertHeld = false;
  /** When the last load / refresh / poll read STARTED (a nudge's doesn't count). */
  private lastPollStartAt = Number.NEGATIVE_INFINITY;
  private lastNudgeReadAt = Number.NEGATIVE_INFINITY;
  private nudgeTimer?: ReturnType<typeof setTimeout>;
  /** A read was asked for while one ran: one more (passive) read follows it. */
  private docsFollowUp = false;
  private unbindNudge?: () => void;
  private baseTitle: string | null = null;
  /** Records newest share first. */
  protected readonly sortedDocs = computed(() => [...this.visibleDocs()].sort(byNewestShare));

  // ---- The view-only document viewer ----
  protected readonly viewerDoc = signal<DoctorSharedDocumentDto | null>(null);
  protected readonly viewerFile = signal<ProtectedDocumentFile | null>(null);
  protected readonly viewerState = signal<ProtectedViewerState>('loading');
  protected readonly viewerError = signal('');
  private viewerSub: Subscription | null = null;
  private viewerOpener: HTMLElement | null = null;
  private readonly viewers = viewChildren(ProtectedDocumentViewer);
  /** Narrow: the viewer fills the screen (the cockpit under it is inert). */
  protected readonly sheetOpen = computed(() => this.layout() === 'narrow' && !!this.viewerDoc() && !!this.viewerFile());
  protected readonly viewerWatermark = computed(() => ({
    viewerName: this.clock.profile()?.name || this.doctorName(),
    timeZone: this.callZone(),
  }));
  protected readonly toolTabs = computed<ReadonlyArray<{ key: NotesTab; label: string }>>(() => {
    const doc = this.viewerDoc();
    if (!doc || this.layout() === 'narrow') return this.notesTabs;
    const title = doc.title.length > 28 ? `${doc.title.slice(0, 27)}…` : doc.title;
    return [...this.notesTabs, { key: 'document', label: title }];
  });

  // ---- The patient chart's disclosures (remembered per device) ----
  protected readonly chartOpen = signal<ReadonlySet<string>>(readChartOpen());
  private readonly chartCol = viewChild<ElementRef<HTMLElement>>('chartCol');
  private readonly allergyCard = viewChild<ElementRef<HTMLElement>>('allergyCard');
  private readonly dockEl = viewChild<ElementRef<HTMLElement>>('dock');

  // ---- Time: the doctor's clock (profile zone) ----
  private readonly clock = inject(DoctorClock);
  /** The doctor's zone: the profile's once loaded (signed in), else the join's, else the device's. */
  protected readonly callZone = computed(() => {
    if (this.clock.status() === 'ready') return this.clock.zone();
    const tz = this.info()?.specialist?.timezone;
    return isValidTimeZone(tz) ? tz : this.clock.zone();
  });
  /** "{Name} · {sex} · {age}" for the top bar. */
  protected readonly headerPatient = computed(() => [this.patientName(), this.patientMeta()].filter(Boolean).join(' · '));
  /** "Booked 9:00 AM CST · 4:00 PM WAT patient's time" (the patient's only when it differs). */
  protected readonly headerPatientTime = computed(() => {
    const at = this.info()?.scheduled_at;
    if (!at) return '';
    const zone = this.callZone();
    const mine = timeLabel(at, zone);
    const theirs = dualTime(at, zone, this.info()?.patient?.timezone ?? null).secondary;
    return theirs ? `Booked ${mine} · ${theirs} patient's time` : `Booked ${mine}`;
  });
  protected readonly allergyNames = computed(() => (this.info()?.patient?.allergies ?? []).map((a) => a.allergen).filter(Boolean));
  private readonly patientFirstName = computed(() => this.patientName().split(/\s+/)[0] ?? '');

  /** A media query as a signal (its listener goes with the page). */
  private media(query: string): Signal<boolean> {
    const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
    const state = signal(mql?.matches ?? false);
    if (mql) {
      const onChange = (e: MediaQueryListEvent) => state.set(e.matches);
      mql.addEventListener?.('change', onChange);
      this.destroyRef.onDestroy(() => mql.removeEventListener?.('change', onChange));
    }
    return state.asReadonly();
  }

  // ---- Controls ----
  protected onControl(id: CallControlId): void {
    switch (id) {
      case 'mic':
        void this.toggleMic();
        return;
      case 'cam':
        void this.toggleCam();
        return;
      case 'share':
        void this.toggleScreen();
        return;
      case 'record':
        void this.toggleRecording();
        return;
      case 'documents':
        this.sideTab.set('documents');
        return;
      case 'end':
        void this.askEnd();
        return;
      default:
        return;
    }
  }

  protected onMenu(id: string): void {
    if (id.startsWith('size-')) {
      const size = id.slice(5) as VideoSize;
      this.videoSize.set(size);
      writeStored(VIDEO_SIZE_KEY, size);
    } else if (id === 'fit-contain' || id === 'fit-cover') {
      const fit = id === 'fit-cover' ? 'cover' : 'contain';
      this.fit.set(fit);
      writeStored(FIT_KEY, fit);
    } else if (id === 'self') {
      const hidden = !this.selfHidden();
      this.selfHidden.set(hidden);
      writeStored(SELF_KEY, hidden ? 'hidden' : 'shown');
    } else if (id === 'theme') {
      this.toggleTheme();
    }
  }

  // ---- Tabs (APG: arrows, Home, End move and select) ----
  protected onTabKey(e: KeyboardEvent, list: 'section' | 'side' | 'tools'): void {
    const keys: readonly string[] =
      list === 'section' ? this.sectionTabs.map((t) => t.key) : list === 'side' ? this.sideTabs.map((t) => t.key) : this.toolTabs().map((t) => t.key);
    const current = list === 'section' ? this.section() : list === 'side' ? this.sideTab() : this.notesTab();
    let i = keys.indexOf(current);
    if (e.key === 'ArrowRight') i = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = keys.length - 1;
    else return;
    e.preventDefault();
    const next = keys[i];
    if (list === 'section') this.section.set(next as CallSection);
    else if (list === 'side') this.sideTab.set(next as SideTab);
    else this.notesTab.set(next as NotesTab);
    const prefix = list === 'section' ? 'call-section-' : list === 'side' ? 'call-side-' : 'call-tab-';
    afterNextRender(() => document.getElementById(prefix + next)?.focus(), { injector: this.injector });
  }

  // ---- Participants (header button / popover) ----
  protected onPeopleButton(): void {
    if (this.layout() === 'wide') {
      this.peopleShown.set(true);
      afterNextRender(() => document.getElementById('call-people-list')?.scrollIntoView({ block: 'nearest' }), { injector: this.injector });
      return;
    }
    this.peopleOpen.update((v) => !v);
  }

  protected closePeople(refocus = false): void {
    if (!this.peopleOpen()) return;
    this.peopleOpen.set(false);
    if (refocus) this.peopleButton()?.nativeElement.focus();
  }

  /** A press outside the participants popover closes it. */
  protected onDocPointer(e: Event): void {
    if (!this.peopleOpen()) return;
    const t = e.target as Node | null;
    const pop = document.getElementById('call-people-popover');
    if (t && (pop?.contains(t) || this.peopleButton()?.nativeElement.contains(t))) return;
    this.peopleOpen.set(false);
  }

  // ---- Chart disclosures ----
  protected isChartOpen(key: string): boolean {
    return this.chartOpen().has(key);
  }

  protected toggleChart(key: string): void {
    const next = new Set(this.chartOpen());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.chartOpen.set(next);
    writeStored(CHART_OPEN_KEY, JSON.stringify([...next]));
  }

  // ---- New documents: the alert, the badge, the hidden-tab title ----

  /** "Shared 4 min ago" / "Shared Wed 4 Nov, 9:00 AM" on the doctor's clock. */
  protected sharedAgo(d: DoctorSharedDocumentDto): string {
    const zone = this.callZone();
    return sharedAgoText(d.shared_at, this.docsClock(), (iso) => formatInZone(iso, zone, 'dayTime'));
  }

  /** A fresh read: which documents are new (after the first), and which went away. */
  private trackNewDocs(dto: DoctorDocumentAccessDto): void {
    const docs = dto.documents ?? [];
    const { state, added } = diffNewDocs(this.newDocsState, docs);
    this.newDocsState = state;
    const present = new Set(docs.map((d) => d.id));
    const next = new Set([...this.newDocIds()].filter((id) => present.has(id)));
    for (const d of added) next.add(d.id);
    this.newDocIds.set(next);
    // A document open in the viewer that is no longer shared: close it and say so.
    const open = this.viewerDoc();
    if (open && !present.has(open.id)) {
      // On screen (the narrow sheet, the Document tab) or holding focus: the message
      // and focus go to the Medical Records (its tab or section chosen first), so focus
      // isn't dropped to the page and the reason is in view. A viewer left behind
      // another tab while the doctor works elsewhere doesn't pull focus away.
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const shown = this.layout() === 'narrow' || this.notesTab() === 'document' || !active || active === document.body;
      this.closeViewer(false);
      this.docOpenError.set(NOT_SHARED);
      if (shown) this.focusRecordsHeading();
    }
    if (!added.length) return;
    const prev = this.docAlert();
    const count = (prev?.count ?? 0) + added.length;
    const alert: DocAlert = { count, doc: count === 1 ? added[0] : null };
    this.docAlertSignedOut.set(false);
    this.docAlert.set(alert);
    const lines = docAlertLines(alert, this.patientFirstName(), this.screenOn());
    this.announceDocs(lines.detail ? `${lines.title}. ${lines.detail}` : `${lines.title}.`);
    this.armAlertTimer();
    this.updateTitle();
  }

  protected holdAlert(on: boolean): void {
    this.alertHeld = on;
    if (on) clearTimeout(this.alertTimer);
    else this.armAlertTimer();
  }

  protected onAlertFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (next && this.docAlertEl()?.nativeElement.contains(next)) return;
    this.holdAlert(false);
  }

  /** The alert hides after 15 s (paused while hovered or focused); the badge stays. */
  private armAlertTimer(): void {
    clearTimeout(this.alertTimer);
    if (this.alertHeld) return;
    this.alertTimer = setTimeout(() => this.dismissAlert(false), DOC_ALERT_MS);
  }

  protected dismissAlert(fromUser = true): void {
    clearTimeout(this.alertTimer);
    this.alertTimer = undefined;
    this.alertHeld = false;
    const hadFocus = fromUser && !!this.docAlertEl()?.nativeElement.contains(document.activeElement);
    this.docAlert.set(null);
    this.docAlertSignedOut.set(false);
    if (hadFocus) this.focusRecordsHeading();
  }

  /** "Show in records": the Documents panel, its heading focused. */
  protected showInRecords(): void {
    this.dismissAlert(false);
    this.recordsTab.set('documents');
    this.focusRecordsHeading();
  }

  protected markAllSeen(): void {
    this.newDocIds.set(new Set());
    this.updateTitle();
  }

  private markSeen(id: string): void {
    if (!this.newDocIds().has(id)) return;
    const next = new Set(this.newDocIds());
    next.delete(id);
    this.newDocIds.set(next);
    this.updateTitle();
  }

  /** "(2) New document · …" while the tab is hidden and documents are new; restored on return. */
  private updateTitle(): void {
    if (typeof document === 'undefined') return;
    const n = this.newDocCount();
    if (document.visibilityState === 'hidden' && n > 0) {
      this.baseTitle ??= document.title;
      document.title = `(${n}) New document · ${this.baseTitle}`;
    } else {
      this.restoreTitle();
    }
  }

  private restoreTitle(): void {
    if (this.baseTitle === null) return;
    document.title = this.baseTitle;
    this.baseTitle = null;
  }

  protected onVisibility(): void {
    if (document.visibilityState === 'visible') this.restoreTitle();
  }

  /** The Medical Records heading (choosing the Documents tab or section first). */
  private focusRecordsHeading(): void {
    if (this.layout() === 'mid') this.sideTab.set('documents');
    else if (this.layout() === 'narrow') this.section.set('documents');
    afterNextRender(() => this.docsHeading()?.nativeElement.focus(), { injector: this.injector });
  }

  // ---- Live delivery: the poll and the patient's nudge ----

  /** A "new document" nudge over the call's data stream (only the patient's counts). */
  private onNudge(uid: number | string): void {
    if (this.left || String(uid) !== String(this.patientUid())) return;
    if (!this.portalSignedIn()) {
      // Nothing can be read: say so (no request).
      this.docAlert.set(null);
      this.docAlertSignedOut.set(true);
      this.armAlertTimer();
      this.announceDocs('The patient shared a new document. Sign in to the doctor portal to see it (opens a new tab).');
      return;
    }
    // Delayed, never dropped: several files finishing together give reads at most every 3 s.
    clearTimeout(this.nudgeTimer);
    const now = Date.now();
    const at = Math.max(now + NUDGE_DEBOUNCE_MS, this.lastNudgeReadAt + NUDGE_MIN_INTERVAL_MS);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      this.lastNudgeReadAt = Date.now();
      this.loadDocumentAccess('nudge');
    }, at - now);
  }

  /** The patient's uid in the call (the roster's, else the emailed link's). */
  private patientUid(): CallUid {
    return this.roster().find((p) => p.role === 'patient')?.uid ?? PATIENT_CALL_UID;
  }

  // ---- The viewer ----

  /**
   * Open a shared document in the view-only viewer: a "Document" tab in the
   * tools (wide / mid; the video stays in view) or a full-screen sheet
   * (narrow; the call goes on). Fetched with `X-SD-Viewer` and recorded.
   */
  protected openPatientDoc(doc: DoctorSharedDocumentDto, opener?: EventTarget | null): void {
    this.docOpenError.set('');
    this.markSeen(doc.id);
    if (this.docAlert()?.doc?.id === doc.id) this.dismissAlert(false);
    this.viewerSub?.unsubscribe();
    this.viewerOpener = opener instanceof HTMLElement ? opener : null;
    this.viewerDoc.set(doc);
    this.viewerError.set('');
    this.viewerFile.set(this.placeholderFile(doc));
    if (this.layout() !== 'narrow') this.notesTab.set('document');
    if (!isViewableDoc(doc)) {
      this.viewerState.set('not_viewable');
      return;
    }
    this.viewerState.set('loading');
    // Over the portal session (fresh token, refreshed if need be) — never a raw token from storage.
    this.viewerSub = this.doctorApi
      .patientDocumentView(this.appointmentId, doc.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (v) => {
          if (this.viewerDoc()?.id !== doc.id) return;
          this.viewerFile.set({ ...this.placeholderFile(doc), blob: v.blob, mime: v.mime, viewRef: v.viewRef, viewedAt: v.viewedAt });
          this.viewerState.set('ready');
        },
        error: (err: unknown) => {
          if (this.viewerDoc()?.id !== doc.id) return;
          const code = apiErrorCode(err);
          const status = errorStatus(err);
          if (status === 415 || code === 'not_viewable') {
            this.viewerState.set('not_viewable');
            return;
          }
          this.viewerError.set(openErrorCopy(status, code));
          this.viewerState.set('error');
          if (code === 'not_shared') this.loadDocumentAccess('refresh');
        },
      });
  }

  private placeholderFile(doc: DoctorSharedDocumentDto): ProtectedDocumentFile {
    return {
      blob: null,
      mime: '',
      title: doc.title,
      typeLabel: doc.type_label,
      extension: doc.extension,
      viewRef: null,
      viewedAt: new Date().toISOString(),
    };
  }

  /**
   * Close the viewer; focus goes back to the row or alert button that opened
   * it, or (when that is gone) to the Medical Records heading.
   */
  protected closeViewer(refocus = true): void {
    const opener = this.viewerOpener;
    this.viewerOpener = null;
    this.viewerSub?.unsubscribe();
    this.viewerSub = null;
    this.viewerDoc.set(null);
    this.viewerFile.set(null);
    if (this.notesTab() === 'document') this.notesTab.set('notes');
    if (!refocus) return;
    // The opener may still be in the document but hidden (a Documents row after the
    // mid side tab changed): focus would silently go nowhere, so use the heading then.
    if (opener?.isConnected && opener.getClientRects().length) afterNextRender(() => opener.focus(), { injector: this.injector });
    else this.focusRecordsHeading();
  }

  /** The viewer's pages are prepared: record the print (the patient sees it), then print — or don't. */
  protected onViewerPrint(): void {
    const doc = this.viewerDoc();
    const file = this.viewerFile();
    const viewer = this.viewers()[0];
    if (!doc || !file || !viewer) return;
    this.doctorApi
      .patientDocumentPrinted(this.appointmentId, doc.id, file.viewRef)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => void viewer.print(),
        error: () => viewer.cancelPrint(),
      });
  }

  // ---- Focus not obscured (WCAG 2.4.11): scroll padding for the sticky dock and the alert ----
  private observeObscurers(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const dock = this.dockEl()?.nativeElement;
    if (dock) {
      const sync = () => {
        const sticky = this.layout() === 'narrow' && getComputedStyle(dock).position === 'sticky';
        root.style.scrollPaddingTop = sticky ? `${Math.ceil(dock.getBoundingClientRect().height)}px` : '';
      };
      const ro = new ResizeObserver(sync);
      ro.observe(dock);
      this.destroyRef.onDestroy(() => ro.disconnect());
    }
    const chart = this.chartCol()?.nativeElement;
    const card = this.allergyCard()?.nativeElement;
    if (chart && card) {
      const ro = new ResizeObserver(() => {
        chart.style.scrollPaddingTop = this.layout() === 'narrow' ? '' : `${Math.ceil(card.getBoundingClientRect().height)}px`;
      });
      ro.observe(card);
      this.destroyRef.onDestroy(() => ro.disconnect());
    }
    this.destroyRef.onDestroy(() => {
      root.style.scrollPaddingTop = '';
      root.style.scrollPaddingBottom = '';
    });
  }

  /** The floating alert (narrow) must never hide the focused element: pad the bottom while it shows. */
  private syncAlertPadding(): void {
    const el = this.docAlertEl()?.nativeElement;
    const root = document.documentElement;
    if (!el || this.layout() !== 'narrow') {
      root.style.scrollPaddingBottom = '';
      return;
    }
    root.style.scrollPaddingBottom = `${Math.ceil(el.getBoundingClientRect().height) + 12}px`;
  }


  /** The video stage: every uid's track is handed to it (attach / detach). */
  private readonly stage = viewChild.required(CallTilesComponent);
  protected readonly selfViewClass = CALL_SELF_VIEW_CLASS_DOCTOR;

  protected readonly status = signal<'loading' | 'in-call' | 'error'>('loading');
  protected readonly errorMessage = signal('');
  /** The join was refused because of the doctor's standing (suspended, not approved, owes the terms). */
  protected readonly joinStanding = signal<DoctorStandingCode | null>(null);
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly screenOn = signal(false);
  protected readonly elapsed = signal(0);

  // ---- Who is in the call ----
  /** Everyone else in the channel, per uid (one camera going off never touches another tile). */
  private readonly remoteList = signal<readonly RemoteParticipant[]>([]);
  private readonly remotes = new RemoteParticipants((list) => this.remoteList.set(list));
  private unbindRemotes?: () => void;
  /** The uid the doctor joined as (Agora's own when the link carries none). */
  private selfUid: CallUid = 'self';
  /** The people in the channel — the cloud recorder (a bot) left out. */
  protected readonly people = computed(() =>
    this.remoteList().filter((r) => String(r.uid) !== RECORDER_UID),
  );
  /** The latest participants from a heartbeat or token renewal (guests added mid-call, consent). */
  private readonly freshRoster = signal<CallParticipantDto[] | null>(null);
  /**
   * The API sends no participants (one from before guest invites, e.g. while a
   * front-end deploy is ahead of the API's): nobody is named and guests' consent
   * isn't tracked — that API doesn't gate recording on guests either.
   */
  protected readonly legacyRoster = computed(() => !this.freshRoster() && !this.info()?.participants);
  /**
   * Everyone who may be in the call, by uid — names only, never emails. Without
   * participants (legacyRoster) the patient is, as before, whoever else is here:
   * uid 1 (their emailed link) when connected, else the first to join under an
   * Agora-assigned uid (the portal's) — an emailed guest link's uid (3–5) stays a guest.
   */
  private readonly roster = computed<readonly CallParticipantDto[]>(() => {
    const list = this.freshRoster() ?? this.info()?.participants;
    if (list) return list;
    const uids = this.people()
      .map((r) => r.uid)
      .filter((u): u is number => typeof u === 'number');
    const uid = uids.find((u) => u === PATIENT_CALL_UID) ?? uids.find((u) => u >= 100);
    return uid === undefined ? [] : [{ uid, role: 'patient', name: this.patientName() }];
  });
  /** Who the API counts as in the call (guests by id), from the heartbeat. */
  private readonly presence = signal<CallPresenceDto | null>(null);
  private rosterRefreshedAt = 0;
  /** A participants refresh asked for too soon after the last, sent once allowed. */
  private rosterRefreshTimer?: ReturnType<typeof setTimeout>;
  /** Why the API stopped taking this call mid-way (cancelled / ended elsewhere); '' while it is fine. */
  protected readonly callClosed = signal('');
  /** Joining the channel again after the RTC token ran out (see rejoin). */
  protected readonly rejoining = signal(false);
  /** Out of the channel (the token ran out) and the automatic rejoin failed: the banner offers Rejoin. */
  protected readonly connectionLost = signal(false);
  private renewRetry?: ReturnType<typeof setTimeout>;
  /** The doctor's tracks that were off when a rejoin published the rest — published when turned on. */
  private readonly heldBack = new Set<ILocalTrack>();

  /** The stage's tiles: the patient first, then guests, the doctor's own last (the PiP 1:1). */
  protected readonly tiles = computed(() =>
    buildCallTiles({
      // Nobody under the connecting / error screens (their tracks play once in the call).
      remotes: this.status() === 'in-call' ? this.people() : [],
      roster: this.roster(),
      self:
        this.status() === 'in-call'
          ? {
              uid: this.selfUid,
              role: 'doctor',
              name: this.doctorName(),
              hasVideo: this.camOn() || this.screenOn(),
              muted: !this.micOn(),
            }
          : null,
    }),
  );
  protected readonly stageMode = computed<CallTilesMode>(() => callTilesMode(this.tiles()));
  /**
   * "· Patient" / "· Guest" after the names on the grid, and 1:1 when the one
   * person there isn't the patient (a guest who joined first). 1:1 with the
   * patient the name tag is just their name, as always.
   */
  protected readonly showRoles = computed(
    () => this.stageMode() === 'grid' || this.tiles().some((t) => !t.self && t.role !== 'patient'),
  );

  /** The patient, then each guest (the API's order), then anyone connected the list doesn't know yet. */
  protected readonly others = computed<CallPerson[]>(() => {
    const live = new Map(this.people().map((r) => [String(r.uid), r] as const));
    const roster = this.roster();
    const person = (
      key: string,
      name: string,
      role: CallPerson['role'],
      uid: CallUid,
      id: string | null,
      consented: boolean | null,
    ): CallPerson => {
      const r = live.get(String(uid));
      return {
        key,
        name,
        initials: this.initials(name),
        role,
        id,
        inCall: !!r,
        muted: !!r && !r.hasAudio,
        cameraOff: !!r && !r.hasVideo,
        consented,
      };
    };
    const patientUid = roster.find((p) => p.role === 'patient')?.uid ?? PATIENT_CALL_UID;
    const list = [person('patient', this.patientName(), 'patient', patientUid, null, null)];
    for (const g of roster) {
      if (g.role === 'guest') list.push(person(`guest:${g.id ?? g.uid}`, g.name, 'guest', g.uid, g.id ?? null, g.consented === true));
    }
    const known = new Set([String(patientUid), ...roster.map((p) => String(p.uid))]);
    for (const r of this.people()) {
      if (!known.has(String(r.uid))) list.push(person(`uid:${r.uid}`, 'Guest', 'guest', r.uid, null, null));
    }
    return list;
  });
  protected readonly hasGuests = computed(() => this.others().some((p) => p.role === 'guest'));
  /**
   * Guests in the call now — connected, or still counted by the API's presence —
   * who haven't accepted the recording notice (one not on the list yet counts:
   * its consent isn't known). The API refuses to start recording while any are.
   * None for an API without participants: it has no such rule.
   */
  protected readonly guestsWithoutConsent = computed(() => {
    if (this.legacyRoster()) return 0;
    const present = new Set(this.presence()?.guests ?? []);
    return this.others().filter(
      (p) => p.role === 'guest' && p.consented !== true && (p.inCall || (!!p.id && present.has(p.id))),
    ).length;
  });
  protected readonly guestConsentLabel = computed(() => {
    const n = this.guestsWithoutConsent();
    if (n === 1) return 'A guest in the call hasn’t agreed to recording yet — you can record once they have.';
    if (n > 1) return `${n} guests in the call haven’t agreed to recording yet — you can record once they have.`;
    if (this.others().some((p) => p.role === 'guest' && p.inCall)) return 'Guests in the call have agreed to recording.';
    // A guest's lobby only asks about recording once the patient has agreed to it.
    return this.recordingConsent()
      ? 'Guests agree to recording before they join.'
      : 'Guests are asked to agree to recording once the patient has.';
  });
  /** Why Record is off ('' when it can start, or is running and can stop). */
  protected readonly recordingBlocked = computed(() => {
    if (this.recordingActive()) return '';
    if (!this.recordingConsent()) return this.consentsError() || 'Patient recording consent required';
    const n = this.guestsWithoutConsent();
    if (n === 1) return 'A guest in the call hasn’t agreed to recording yet';
    if (n > 1) return `${n} guests in the call haven’t agreed to recording yet`;
    return '';
  });

  protected readonly notesTab = signal<NotesTab>('notes');
  protected readonly recordsTab = signal<RecordsTab>('documents');
  protected readonly subjective = signal('');
  protected readonly objective = signal('');
  protected readonly assessment = signal('');
  protected readonly plan = signal('');
  protected readonly toolNote = signal('');

  // Clinical-note persistence state.
  protected readonly noteStatus = signal<'draft' | 'finalized'>('draft');
  protected readonly noteSaved = signal('');
  /** The real reason a note load/save/finalize failed (shown under the header). */
  protected readonly noteError = signal('');
  protected readonly finalizing = signal(false);
  /**
   * Whether the saved note has loaded. Until it has, the editor is read-only
   * and nothing is saved: a blank editor would auto-save (or finalize) over
   * the real note — e.g. after a rejoin whose first load hit a network blip.
   */
  protected readonly noteLoad = signal<LoadState>('idle');
  protected readonly noteFinalized = computed(() => this.noteStatus() === 'finalized');
  /** Signed in to the portal (the clinical tools need it) — follows sign-in / sign-out, here or in another tab. */
  protected readonly canDocument = computed(() => this.portalSignedIn());
  /**
   * The loaded draft note can be written in — signed in or not: an edit made
   * after the session ended is kept on this device and saved to the record
   * once the doctor signs in again (finalizing still needs a session).
   */
  protected readonly noteEditable = computed(() => this.noteLoad() === 'ready' && !this.noteFinalized());
  /** Whose note this is (the portal user it loaded for) — a draft kept on the device is theirs only. */
  private readonly noteSub = signal<string | null>(null);

  // ePrescribing (GVM-RX-02) — the shared <doc-rx-panel>, over the portal
  // session (DoctorApi + staffAuthInterceptor, which refreshes tokens).
  /** Bumped when the window regains focus, so the portal sign-in is re-checked. */
  private readonly authCheck = signal(0);
  /**
   * Signed in to the doctor portal in this browser — as the doctor this call's
   * note loaded for? The cockpit can be opened from an emailed join link
   * without one. StaffAuthService mirrors a sign-in made in another tab; the
   * focus tick re-evaluates on return to this tab. Another doctor signing in
   * on this machine mid-call counts as signed out here (the page reloads only
   * after the call): the clinical actions must never run under their account.
   */
  protected readonly portalSignedIn = computed(() => {
    this.authCheck();
    const noteSub = this.noteSub();
    return this.auth.isAuthenticated() && (noteSub === null || this.auth.subject() === noteSub);
  });
  /** Patient id looked up via the portal when the join payload lacks one. */
  private readonly lookedUpPatientId = signal<string | null>(null);
  private patientLookup: 'idle' | 'loading' | 'done' = 'idle';
  protected readonly rxPatientError = signal('');
  protected readonly rxPatientId = computed(
    () => this.info()?.patient?.id || this.lookedUpPatientId(),
  );
  protected readonly rxAppointmentId = computed(() => this.info()?.appointment_id ?? null);
  /** Latches true once the prescribing panel has been shown (see `rxMounted`). */
  private readonly rxKeep = signal(false);
  /**
   * The prescribing panel is mounted: from the first time the doctor opens the
   * Prescriptions tab while signed in, until the call ends. It is then only
   * hidden — never destroyed — by tab switches or a portal sign-out, so a
   * half-written prescription survives both.
   */
  protected readonly rxMounted = computed(
    () =>
      this.rxKeep() ||
      (this.notesTab() === 'prescriptions' && this.portalSignedIn() && !!this.rxPatientId()),
  );
  private readonly rxPanel = viewChild(RxPanel);
  /** Latches true once the follow-up planner has been shown (see `followUpMounted`). */
  private readonly followUpKeep = signal(false);
  /**
   * The follow-up planner (Follow-ups tab) is mounted: from the first time the
   * doctor opens that tab while signed in, until the call ends — then only
   * hidden by tab switches, like the prescribing panel, so a half-chosen time
   * and note survive. It talks to the API over the portal session (DoctorApi).
   */
  protected readonly followUpMounted = computed(
    () =>
      this.followUpKeep() ||
      (this.notesTab() === 'followup' && this.portalSignedIn() && !!this.rxAppointmentId()),
  );
  /** "Leave the call?" / "…with an unsaved prescription?" and the clinical confirmations (rendered by the app's outlet). */
  private readonly dialogs = inject(DialogService);
  /** Leave questions open (End waits for them rather than stacking on top). */
  private asking = 0;

  // End consultation ("End consultation for everyone?") — focus returns to the opener by itself.
  protected readonly endOpen = signal(false);
  protected readonly ending = signal(false);
  /** Why the visit could not be closed — the doctor stays in the call. */
  protected readonly endError = signal('');

  // Lab orders builder + list.
  protected readonly labTests = signal('');
  protected readonly labInstructions = signal('');
  protected readonly labPriority = signal<'routine' | 'urgent'>('routine');
  protected readonly labBusy = signal(false);
  protected readonly labError = signal('');
  protected readonly issuedLabs = signal<LabOrderDto[]>([]);

  // Care plan editor.
  protected readonly carePlanItems = signal<string[]>(['']);
  protected readonly carePlanBusy = signal(false);
  protected readonly carePlanSaved = signal('');
  protected readonly carePlanError = signal('');
  /** A plan was published before (the confirmation then says "Update"). */
  private readonly carePlanPublished = signal(false);
  /** Until the published plan has loaded, "Save & publish" could replace it — stay read-only. */
  protected readonly carePlanLoad = signal<LoadState>('idle');
  protected readonly carePlanEditable = computed(
    () => this.carePlanLoad() === 'ready' && this.canDocument(),
  );

  // Referral form + list.
  protected readonly refType = signal<ReferralDto['referral_type']>('specialist');
  protected readonly refTarget = signal('');
  protected readonly refReason = signal('');
  protected readonly refPriority = signal<'routine' | 'urgent'>('routine');
  protected readonly refBusy = signal(false);
  protected readonly refError = signal('');
  protected readonly referrals = signal<ReferralDto[]>([]);

  // Medical certificate builder + issued list.
  protected readonly certType = signal<MedicalCertificateDto['type']>('sick_leave');
  protected readonly certStatement = signal('');
  protected readonly certDiagnosis = signal('');
  protected readonly certFrom = signal('');
  protected readonly certTo = signal('');
  protected readonly certBusy = signal(false);
  protected readonly certError = signal('');
  protected readonly issuedCerts = signal<MedicalCertificateDto[]>([]);
  /** The API's earliest leave start (clinic calendar), from the certificates list; '' until it loads. */
  protected readonly certEarliestFrom = signal('');

  // The documents the patient shares with this doctor (reviewed in-call, right
  // panel) — DoctorApi over the portal session, re-read every 30 s while
  // connected and on screen (passive: never extends the idle clock).
  protected readonly docAccess = signal<DoctorDocumentAccessDto | null>(null);
  protected readonly patientDocs = computed<readonly DoctorSharedDocumentDto[]>(() => this.docAccess()?.documents ?? []);
  protected readonly docsLoading = signal(false);
  /** The last read failed with nothing to show: an error with Try again (never "nothing shared"). */
  protected readonly docsFailed = signal(false);
  protected readonly docsSignedOut = CALL_SIGNED_OUT;
  protected readonly docsLoadFailed = LOAD_FAILED;
  /** The request dialog (theme `call`) is showing. */
  protected readonly docRequestOpen = signal(false);
  /** The withdraw POST is running ("Withdrawing…") — not while the doctor is still being asked. */
  protected readonly withdrawingRequest = signal(false);
  /** "Withdraw your request?" is being asked or answered (guards a second click). */
  private withdrawAsked = false;
  /** A request was sent: once its dialog has closed, focus the panel heading (the opener is gone). */
  private focusDocsAfterClose = false;
  private readonly docsHeading = viewChild<ElementRef<HTMLElement>>('docsHeading');
  /** Sharing results for screen readers ("Request sent."). */
  protected readonly docAnnounce = signal('');
  /** The consultation, once the join resolved it (the request dialog needs it). */
  protected readonly appointmentIdForDocs = signal<string | null>(null);
  protected readonly callDocBanner = computed(() => {
    if (this.docsFailed()) return unavailableBanner();
    const dto = this.docAccess();
    return dto ? accessBanner(dto, this.patientName(), this.callZone()) : null;
  });
  /** "Shared by the patient · until 4:30 PM" — left out when the empty Documents tab says "No documents shared". */
  protected readonly docsHeaderLine = computed(() => {
    const dto = this.docAccess();
    if (!dto || this.callDocBanner()?.access.state === 'unavailable') return '';
    if (dto.access.state !== 'active' && this.recordsTab() === 'documents' && this.patientDocs().length === 0) return '';
    return callHeaderLine(dto, this.docsClock(), this.callZone());
  });
  /** Ticks with each read, so "until 4:30 PM" (today) / a date stays right across midnight. */
  private readonly docsClock = signal(Date.now());
  private docsSeq = 0;
  private docsRead: Subscription | null = null;
  private docsPoll?: ReturnType<typeof setInterval>;
  private docsChangeTimer?: ReturnType<typeof setTimeout>;
  /** Why the last document could not be opened (e.g. no longer shared). */
  protected readonly docOpenError = signal('');

  // Patient consent decisions (read-only for the doctor).
  protected readonly consents = signal<ConsentDto[]>([]);
  protected readonly consentsError = signal('');
  protected readonly recordingConsent = computed(
    () => this.consents().find((c) => c.type === 'recording')?.granted ?? false,
  );

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

  // Cloud recording.
  protected readonly recordingConfigured = signal(false);
  protected readonly recordingActive = signal(false);
  protected readonly recordingBusy = signal(false);
  protected readonly recordingError = signal('');

  // Live transcription + AI copilot.
  protected readonly aiConsent = computed(
    () => this.consents().find((c) => c.type === 'ai_transcription')?.granted ?? false,
  );
  protected readonly transcribing = signal(false);
  protected readonly transcript = signal<TranscriptSegmentDto[]>([]);
  protected readonly copilotConfigured = signal(false);
  protected readonly copilotDraft = signal<CopilotDraftDto | null>(null);
  protected readonly copilotBusy = signal(false);
  protected readonly copilotError = signal('');
  protected readonly speechSupported = signal(this.detectSpeech());

  protected readonly info = signal<JoinInfoDto | null>(null);

  protected readonly notesTabs: ReadonlyArray<{ key: NotesTab; label: string }> = [
    { key: 'notes', label: 'Consultation Notes' },
    { key: 'prescriptions', label: 'Prescriptions' },
    { key: 'labs', label: 'Lab Orders' },
    { key: 'followup', label: 'Follow-ups' },
    { key: 'copilot', label: 'Transcript & AI' },
  ];
  protected readonly recordsTabs: ReadonlyArray<{ key: RecordsTab; label: string }> = [
    { key: 'documents', label: 'Documents' },
    { key: 'imaging', label: 'Imaging' },
    { key: 'labs', label: 'Labs' },
  ];
  protected readonly tools: ReadonlyArray<{ label: string; icon: string }> = [
    { label: 'ePrescription', icon: 'pill' },
    { label: 'Lab Request', icon: 'clipboard-list' },
    { label: 'Referral', icon: 'user-round' },
    { label: 'Certificate', icon: 'file-text' },
  ];

  // Vitals: the latest reading of each type (units as recorded, e.g. °C), who
  // recorded it and whether it is over a week old — from the join payload.
  protected readonly vitals = computed<VitalReadingDto[]>(() => this.info()?.patient?.vitals ?? []);
  /** "Updated 3 days ago" from the newest reading, or '' when there are none. */
  protected readonly vitalsAsOf = computed(() => {
    const times = this.vitals()
      .map((v) => Date.parse(v.taken_at ?? ''))
      .filter((t) => !Number.isNaN(t));
    if (!times.length) return '';
    const days = Math.floor((Date.now() - Math.max(...times)) / 86_400_000);
    if (days <= 0) return 'Updated today';
    return days === 1 ? 'Updated yesterday' : `Updated ${days} days ago`;
  });
  /** Readings the API says need attention (high / critical carry advice), critical first. */
  protected readonly vitalAlerts = computed(() =>
    this.vitals()
      .filter((v) => !!v.flag?.advice)
      .sort((a, b) => Number(b.flag?.level === 'critical') - Number(a.flag?.level === 'critical')),
  );
  protected vitalTitle(v: VitalReadingDto): string {
    // On the doctor's clock (profile zone), e.g. "Wed 4 Nov 2026, 9:00 AM CST".
    const when = v.taken_at
      ? `${formatInZone(v.taken_at, this.callZone(), 'date')}, ${timeLabel(v.taken_at, this.callZone())}`
      : 'time not recorded';
    return `${v.label}: ${v.value} ${v.unit} · ${v.source_label ?? (v.recorded_by === 'patient' ? 'Self-reported' : 'Recorded by a doctor')} · ${when}`;
  }

  // ---- Derived ----
  protected readonly doctorName = computed(() => this.info()?.you?.name ?? 'You');
  protected readonly patientName = computed(() => this.info()?.patient?.name ?? 'Patient');
  protected readonly patientMeta = computed(() => {
    const p = this.info()?.patient;
    if (!p) return '';
    const bits: string[] = [];
    if (p.gender) bits.push(p.gender);
    const age = this.ageFrom(p.date_of_birth);
    if (age !== null) bits.push(`${age} yrs`);
    return bits.join(' · ');
  });
  protected readonly conditions = computed(() => this.info()?.patient?.conditions ?? []);
  protected readonly medications = computed(() => this.info()?.patient?.medications ?? []);
  protected readonly history = computed(() => this.info()?.patient?.history ?? []);
  protected readonly allergiesLabel = computed(() => {
    const a = this.info()?.patient?.allergies ?? [];
    return a.length ? a.map((x) => x.allergen).join(', ') : 'None recorded';
  });
  /** Shared documents shown for the active Records tab (all / imaging / labs). */
  protected readonly visibleDocs = computed<readonly DoctorSharedDocumentDto[]>(() => {
    const tab = this.recordsTab();
    const docs = this.patientDocs();
    if (tab === 'imaging') return docs.filter((d) => DoctorCall.IMAGING_TYPES.has(d.document_type));
    if (tab === 'labs') return docs.filter((d) => DoctorCall.LAB_TYPES.has(d.document_type));
    return docs; // timeline + documents show everything
  });
  /** The empty Records tab: nothing shared, or nothing of that kind. */
  protected docsEmpty(state: 'none' | 'active'): { title: string; body: string | null } {
    return callEmptyCopy(this.recordsTab(), state);
  }
  protected docIcon(d: Pick<DoctorSharedDocumentDto, 'extension'>): string {
    const ext = d.extension.toLowerCase();
    if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'camera';
    return 'file-text';
  }

  /** The doctor plus everyone connected now (live Agora uids, the recorder left out). */
  protected readonly participantCount = computed(() => 1 + this.people().length);
  protected readonly doctorInitials = computed(() => this.initials(this.doctorName()));
  protected readonly patientInitials = computed(() => this.initials(this.patientName()));
  protected readonly elapsedLabel = computed(() => {
    const t = this.elapsed();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
  });

  private client?: IAgoraRTCClient;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  private screenTrack?: ILocalVideoTrack;
  private timer?: ReturnType<typeof setInterval>;
  private noteSaveTimer?: ReturnType<typeof setTimeout>;
  private metricsTimer?: ReturnType<typeof setInterval>;
  private transcriptPoll?: ReturnType<typeof setInterval>;
  private recognition?: SpeechRec;
  private netUplink = 0;
  private netDownlink = 0;
  private token = '';
  private appointmentId = '';
  private readonly base = environment.apiBaseUrl.replace(/\/+$/, '');
  private left = false;
  /** The portal idle timeout is held (see syncHold). */
  private holding = false;
  /** Someone else has been in the call (the first-wait hold no longer applies). */
  private readonly someoneJoined = signal(false);
  /** Waited FIRST_WAIT_HOLD_MS for the patient without anyone arriving. */
  private readonly firstWaitOver = signal(false);
  private firstWaitTimer?: ReturnType<typeof setTimeout>;
  /** The clinical panels (note, orders, documents…) have been loaded over the portal session. */
  private clinicalLoaded = false;
  /** Stops the "in the call" heartbeat; set only while one is running. */
  private heartbeatStop?: () => void;

  /**
   * Guard against an accidental refresh/close mid-consultation — reloading tears
   * down the Agora session and drops the doctor from the call. Only armed while
   * actually in-call, so the browser's native "Leave site?" prompt never nags
   * before the call starts or after it ends.
   */
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (this.status() === 'in-call' && !this.left) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  /** Document types surfaced under the Imaging / Labs records tabs. */
  private static readonly IMAGING_TYPES = new Set([
    'xray_report', 'ct_scan_report', 'mri_report', 'ultrasound_report', 'echocardiogram_report', 'radiology_report',
  ]);
  private static readonly LAB_TYPES = new Set([
    'laboratory_test_report', 'blood_test_report', 'urine_test_report', 'pathology_report', 'histopathology_report', 'biopsy_report', 'genetic_test_report',
  ]);

  constructor() {
    // The idle timeout is paused while in the call; always resume it on exit.
    this.destroyRef.onDestroy(() => {
      this.releaseHold();
      clearTimeout(this.firstWaitTimer);
      clearTimeout(this.alertTimer);
      clearTimeout(this.nudgeTimer);
      this.unbindNudge?.();
      this.unbindNudge = undefined;
      this.restoreTitle();
      this.viewerSub?.unsubscribe();
    });

    // The floating alert (narrow) pads the page's bottom while it shows.
    effect(() => {
      this.docAlertView();
      this.layout();
      untracked(() => afterNextRender(() => this.syncAlertPadding(), { injector: this.injector }));
    });

    // Hold the portal idle timeout only while a consultation is going on:
    // connected and someone else is here, or (for a bounded time) waiting for
    // the patient to first arrive. An ended call left open on a shared
    // computer still times out.
    effect(() => {
      const live = this.status() === 'in-call' && !this.callClosed();
      const othersInCall = this.people().length;
      if (live && othersInCall > 0 && !untracked(this.someoneJoined)) {
        untracked(() => this.someoneJoined.set(true));
      }
      const want = callHoldWanted({
        live,
        othersInCall,
        someoneJoined: this.someoneJoined(),
        firstWaitOver: this.firstWaitOver(),
      });
      untracked(() => this.syncHold(want));
    });

    // Signed in to the portal (at join, later in another tab, or again after
    // the session ended mid-call): load the clinical panels if they haven't
    // loaded yet, and save a note kept on this device meanwhile to the record.
    effect(() => {
      if (!this.portalSignedIn()) return;
      untracked(() => this.onPortalSignedIn());
    });
    // Signed out of the portal (or another doctor signed in on this machine):
    // the shared documents leave the screen, and nothing is fetched until the
    // doctor signs in again (onPortalSignedIn reads them afresh).
    effect(() => {
      if (this.portalSignedIn()) return;
      untracked(() => this.clearDocumentAccess());
    });

    // Keep the prescribing panel mounted once it has been shown.
    effect(() => {
      if (this.rxMounted() && !untracked(this.rxKeep)) untracked(() => this.rxKeep.set(true));
    });
    // ...and the follow-up planner once it has been shown.
    effect(() => {
      if (this.followUpMounted() && !untracked(this.followUpKeep)) untracked(() => this.followUpKeep.set(true));
    });

    // The doctor-role join payload carries the patient id; if it ever doesn't,
    // find it from the portal schedule once the doctor is signed in.
    effect(() => {
      const info = this.info();
      if (!info || info.patient?.id || !this.portalSignedIn()) return;
      untracked(() => this.lookUpPatient(info.appointment_id));
    });
  }

  ngAfterViewInit(): void {
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.observeObscurers();
    void this.start();
  }

  /** Window regained focus — the doctor may have just signed in in another tab. */
  protected recheckPortalSignIn(): void {
    this.authCheck.update((n) => n + 1);
  }

  /** Hold (or release) the portal idle timeout — never held after leaving. */
  private syncHold(want: boolean): void {
    const on = want && !this.left;
    if (on === this.holding) return;
    this.holding = on;
    if (on) this.session.hold(CALL_HOLD);
    else this.session.release(CALL_HOLD);
  }

  private releaseHold(): void {
    this.holding = false;
    this.session.release(CALL_HOLD);
  }

  /** The clinical panels, over the portal session — once per call, as soon as the doctor is signed in. */
  private loadClinical(): void {
    if (this.clinicalLoaded || !this.appointmentId || !this.auth.isAuthenticated()) return;
    this.clinicalLoaded = true;
    // The doctor's zone for every time shown here (shared with the portal's pages).
    void this.clock.ensureLoaded();
    void this.loadNote();
    void this.loadLabOrders();
    void this.loadCarePlan();
    void this.loadReferrals();
    void this.loadCertificates();
    this.loadDocumentAccess('load');
    void this.loadConsents();
    void this.loadRecording();
    void this.loadCopilot();
  }

  /**
   * Signed in to the portal: the panels load if they never did (the call was
   * opened from an emailed link, or the first load met an ended session); a
   * note kept on this device while signed out is saved to the record — when
   * it is the same doctor's.
   */
  private onPortalSignedIn(): void {
    if (this.left) return;
    if (!this.clinicalLoaded) {
      this.loadClinical();
      return;
    }
    if (!this.docAccess() && !this.docsLoading()) this.loadDocumentAccess('load');
    if (this.noteLoad() === 'error') {
      void this.loadNote();
      return;
    }
    if (this.noteLoad() !== 'ready' || this.noteFinalized()) return;
    const sub = this.auth.subject();
    if (sub !== null && sub === this.noteSub() && this.drafts.take(this.appointmentId, sub)) {
      void this.saveNote();
    }
  }

  /** Open the portal sign-in in a NEW tab, so the live call is not interrupted. */
  protected openPortalSignIn(): void {
    window.open('/auth/login', '_blank', 'noopener');
  }

  protected retryRxPatient(): void {
    const info = this.info();
    if (!info) return;
    this.patientLookup = 'idle';
    this.lookUpPatient(info.appointment_id);
  }

  private lookUpPatient(appointmentId: string): void {
    if (this.patientLookup !== 'idle') return;
    this.patientLookup = 'loading';
    this.rxPatientError.set('');
    this.doctorApi
      .appointment(appointmentId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.patientLookup = 'done';
          if (res.data.patient_id) this.lookedUpPatientId.set(res.data.patient_id);
          else this.rxPatientError.set('Could not find the patient for this consultation.');
        },
        error: (err: unknown) => {
          this.patientLookup = 'done';
          this.rxPatientError.set(apiErrorMessage(err, 'Could not load the patient for this consultation.'));
        },
      });
  }

  private async start(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    try {
      const data = await this.resolveJoin();
      this.info.set(data);
      this.appointmentId = data.appointment_id;
      this.appointmentIdForDocs.set(data.appointment_id || null);
      this.loadClinical();

      if (!data.configured || !data.app_id || !data.channel) {
        this.errorMessage.set('Video calling isn’t enabled on this environment yet.');
        this.status.set('error');
        return;
      }

      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      this.client = client;
      // The patient's "new document" nudge (no PHI: it only triggers a re-read); kept across rejoins.
      this.unbindNudge = onCallNudge(client, (_kind, uid) => this.onNudge(uid));

      // Per-uid state (joined, camera / mic on, talking) for the tiles and the
      // participants panel; the tracks themselves are played below.
      this.unbindRemotes = this.remotes.bind(client);
      client.on('user-published', async (user, mediaType) => {
        try {
          await client.subscribe(user, mediaType);
        } catch {
          return; // they left (or unpublished) in the meantime
        }
        if (this.left) return;
        if (mediaType === 'video' && user.videoTrack) this.stage().attach(user.uid, user.videoTrack);
        else if (mediaType === 'audio') user.audioTrack?.play();
      });
      // One person's camera going off (or them leaving) only touches their own tile.
      client.on('user-unpublished', (user, mediaType) => {
        if (mediaType === 'video') this.stage().detach(user.uid);
      });
      client.on('user-left', (user) => this.stage().detach(user.uid));
      client.on('user-joined', (user) => this.labelNewcomer(user.uid));
      client.on('token-privilege-will-expire', () => void this.renewToken());
      client.on('token-privilege-did-expire', () => void this.rejoin());
      client.on('network-quality', (s) => {
        this.netUplink = s.uplinkNetworkQuality ?? 0;
        this.netDownlink = s.downlinkNetworkQuality ?? 0;
        const known = [this.netUplink, this.netDownlink].filter((q) => q > 0);
        this.quality.set(known.length ? Math.max(...known) : 0);
      });
      // Who is talking (the grid's green ring).
      client.enableAudioVolumeIndicator();

      const joinedAs = await client.join(
        data.app_id,
        data.channel,
        data.token ?? null,
        data.uid === 0 ? null : (data.uid ?? null),
      );
      this.selfUid = joinedAs ?? 'self';
      if (this.left) return;

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      this.micTrack = mic;
      this.camTrack = cam;
      // Plays as soon as the doctor's own tile renders (status flips below): the
      // stage's PiP, or the phone's control-row tile (selfTrack).
      this.stage().attach(this.selfUid, cam);
      this.selfTrack.set(cam);
      await client.publish([mic, cam]);

      this.status.set('in-call');
      // Nobody touches the keyboard for long stretches in a consultation: the
      // portal idle timeout is held while the call goes on (the hold effect) —
      // waiting for the patient to first arrive holds it for a bounded time.
      if (!this.left) {
        this.firstWaitTimer = setTimeout(() => this.firstWaitOver.set(true), FIRST_WAIT_HOLD_MS);
      }
      // Let schedules show the doctor is in the call (stopped in teardown).
      if (!this.left) this.startHeartbeat();
      this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
      this.startMetricsReport();
      if (!this.left) this.startDocsPoll();
    } catch (err: unknown) {
      this.errorMessage.set(apiErrorMessage(err, 'This join link is invalid or has expired.'));
      this.joinStanding.set(doctorStandingCode(err));
      this.status.set('error');
      // Joined but could not go on (e.g. no camera): don't sit in the others'
      // call as a silent tile while this screen says it failed.
      if (this.client && !this.left) {
        this.unbindRemotes?.();
        this.unbindRemotes = undefined;
        this.remotes.clear();
        void this.client.leave().catch(() => undefined);
      }
      // ...and don't keep the camera and mic open behind it (e.g. publish failed).
      if (!this.left) {
        this.stage().detach(this.selfUid);
        this.micTrack?.close();
        this.camTrack?.close();
        this.micTrack = undefined;
        this.camTrack = undefined;
      }
    }
  }

  /** The join endpoint is public — the signed token in the path is the credential. */
  private async resolveJoin(): Promise<JoinInfoDto> {
    const res = await rawFetch(`${this.base}/api/public/call/${encodeURIComponent(this.token)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw fetchError(res.status, body);
    return body.data as JoinInfoDto;
  }

  /**
   * token-privilege-will-expire: the same join call answers with a fresh RTC
   * token (and the current participants). A refusal means the consultation was
   * cancelled or ended meanwhile — said in the banner. Anything else is tried
   * again a few times (the SDK warns only once); if the token still runs out,
   * token-privilege-did-expire rejoins.
   */
  private async renewToken(attempt = 0): Promise<void> {
    this.renewRetry = undefined;
    if (this.left || this.rejoining()) return;
    try {
      const data = await this.resolveJoin();
      if (this.left) return;
      if (data.participants) this.freshRoster.set(data.participants);
      if (data.token) await this.client?.renewToken(data.token);
    } catch (err: unknown) {
      if (this.left || this.refusedBy(err)) return;
      if (attempt + 1 < RENEW_RETRIES) {
        this.renewRetry = setTimeout(() => void this.renewToken(attempt + 1), RENEW_RETRY_MS);
      }
    }
  }

  /**
   * token-privilege-did-expire: the token could not be renewed in time and
   * Agora dropped the doctor from the channel. Fetch a fresh one and join
   * again with the same tracks (the others' tiles come back as they are
   * announced again); if that fails too, the banner offers Rejoin. Notes and
   * prescriptions are untouched. Not for a consultation the API has closed.
   */
  protected async rejoin(): Promise<void> {
    const client = this.client;
    if (!client || this.left || this.rejoining() || this.callClosed() || this.status() !== 'in-call') return;
    if (this.renewRetry) clearTimeout(this.renewRetry);
    this.renewRetry = undefined;
    this.rejoining.set(true);
    this.connectionLost.set(false);
    try {
      const data = await this.resolveJoin();
      if (this.left) return;
      if (data.participants) this.freshRoster.set(data.participants);
      if (!data.configured || !data.app_id || !data.channel) throw fetchError(0, null);
      await client.leave().catch(() => undefined);
      for (const r of this.remotes.list()) this.stage().detach(r.uid);
      this.remotes.clear();
      // The same uid as before, so the doctor's own tile (keyed by it) stays put.
      const uid = typeof this.selfUid === 'number' ? this.selfUid : data.uid ? data.uid : null;
      await client.join(data.app_id, data.channel, data.token ?? null, uid);
      if (this.left) {
        await client.leave().catch(() => undefined);
        return;
      }
      await this.publishOwnTracks();
    } catch (err: unknown) {
      if (this.left || this.refusedBy(err)) return;
      this.connectionLost.set(true);
    } finally {
      this.rejoining.set(false);
    }
  }

  /**
   * A join-call failure that is the API refusing the call: 410 / 409, or a 403
   * for the doctor's standing (suspended mid-call — the token renewal or a
   * rejoin meets it; a new terms version only refuses a consultation that
   * hasn't started yet). Shown as the closed banner, which then also points
   * to the terms or the account status.
   */
  private refusedBy(err: unknown): boolean {
    const status = (err as { status?: unknown }).status;
    const standing = status === 403 ? doctorStandingCode(err) : null;
    if (standing) {
      this.standingRefused(standing, apiErrorMessage(err, ''));
      return true;
    }
    if (status !== 410 && status !== 409) return false;
    const code = (err as { errors?: { code?: CallRefusalCode } }).errors?.code ?? null;
    this.callRefused(code, apiErrorMessage(err, ''));
    return true;
  }

  /**
   * After a rejoin: publish the mic and the camera (or the shared screen).
   * Agora refuses a disabled track, so one that is off is held back and
   * published when the doctor turns it on (publishHeldBack).
   */
  private async publishOwnTracks(): Promise<void> {
    this.heldBack.clear();
    const mine = [this.micTrack, this.screenOn() ? this.screenTrack : this.camTrack].filter(
      (t): t is NonNullable<typeof t> => !!t,
    );
    for (const t of mine) if (!t.enabled) this.heldBack.add(t);
    const live = mine.filter((t) => t.enabled);
    if (live.length) await this.client?.publish(live);
  }

  private async publishHeldBack(track: ILocalTrack): Promise<void> {
    if (!this.heldBack.delete(track)) return;
    await this.client?.publish(track).catch(() => undefined);
  }

  /** Heartbeat "the doctor is in the call" via the join token. Never two at once. */
  private startHeartbeat(): void {
    if (this.heartbeatStop) return;
    this.heartbeatStop = startCallPresence((s) => this.sendBeat(s));
  }

  /**
   * One heartbeat. An "in" beat answers with who is in the call (guests by id)
   * and the current participants — guests added mid-call, consents given — or
   * with a refusal once the consultation was cancelled or ended elsewhere.
   */
  private sendBeat(state: CallPresenceState): void {
    const url = `${this.base}/api/public/call/${encodeURIComponent(this.token)}/presence`;
    sendCallPresence(url, state, {}, {
      onBeat: (beat) => this.onBeat(beat),
      onRefused: (_status, code, message) => {
        if (isDoctorStandingCode(code)) this.standingRefused(code, message);
        else this.callRefused(code, message);
      },
    });
  }

  private onBeat(beat: CallPresenceBeatDto): void {
    if (this.left) return;
    if (beat.presence) this.presence.set(beat.presence);
    if (beat.participants) this.freshRoster.set(beat.participants);
  }

  /**
   * Someone joined the channel whose uid the participants don't have (a guest
   * the patient invited after this call loaded): fetch the list again now
   * rather than at the next beat, so their tile and row get a name. Their tile
   * says "Guest" meanwhile.
   */
  private labelNewcomer(uid: CallUid): void {
    if (String(uid) === RECORDER_UID) return;
    // Also a guest last seen without consent: they have likely just agreed in
    // their lobby, and Record would otherwise stay off until the next beat.
    const known = participantByUid(this.roster(), uid);
    if (known && (known.role !== 'guest' || known.consented === true)) return;
    this.refreshRoster();
  }

  /**
   * An extra "in" beat for fresh participants — only while the heartbeat runs,
   * at most every few seconds (one asked for sooner is sent once allowed).
   */
  private refreshRoster(): void {
    if (!this.heartbeatStop || this.left) return;
    const wait = this.rosterRefreshedAt + ROSTER_REFRESH_MS - Date.now();
    if (wait > 0) {
      this.rosterRefreshTimer ??= setTimeout(() => {
        this.rosterRefreshTimer = undefined;
        this.refreshRoster();
      }, wait);
      return;
    }
    this.rosterRefreshedAt = Date.now();
    this.sendBeat('in');
  }

  /**
   * The API refused the call for the doctor's standing (a 403 on a rejoin, a
   * token renewal or a heartbeat): the closed banner, pointing to the terms
   * or the account status.
   */
  private standingRefused(standing: DoctorStandingCode, message: string): void {
    this.joinStanding.set(standing);
    this.callRefused(
      null,
      message ||
        (standing === 'terms_required'
          ? 'Accept the updated practitioner terms to continue consultations.'
          : 'Your account can no longer take consultations.'),
    );
  }

  /**
   * The API no longer takes this call (410 cancelled / ended — e.g. ended from
   * the appointment page, or cancelled by the clinic). The doctor stays to
   * finish notes or a prescription; the banner says why and offers Leave.
   * Not while ending it here (that refusal is expected) or after leaving.
   */
  private callRefused(code: CallRefusalCode | null, message: string): void {
    if (this.left || this.ending() || this.callClosed()) return;
    this.callClosed.set(
      message || (code === 'cancelled' ? 'This consultation was cancelled.' : 'This consultation has ended.'),
    );
    // Stop saying "the doctor is in the call" for a visit that is over.
    this.heartbeatStop?.();
    this.heartbeatStop = undefined;
  }

  protected async toggleMic(): Promise<void> {
    if (!this.micTrack) return;
    const on = !this.micOn();
    await this.micTrack.setEnabled(on);
    if (on) await this.publishHeldBack(this.micTrack);
    this.micOn.set(on);
  }

  protected async toggleCam(): Promise<void> {
    if (!this.camTrack) return;
    const on = !this.camOn();
    await this.camTrack.setEnabled(on);
    if (on) await this.publishHeldBack(this.camTrack);
    this.camOn.set(on);
  }

  protected async toggleScreen(): Promise<void> {
    if (!this.client) return;
    try {
      if (this.screenOn()) {
        if (this.screenTrack) {
          await this.client.unpublish(this.screenTrack);
          this.screenTrack.close();
          this.screenTrack = undefined;
        }
        if (this.camTrack) {
          await this.client.publish(this.camTrack);
          this.stage().attach(this.selfUid, this.camTrack);
        }
        this.selfTrack.set(this.camTrack ?? null);
        this.screenOn.set(false);
      } else {
        const track = (await AgoraRTC.createScreenVideoTrack({}, 'disable')) as ILocalVideoTrack;
        if (this.camTrack) await this.client.unpublish(this.camTrack);
        this.screenTrack = track;
        await this.client.publish(track);
        // The doctor's own tile previews the shared screen (whole, not cropped).
        this.stage().attach(this.selfUid, track, { fit: 'contain' });
        this.selfTrack.set(track);
        track.on('track-ended', () => void this.toggleScreen());
        this.screenOn.set(true);
      }
    } catch {
      this.screenOn.set(false);
    }
  }

  protected useTool(label: string): void {
    if (label === 'ePrescription') {
      this.toolNote.set('');
      this.notesTab.set('prescriptions');
      return;
    }
    if (label === 'Lab Request') {
      this.toolNote.set('');
      this.notesTab.set('labs');
      return;
    }
    if (label === 'Referral') {
      this.toolNote.set('');
      this.openFollowUpSection('call-referral');
      return;
    }
    if (label === 'Certificate') {
      this.toolNote.set('');
      this.openFollowUpSection('call-certificate');
      return;
    }
    this.toolNote.set('');
  }

  /** The Follow-ups tab, scrolled to one of its tools (they sit below Schedule follow-up and the care plan). */
  private openFollowUpSection(id: string): void {
    this.notesTab.set('followup');
    afterNextRender(
      () => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      { injector: this.injector },
    );
  }

  // ---- Documents the patient shares (in-call review) ----
  /**
   * What the patient shares with this doctor (`DoctorApi.documentAccess`, over
   * the portal session: fresh token, refreshed if need be). `load`: at join,
   * on sign-in, Try again — a failure with nothing on screen shows the error;
   * `refresh`: after a request or a refused open — a failure keeps the list;
   * `poll`: the live call's 10 s (30 s hidden) re-read and the next-change
   * re-read; `nudge`: the patient said a document is on its way. Poll and
   * nudge are passive (never extend the idle clock); one asked for while a
   * read runs becomes ONE more read after it (never skipped). Nothing
   * without a session.
   */
  protected loadDocumentAccess(mode: 'load' | 'refresh' | 'poll' | 'nudge'): void {
    if (!this.appointmentId || !this.portalSignedIn() || this.left) return;
    const passive = mode === 'poll' || mode === 'nudge';
    if (passive && this.docsRead && !this.docsRead.closed) {
      this.docsFollowUp = true;
      return;
    }
    this.docsRead?.unsubscribe();
    // The poll's clock starts when a read STARTS (latency never stretches the
    // cadence); a nudge read doesn't move it, so the 10 s guarantee never shifts.
    if (mode !== 'nudge') this.lastPollStartAt = Date.now();
    const seq = ++this.docsSeq;
    this.docsLoading.set(true);
    if (mode === 'load') this.docsFailed.set(false);
    this.docsRead = this.doctorApi
      .documentAccess(this.appointmentId, passive ? { passive: true } : undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.docsSeq) return;
          this.docsLoading.set(false);
          // Signed out (or another doctor signed in) while it was on its way: drop it.
          if (!this.portalSignedIn()) return;
          this.docAccess.set(res.data);
          this.docsFailed.set(false);
          this.docsClock.set(Date.now());
          this.trackNewDocs(res.data);
          this.scheduleDocsChange(res.data);
          this.runFollowUp(seq);
        },
        error: (err: unknown) => {
          if (seq !== this.docsSeq) return;
          this.docsLoading.set(false);
          if (isSessionEndError(err)) return;
          this.runFollowUp(seq);
          // A re-read that fails keeps what is on screen (each file is still checked when opened); no alert.
          if (mode !== 'load' && this.docAccess()) return;
          this.docAccess.set(null);
          this.docsFailed.set(true);
        },
      });
  }

  /** A read asked for while this one ran: run it now (once). */
  private runFollowUp(seq: number): void {
    if (!this.docsFollowUp || seq !== this.docsSeq) return;
    this.docsFollowUp = false;
    queueMicrotask(() => this.loadDocumentAccess('nudge'));
  }

  protected retryDocumentAccess(): void {
    this.loadDocumentAccess('load');
  }

  /** Signed out: nothing shared stays on screen, no read is pending, no timer runs. */
  private clearDocumentAccess(): void {
    this.docsSeq++;
    this.docsRead?.unsubscribe();
    this.docsRead = null;
    this.docsFollowUp = false;
    clearTimeout(this.docsChangeTimer);
    this.docsChangeTimer = undefined;
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    this.docAccess.set(null);
    this.docsFailed.set(false);
    this.docsLoading.set(false);
    this.docRequestOpen.set(false);
    // Signing in again starts a fresh baseline: what is shared then is not "new".
    this.newDocsState = EMPTY_NEW_DOCS;
    this.newDocIds.set(new Set());
    this.docAlert.set(null);
    this.restoreTitle();
    if (this.viewerDoc()) this.closeViewer(false);
  }

  /**
   * The guaranteed delivery of a new document: in the live call, a passive
   * read every 10 s with the tab visible, every 30 s hidden. One timer ticks
   * every 10 s; a tick reads when the last read STARTED a cadence ago (less a
   * second of timer jitter). The call holds the session; this never extends it.
   */
  private startDocsPoll(): void {
    if (this.docsPoll) return;
    this.docsPoll = setInterval(() => {
      if (!this.inLiveCall()) return;
      const cadence = document.visibilityState === 'visible' ? CALL_LIVE_POLL_MS : CALL_HIDDEN_POLL_MS;
      if (Date.now() - this.lastPollStartAt >= cadence - POLL_SLACK_MS) this.loadDocumentAccess('poll');
    }, CALL_LIVE_POLL_MS);
  }

  /** Re-read when the next share starts or ends (`next_change_at`, by the server's clock). */
  private scheduleDocsChange(dto: DoctorDocumentAccessDto): void {
    clearTimeout(this.docsChangeTimer);
    this.docsChangeTimer = undefined;
    const serverNow = Date.parse(dto.server_time);
    const delay = nextRefreshDelay(dto.access.next_change_at, Number.isFinite(serverNow) ? serverNow : Date.now());
    if (delay !== null) this.docsChangeTimer = setTimeout(() => this.loadDocumentAccess('poll'), delay);
  }

  protected openDocRequest(): void {
    if (!this.portalSignedIn() || !this.appointmentIdForDocs()) return;
    this.docOpenError.set('');
    this.docRequestOpen.set(true);
  }

  /** The request was made: show it as waiting (from the answer), then re-read. */
  protected onDocRequestSent(request: DoctorAccessRequestDto): void {
    this.docRequestOpen.set(false);
    // "Request access" / "Ask for more" / "Ask to extend" gives way to the waiting line.
    this.focusDocsAfterClose = true;
    this.docAccess.update((d) =>
      d ? { ...d, request: { ...d.request, can_request: false, blocked_reason: 'request_pending', pending: request } } : d,
    );
    this.announceDocs(REQUEST_SENT);
    this.loadDocumentAccess('refresh');
  }

  /** The request dialog has fully closed: after a send, keep keyboard focus in the panel (never `<body>` mid-call). */
  protected focusDocsIfAsked(): void {
    if (!this.focusDocsAfterClose) return;
    this.focusDocsAfterClose = false;
    this.docsHeading()?.nativeElement.focus();
  }

  /** "Withdraw your request?" — the patient is no longer asked. */
  protected async withdrawDocRequest(): Promise<void> {
    if (this.withdrawAsked || !this.appointmentId || !this.portalSignedIn()) return;
    this.withdrawAsked = true;
    try {
      const { confirmed } = await this.dialogs.confirm({
        ...WITHDRAW_PROMPT,
        errorMessage: (err) => requestErrorCopy(apiErrorCode(err), null) ?? apiErrorMessage(err, WITHDRAW_FAILED),
        // Busy only while the cancel runs (the dialog shows its own spinner meanwhile).
        action: () => {
          this.withdrawingRequest.set(true);
          return this.doctorApi.cancelDocumentAccessRequest(this.appointmentId).pipe(
            tap({
              error: (err: unknown) => {
                this.withdrawingRequest.set(false);
                if (isStaleRequestCode(apiErrorCode(err))) this.loadDocumentAccess('refresh');
              },
            }),
          );
        },
      });
      if (!confirmed) return;
      this.docAccess.update((d) =>
        d ? { ...d, request: { ...d.request, can_request: false, blocked_reason: null, pending: null } } : d,
      );
      this.announceDocs(REQUEST_WITHDRAWN);
      this.loadDocumentAccess('refresh');
      // "Withdraw request" is gone: focus the panel heading once the prompt has fully closed.
      focusAfterDialogs(this.injector, () => this.docsHeading()?.nativeElement);
    } finally {
      this.withdrawAsked = false;
      this.withdrawingRequest.set(false);
    }
  }

  private announceDocs(text: string): void {
    // Cleared first, so the same words twice are announced twice.
    this.docAnnounce.set('');
    setTimeout(() => this.docAnnounce.set(text), 50);
  }

  // ---- Medical certificate ----
  private async loadCertificates(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/certificates`,
        { method: 'GET' },
      );
      this.issuedCerts.set(Array.isArray(body.data) ? body.data : []);
      // The leave-start floor on the clinic calendar (refreshed with the list).
      this.certEarliestFrom.set(body?.meta?.earliest_from_date ?? '');
    } catch {
      /* leave empty */
    }
  }

  /**
   * The leave-start floor for the picker and the pre-check: the API's date (clinic
   * calendar), or, until it loads, a day looser than the browser's own so no date
   * the API accepts is hidden. The API rejects anything earlier with its message.
   */
  protected certMinFrom(): string {
    return this.certEarliestFrom() || todayLocal(-CERTIFICATE_BACKDATE_DAYS - 1);
  }

  protected async issueCertificate(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.certBusy()) return;
    if (this.certStatement().trim() === '') {
      this.certError.set('Add a certifying statement.');
      return;
    }
    if (this.certType() === 'sick_leave' && (this.certFrom() === '' || this.certTo() === '')) {
      this.certError.set('Set the leave period.');
      return;
    }
    if (this.certType() === 'sick_leave' && this.certFrom() < this.certMinFrom()) {
      this.certError.set(`Leave can start at most ${CERTIFICATE_BACKDATE_DAYS} days ago.`);
      return;
    }
    if (this.certType() === 'sick_leave' && this.certTo() < this.certFrom()) {
      this.certError.set('The end date cannot be before the start date.');
      return;
    }
    this.certError.set('');
    // Signed in the doctor's name and downloadable at once: ask first.
    const kind = this.certType();
    const period = kind === 'sick_leave' ? `${shortDayLabel(this.certFrom())} – ${shortDayLabel(this.certTo())}` : null;
    if (!(await this.dialogs.confirm(certificatePrompt(this.patientName(), kind, period))).confirmed) return;
    if (this.certBusy()) return;
    this.certBusy.set(true);
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/certificates`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: this.certType(),
            statement: this.certStatement(),
            diagnosis: this.certDiagnosis() || null,
            from_date: this.certType() === 'sick_leave' ? this.certFrom() : null,
            to_date: this.certType() === 'sick_leave' ? this.certTo() : null,
          }),
        },
      );
      this.certStatement.set('');
      this.certDiagnosis.set('');
      this.certFrom.set('');
      this.certTo.set('');
      await this.loadCertificates();
    } catch (err: unknown) {
      this.certError.set(apiErrorMessage(err, 'Could not issue certificate.'));
      // A call left open past midnight picks up the new leave-start floor.
      void this.loadCertificates();
    } finally {
      this.certBusy.set(false);
    }
  }

  // ---- Clinical note (SOAP) persistence ----
  /**
   * A clinical call over the portal session (HttpClient + staffAuthInterceptor):
   * the token is refreshed before it expires and on a 401, and a session that
   * ended is handled like anywhere else in the portal. Errors arrive as the
   * shared `ApiError` (`apiErrorMessage` reads them).
   */
  private noteFetch(path: string, init: RequestInit): Promise<any> {
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined;
    return firstValueFrom(this.api.request<unknown>(init.method ?? 'GET', path, body));
  }

  private notePayload(): NoteDraftPayload {
    return {
      subjective: this.subjective(),
      objective: this.objective(),
      assessment: this.assessment(),
      plan: this.plan(),
    };
  }

  private async loadNote(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated() || this.noteLoad() === 'loading') return;
    this.noteLoad.set('loading');
    this.noteError.set('');
    const sub = this.auth.subject();
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note`,
        { method: 'GET' },
      );
      const n = body?.data ?? {};
      this.subjective.set(n.subjective ?? '');
      this.objective.set(n.objective ?? '');
      this.assessment.set(n.assessment ?? '');
      this.plan.set(n.plan ?? '');
      this.noteStatus.set(n.status === 'finalized' ? 'finalized' : 'draft');
      if (n.updated_at) this.noteSaved.set('Saved');
      this.noteSub.set(sub);
      this.noteLoad.set('ready');
      this.restoreDraft(sub, n.updated_at ?? null);
    } catch (err: unknown) {
      // The editor stays read-only (and nothing is saved) until a retry
      // succeeds — otherwise auto-save would overwrite the real note. A
      // session that ended meanwhile loads it again after signing in.
      this.noteError.set(
        isSessionEndError(err) || !this.auth.isAuthenticated()
          ? 'Sign in to the doctor portal to load the saved note.'
          : apiErrorMessage(err, 'Could not load the saved note.'),
      );
      this.noteLoad.set('error');
    }
  }

  /**
   * A note this doctor wrote here while signed out (e.g. the page was reloaded
   * before it could be saved): put it back in the editor and save it now. A
   * note finalized meanwhile — or saved after the draft was kept (edited on
   * another device) — wins: the kept copy is dropped, never saved over it.
   */
  private restoreDraft(sub: string | null, updatedAt: string | null): void {
    const draft = this.drafts.take(this.appointmentId, sub);
    if (!draft) return;
    if (this.noteFinalized() || !draftIsNewer(draft, updatedAt, this.auth.clockOffset())) {
      this.drafts.clear(this.appointmentId);
      return;
    }
    const kept = draft.payload;
    this.subjective.set(kept.subjective);
    this.objective.set(kept.objective);
    this.assessment.set(kept.assessment);
    this.plan.set(kept.plan);
    this.noteSaved.set('Saving the note kept on this device…');
    void this.saveNote();
  }

  protected retryLoadNote(): void {
    void this.loadNote();
  }

  /**
   * Debounced auto-save while the note is still a draft (only once it has
   * loaded). Signed out meanwhile, the note is kept on this device instead.
   */
  protected scheduleSave(): void {
    if (!this.noteEditable()) return;
    this.noteSaved.set('Saving…');
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    this.noteSaveTimer = setTimeout(() => void this.saveNote(), 1200);
  }

  private async saveNote(): Promise<void> {
    if (!this.appointmentId || this.noteLoad() !== 'ready' || this.noteFinalized()) return;
    // The session ended (idle, expiry, signed out elsewhere): never lose the words.
    const noteSub = this.noteSub();
    if (!this.auth.isAuthenticated() || (noteSub !== null && this.auth.subject() !== noteSub)) {
      this.keepNoteOnDevice();
      return;
    }
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note`,
        { method: 'PUT', body: JSON.stringify(this.notePayload()) },
      );
      this.drafts.clear(this.appointmentId);
      this.noteSaved.set('Saved');
      this.noteError.set('');
    } catch (err: unknown) {
      if (isSessionEndError(err) || !this.auth.isAuthenticated()) {
        this.keepNoteOnDevice();
        return;
      }
      this.noteSaved.set('Save failed — retry');
      this.noteError.set(apiErrorMessage(err, 'Could not save the note.'));
    }
  }

  /** Keep the note on this device for the doctor it belongs to, until they sign in again. */
  private keepNoteOnDevice(): void {
    const sub = this.noteSub() ?? this.auth.subject();
    if (sub && this.drafts.save(this.appointmentId, sub, this.notePayload())) {
      this.noteSaved.set(NOTE_KEPT_ON_DEVICE);
      this.noteError.set('');
      return;
    }
    this.noteSaved.set('Not saved — sign in to save');
    this.noteError.set('Sign in to the doctor portal (new tab) to save this note — keep this page open until then.');
  }

  protected async finalizeNote(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.finalizing()) return;
    // Never lock in a note that may be blank only because it failed to load.
    if (this.noteLoad() !== 'ready') return;
    // Signing locks it for good and shares the summary: ask first.
    if (!(await this.dialogs.confirm(finalizeNotePrompt(this.patientName()))).confirmed) return;
    if (this.finalizing() || this.noteLoad() !== 'ready') return;
    this.finalizing.set(true);
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note/finalize`,
        { method: 'POST', body: JSON.stringify(this.notePayload()) },
      );
      this.noteStatus.set(body.data?.status === 'finalized' ? 'finalized' : 'draft');
      this.drafts.clear(this.appointmentId);
      this.noteSaved.set('Finalized & locked');
      this.noteError.set('');
    } catch (err: unknown) {
      this.noteSaved.set('Could not finalize — retry');
      this.noteError.set(apiErrorMessage(err, 'Could not finalize the note.'));
    } finally {
      this.finalizing.set(false);
    }
  }

  // ---- Lab orders ----
  private async loadLabOrders(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/lab-orders`,
        { method: 'GET' },
      );
      this.issuedLabs.set(Array.isArray(body.data) ? body.data : []);
    } catch {
      /* leave empty */
    }
  }

  protected async issueLab(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.labBusy()) return;
    const tests = this.labTests()
      .split(/\r?\n|,/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tests.length === 0) {
      this.labError.set('Add at least one test.');
      return;
    }
    this.labError.set('');
    if (!(await this.dialogs.confirm(labOrderPrompt(this.patientName(), tests.length, this.labPriority()))).confirmed) return;
    if (this.labBusy()) return;
    this.labBusy.set(true);
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/lab-orders`,
        {
          method: 'POST',
          body: JSON.stringify({
            tests,
            instructions: this.labInstructions(),
            priority: this.labPriority(),
          }),
        },
      );
      this.labTests.set('');
      this.labInstructions.set('');
      this.labPriority.set('routine');
      await this.loadLabOrders();
    } catch (err: unknown) {
      this.labError.set(apiErrorMessage(err, 'Could not create order.'));
    } finally {
      this.labBusy.set(false);
    }
  }

  // ---- Care plan ----
  private async loadCarePlan(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated() || this.carePlanLoad() === 'loading') return;
    this.carePlanLoad.set('loading');
    this.carePlanError.set('');
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/care-plan`,
        { method: 'GET' },
      );
      const items: string[] = Array.isArray(body?.data?.items) ? body.data.items : [];
      this.carePlanItems.set(items.length ? items : ['']);
      if (body?.data?.published) {
        this.carePlanSaved.set('Published');
        this.carePlanPublished.set(true);
      }
      this.carePlanLoad.set('ready');
    } catch (err: unknown) {
      // Not silent, and read-only until a retry succeeds: an empty editor here
      // would let "Save & publish" overwrite the real plan.
      this.carePlanError.set(apiErrorMessage(err, 'Could not load the care plan.'));
      this.carePlanLoad.set('error');
    }
  }

  protected retryLoadCarePlan(): void {
    void this.loadCarePlan();
  }

  protected addCareItem(): void {
    if (!this.carePlanEditable()) return;
    this.carePlanItems.update((rows) => [...rows, '']);
  }

  protected removeCareItem(index: number): void {
    if (!this.carePlanEditable()) return;
    this.carePlanItems.update((rows) =>
      rows.length <= 1 ? [''] : rows.filter((_, i) => i !== index),
    );
  }

  protected updateCareItem(index: number, value: string): void {
    if (!this.carePlanEditable()) return;
    this.carePlanItems.update((rows) => rows.map((r, i) => (i === index ? value : r)));
  }

  protected async saveCarePlan(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.carePlanBusy()) return;
    if (this.carePlanLoad() !== 'ready') return;
    const items = this.carePlanItems().map((s) => s.trim()).filter(Boolean);
    if (!(await this.dialogs.confirm(carePlanPrompt(this.patientName(), items.length, this.carePlanPublished()))).confirmed) return;
    if (this.carePlanBusy()) return;
    this.carePlanBusy.set(true);
    this.carePlanSaved.set('Saving…');
    this.carePlanError.set('');
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/care-plan`,
        { method: 'PUT', body: JSON.stringify({ items }) },
      );
      this.carePlanSaved.set('Published to patient');
      this.carePlanPublished.set(true);
    } catch (err: unknown) {
      this.carePlanSaved.set('Could not save — retry');
      this.carePlanError.set(apiErrorMessage(err, 'Could not publish the care plan.'));
    } finally {
      this.carePlanBusy.set(false);
    }
  }

  // ---- Referrals ----
  private async loadReferrals(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/referrals`,
        { method: 'GET' },
      );
      this.referrals.set(Array.isArray(body.data) ? body.data : []);
    } catch {
      /* leave empty */
    }
  }

  protected async createReferral(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.refBusy()) return;
    if (this.refTarget().trim() === '' || this.refReason().trim() === '') {
      this.refError.set('Target and reason are required.');
      return;
    }
    this.refError.set('');
    if (!(await this.dialogs.confirm(referralPrompt(this.patientName(), this.refTarget().trim(), this.refPriority()))).confirmed) return;
    if (this.refBusy()) return;
    this.refBusy.set(true);
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/referrals`,
        {
          method: 'POST',
          body: JSON.stringify({
            referral_type: this.refType(),
            target: this.refTarget(),
            reason: this.refReason(),
            priority: this.refPriority(),
          }),
        },
      );
      this.refTarget.set('');
      this.refReason.set('');
      this.refPriority.set('routine');
      await this.loadReferrals();
    } catch (err: unknown) {
      this.refError.set(apiErrorMessage(err, 'Could not create referral.'));
    } finally {
      this.refBusy.set(false);
    }
  }

  // ---- Consent (read-only) ----
  private async loadConsents(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/consents`,
        { method: 'GET' },
      );
      this.consents.set(Array.isArray(body.data) ? body.data : []);
    } catch (err: unknown) {
      // Not silent: an empty list would read as "consent not granted" and gate recording/AI.
      this.consentsError.set(apiErrorMessage(err, "Could not load the patient's consent decisions."));
    }
  }

  // ---- Cloud recording ----
  private async loadRecording(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/recording`,
        { method: 'GET' },
      );
      this.recordingConfigured.set(body.data?.configured === true);
      this.recordingActive.set(body.data?.active === true);
    } catch {
      /* recording unavailable */
    }
  }

  protected async toggleRecording(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.recordingBusy()) return;
    // What the click meant, fixed before any prompt: a state refresh while the
    // question is open must never turn "Stop recording" into a start.
    const stopping = this.recordingActive();
    // Stopping closes this file (starting again makes another one): ask first.
    if (stopping && !(await this.dialogs.confirm(STOP_RECORDING_PROMPT)).confirmed) return;
    // Busy meanwhile, or the state changed under the prompt (stopped elsewhere): do nothing.
    if (this.recordingBusy() || this.recordingActive() !== stopping) return;
    this.recordingError.set('');
    this.recordingBusy.set(true);
    const path = stopping ? 'recording/stop' : 'recording/start';
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/${path}`,
        { method: 'POST' },
      );
      this.recordingActive.set(!stopping);
    } catch (err: unknown) {
      this.recordingError.set(apiErrorMessage(err, 'Recording failed.'));
      // E.g. a guest who hasn't agreed yet joined a moment ago: refresh who is
      // here, so the button and the participants panel show it too.
      this.refreshRoster();
    } finally {
      this.recordingBusy.set(false);
    }
  }

  /**
   * Leave WITHOUT ending (Back, "Leave the call", "Just leave"): the visit
   * stays open, so the doctor can rejoin — to the appointment page, where the
   * note and prescriptions can be finished (or the schedule, from the error
   * screen). Asks first while in the call, or with a half-written prescription.
   */
  protected async leave(to: 'appointment' | 'schedule' = 'appointment', asked = false): Promise<void> {
    if (!this.left && !asked && !(await this.confirmLeaveCall())) return;
    await this.flushNote();
    await this.teardown();
    if (to === 'schedule') void this.router.navigate(['/']);
    else this.goToAppointment();
  }

  /** A join refused for the doctor's standing: the terms to accept, or the account-status page. */
  protected async openStanding(): Promise<void> {
    const target = this.joinStanding() === 'terms_required' ? '/onboarding/terms' : '/account-status';
    if (!this.left && !(await this.confirmLeaveCall())) return;
    await this.flushNote();
    await this.teardown();
    void this.router.navigateByUrl(target);
  }

  /** The appointment page, or the history when the join never said which visit this is. */
  private goToAppointment(): void {
    void this.router.navigate(this.appointmentId ? ['/appointments', this.appointmentId] : ['/appointments/history']);
  }

  /**
   * End (in-call control) — ask first: end the visit for everyone, or just
   * leave? Both ways out leave the call, so a half-written prescription is
   * asked about BEFORE the dialog opens — never stacked on top of it, where
   * cancelling the End underneath could still let a late answer complete the
   * visit. (The dialog is modal, so nothing can be edited between the two.)
   */
  protected async askEnd(): Promise<void> {
    if (this.endOpen() || this.asking > 0 || this.left) return;
    if (!(await this.confirmDiscardPrescription())) return;
    if (this.endOpen() || this.left) return;
    this.endError.set('');
    this.endOpen.set(true);
  }

  /** Cancel, Esc or the scrim (ignored while ending); focus goes back to End by itself. */
  protected cancelEnd(): void {
    if (this.ending()) return;
    this.endOpen.set(false);
  }

  /** "Just leave — I'll come back": the visit stays open. */
  protected async leaveFromEndDialog(): Promise<void> {
    if (this.ending()) return;
    this.endOpen.set(false);
    // An unsaved prescription was already asked about when End was pressed.
    await this.leave('appointment', true);
  }

  /**
   * "End consultation": mark the visit completed (an already-completed one is
   * fine too), then leave for the appointment page. On failure the doctor stays
   * in the call and the dialog says why. An unsaved prescription was already
   * asked about when End was pressed (askEnd).
   */
  protected async endConsultation(): Promise<void> {
    if (this.ending() || !this.endOpen()) return;
    if (!this.appointmentId) {
      this.endError.set('This consultation could not be identified. Leave the call and mark it completed from the appointment page.');
      return;
    }
    if (!this.portalSignedIn()) {
      this.endError.set('Sign in to the doctor portal to end the consultation.');
      return;
    }
    // While this runs the dialog can't be dismissed and its buttons do nothing (focus stays put).
    this.ending.set(true);
    this.endError.set('');
    await this.flushNote();
    try {
      await firstValueFrom(this.doctorApi.complete(this.appointmentId));
    } catch (err: unknown) {
      if (!/already completed/i.test(apiErrorMessage(err, ''))) {
        this.endError.set(apiErrorMessage(err, 'Could not end the consultation. Please try again.'));
        this.ending.set(false);
        return;
      }
    }
    this.ending.set(false);
    this.endOpen.set(false);
    await this.teardown();
    this.goToAppointment();
  }

  /** Save a pending (debounced) note edit now, so leaving never drops the last words. */
  private async flushNote(): Promise<void> {
    if (!this.noteSaveTimer) return;
    clearTimeout(this.noteSaveTimer);
    this.noteSaveTimer = undefined;
    if (this.noteEditable()) await this.saveNote();
  }

  /** Route guard hook (e.g. the browser Back button) — the same question as Leave. */
  canLeave(): boolean | Promise<boolean> {
    return this.left ? true : this.confirmLeaveCall();
  }

  /** In the live call (connected, and the API still takes it). */
  protected inLiveCall(): boolean {
    return this.status() === 'in-call' && !this.left && !this.callClosed();
  }

  /**
   * One question before leaving — never two stacked: "Leave the call?" while
   * in it (the visit stays open, they can rejoin), worded for an unsaved
   * prescription too when there is one; just the prescription question once
   * the call is over. True to leave.
   */
  private confirmLeaveCall(): boolean | Promise<boolean> {
    if (this.left) return true;
    const rx = !!this.rxPanel()?.hasUnsavedChanges();
    if (!this.inLiveCall()) return rx ? this.ask(UNSAVED_RX_LEAVE) : true;
    return this.ask(
      rx
        ? {
            tone: 'danger',
            icon: 'phone-off',
            title: 'Leave the call with an unsaved prescription?',
            message:
              "Your latest changes to the prescription haven't been saved, and leaving loses them. The visit stays open — you can rejoin from the appointment page.",
            confirmLabel: 'Leave without saving',
            cancelLabel: 'Stay in the call',
          }
        : {
            tone: 'warning',
            icon: 'door-open',
            title: 'Leave the call?',
            message: `The visit stays open — you can rejoin from the appointment page while ${this.patientName()} is still there.`,
            confirmLabel: 'Leave call',
            cancelLabel: 'Stay',
          },
    );
  }

  /**
   * True when it is fine to destroy the prescribing panel (End): nothing
   * unsaved, or the doctor chose to leave anyway. Asked by the cockpit, as the
   * panel itself may be hidden behind another tab.
   */
  private confirmDiscardPrescription(): boolean | Promise<boolean> {
    if (!this.rxPanel()?.hasUnsavedChanges()) return true;
    return this.ask(UNSAVED_RX_LEAVE);
  }

  /** A leave question through the app's dialog outlet (a newer one answers an older one "stay"). */
  private async ask(copy: LeaveCopy): Promise<boolean> {
    this.asking++;
    try {
      return await this.dialogs.confirmLeave(copy);
    } finally {
      this.asking--;
    }
  }

  /** Open the patient's full record in a NEW tab — without leaving the live call. */
  protected openRecord(): void {
    const id = this.info()?.patient?.id;
    if (id) window.open('/patients/' + encodeURIComponent(id), '_blank', 'noopener');
  }

  /** Report an RTC quality sample every 15s for back-office monitoring. */
  private startMetricsReport(): void {
    const report = async (): Promise<void> => {
      if (!this.client || !this.portalSignedIn()) return;
      let rtt: number | null = null;
      try {
        const stats = this.client.getRTCStats();
        rtt = stats?.RTT && stats.RTT > 0 ? Math.round(stats.RTT) : null;
      } catch {
        /* stats unavailable */
      }
      try {
        await this.noteFetch(
          `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/metrics`,
          { method: 'POST', body: JSON.stringify({ uplink: this.netUplink, downlink: this.netDownlink, rtt }) },
        );
      } catch {
        /* fire-and-forget */
      }
    };
    this.metricsTimer = setInterval(() => void report(), 15000);
  }

  // ---- Live transcription + AI copilot ----
  private detectSpeech(): boolean {
    const w = window as unknown as { SpeechRecognition?: SpeechRecCtor; webkitSpeechRecognition?: SpeechRecCtor };
    return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
  }

  private async loadCopilot(): Promise<void> {
    if (!this.appointmentId || !this.auth.isAuthenticated()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/copilot`,
        { method: 'GET' },
      );
      this.copilotConfigured.set(body.data?.configured === true);
      if (body.data?.draft) this.copilotDraft.set(body.data.draft);
    } catch {
      /* copilot unavailable */
    }
    await this.loadTranscript();
    this.ensureTranscriptPoll();
  }

  private async loadTranscript(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/transcript`,
        { method: 'GET' },
      );
      if (Array.isArray(body.data)) this.transcript.set(body.data);
    } catch {
      /* leave prior */
    }
  }

  private ensureTranscriptPoll(): void {
    if (this.transcriptPoll) return;
    this.transcriptPoll = setInterval(() => void this.loadTranscript(), 8000);
  }

  protected toggleTranscription(): void {
    if (this.transcribing()) {
      this.stopRecognition();
      return;
    }
    if (!this.aiConsent()) {
      this.copilotError.set(this.consentsError() || 'The patient has not granted AI-transcription consent.');
      return;
    }
    if (!this.speechSupported()) {
      this.copilotError.set('This browser does not support speech recognition.');
      return;
    }
    this.copilotError.set('');
    this.startRecognition();
  }

  private startRecognition(): void {
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
          if (text) this.postSegment(text);
        }
      }
    };
    rec.onend = () => {
      if (this.transcribing()) {
        try {
          rec.start();
        } catch {
          /* already restarting */
        }
      }
    };
    rec.onerror = () => {
      /* transient — onend will restart while transcribing */
    };
    this.recognition = rec;
    this.transcribing.set(true);
    try {
      rec.start();
    } catch {
      /* ignore double-start */
    }
    this.ensureTranscriptPoll();
  }

  private stopRecognition(): void {
    this.transcribing.set(false);
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
    this.recognition = undefined;
  }

  private postSegment(text: string): void {
    this.transcript.update((t) => [...t, { id: 'local-' + t.length, role: 'doctor', text, at: '' }]);
    void this.noteFetch(
      `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/transcript`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ).catch(() => undefined);
  }

  protected async generateDraft(): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn() || this.copilotBusy()) return;
    this.copilotError.set('');
    this.copilotBusy.set(true);
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/copilot/draft`,
        { method: 'POST' },
      );
      this.copilotDraft.set(body.data);
    } catch (err: unknown) {
      this.copilotError.set(apiErrorMessage(err, 'Could not generate a draft.'));
    } finally {
      this.copilotBusy.set(false);
    }
  }

  /** Carry the AI draft into the SOAP editor for the clinician to review + finalize. */
  protected useDraftInNote(): void {
    const d = this.copilotDraft();
    // Only into a loaded, editable note — never over one that failed to load.
    if (!d || !this.noteEditable()) return;
    if (d.subjective) this.subjective.set(d.subjective);
    if (d.objective) this.objective.set(d.objective);
    if (d.assessment) this.assessment.set(d.assessment);
    if (d.plan) this.plan.set(d.plan);
    this.notesTab.set('notes');
    this.scheduleSave();
  }

  private async teardown(): Promise<void> {
    this.left = true;
    this.releaseHold();
    clearTimeout(this.firstWaitTimer);
    // Says "out" at once, so schedules stop showing the doctor in the call.
    this.heartbeatStop?.();
    this.heartbeatStop = undefined;
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    if (this.timer) clearInterval(this.timer);
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.transcriptPoll) clearInterval(this.transcriptPoll);
    if (this.docsPoll) clearInterval(this.docsPoll);
    this.docsPoll = undefined;
    clearTimeout(this.docsChangeTimer);
    this.docsChangeTimer = undefined;
    this.docsRead?.unsubscribe();
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = undefined;
    clearTimeout(this.alertTimer);
    this.unbindNudge?.();
    this.unbindNudge = undefined;
    this.restoreTitle();
    if (this.renewRetry) clearTimeout(this.renewRetry);
    if (this.rosterRefreshTimer) clearTimeout(this.rosterRefreshTimer);
    this.heldBack.clear();
    this.stopRecognition();
    this.unbindRemotes?.();
    this.unbindRemotes = undefined;
    this.remotes.clear();
    try {
      this.micTrack?.close();
      this.camTrack?.close();
      this.screenTrack?.close();
      await this.client?.leave();
    } catch {
      /* releasing devices — nothing actionable on failure */
    }
    this.client = undefined;
    this.micTrack = undefined;
    this.camTrack = undefined;
    this.screenTrack = undefined;
  }

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

  private initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }

  ngOnDestroy(): void {
    void this.teardown();
  }
}
