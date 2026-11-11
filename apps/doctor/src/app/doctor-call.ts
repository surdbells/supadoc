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
  type TemplateRef,
  untracked,
  viewChild,
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
  type ApiRequestOptions,
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
  type MedicalCertificateDto,
  PATIENT_CALL_UID,
  type ReferralDto,
  type TranscriptSegmentDto,
  type VitalReadingDto,
} from '@supadoc/models';
import {
  buildCallTiles,
  type CallChoiceChange,
  type CallControl,
  type CallControlId,
  CallControlsComponent,
  CallQualityComponent,
  CallSelfTileComponent,
  type CallSelfViewMode,
  type CallSetting,
  CALL_SELF_VIEW_CLASS_DOCTOR,
  type CallTilesMode,
  CallTilesComponent,
  type CallTile,
  type CallVideoFit,
  type CallVideoTrack,
  type CallUid,
  callTilesMode,
  DialogComponent,
  DialogService,
  type LeaveCopy,
  IconComponent,
  type RemoteParticipant,
  RemoteParticipants,
  shortDayLabel,
} from '@supadoc/ui';
import { CallPeerTileComponent, DocumentViewerService, SHARE_COVER_TITLE, shareCoverText, SHOW_ANYWAY, STOP_SHARING } from '@supadoc/viewer';
import { CallLaunchers, CallWorkspace, type LauncherStatus, PeerHandover, type WorkspaceFlag, WorkspacePanel } from '@supadoc/call-workspace';
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
  LOAD_FAILED,
  type NewDocsState,
  nextRefreshDelay,
  NUDGE_DEBOUNCE_MS,
  NUDGE_MIN_INTERVAL_MS,
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
import { discardDraftsCopy, leaveCallCopy } from './call-workspace/call-leave-copy';
import { CallPatientRecord } from './call-workspace/call-patient-record';
import {
  STANDING_REFUSED,
  STANDING_TERMS,
  WS_CLOSE,
  WS_KICKER,
  WS_LAUNCHERS,
  WS_RECORD_SHOWN,
  WS_STATUS,
  WS_TAB_LIVE,
  WS_TAB_UNSAVED,
  WS_TAB_UNSENT,
  WS_TABS,
  WS_TOOLS_HINT,
  type WorkspaceTab,
  wsShareBanner,
} from './call-workspace/call-workspace-copy';
import { callHoldWanted, FIRST_WAIT_HOLD_MS } from './call-hold';
import { DoctorClock } from './doctor-clock';
import { focusAfterDialogs } from './focus-after-dialog';
import { CallLabRequests } from './lab/call-lab-requests';
import { RxPanel } from './prescriptions/rx-panel';
import {
  certificatePrompt,
  finalizeNotePrompt,
  carePlanPrompt,
  referralPrompt,
  STOP_RECORDING_PROMPT,
} from './appointment/clinical/clinical-prompts';
import { clinicalDocumentSource, patientDocumentSource, revokeUnshared, viewerWatermark } from './viewer/doctor-viewer-sources';

/** Load state of something the editor must not overwrite before it has loaded. */
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** Whether the note's save line signals a problem (the launcher reads the type, never the words). */
type NoteIssue = '' | 'failed' | 'device' | 'signed-out';
/** Narrow screens: the section under the video. */
type CallSection = 'notes' | 'patient' | 'documents' | 'people';
/** Mid screens: the side panel's tab. */
type SideTab = 'patient' | 'documents' | 'people';
/** Video size (the dock's Small / Medium / Large; Large by default). */
type VideoSize = 's' | 'm' | 'l';

/** The new-document alert hides after this long (the badge stays). */
const DOC_ALERT_MS = 15_000;
const VIDEO_SIZE_KEY = 'videomed.call.video-size';
/** The old "More room" switch: on means a small video. */
const OLD_MORE_ROOM_KEY = 'videomed.call.more-room';
const FIT_KEY = 'videomed.call.fit';
const SELF_KEY = 'videomed.call.self';
/** The dock's segmented settings: the video size and how the video fills the stage. */
const SIZE_OPTIONS = [
  { value: 's', label: 'Small', ariaLabel: 'Small video' },
  { value: 'm', label: 'Medium', ariaLabel: 'Medium video' },
  { value: 'l', label: 'Large', ariaLabel: 'Large video' },
] as const;
const FIT_OPTIONS = [
  { value: 'contain', label: 'Fit', ariaLabel: 'Fit whole picture' },
  { value: 'cover', label: 'Fill', ariaLabel: 'Fill the frame' },
] as const;
const CHART_OPEN_KEY = 'videomed.call.chart-open';
const CHART_SECTIONS: readonly string[] = ['vitals', 'conditions', 'medications', 'history'];
/**
 * The stage's height at wide and mid, per video size — at most: the dock's grid
 * row never takes the launcher card's height from the tools row (the row's
 * minimum), and the stage gives way first.
 */
const STAGE_HEIGHT: Record<VideoSize, string> = {
  l: 'clamp(320px, calc(100dvh - 16rem), 900px)',
  m: 'clamp(260px, calc(52dvh - 3rem), 640px)',
  s: 'clamp(200px, 32dvh, 360px)',
};
/** A phone held sideways: the controls become a rail beside the video (as in the patient's call). */
const RAIL_QUERY = '(orientation: landscape) and (max-height: 500px) and (max-width: 1023.98px)';
/**
 * The most of the screen's height the dock may take and still stick to the top
 * (narrow, held upright). Taller (its bar on three or four rows on a short
 * phone) it scrolls with the page, so the section under it keeps its room.
 */
const DOCK_STICKY_MAX = 0.6;
/**
 * The height of the rail's stage column (the video, and under it the
 * new-document alert while it shows), per video size. Fixed, so an alert takes
 * its room from the video: the dock and the rail never move and nothing below
 * shifts. Medium and Large fill the screen under the 48px top bar and any banner
 * (--rail-above, measured); they are alike below 1024px, as at narrow. Small
 * leaves the section switcher and the top of the notes in view. Never shorter
 * than one column of four 44px controls beside it (the rail packs its controls
 * and settings into columns of its height), so their bottoms line up: three 8px
 * gaps, py-2 and the border = 218px. The rail is given the same height.
 */
const RAIL_COLUMN: Record<VideoSize, string> = {
  l: 'h-[max(13.625rem,calc(100dvh_-_4.5rem_-_var(--rail-above,0px)))]',
  m: 'h-[max(13.625rem,calc(100dvh_-_4.5rem_-_var(--rail-above,0px)))]',
  s: 'h-[max(13.625rem,calc(100dvh_-_10rem_-_var(--rail-above,0px)))]',
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

/** The video size (Large unless chosen), migrating the old "More room" switch (on = small). */
function readVideoSize(): VideoSize {
  const size = readStored<VideoSize | ''>(VIDEO_SIZE_KEY, ['s', 'm', 'l'], '');
  if (size) return size;
  return readStored(OLD_MORE_ROOM_KEY, ['1', '0'], '0') === '1' ? 's' : 'l';
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

/** Follow-ups field label (Figma "Label": caption, 8px above the box, as doc-lab-select's label). Light: ink (theme.css remaps text-white/85). */
const CALL_LABEL = 'font-sans text-caption text-white/85';
/**
 * A Follow-ups field in the cockpit palette: the Figma select-field box (call-field: 38px, ≥3:1 edge,
 * AA placeholder), AA text, the ws-ring focus ring. NO `read-only:` variant here: a <select> always
 * matches :read-only (HTML: only mutable input/textarea and editing hosts are :read-write), so
 * `read-only:opacity-70` would dim every dropdown permanently. NO `placeholder:` utility: the
 * placeholder colour is a component rule (call-field), because white/35 is 3.19:1 dark and 3.00:1 light.
 */
const CALL_FIELD =
  'call-field ws-ring min-w-0 rounded-lg border bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white';
/** …as a native select: block (no line-box slack under it), no UA arrow (the chevron icon is drawn), room for it (8 + 20 + 8 = 36px). Options carry no class (NP1, tailwind/theme.css). */
const CALL_SELECT = `${CALL_FIELD} block w-full cursor-pointer appearance-none pr-9`;
/** The 20px chevron, 8px from the right, centred; decorative. */
const CALL_CHEVRON = 'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-white/70';
/** A Follow-ups validation or API error line: AA in both tones (call-error), announced (role="alert" in the markup). */
const CALL_ERROR = 'call-error font-sans text-caption';

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
 * first), call controls and the launchers of the consultation tools, which open
 * over the call in one large modal (the workspace, with the Full EMR), the
 * patient staying in view. Right: records and participants.
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
    CallPatientRecord,
    CallPeerTileComponent,
    CallLaunchers,
    CallWorkspace,
    WorkspacePanel,
    IconComponent,
    RequestAccessDialog,
    RxPanel,
    CallLabRequests,
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

      /* White on cerulean (about 4.8:1) for every solid cerulean button outside the dock:
         the light theme's global .text-white rule would make that text dark (about 2.6:1). */
      :host([data-theme='light']) .bg-cerulean.text-white { color: #ffffff; }

      /* The launcher card under the video (sd-call-launchers): its own height in the grid's tools row. */
      .ws-tools-start { align-self: start; }
      /* "View Full EMR" and the Full EMR cover's buttons. theme.css has no light remap for the frost outline: about 1.3:1 on the light cockpit. */
      .ws-ring:focus-visible { outline: 2px solid var(--color-frost); outline-offset: 2px; }
      :host([data-theme='light']) .ws-ring:focus-visible { outline-color: var(--color-cerulean); }
      /* Narrow pages scroll: room under the launchers for the fixed Feedback button (index.html). */
      .ws-tools-narrow { margin-bottom: 3rem; }
      /* The transcript in the workspace: its box scrolls, its offset is kept (data-ws-keep-scroll). */
      .ws-transcript { max-height: min(24rem, 45dvh); }

      /* Follow-ups fields: the Figma select field's 38px box; a >=3:1 edge in both tones (white/45 over
         the field's 4% fill: 4.38 on the field, 4.81 on abyss; light #78909c: 3.35 / 3.02); example
         placeholders at AA (white/60 6.71; slate 5.40). Unlayered: a min-h-* utility here would lose. */
      .call-field { min-height: 38px; border-color: rgb(255 255 255 / 0.45); }
      .call-field::placeholder { color: rgb(255 255 255 / 0.6); }
      :host([data-theme='light']) .call-field { border-color: #78909c; }
      :host([data-theme='light']) .call-field::placeholder { color: #546e7a; }
      /* A read-only Care Plan item: no fill, full-contrast text and edge (never opacity). Not a select: it is always :read-only. */
      .call-field:read-only:not(select) { background-color: transparent; }
      /* Error lines: 7.94 on abyss; alert-ink 5.92 on the light frame (text-alert is 4.29 / 3.81). */
      .call-error { color: #ff8a80; }
      :host([data-theme='light']) .call-error { color: var(--color-alert-ink); }
      /* "Create referral" / "Issue certificate": the field's height, so each lines up with the field beside it. */
      .call-row-btn { min-height: 38px; }
    `,
  ],
  template: `
    <!-- relative: contains absolutely positioned bits (e.g. screen-reader-only labels deep in
         the tools panel) so they can never make the desktop cockpit scroll as a page.
         A document opens in the shared viewer, a real modal: the cockpit is inert under it
         natively, and its call band (#viewerBar) keeps Back to call, Mute and End. -->
    <div class="relative flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <!-- Top bar: who, their allergies, how the call is going. Nothing here covers the video. -->
      <!-- A phone held sideways: one 48px row (the logo, "Encrypted" and "Secure call" give way). -->
      <header
        class="relative z-30 flex shrink-0 items-center gap-x-2 gap-y-1 border-b border-white/10 px-2 sm:px-4"
        [class]="rail() ? 'h-12 flex-nowrap' : 'min-h-14 flex-wrap py-1.5'"
      >
        <!-- Leaves without ending: the visit stays open and the doctor can rejoin. -->
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
          aria-label="Leave the call without ending it (you can rejoin)"
          (click)="leave()"
        >
          <sd-icon name="arrow-left" [size]="20" />
        </button>
        @if (!rail()) {
          <span class="hidden shrink-0 font-heading text-h5 tracking-tight sm:inline">
            <span class="text-frost">Video</span><span class="text-sage">Med</span>
          </span>
        }
        <p class="min-w-0 flex-1 basis-28 truncate font-sans text-body-sm font-semibold text-white">
          {{ headerPatient() }}
          @if (headerPatientTime(); as pt) {
            <span class="hidden font-normal text-white/70 2xl:inline"> · {{ pt }}</span>
          }
        </p>
        <!-- Allergies: always in view (the full list for screen readers, truncated on screen). -->
        @if (allergyNames().length) {
          <span class="sd-chip sd-tone-danger [--sd-chip-ring:rgb(229_57_53/0.6)] min-w-0 max-w-[9rem] sm:max-w-[18rem]">
            <sd-icon name="triangle-alert" [size]="14" class="shrink-0 text-alert" />
            <span class="truncate" aria-hidden="true">Allergies: {{ allergyNames().join(', ') }}</span>
            <span class="sr-only">Allergies: {{ allergyNames().join(', ') }}</span>
          </span>
        } @else if (info()?.patient) {
          <span class="shrink-0 font-sans text-caption text-white/70">No known allergies</span>
        }
        <span role="timer" class="sd-chip sd-tone-neutral">
          <span class="size-1.5 rounded-full bg-alert" aria-hidden="true"></span>
          @if (!rail()) {
            <span class="hidden sm:inline">Secure call ·</span>
          }
          <span class="font-label tabular-nums">{{ elapsedLabel() }}</span>
        </span>
        <sd-call-quality class="shrink-0" [quality]="quality()" />
        @if (!rail()) {
          <span class="hidden shrink-0 items-center gap-1 font-sans text-caption text-white/70 md:inline-flex">
            <sd-icon name="lock" [size]="14" />Encrypted
          </span>
        }
        <div class="relative shrink-0">
          <button
            #peopleButton
            type="button"
            class="sd-pill sd-pill-c sd-action"
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
            <span class="sd-chip bg-alert/20 text-white">
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
      <!-- The banners under the top bar, measured: a phone held sideways takes their
           height (--rail-above) from the rail's stage column, so the dock still fits. -->
      <div #banners class="shrink-0">
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
      </div>

      <!-- Cockpit. DOM order = reading order: the video, the tools, then the chart,
           records and participants (grid areas place them; never order-*). -->
      <main [class]="gridClass()" [style.--stage-h]="stageHeight()" [style.--stage-max]="stageMax()">
        <!-- ===================== DOCK: the video and its controls =====================
             A column (the controls under the video); on a phone held sideways a row,
             not sticky: the video, then the controls as a rail beside it. -->
        <section #dock class="sd-dock flex min-w-0 gap-2" [class]="dockClass()" aria-label="Video call">
          <!-- The stage's column beside the rail (display: contents otherwise): a fixed
               height, the video filling what the new-document alert under it leaves.
               Never inside an @if: the tiles keep the tracks handed to them. -->
          <div [class]="stageColumnClass()">
            <div
              class="sd-stage relative overflow-hidden rounded-card bg-ink [container-name:stage] [container-type:size] motion-reduce:transition-none"
              [class]="stageClass()"
            >
              <!-- One tile per person, keyed by Agora uid: 1:1 the patient (or whoever is
                   there) fills the stage (cover) unless "Fit" (the whole picture) is chosen;
                   from a third person an even grid. The doctor's own camera is the PiP from
                   640px up and on a phone held sideways; on a phone held upright it is a
                   small tile at the start of the control row. -->
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
            <!-- A phone held sideways: the new-document alert under the video, beside the
                 rail. Floating at the bottom it would cover the video and the rail's End;
                 above the dock it would push the rail off the screen. -->
            @if (rail() && docAlertView()) {
              <div class="mt-2 min-w-0">
                <ng-container [ngTemplateOutlet]="docAlertTpl" />
              </div>
            }
          </div>

          @if (status() === 'in-call') {
            <!-- The controls sit under the video (a rail beside it on a phone held
                 sideways), never on it. The self tile only on a phone held upright. -->
            <div [class]="controlRowClass()">
              @if (selfMode() === 'external' && selfTile(); as st) {
                <sd-call-self-tile [tile]="st" [track]="selfTrack()" [playConfig]="selfPlayConfig()" />
              }
              <div [class]="controlsBoxClass()">
                <sd-call-controls
                  [controls]="controls()"
                  [settings]="settings()"
                  [layout]="rail() ? 'rail' : 'bar'"
                  ariaLabel="Call controls"
                  (pressed)="onControl($event)"
                  (choiceChange)="onChoice($event)"
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
                  <span class="sd-count">{{ newDocCount() }}<span class="sr-only"> new</span></span>
                }
                @if (section() === s.key) {
                  <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                }
              </button>
            }
          </div>
        }

        <!-- ===================== CONSULTATION TOOLS =====================
             The launcher card: each opens the workspace (a modal over the call) on its tool. -->
        <section
          id="call-tools"
          class="flex min-w-0 flex-col rounded-card border border-white/10 bg-white/[0.03] p-3"
          [class]="toolsClass()"
          [hidden]="layout() === 'narrow' && section() !== 'notes'"
          [attr.role]="layout() === 'narrow' ? 'tabpanel' : null"
          [attr.aria-labelledby]="layout() === 'narrow' ? 'call-section-notes' : 'call-tools-heading'"
        >
          <div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1">
            <h3 id="call-tools-heading" tabindex="-1" class="font-sans text-body-sm font-semibold text-white outline-none">Consultation tools</h3>
            <p class="font-sans text-caption text-white/70">{{ toolsHint() }}</p>
          </div>
          <!-- The shared launcher list: a status line only when there is one, its height reserved
               otherwise, so each label sits centred on its icon and the row never jumps. -->
          <sd-call-launchers [items]="wsLaunchers" [statuses]="launcherStatus()" [tone]="theme()" (opened)="openWorkspace($event.key, $event.opener)" />
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
                    <span class="sd-count">{{ newDocCount() }}<span class="sr-only"> new</span></span>
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
                                  class="sd-chip"
                                  [class]="v.flag.level === 'high' || v.flag.level === 'critical' ? 'sd-tone-danger' : 'sd-tone-warning'"
                                >{{ v.flag.label }}</span>
                              }
                              @if (v.recorded_by === 'patient') {
                                <span class="sd-chip sd-tone-info">Self-reported</span>
                              }
                              @if (v.stale) {
                                <span class="sd-chip sd-tone-warning">Out of date</span>
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
                class="ws-ring flex min-h-11 items-center justify-center gap-2 rounded-field border border-white/15 py-2.5 font-sans text-body-sm font-semibold text-white/85 transition-colors hover:bg-white/10"
                aria-haspopup="dialog"
                data-ws-launcher="record"
                (click)="openWorkspace('record', $event.currentTarget)"
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
                  <span class="sd-chip sd-tone-info">{{ newDocCount() }} new</span>
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
                <div class="sd-pill-row-wrap mb-3 mt-3" role="group" aria-label="Show">
                  @for (t of recordsTabs; track t.key) {
                    <button
                      type="button"
                      class="sd-pill sd-pill-s sd-filter-solid"
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
                                <span class="sd-chip sd-tone-info">New</span>
                              }
                            </span>
                            <span class="truncate font-sans text-caption text-white/70">{{ d.type_label }} · {{ d.extension.toUpperCase() }} · {{ d.size_label }}</span>
                            <span class="truncate font-sans text-caption text-white/70">{{ sharedAgo(d) }}</span>
                            @if (d.viewable === false) {
                              <span class="font-sans text-caption text-white/70">Preview not available</span>
                            }
                          </span>
                          <span class="sd-chip" [class]="d.uploader_role === 'patient' ? 'sd-tone-success' : 'sd-tone-info'">{{ d.uploader_role === 'patient' ? 'Patient' : 'Clinician' }}</span>
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

    <!-- The consultation tools and the Full EMR, in one large modal over the cockpit (the
         call band on top, the patient's live video as its picture-in-picture). The panels
         stay declared here and are projected into it: each is mounted the first time it
         shows, then only hidden, so closing it destroys no draft, list or drill-in. -->
    <sd-call-workspace
      #ws
      [open]="wsOpen()"
      [(tab)]="wsTab"
      [tabs]="wsTabs"
      [band]="viewerBar"
      [peer]="workspacePeer"
      [peerName]="patientName()"
      [title]="patientName()"
      [kicker]="wsKicker"
      [closeLabel]="wsClose"
      [meta]="patientMeta()"
      [allergies]="allergyNames()"
      [sharing]="screenOn()"
      [shareText]="wsShareText()"
      [shareBanner]="screenOn() && !(wsTab() === 'record' && recordCovered())"
      [tone]="theme()"
      [flags]="wsFlags()"
      (closed)="closeWorkspace()"
      (afterClose)="onWorkspaceClosed()"
      (stopSharing)="stopSharingFromWorkspace()"
    >
      @if (wsSeen().has('notes')) {
        <div sdWsPanel="notes">
          <!-- Documentation header: status + auto-save + finalize -->
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="font-sans text-body-sm font-semibold text-white">SOAP Note</span>
              @if (noteFinalized()) {
                <span class="sd-chip sd-tone-success">
                  <sd-icon name="lock" [size]="14" /> Signed &amp; locked
                </span>
              } @else {
                <span class="sd-chip sd-tone-neutral">Draft</span>
              }
            </div>
            <div class="flex items-center gap-3">
              @if (noteSaved()) {
                <span class="font-sans text-caption text-white/45">{{ noteSaved() }}</span>
              }
              @if (!noteFinalized() && canDocument()) {
                <button
                  type="button"
                  class="sd-pill sd-pill-c bg-cerulean text-white hover:bg-cerulean-dark"
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
                class="sd-pill sd-pill-c w-fit shrink-0 bg-cerulean text-white hover:bg-cerulean-dark"
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
                class="sd-pill sd-pill-c [--sd-fw:400] border border-white/15 text-white/85 hover:bg-white/10"
                (click)="retryLoadNote()"
              >
                <sd-icon name="refresh-cw" [size]="14" /> Try again
              </button>
            </div>
          } @else if (noteError()) {
            <p class="mb-3 font-sans text-caption text-alert">{{ noteError() }}</p>
          }

          <div class="grid gap-4 lg:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-white/60">Subjective</span>
              <textarea
                rows="5"
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
                rows="5"
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
                rows="5"
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
                rows="5"
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
            <div class="sd-pill-row-wrap" role="group" aria-labelledby="call-tools-label">
              @for (tool of tools; track tool.label) {
                <button
                  type="button"
                  class="sd-pill sd-pill-c sd-action"
                  (click)="useTool(tool.label)"
                >
                  <sd-icon [name]="tool.icon" [size]="14" class="text-frost" />{{ tool.label }}
                </button>
              }
            </div>
            @if (toolNote()) {
              <p class="mt-2 font-sans text-caption text-white/45">{{ toolNote() }}</p>
            }
          </div>
        </div>
      }
      @if (wsSeen().has('prescriptions')) {
        <div sdWsPanel="prescriptions">
          <!-- Until the prescribing panel is mounted: why, or that it is on its way. -->
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
                class="sd-pill sd-pill-c [--sd-fw:400] border border-white/15 text-white/80 hover:bg-white/10"
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
          <!-- Prescribing panel. Once opened it stays mounted for the rest of
               the call — hidden on the other tabs, kept while the portal
               session is signed out — so a half-written prescription is
               never thrown away by a tab switch or a re-sign-in. -->
          @if (rxMounted() && rxPatientId(); as pid) {
            <div>
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
                    class="sd-pill sd-pill-c w-fit shrink-0 bg-cerulean text-white hover:bg-cerulean-dark"
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
                  [compact]="ws.narrow()"
                  [disabled]="!portalSignedIn()"
                  [composeRequest]="rxComposeSeq()"
                />
              </div>
            </div>
          }
        </div>
      }
      @if (wsSeen().has('labs')) {
        <div sdWsPanel="labs">
          @if (!portalSignedIn()) {
            @if (labComposing()) {
              <div class="mb-3 flex flex-col gap-2 rounded-2xl bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                <span class="flex items-start gap-2 font-sans text-caption text-warning">
                  <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                  <span>
                    You are signed out of the doctor portal. Your lab request is kept here —
                    sign in again in a new tab (this call keeps going), then come back to send it.
                  </span>
                </span>
                <button
                  type="button"
                  class="sd-pill sd-pill-c w-fit shrink-0 bg-cerulean text-white hover:bg-cerulean-dark"
                  (click)="openPortalSignIn()"
                >
                  <sd-icon name="external-link" [size]="14" /> Sign in again
                </button>
              </div>
            } @else {
              <div class="flex flex-col items-center gap-3 px-2 py-8 text-center">
                <span class="flex size-14 items-center justify-center rounded-full bg-white/[0.06] text-frost">
                  <sd-icon name="lock" [size]="24" />
                </span>
                <p class="max-w-sm font-sans text-body-sm font-semibold text-white">
                  Sign in to the doctor portal to request lab tests
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
            }
          }
          <!-- Light "paper" surface, as Prescriptions: the list, the composer (in place, never a new
               tab), its dialogs and the drill-in use the portal palette. Mounted for the rest of the
               call once shown; hidden (never destroyed) while signed out without a request in progress. -->
          <div class="sd-rx-zone rounded-card bg-glacier p-3 text-ink sm:p-4" [hidden]="!portalSignedIn() && !labComposing()">
            <doc-call-lab-requests
              [appointmentId]="rxAppointmentId()"
              [patientId]="rxPatientId() ?? null"
              [patientError]="rxPatientError()"
              [detailsFailed]="status() === 'error' && !info()"
              [signedIn]="portalSignedIn()"
              [watermark]="watermark()"
              [sharing]="screenOn()"
              [active]="wsOpen() && wsTab() === 'labs'"
              [composeRequest]="labComposeSeq()"
              (retryPatient)="retryRxPatient()"
            />
          </div>
        </div>
      }
      @if (wsSeen().has('followup')) {
        <div sdWsPanel="followup">
          @if (followUpMounted() && rxAppointmentId(); as apptId) {
            <div class="mb-4">
              @if (!portalSignedIn()) {
                <div class="mb-3 flex flex-col gap-2 rounded-2xl bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                  <span class="flex items-start gap-2 font-sans text-caption text-warning">
                    <sd-icon name="lock" [size]="14" class="mt-0.5 shrink-0" />
                    <span>You are signed out of the doctor portal. Sign in again in a new tab (this call keeps going) to propose or withdraw a follow-up, or edit the care plan.</span>
                  </span>
                  <button
                    type="button"
                    class="sd-pill sd-pill-c w-fit shrink-0 bg-cerulean text-white hover:bg-cerulean-dark"
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
                  [active]="wsOpen() && wsTab() === 'followup'"
                  [linkRecord]="false"
                />
              </div>
            </div>
          }
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
                  class="sd-pill sd-pill-c w-fit shrink-0 bg-cerulean text-white hover:bg-cerulean-dark"
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
            <h3 class="font-sans text-body-sm font-semibold text-white">Care Plan</h3>
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
                class="sd-pill sd-pill-c [--sd-fw:400] border border-white/15 text-white/85 hover:bg-white/10"
                (click)="retryLoadCarePlan()"
              >
                <sd-icon name="refresh-cw" [size]="14" /> Try again
              </button>
            </div>
          }
          <div class="flex flex-col gap-2">
            @for (item of carePlanItems(); track $index) {
              <div class="flex items-center gap-2">
                <sd-icon name="circle-check" [size]="16" class="shrink-0 text-sage" />
                <input
                  placeholder="e.g. Monitor blood pressure daily"
                  class="${CALL_FIELD} flex-1"
                  [attr.aria-label]="'Care plan item ' + ($index + 1)"
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
            <div class="sd-pill-row-wrap mt-1">
              <button
                type="button"
                class="sd-pill sd-pill-c [--sd-fw:400] border border-white/15 text-white/80 hover:bg-white/10"
                [disabled]="!carePlanEditable()"
                (click)="addCareItem()"
              >
                <sd-icon name="plus" [size]="14" /> Add item
              </button>
              <button
                type="button"
                class="sd-pill sd-pill-c bg-cerulean text-white hover:bg-cerulean-dark"
                [disabled]="carePlanBusy() || !carePlanEditable()"
                (click)="saveCarePlan()"
              >
                <sd-icon name="check" [size]="14" /> Save &amp; publish
              </button>
            </div>
            @if (carePlanError() && carePlanLoad() !== 'error') {
              <p role="alert" class="${CALL_ERROR}">{{ carePlanError() }}</p>
            }
          </div>

          <!-- Referral -->
          <!-- Every field is labelled (Figma select field: label, 8px, then the 38px box); options carry no
               class (NP1). Two fields share a row only when the section is 28rem wide (its own width, not
               the viewport's: the PiP gutter narrows the panel). -->
          <div id="call-referral" class="@container mt-4 scroll-mt-4 border-t border-white/10 pt-3">
            <h3 data-ws-focus tabindex="-1" class="mb-2 font-sans text-body-sm font-semibold text-white outline-none">Referral</h3>
            <div class="grid grid-cols-1 gap-x-6 gap-y-3 @md:grid-cols-2">
              <div class="flex min-w-0 flex-col gap-2">
                <label for="call-ref-type" class="${CALL_LABEL}">Referral type</label>
                <div class="relative">
                  <select id="call-ref-type" class="${CALL_SELECT}" [value]="refType()" (change)="refType.set($any($event.target).value)">
                    <option value="specialist">Specialist</option>
                    <option value="hospital">Hospital</option>
                    <option value="laboratory">Laboratory</option>
                    <option value="imaging">Imaging</option>
                  </select>
                  <sd-icon name="chevron-down" [size]="20" aria-hidden="true" class="${CALL_CHEVRON}" />
                </div>
              </div>
              <div class="flex min-w-0 flex-col gap-2">
                <label for="call-ref-target" class="${CALL_LABEL}">Refer to <span aria-hidden="true">*</span></label>
                <input id="call-ref-target" aria-required="true" placeholder="e.g. Cardiology" class="${CALL_FIELD}"
                  [attr.aria-invalid]="refError() && !refTarget().trim() ? 'true' : null" [attr.aria-describedby]="refError() ? 'call-ref-error' : null"
                  [value]="refTarget()" (input)="refTarget.set($any($event.target).value)" />
              </div>
            </div>
            <div class="mt-3 flex min-w-0 flex-col gap-2">
              <label for="call-ref-reason" class="${CALL_LABEL}">Reason for referral <span aria-hidden="true">*</span></label>
              <input id="call-ref-reason" aria-required="true" placeholder="e.g. Persistent chest pain" class="${CALL_FIELD} w-full"
                [attr.aria-invalid]="refError() && !refReason().trim() ? 'true' : null" [attr.aria-describedby]="refError() ? 'call-ref-error' : null"
                [value]="refReason()" (input)="refReason.set($any($event.target).value)" />
            </div>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <div class="flex w-40 flex-col gap-2">
                <label for="call-ref-priority" class="${CALL_LABEL}">Priority</label>
                <div class="relative">
                  <select id="call-ref-priority" class="${CALL_SELECT}" [value]="refPriority()" (change)="refPriority.set($any($event.target).value)">
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                  </select>
                  <sd-icon name="chevron-down" [size]="20" aria-hidden="true" class="${CALL_CHEVRON}" />
                </div>
              </div>
              <button type="button"
                class="call-row-btn flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                [disabled]="refBusy() || !canDocument()" (click)="createReferral()">
                <sd-icon name="check" [size]="14" /> {{ refBusy() ? 'Creating…' : 'Create referral' }}
              </button>
            </div>
            @if (refError()) {
              <p id="call-ref-error" role="alert" class="mt-1 ${CALL_ERROR}">{{ refError() }}</p>
            }
            @if (referrals().length) {
              <ul class="mt-3 flex flex-col gap-2">
                @for (r of referrals(); track r.id) {
                  <li class="flex flex-wrap items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                    <div class="min-w-0 flex-1">
                      <p class="font-sans text-body-sm text-white/85">
                        <span class="capitalize">{{ r.referral_type }}</span> → {{ r.target }}
                        @if (r.priority === 'urgent') {
                          <span class="sd-chip sd-chip-xs sd-tone-danger ml-1">Urgent</span>
                        }
                      </p>
                      <p class="font-sans text-caption text-white/50">{{ r.reason }}</p>
                    </div>
                    <button type="button" class="${ALERT_BUTTON}" [attr.aria-label]="'View PDF of the referral to ' + r.target" (click)="openClinicalDoc('referral', r, $event.currentTarget)">
                      <sd-icon name="file-text" [size]="14" />View PDF
                    </button>
                  </li>
                }
              </ul>
            }
          </div>

          <!-- Certificate -->
          <div id="call-certificate" class="@container mt-4 scroll-mt-4 border-t border-white/10 pt-3">
            <h3 data-ws-focus tabindex="-1" class="mb-2 font-sans text-body-sm font-semibold text-white outline-none">Medical Certificate</h3>
            <div class="grid grid-cols-1 gap-x-6 gap-y-3 @md:grid-cols-2">
              <div class="flex min-w-0 flex-col gap-2">
                <label for="call-cert-type" class="${CALL_LABEL}">Certificate type</label>
                <div class="relative">
                  <select id="call-cert-type" class="${CALL_SELECT}" [value]="certType()" (change)="certType.set($any($event.target).value)">
                    <option value="sick_leave">Sick leave</option>
                    <option value="fitness">Fitness / return to work</option>
                    <option value="general">General</option>
                  </select>
                  <sd-icon name="chevron-down" [size]="20" aria-hidden="true" class="${CALL_CHEVRON}" />
                </div>
              </div>
              <div class="flex min-w-0 flex-col gap-2">
                <label for="call-cert-diagnosis" class="${CALL_LABEL}">Diagnosis (optional)</label>
                <input id="call-cert-diagnosis" placeholder="e.g. Acute bronchitis" class="${CALL_FIELD}"
                  [value]="certDiagnosis()" (input)="certDiagnosis.set($any($event.target).value)" />
              </div>
            </div>
            @if (certType() === 'sick_leave') {
              <!-- Named like the portal's form and the error "Set the leave period."; two columns at every width. -->
              <fieldset class="mt-3">
                <legend class="${CALL_LABEL}">Leave period <span aria-hidden="true">*</span></legend>
                <div class="mt-2 grid grid-cols-2 gap-3">
                  <label class="flex min-w-0 flex-col gap-2"><span class="${CALL_LABEL}">From</span>
                    <input type="date" aria-required="true" class="${CALL_FIELD}" [min]="certMinFrom()"
                      [attr.aria-invalid]="certError() && !certFrom() ? 'true' : null" [attr.aria-describedby]="certError() ? 'call-cert-error' : null" [value]="certFrom()" (input)="certFrom.set($any($event.target).value)" /></label>
                  <label class="flex min-w-0 flex-col gap-2"><span class="${CALL_LABEL}">To</span>
                    <input type="date" aria-required="true" class="${CALL_FIELD}" [min]="certFrom() || certMinFrom()"
                      [attr.aria-invalid]="certError() && !certTo() ? 'true' : null" [attr.aria-describedby]="certError() ? 'call-cert-error' : null" [value]="certTo()" (input)="certTo.set($any($event.target).value)" /></label>
                </div>
              </fieldset>
            }
            <div class="mt-3 flex min-w-0 flex-col gap-2">
              <label for="call-cert-statement" class="${CALL_LABEL}">Certifying statement <span aria-hidden="true">*</span></label>
              <textarea id="call-cert-statement" rows="2" aria-required="true" placeholder="e.g. Unfit for work and requires rest"
                class="${CALL_FIELD} w-full resize-y"
                [attr.aria-invalid]="certError() && !certStatement().trim() ? 'true' : null" [attr.aria-describedby]="certError() ? 'call-cert-error' : null"
                [value]="certStatement()" (input)="certStatement.set($any($event.target).value)"></textarea>
            </div>
            <div class="mt-3 flex items-center gap-2">
              <button type="button"
                class="call-row-btn flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                [disabled]="certBusy() || !canDocument()" (click)="issueCertificate()">
                <sd-icon name="check" [size]="14" /> {{ certBusy() ? 'Issuing…' : 'Issue certificate' }}
              </button>
            </div>
            @if (certError()) {
              <p id="call-cert-error" role="alert" class="mt-1 ${CALL_ERROR}">{{ certError() }}</p>
            }
            @if (issuedCerts().length) {
              <ul class="mt-3 flex flex-col gap-2">
                @for (c of issuedCerts(); track c.id) {
                  <li class="flex flex-wrap items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                    <div class="min-w-0 flex-1">
                      <p class="font-sans text-body-sm text-white/85">{{ c.type_label }}</p>
                      @if (c.from_date && c.to_date) {
                        <p class="font-sans text-caption text-white/50">{{ c.from_date }} → {{ c.to_date }}</p>
                      }
                    </div>
                    <button type="button" class="${ALERT_BUTTON}" [attr.aria-label]="'View PDF of ' + c.type_label" (click)="openClinicalDoc('certificate', c, $event.currentTarget)">
                      <sd-icon name="file-text" [size]="14" />View PDF
                    </button>
                  </li>
                }
              </ul>
            }
          </div>
        </div>
      }
      @if (wsSeen().has('copilot')) {
        <div sdWsPanel="copilot">
          <!-- Live transcription -->
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span class="font-sans text-body-sm font-semibold text-white">Live transcription</span>
            <!-- "Stop" takes the danger tone's pair (pills.css): text-alert on alert/20 was 3.4:1 dark, 3.2:1 light. -->
            <button
              type="button"
              class="sd-pill sd-pill-c"
              [class]="transcribing() ? 'bg-(--sd-tone-danger-bg) text-(--sd-tone-danger-fg) hover:bg-alert/20' : 'bg-cerulean text-white hover:bg-cerulean-dark'"
              [disabled]="!canDocument() || (!transcribing() && (!aiConsent() || !speechSupported()))"
              (click)="toggleTranscription()"
            >
              <!-- The 8px dot in the pill's 14px icon slot, so the label sits as beside any icon. -->
              <svg viewBox="0 0 14 14" aria-hidden="true" [class]="transcribing() ? 'animate-pulse text-alert' : 'opacity-70'"><circle cx="7" cy="7" r="4" fill="currentColor" /></svg>
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

          <div data-ws-keep-scroll="transcript" class="ws-transcript overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.03] p-3">
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
                  class="sd-pill sd-pill-c bg-cerulean text-white hover:bg-cerulean-dark"
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
                      <span class="sd-chip sd-chip-xs sd-tag sd-tone-neutral">{{ x }}</span>
                    }
                    @for (x of d.medications; track x) {
                      <span class="sd-chip sd-chip-xs sd-tag sd-tone-info">{{ x }}</span>
                    }
                  </div>
                }
                <button
                  type="button"
                  class="sd-pill sd-pill-c [--sd-fw:400] mt-3 border border-white/15 text-white/85 hover:bg-white/10"
                  [disabled]="!noteEditable()"
                  (click)="useDraftInNote()"
                >
                  <sd-icon name="arrow-right" [size]="14" /> Use in SOAP note
                </button>
              </div>
            }
          </div>
        </div>
      }
      @if (wsSeen().has('record')) {
        <div sdWsPanel="record">
          <!-- Covered while the doctor shares their screen, like a view-only document. -->
          @if (recordCovered()) {
            <div class="mx-auto mt-6 flex max-w-md flex-col items-center gap-3 rounded-card border border-white/10 bg-white/[0.04] px-6 py-6 text-center" role="group" aria-labelledby="ws-cover-title">
              <sd-icon name="eye-off" [size]="28" class="text-white/70" />
              <p id="ws-cover-title" class="font-sans text-body-sm font-semibold text-white">{{ shareCoverTitle }}</p>
              <p class="font-sans text-caption text-white/70">{{ shareCover(recordingActive()) }}</p>
              <div class="flex flex-wrap justify-center gap-2">
                <button type="button" class="ws-ring min-h-11 rounded-field bg-cerulean px-4 font-sans text-body-sm font-semibold text-white hover:bg-cerulean-dark" (click)="stopSharingFromWorkspace()">{{ stopSharingLabel }}</button>
                <button type="button" class="ws-ring min-h-11 rounded-field border border-white/15 px-4 font-sans text-body-sm font-semibold text-white hover:bg-white/10" (click)="revealRecord()">{{ showAnyway }}</button>
              </div>
            </div>
          }
          <div [hidden]="recordCovered()">
            <doc-call-patient-record
              [patientId]="rxPatientId() ?? null"
              [currentAppointmentId]="rxAppointmentId()"
              [signedIn]="portalSignedIn()"
              [active]="wsOpen() && wsTab() === 'record'"
              [documents]="allSharedDocs()"
              [documentsState]="recordDocsState()"
              [patientError]="rxPatientError()"
              [detailsFailed]="status() === 'error' && !info()"
              (openDocument)="openPatientDoc($event.doc, $event.opener, allSharedDocs())"
              (retryDocuments)="retryDocumentAccess()"
              (retryPatient)="retryRxPatient()"
              (goTo)="selectWorkspaceTab($event)"
              (writePrescription)="openRxComposer()"
              (newLabRequest)="openLabComposer()"
              (signIn)="openPortalSignIn()"
            />
          </div>
        </div>
      }
    </sd-call-workspace>

    <!-- The one live region for documents ("Request sent.", "Ada shared a new document…").
         Outside every panel that can be hidden (the records aside at mid and narrow), so it
         is always read out — except under the document viewer (a modal: the page is inert),
         where the call band says the same (#viewerBar). -->
    <p class="sr-only" aria-live="polite">{{ docAnnounce() }}</p>

    <!-- Narrow screens: the new-document alert floats at the bottom (never over the video:
         the dock is above it). Held sideways it is under the video, beside the rail, instead. -->
    @if (floatAlert()) {
      <!-- Dark in both cockpit themes, like the dock it belongs to. -->
      <div class="sd-dock">
        <ng-container [ngTemplateOutlet]="docAlertTpl" />
      </div>
    }

    <!-- The call band of the workspace and of the shared document viewer (registered with it
         in afterNextRender): rendered above their content while this call page lives, always
         dark (.sd-dock in the workspace, .sd-call[data-theme=dark] in the viewer). Under a modal
         the cockpit is inert and its live regions silent, so this mirrors every call-level
         banner and live region, with its action. Back to call, then who and how long, Mute and
         End, then the alerts row. -->
    <ng-template #viewerBar>
      <button
        type="button"
        class="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-field px-2 font-sans text-body-sm font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-frost"
        aria-label="Back to call"
        (click)="backToCall()"
      >
        <sd-icon name="arrow-left" [size]="18" /><span class="hidden sm:inline" data-band-label>Back to call</span>
      </button>
      <span class="min-w-0 flex-1 truncate font-sans text-caption text-white/70">{{ patientName() }} · <span class="font-label tabular-nums">{{ elapsedLabel() }}</span></span>
      <span role="status" class="shrink-0">
        @if (recordingActive()) {
          <span class="sd-chip bg-alert/20 text-white">
            <span class="size-2 rounded-full bg-alert motion-safe:animate-pulse"></span>Recording
          </span>
        }
      </span>
      @if (inLive()) {
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-frost"
          [class]="micOn() ? 'bg-white/10 hover:bg-white/20' : 'bg-alert hover:bg-alert/85'"
          [attr.aria-label]="micOn() ? 'Mute' : 'Unmute'"
          (click)="toggleMic()"
        >
          <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="18" />
        </button>
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-full bg-alert transition-colors hover:bg-alert/85 focus-visible:outline-2 focus-visible:outline-frost"
          aria-label="End consultation"
          (click)="endFromViewer()"
        >
          <sd-icon name="phone-off" [size]="18" />
        </button>
      }
      <!-- The alerts row (wraps under the controls); only while there is one. -->
      @if (bandAlerts()) {
      <div class="flex w-full flex-col gap-1">
        <!-- Still joining (records open before Agora has joined), or the join failed: the
             stage's own status and error (with its ways out) are inert under the viewer. -->
        @if (status() === 'loading') {
          <p class="flex items-center gap-1.5 font-sans text-caption text-white/80" role="status">
            <sd-icon name="loader-circle" [size]="14" class="shrink-0 motion-safe:animate-spin" />Connecting to the consultation…
          </p>
        } @else if (status() === 'error') {
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1" role="alert">
            <span class="flex items-center gap-1.5 font-sans text-caption text-warning">
              <sd-icon name="circle-alert" [size]="14" class="shrink-0" />{{ errorMessage() }}
            </span>
            @if (joinStanding(); as code) {
              <button
                type="button"
                class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
                (click)="standingFromViewer()"
              >
                {{ code === 'terms_required' ? 'Read and accept the terms' : 'See your account status' }}
              </button>
            }
            <button
              type="button"
              class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
              (click)="scheduleFromViewer()"
            >
              Back to schedule
            </button>
          </div>
        }
        @if (recordingError()) {
          <p class="font-sans text-caption text-white" role="alert">{{ recordingError() }}</p>
        }
        @if (callClosed()) {
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1" role="alert">
            <span class="flex items-center gap-1.5 font-sans text-caption text-warning">
              <sd-icon name="circle-alert" [size]="14" class="shrink-0" />{{ callClosed() }}
            </span>
            @if (joinStanding(); as code) {
              <button
                type="button"
                class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
                (click)="standingFromViewer()"
              >
                {{ code === 'terms_required' ? 'Read and accept the terms' : 'See your account status' }}
              </button>
            }
            <button
              type="button"
              class="min-h-11 rounded-field px-3 font-sans text-caption font-semibold text-white underline underline-offset-2 transition-colors hover:text-white/80"
              (click)="leaveFromViewer()"
            >
              Leave the call
            </button>
          </div>
        } @else if (rejoining() || connectionLost()) {
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1" role="alert">
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
        @if (peerLeft()) {
          <p class="font-sans text-caption text-white/80" aria-hidden="true">{{ patientName() }} left the call</p>
        }
        @if (docAlertView(); as al) {
          <!-- The new-document alert: its View replaces the open document (focus goes to its title). -->
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1"
            role="status"
            (mouseenter)="holdAlert(true)"
            (mouseleave)="holdAlert(false)"
            (focusin)="holdAlert(true)"
            (focusout)="holdAlert(false)"
          >
            <span class="flex min-w-0 items-center gap-1.5 font-sans text-caption font-semibold text-white">
              <sd-icon name="bell" [size]="14" class="shrink-0 text-frost" /><span class="truncate">{{ al.title }}</span>
            </span>
            @if (al.detail) {
              <span class="min-w-0 truncate font-sans text-caption text-white/80">{{ al.detail }}</span>
            }
            @if (al.signedOut) {
              <button type="button" class="${ALERT_BUTTON}" (click)="openPortalSignIn()">
                <sd-icon name="external-link" [size]="14" />Sign in
              </button>
            } @else if (al.doc; as doc) {
              @if (doc.viewable !== false) {
                <button type="button" class="${ALERT_BUTTON}" (click)="openPatientDoc(doc, $event.currentTarget)">
                  <sd-icon name="eye" [size]="14" />View
                </button>
              }
            }
          </div>
        }
      </div>
      }
      <!-- Live regions (sr-only: out of the band's layout). -->
      <p class="sr-only" role="status">{{ peerLeft() ? patientName() + ' left the call' : '' }}</p>
      <p class="sr-only" role="status">{{ bandPresenceNote() }}</p>
      <p class="sr-only" aria-live="polite">{{ docAnnounce() }}</p>
    </ng-template>

    <!-- The patient's live video in the viewer's picture-in-picture (handed over, never in two places). -->
    <ng-template #viewerPeer>
      <sd-call-peer-tile [tile]="peerTile()" [track]="peer.holder() === 'viewer' ? peer.track() : null" />
    </ng-template>

    <!-- ... and in the workspace's. -->
    <ng-template #workspacePeer>
      @if (peer.holder() === 'workspace') {
        <sd-call-peer-tile [tile]="peerTile()" [track]="peer.track()" />
      } @else {
        <!-- The tile is with the viewer above, or going: initials, never a black box. -->
        <div class="ws-peer-wait" aria-hidden="true"><span class="font-heading text-body font-semibold">{{ patientInitials() }}</span></div>
      }
    </ng-template>

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
         (narrow), under the video beside the rail (a phone held sideways). Not a live region (announceDocs
         says it); focus never moves to it. -->
    <ng-template #docAlertTpl>
      @if (docAlertView(); as al) {
        <div
          #docAlertEl
          role="group"
          aria-label="New document"
          tabindex="-1"
          class="flex items-start gap-3 outline-none rounded-card border border-cerulean/40 bg-ink px-4 py-3 shadow-raised"
          [class]="floatAlert() ? 'fixed inset-x-3 bottom-3 z-40' : ''"
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
  /**
   * Below 640px: the doctor's own camera is a small tile in the control row, not
   * on the video (held upright). A change moves the self view: see moveSelfView.
   */
  protected readonly phone = this.media('(max-width: 639.98px)', (change) => this.moveSelfView(change));
  /** A phone held sideways (the query; `rail` is what the template uses). */
  private readonly railMq = this.media(RAIL_QUERY, (change) => this.moveSelfView(change));
  protected readonly layout = computed<'wide' | 'mid' | 'narrow'>(() =>
    this.wideMq() ? 'wide' : this.midMq() ? 'mid' : 'narrow',
  );
  /**
   * A phone held sideways (narrow only): the dock is a row, not sticky — the video,
   * with the controls as a rail beside it — under a 48px top bar; the section
   * switcher and the panels follow below (page scroll). The self view is the
   * picture-in-picture at any width: the wide stage has a free corner and the rail
   * has no room for the 64px tile above its controls.
   */
  protected readonly rail = computed(() => this.railMq() && this.layout() === 'narrow');
  /** Narrow: which section shows under the video. */
  protected readonly section = signal<CallSection>('notes');
  /** Mid: which side panel shows. */
  protected readonly sideTab = signal<SideTab>('patient');
  protected readonly sectionTabs: ReadonlyArray<{ key: CallSection; label: string; panel: string }> = [
    { key: 'notes', label: 'Tools', panel: 'call-tools' },
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
      // The dock's row is as tall as its video size asks, but never takes the launcher card's height from the tools row.
      case 'wide':
        return "grid min-h-0 flex-1 gap-4 p-4 grid-cols-[272px_minmax(0,1fr)_336px] 2xl:grid-cols-[300px_minmax(0,1fr)_380px] grid-rows-[minmax(0,auto)_minmax(auto,1fr)] [grid-template-areas:'chart_dock_records''chart_tools_records']";
      case 'mid':
        return "grid min-h-0 flex-1 gap-4 p-4 grid-cols-[minmax(0,1fr)_340px] grid-rows-[minmax(0,auto)_minmax(auto,1fr)] [grid-template-areas:'dock_side''tools_side']";
      default:
        return 'flex flex-col gap-3 p-3';
    }
  });
  /** The dock: the tools column's width (wide, mid) or the content width (narrow), so the stage and bar line up with what is below. */
  protected readonly dockClass = computed(() => {
    if (this.rail()) return 'flex-row items-stretch';
    return this.layout() === 'narrow'
      ? 'flex-col sticky top-0 z-20 bg-abyss pt-1 [@media(max-height:500px)]:static'
      : 'flex-col min-h-0 [grid-area:dock]';
  });
  /**
   * A phone held sideways: the stage's column beside the rail, a fixed height
   * (RAIL_COLUMN). The video takes the first row, the new-document alert (when
   * it shows) the second, so the alert shrinks the video, not the page.
   */
  protected readonly stageColumnClass = computed(() =>
    this.rail()
      ? `grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] ${RAIL_COLUMN[this.videoSize()]}`
      : 'contents',
  );
  /**
   * The stage is always the full width of its column; the video fills it (or
   * is letterboxed in it: Video fit). Beside a rail: the grid row's height (what
   * the alert leaves). Narrow: 4:3 (16:9 from sm) of the width, at most
   * --stage-max. Wide and mid: the video size's height, giving way (flex
   * shrink) when the dock's row can't spare it.
   */
  protected readonly stageClass = computed(() => {
    if (this.rail()) return 'h-full w-full';
    return this.layout() === 'narrow'
      ? 'w-full shrink-0 aspect-[4/3] max-h-[var(--stage-max)] sm:aspect-video'
      : 'w-full min-h-0 h-[var(--stage-h)] transition-[height] duration-300 ease-out';
  });
  /**
   * The control bar under the video, or (a phone held sideways) the rail beside
   * it: exactly as tall as the stage's column (RAIL_COLUMN), never by its
   * content, so the controls measure that height and pack into as many columns
   * as it needs (End stays on the screen), and as wide as those columns.
   */
  protected readonly controlRowClass = computed(() =>
    this.rail()
      ? `flex min-h-0 shrink-0 flex-col items-center gap-2 rounded-card border border-white/10 bg-ink px-1 py-2 ${RAIL_COLUMN[this.videoSize()]}`
      : 'flex shrink-0 items-center gap-2 rounded-card border border-white/10 bg-ink px-2 py-2',
  );
  /** The bar's `callbar` container (its labels show from 34rem); a rail's box sizes to its columns instead. */
  protected readonly controlsBoxClass = computed(() =>
    this.rail()
      ? 'flex min-h-0 flex-1 justify-center'
      : 'min-w-0 flex-1 [container-name:callbar] [container-type:inline-size]',
  );
  /** The new-document alert floats at the bottom (narrow, held upright). */
  protected readonly floatAlert = computed(() => this.layout() === 'narrow' && !this.rail());
  protected readonly toolsClass = computed(() => (this.layout() === 'narrow' ? 'ws-tools-narrow' : '[grid-area:tools] ws-tools-start'));
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

  // ---- The video: size, fit and my own preview (remembered per device; Large and fill by default) ----
  protected readonly videoSize = signal<VideoSize>(readVideoSize());
  protected readonly fit = signal<CallVideoFit>(readStored(FIT_KEY, ['contain', 'cover'], 'cover'));
  protected readonly selfHidden = signal(readStored(SELF_KEY, ['hidden', 'shown'], 'shown') === 'hidden');
  /** The control-row tile only on a phone held upright; else the stage's picture-in-picture. */
  protected readonly selfMode = computed<CallSelfViewMode>(() =>
    this.selfHidden() ? 'hidden' : this.phone() && !this.rail() ? 'external' : 'pip',
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
        hidden: !this.canShareScreen,
      },
      {
        id: 'record',
        label: 'Record',
        icon: this.recordingActive() ? 'circle-stop' : 'circle',
        pressed: this.recordingActive(),
        tone: this.recordingActive() ? 'active' : 'default',
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
      { id: 'end', label: 'End', ariaLabel: 'End consultation', icon: 'phone-off', tone: 'danger' },
    ];
  });

  /**
   * The dock's settings, after its controls (never behind a menu): the video
   * size and fit, my preview, and on a phone (where the top bar has no room for
   * it) the cockpit theme.
   */
  protected readonly settings = computed<CallSetting[]>(() => {
    const items: CallSetting[] = [
      { id: 'size', label: 'Video size', value: this.videoSize(), options: SIZE_OPTIONS },
      { id: 'fit', label: 'Video fit', value: this.fit(), options: FIT_OPTIONS },
      { id: 'self', label: 'Hide my preview', icon: 'eye-off', pressed: this.selfHidden() },
    ];
    if (this.phone()) items.push({ id: 'theme', label: 'Light cockpit', icon: 'sun', pressed: this.theme() === 'light' });
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

  // ---- The shared document viewer (a modal over the cockpit, §3) ----
  /** Opens every document here (records, prescriptions); this page registers its call with it. */
  protected readonly viewer = inject(DocumentViewerService);
  /** The call band and the picture-in-picture the viewer renders while this page lives. */
  private readonly viewerBarTpl = viewChild.required<TemplateRef<unknown>>('viewerBar');
  private readonly viewerPeerTpl = viewChild.required<TemplateRef<unknown>>('viewerPeer');
  /** The view-only watermark: the doctor's name and the call's zone. */
  protected readonly watermark = computed(() => viewerWatermark(this.clock, { displayName: () => this.doctorName() }, this.callZone()));
  /** Who plays the patient's video (the stage, the workspace or the viewer): one at a time. */
  protected readonly peer = new PeerHandover({
    peerUid: () => this.patientUid(),
    remoteVideo: (uid) => this.remoteVideo(uid),
    stageAttach: (uid, t) => this.stage().attach(uid, t),
    stageDetach: (uid) => this.stage().detach(uid),
    workspaceOpen: () => this.wsOpen(),
    left: () => this.left(),
    afterNextRender: (fn) => afterNextRender(fn, { injector: this.injector }),
  });

  // ---- The workspace: the five tools and the Full EMR in one modal over the call ----
  protected readonly wsTabs = WS_TABS;
  /** The five launchers under the video (the user's five tools; the Full EMR opens from "View Full EMR"). */
  protected readonly wsLaunchers = WS_LAUNCHERS;
  protected readonly wsOpen = signal(false);
  protected readonly wsTab = signal<WorkspaceTab>('notes');
  /** The shell's words (the shared shell holds none of the doctor's copy). */
  protected readonly wsKicker = WS_KICKER;
  protected readonly wsClose = WS_CLOSE;
  protected readonly wsShareText = computed(() => wsShareBanner(this.recordingActive()));
  /** The tabs' marks: a warning dot while the prescription has unsaved changes or a lab request is not sent, a live dot while transcribing. */
  protected readonly wsFlags = computed<Partial<Record<WorkspaceTab, WorkspaceFlag>>>(() => ({
    prescriptions: this.rxUnsaved() ? { mark: 'warn', sr: WS_TAB_UNSAVED } : undefined,
    labs: this.labUnsent() ? { mark: 'warn', sr: WS_TAB_UNSENT } : undefined,
    copilot: this.transcribing() ? { mark: 'live', sr: WS_TAB_LIVE } : undefined,
  }));
  /** The panels shown so far (each mounted on first show, then only hidden, until the page goes). */
  protected readonly wsSeen = signal<ReadonlySet<WorkspaceTab>>(new Set());
  private readonly workspace = viewChild(CallWorkspace);
  private wsOpener: HTMLElement | null = null;
  /** "Show anyway" on the covered Full EMR while sharing (forgotten when sharing stops, the tab changes or the workspace closes). */
  protected readonly recordRevealed = signal(false);
  protected readonly recordCovered = computed(() => this.screenOn() && !this.recordRevealed());
  protected readonly shareCoverTitle = SHARE_COVER_TITLE;
  protected readonly shareCover = shareCoverText;
  protected readonly stopSharingLabel = STOP_SHARING;
  protected readonly showAnyway = SHOW_ANYWAY;
  /** For the call band's live region: "{name} joined the call." (and a guest's "left"). */
  protected readonly bandPresenceNote = signal('');
  /** Every document shared for this consultation, newest first (the EMR's Documents sub-tab). sortedDocs() is narrowed by the cockpit Records' filter; this is not. */
  protected readonly allSharedDocs = computed(() => [...this.patientDocs()].sort(byNewestShare));
  /** The cockpit Records' load state, for the EMR's Documents sub-tab. */
  protected readonly recordDocsState = computed<'loading' | 'failed' | 'ready'>(() =>
    this.docsLoading() && !this.docAccess()
      ? 'loading'
      : this.docsFailed() || this.callDocBanner()?.access?.state === 'unavailable'
        ? 'failed'
        : 'ready',
  );
  protected readonly toolsHint = computed(() => WS_TOOLS_HINT(this.patientFirstName()));
  /** What a launcher says under its label, from typed state (never from display strings). */
  protected readonly launcherStatus = computed<Partial<Record<WorkspaceTab, LauncherStatus>>>(() => ({
    notes: this.noteLauncherStatus(),
    prescriptions: this.rxUnsaved() ? { ...WS_STATUS.unsaved, tone: 'warn' } : undefined,
    labs: this.labUnsent() ? { ...WS_STATUS.labUnsent, tone: 'warn' } : undefined,
    copilot: this.transcribing()
      ? { ...WS_STATUS.live, tone: 'live' }
      : this.copilotDraft()
        ? { ...WS_STATUS.draftReady, tone: 'muted' }
        : undefined,
  }));

  // ---- The patient chart's disclosures (remembered per device) ----
  protected readonly chartOpen = signal<ReadonlySet<string>>(readChartOpen());
  private readonly chartCol = viewChild<ElementRef<HTMLElement>>('chartCol');
  private readonly allergyCard = viewChild<ElementRef<HTMLElement>>('allergyCard');
  private readonly dockEl = viewChild<ElementRef<HTMLElement>>('dock');
  private readonly bannersEl = viewChild<ElementRef<HTMLElement>>('banners');

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

  private noteLauncherStatus(): LauncherStatus | undefined {
    const load = this.noteLoad();
    if (load === 'loading') return { ...WS_STATUS.loading, tone: 'muted' };
    if (load === 'error') return { ...WS_STATUS.noteNotLoaded, tone: 'warn' };
    if (this.noteFinalized()) return { ...WS_STATUS.signed, tone: 'muted' };
    switch (this.noteIssue()) {
      case 'failed':
        return { ...WS_STATUS.saveFailed, tone: 'warn' };
      case 'device':
        return { ...WS_STATUS.onDevice, tone: 'warn' };
      case 'signed-out':
        return { ...WS_STATUS.signedOut, tone: 'warn' };
      default:
        return undefined;
    }
  }

  /**
   * A media query as a signal (its listener goes with the page). `wrap` runs
   * around each change (moveSelfView hands the camera over around it).
   */
  private media(query: string, wrap?: (change: () => void) => void): Signal<boolean> {
    const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
    const state = signal(mql?.matches ?? false);
    if (mql) {
      const onChange = (e: MediaQueryListEvent) => {
        const change = () => state.set(e.matches);
        if (wrap) wrap(change);
        else change();
      };
      mql.addEventListener?.('change', onChange);
      this.destroyRef.onDestroy(() => mql.removeEventListener?.('change', onChange));
    }
    return state.asReadonly();
  }

  /**
   * Change where the doctor's own video plays (the stage's picture-in-picture,
   * the control-row tile, or nowhere), handing the track over first: an Agora
   * track plays in one element at a time, and stopping one playback stops the
   * other. Leaving the picture-in-picture, the stage lets go of the track now
   * (before the row tile starts it); coming back, the stage gets it again and
   * plays it once its tile renders (after the row tile has stopped).
   */
  private moveSelfView(change: () => void): void {
    const before = this.selfMode();
    change();
    const after = this.selfMode();
    const track = this.selfTrack();
    // Nothing to hand over before the doctor's camera is in the call.
    if (before === after || !track) return;
    if (after === 'pip') this.stage().attach(this.selfUid, track, this.selfPlayConfig());
    else if (before === 'pip') this.stage().detach(this.selfUid);
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
      case 'self': {
        const hidden = !this.selfHidden();
        this.moveSelfView(() => this.selfHidden.set(hidden));
        writeStored(SELF_KEY, hidden ? 'hidden' : 'shown');
        return;
      }
      case 'theme':
        this.toggleTheme();
        return;
      default:
        return;
    }
  }

  /** A segmented setting in the dock changed: the video size or fit. */
  protected onChoice({ id, value }: CallChoiceChange): void {
    if (id === 'size' && (value === 's' || value === 'm' || value === 'l')) {
      this.videoSize.set(value);
      writeStored(VIDEO_SIZE_KEY, value);
    } else if (id === 'fit' && (value === 'contain' || value === 'cover')) {
      this.fit.set(value);
      writeStored(FIT_KEY, value);
    }
  }

  // ---- Tabs (APG: arrows, Home, End move and select) ----
  protected onTabKey(e: KeyboardEvent, list: 'section' | 'side'): void {
    const keys: readonly string[] = list === 'section' ? this.sectionTabs.map((t) => t.key) : this.sideTabs.map((t) => t.key);
    const current = list === 'section' ? this.section() : this.sideTab();
    let i = keys.indexOf(current);
    if (e.key === 'ArrowRight') i = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = keys.length - 1;
    else return;
    e.preventDefault();
    const next = keys[i];
    if (list === 'section') this.section.set(next as CallSection);
    else this.sideTab.set(next as SideTab);
    const prefix = list === 'section' ? 'call-section-' : 'call-side-';
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
    // No longer shared (realtime or poll): the open viewer drops those bytes at once and
    // says so in place (role=alert) until the doctor closes it.
    revokeUnshared(this.viewer, present);
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
    if (this.left() || String(uid) !== String(this.patientUid())) return;
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
   * Open a shared document in the shared viewer — a modal over the cockpit with
   * the call band (Back to call, Mute, End, the call's alerts) and the
   * patient's video as its picture-in-picture; the call goes on underneath. It
   * opens on the records list as filtered and shown (Documents / Imaging /
   * Labs), so ‹ / › move through it. View-only: watermarked, every print
   * recorded first, never downloadable; fetched with `X-SD-Viewer` and
   * recorded (over the portal session, never a raw token). Focus goes back to
   * the row or alert button, else to the Medical Records heading (over the
   * workspace: to its selected tab). `list`: what ‹ / › walk through (the EMR's
   * Documents sub-tab passes its own, not narrowed by the Records' filter).
   */
  protected openPatientDoc(
    doc: DoctorSharedDocumentDto,
    opener?: EventTarget | null,
    list: readonly DoctorSharedDocumentDto[] = this.sortedDocs(),
  ): void {
    this.markSeen(doc.id);
    if (this.docAlert()?.doc?.id === doc.id) this.dismissAlert(false);
    const at = list.findIndex((d) => d.id === doc.id);
    const docs = at < 0 ? [doc] : list;
    const zone = this.callZone();
    const onGone = () => this.loadDocumentAccess('refresh');
    this.viewer.open(
      docs.map((d) => patientDocumentSource(this.doctorApi, this.appointmentId, d, { onGone }, zone)),
      {
        index: Math.max(0, at),
        opener: opener instanceof HTMLElement ? opener : null,
        // Over the workspace: its selected tab. Else the heading, which may be behind another side tab or section: choose it, then focus it.
        fallbackFocus: () => {
          if (this.wsOpen()) return document.getElementById('ws-tab-' + this.wsTab());
          this.focusRecordsHeading();
          return null;
        },
        watermark: this.watermark(),
        listLabel: 'shared documents',
      },
    );
  }

  /** A referral letter or certificate of this consultation in the viewer: Print, no Download (D13). */
  protected openClinicalDoc(kind: 'referral' | 'certificate', d: ReferralDto | MedicalCertificateDto, opener: EventTarget | null): void {
    const doc = {
      id: d.id,
      label: kind === 'referral' ? (d as ReferralDto).target : (d as MedicalCertificateDto).type_label,
      issued_at: d.created_at,
    };
    this.viewer.open(clinicalDocumentSource(this.doctorApi, this.appointmentId, kind, doc, this.callZone()), {
      opener: opener instanceof HTMLElement ? opener : null,
    });
  }

  // ---- The workspace ----

  protected openWorkspace(tab: WorkspaceTab, opener?: EventTarget | null): void {
    if (this.left()) return;
    this.wsTab.set(tab);
    this.wsOpener = opener instanceof HTMLElement ? opener : null;
    if (this.wsOpen()) return;
    this.wsOpen.set(true);
    this.peer.workspaceOpened();
  }

  /** Esc, ✕, the scrim, Back to call: nothing is destroyed, so nothing is asked. Never under a tool's open dialog. */
  protected closeWorkspace(): void {
    if (!this.wsOpen() || this.workspace()?.hasOpenNestedDialog()) return;
    this.wsOpen.set(false);
    this.recordRevealed.set(false);
    this.peer.workspaceClosed();
  }

  /** The band's first button, in the workspace and in the viewer: back to the cockpit. */
  protected backToCall(): void {
    const viewerOpen = this.viewer.isOpen();
    // A viewer opened from a tool's dialog inside the workspace (the rx Send dialog's View PDF):
    // leave only the document. Closing the workspace would detach that dialog while it is modal.
    if (viewerOpen && this.workspace()?.hasOpenNestedDialog()) {
      this.viewer.close();
      return;
    }
    this.closeWorkspace();
    if (viewerOpen) this.viewer.close();
  }

  /** After the workspace's exit: focus the opener, else this tab's launcher, else the tools heading (only when focus was lost). */
  protected onWorkspaceClosed(): void {
    setTimeout(() => {
      if (this.wsOpen()) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const usable = (el: HTMLElement | null) => !!el?.isConnected && el.getClientRects().length > 0;
      const launcher = document.querySelector<HTMLElement>(`[data-ws-launcher="${this.wsTab()}"]`);
      (usable(this.wsOpener) ? this.wsOpener : usable(launcher) ? launcher : document.getElementById('call-tools-heading'))?.focus();
    });
  }

  /**
   * A tool inside the workspace picked another tab (quick tools, "Use in SOAP note",
   * the EMR's jumps). The button that was pressed is now inside a hidden panel, so
   * focus must move: to `targetId`'s element (scrolled into view; its
   * `[data-ws-focus]` heading, else itself), else to the selected tab. The shell does
   * it after render, and an explicit target wins over the tab's remembered scroll.
   */
  protected selectWorkspaceTab(key: WorkspaceTab, targetId?: string): void {
    const ws = this.workspace();
    if (ws) ws.showTab(key, targetId); // writes the `tab` model (two-way bound to wsTab)
    else this.wsTab.set(key);
  }

  /** The share banner's and the EMR cover's Stop sharing (never starts a share). */
  protected stopSharingFromWorkspace(): void {
    if (this.screenOn()) void this.toggleScreen();
  }

  /** "Show anyway" on the covered Full EMR. */
  protected revealRecord(): void {
    this.recordRevealed.set(true);
    this.announceDocs(WS_RECORD_SHOWN);
  }

  /** "Back to call" is the viewer's own; these band actions leave its full screen first (their prompts aren't in it). */
  private leaveViewerFullscreen(): void {
    if (typeof document === 'undefined' || !document.fullscreenElement) return;
    void document.exitFullscreen?.()?.catch(() => undefined);
  }

  protected endFromViewer(): void {
    this.leaveViewerFullscreen();
    void this.askEnd();
  }

  protected leaveFromViewer(): void {
    this.leaveViewerFullscreen();
    void this.leave();
  }

  protected standingFromViewer(): void {
    this.leaveViewerFullscreen();
    void this.openStanding();
  }

  /** The join failed (the stage's "Back to schedule", mirrored in the band). */
  protected scheduleFromViewer(): void {
    this.leaveViewerFullscreen();
    void this.leave('schedule');
  }

  // ---- The patient's video, handed between the stage, the workspace and the viewer (see PeerHandover) ----

  /** Agora's current video track of a remote uid (never a copy kept here). */
  private remoteVideo(uid: CallUid): CallVideoTrack | null {
    return this.client?.remoteUsers.find((u) => String(u.uid) === String(uid))?.videoTrack ?? null;
  }

  /** The patient (for the viewer's and the workspace's tile): their stage tile, or initials until they are in the call. */
  protected readonly peerTile = computed<CallTile>(() => {
    const uid = this.patientUid();
    return (
      this.tiles().find((t) => !t.self && String(t.uid) === String(uid)) ?? {
        uid,
        name: this.patientName(),
        role: 'patient',
        hasVideo: false,
        muted: false,
      }
    );
  });
  /** The patient is connected now. */
  private readonly peerPresent = computed(() => this.people().some((r) => String(r.uid) === String(this.patientUid())));
  /** The patient has been in this call (so "left the call" can be said). */
  private readonly peerSeen = signal(false);
  /** "{name} left the call" in the band — not while the doctor's own connection is the problem. */
  protected readonly peerLeft = computed(
    () => this.peerSeen() && !this.peerPresent() && this.status() === 'in-call' && !this.rejoining() && !this.connectionLost(),
  );
  /** The band's alerts row shows (wraps under the controls): joining or failed to join, or a banner. */
  protected readonly bandAlerts = computed(
    () =>
      this.status() !== 'in-call' ||
      !!this.recordingError() ||
      !!this.callClosed() ||
      this.rejoining() ||
      this.connectionLost() ||
      this.peerLeft() ||
      !!this.docAlertView(),
  );

  // ---- Focus not obscured (WCAG 2.4.11): scroll padding for the sticky dock and the alert ----
  private observeObscurers(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    // On a phone held sideways the dock is a row in the page (never sticky, so
    // nothing to pad) and the banners' observer resizes it (--rail-above). A
    // second observer on it there, at the banners' depth (siblings), would be a
    // ResizeObserver loop ("completed with undelivered notifications"), so the
    // dock is only watched off the rail; turning the phone re-runs this.
    effect(
      (onCleanup) => {
        const dock = this.rail() ? null : this.dockEl()?.nativeElement;
        if (!dock) {
          root.style.scrollPaddingTop = '';
          return;
        }
        const sync = () => {
          const narrow = this.layout() === 'narrow';
          const height = dock.getBoundingClientRect().height;
          // Too tall to stay in view: it scrolls with the page (set inline, so the check below sees it at once).
          const room = root.clientHeight;
          dock.style.position = narrow && room > 0 && height > room * DOCK_STICKY_MAX ? 'static' : '';
          const sticky = narrow && getComputedStyle(dock).position === 'sticky';
          root.style.scrollPaddingTop = sticky ? `${Math.ceil(height)}px` : '';
        };
        const ro = new ResizeObserver(sync);
        ro.observe(dock);
        // The screen's height can change without the dock's (a window made shorter).
        window.addEventListener('resize', sync);
        onCleanup(() => {
          ro.disconnect();
          window.removeEventListener('resize', sync);
          dock.style.position = '';
        });
      },
      { injector: this.injector },
    );
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

  /**
   * The banners under the top bar (recording error, call closed, reconnecting)
   * as --rail-above: a phone held sideways takes their height from the rail's
   * stage column (RAIL_COLUMN), so the dock still ends on the first screen. Set
   * here, not bound, so the column follows in the same frame.
   */
  private observeBanners(): void {
    const banners = this.bannersEl()?.nativeElement;
    const page = banners?.parentElement;
    if (!banners || !page || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1]?.contentRect.height ?? 0;
      page.style.setProperty('--rail-above', `${Math.ceil(h)}px`);
    });
    ro.observe(banners);
    this.destroyRef.onDestroy(() => ro.disconnect());
  }

  /** The floating alert (narrow, held upright) must never hide the focused element: pad the bottom while it shows. */
  private syncAlertPadding(): void {
    const el = this.docAlertEl()?.nativeElement;
    const root = document.documentElement;
    if (!el || !this.floatAlert()) {
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

  protected readonly recordsTab = signal<RecordsTab>('documents');
  protected readonly subjective = signal('');
  protected readonly objective = signal('');
  protected readonly assessment = signal('');
  protected readonly plan = signal('');
  protected readonly toolNote = signal('');

  // Clinical-note persistence state.
  protected readonly noteStatus = signal<'draft' | 'finalized'>('draft');
  protected readonly noteSaved = signal('');
  /** Whether that line signals a problem (typed: the launcher never parses the words). */
  private readonly noteIssue = signal<NoteIssue>('');
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
      (this.wsOpen() && this.wsTab() === 'prescriptions' && this.portalSignedIn() && !!this.rxPatientId()),
  );
  private readonly rxPanel = viewChild(RxPanel);
  /** A half-written prescription (the composer stays mounted, so closing the workspace loses nothing). */
  protected readonly rxUnsaved = computed(() => !!this.rxPanel()?.hasUnsavedChanges());
  /** Bumped by the Full EMR's "Write prescription" (the panel opens its composer). */
  protected readonly rxComposeSeq = signal(0);
  /** The Lab requests tab (mounted on first show, then only hidden, like the prescribing panel). */
  private readonly labPanel = viewChild(CallLabRequests);
  /** A lab request is being written in the tab (the zone stays visible while signed out). */
  protected readonly labComposing = computed(() => !!this.labPanel()?.composing());
  /** A lab request being written and not sent (launcher, tab, Leave / End). */
  protected readonly labUnsent = computed(() => !!this.labPanel()?.unsent());
  /** Bumped by the Full EMR's "New lab request" (the tab opens its composer). */
  protected readonly labComposeSeq = signal(0);
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
      (this.wsOpen() && this.wsTab() === 'followup' && this.portalSignedIn() && !!this.rxAppointmentId()),
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

  protected readonly recordsTabs: ReadonlyArray<{ key: RecordsTab; label: string }> = [
    { key: 'documents', label: 'Documents' },
    { key: 'imaging', label: 'Imaging' },
    { key: 'labs', label: 'Labs' },
  ];
  protected readonly tools: ReadonlyArray<{ label: string; icon: string }> = [
    { label: 'ePrescription', icon: 'pill' },
    { label: 'Lab request', icon: 'flask-conical' },
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
  /** The doctor left the call (teardown): no rejoin, no more reads; the viewer closes. */
  private readonly left = signal(false);
  /**
   * In the live call: connected, not left, and the API still takes it. The
   * viewer reads it (Mute / End in its band, print asks first, no Reload).
   */
  protected readonly inLive = computed(() => this.status() === 'in-call' && !this.left() && !this.callClosed());
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
    if (this.status() === 'in-call' && !this.left()) {
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
    });

    // While this page lives, every document opened anywhere (records, prescriptions, the
    // workspace) gets the call band and the patient's video (§3). The templates exist after the first render.
    afterNextRender(() => {
      const unregister = this.viewer.registerCall({
        bar: this.viewerBarTpl(),
        peer: this.viewerPeerTpl(),
        peerName: this.patientName,
        tone: this.theme,
        live: this.inLive,
        sharingScreen: this.screenOn,
        recording: this.recordingActive,
        stopSharing: () => {
          if (this.screenOn()) void this.toggleScreen();
        },
        willOpen: () => this.peer.viewerWillOpen(),
        didClose: () => this.peer.viewerDidClose(),
      });
      this.destroyRef.onDestroy(unregister);
    });

    // The call is over for this doctor (teardown): the workspace and the viewer close (the page then
    // navigates). callLeft first, so the viewer's didClose finds the stage and does nothing.
    // The API closing the call (callClosed) keeps them open: their band says so.
    effect(() => {
      if (this.left()) {
        untracked(() => {
          this.peer.callLeft();
          this.wsOpen.set(false);
          this.viewer.close();
        });
      }
    });

    // Each workspace panel is mounted the first time it shows, then only hidden.
    effect(() => {
      if (!this.wsOpen()) return;
      const t = this.wsTab();
      untracked(() => {
        if (!this.wsSeen().has(t)) this.wsSeen.set(new Set([...this.wsSeen(), t]));
      });
    });

    // "Show anyway" on the covered Full EMR is forgotten when sharing stops or the tab changes (closing resets it too).
    effect(() => {
      this.wsTab();
      this.screenOn();
      untracked(() => this.recordRevealed.set(false));
    });

    // Who joined, for the band's live region: the tiles' own region is inert under a modal, and
    // the workspace stays open for long stretches. The same rules as the tiles; the patient's "left"
    // is already the band's own line (peerLeft), so it only clears the note: no stale "joined" beside
    // it, and their return changes the region again. A live region reads changes, never a repeat.
    let presence: Map<string, { readonly name: string; readonly role: string }> | null = null;
    effect(() => {
      const tiles = this.tiles();
      const current = new Map(tiles.filter((t) => !t.self).map((t) => [String(t.uid), { name: t.name, role: t.role }] as const));
      const before = presence;
      presence = current;
      if (!before || !tiles.length) return;
      const went = [...before].filter(([k]) => !current.has(k)).map(([, p]) => p);
      const text = [
        ...[...current].filter(([k]) => !before.has(k)).map(([, p]) => `${p.name} joined the call.`),
        ...went.filter((p) => p.role !== 'patient').map((p) => `${p.name} left the call.`),
      ].join(' ');
      untracked(() => {
        if (text) this.bandPresenceNote.update((was) => (was === text ? `${text}\u00a0` : text));
        else if (went.length) this.bandPresenceNote.set('');
      });
    });

    // The patient has been here: from now on the band can say they left.
    effect(() => {
      if (this.peerPresent() && !untracked(this.peerSeen)) untracked(() => this.peerSeen.set(true));
    });

    // The floating alert (narrow, held upright) pads the page's bottom while it shows.
    effect(() => {
      this.docAlertView();
      this.floatAlert();
      untracked(() => afterNextRender(() => this.syncAlertPadding(), { injector: this.injector }));
    });

    // Hold the portal idle timeout only while a consultation is going on:
    // connected and someone else is here, or (for a bounded time) waiting for
    // the patient to first arrive. An ended call left open on a shared
    // computer still times out. The hold is also what keeps a live call's
    // SERVER session alive (SessionTimeoutService touches it every few
    // minutes while held, hidden tab or not); the call's timed requests
    // (transcript, metrics, documents) are all passive and never do.
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
    this.observeBanners();
    void this.start();
  }

  /** Window regained focus — the doctor may have just signed in in another tab. */
  protected recheckPortalSignIn(): void {
    this.authCheck.update((n) => n + 1);
  }

  /** Hold (or release) the portal idle timeout — never held after leaving. */
  private syncHold(want: boolean): void {
    const on = want && !this.left();
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
    if (this.left()) return;
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

  /** The Full EMR's "New lab request": the composer on the Lab requests tab, focus on its title; one being written is kept. */
  protected openLabComposer(): void {
    const already = this.labComposing();
    this.labComposeSeq.update((n) => n + 1);
    this.selectWorkspaceTab('labs', already ? undefined : 'call-lab-compose-title');
  }

  /**
   * The Full EMR's "Write prescription": the composer on the Prescriptions tab
   * (focus on its title once the form is ready); one being written is kept.
   * Signed out, or without the patient yet, it only shows the tab.
   */
  protected openRxComposer(): void {
    if (!this.portalSignedIn() || !this.rxPatientId()) {
      this.selectWorkspaceTab('prescriptions');
      return;
    }
    const already = !!this.rxPanel()?.composerOpen();
    this.rxComposeSeq.update((n) => n + 1);
    this.selectWorkspaceTab('prescriptions', already ? undefined : 'rx-compose-title');
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
        if (this.left()) return;
        // The stage, or the tile (workspace, viewer) that holds the patient's video.
        if (mediaType === 'video' && user.videoTrack) this.peer.route(user.uid, user.videoTrack);
        else if (mediaType === 'audio') user.audioTrack?.play();
      });
      // One person's camera going off (or them leaving) only touches their own tile.
      client.on('user-unpublished', (user, mediaType) => {
        if (mediaType === 'video') this.peer.route(user.uid, null);
      });
      client.on('user-left', (user) => this.peer.route(user.uid, null));
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
      if (this.left()) return;

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
      if (!this.left()) {
        this.firstWaitTimer = setTimeout(() => this.firstWaitOver.set(true), FIRST_WAIT_HOLD_MS);
      }
      // Let schedules show the doctor is in the call (stopped in teardown).
      if (!this.left()) this.startHeartbeat();
      this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
      this.startMetricsReport();
      if (!this.left()) this.startDocsPoll();
    } catch (err: unknown) {
      this.errorMessage.set(apiErrorMessage(err, 'This join link is invalid or has expired.'));
      this.joinStanding.set(doctorStandingCode(err));
      this.status.set('error');
      // Joined but could not go on (e.g. no camera): don't sit in the others'
      // call as a silent tile while this screen says it failed.
      if (this.client && !this.left()) {
        this.unbindRemotes?.();
        this.unbindRemotes = undefined;
        this.remotes.clear();
        void this.client.leave().catch(() => undefined);
      }
      // ...and don't keep the camera and mic open behind it (e.g. publish failed).
      if (!this.left()) {
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
    if (this.left() || this.rejoining()) return;
    try {
      const data = await this.resolveJoin();
      if (this.left()) return;
      if (data.participants) this.freshRoster.set(data.participants);
      if (data.token) await this.client?.renewToken(data.token);
    } catch (err: unknown) {
      if (this.left() || this.refusedBy(err)) return;
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
    if (!client || this.left() || this.rejoining() || this.callClosed() || this.status() !== 'in-call') return;
    if (this.renewRetry) clearTimeout(this.renewRetry);
    this.renewRetry = undefined;
    this.rejoining.set(true);
    this.connectionLost.set(false);
    try {
      const data = await this.resolveJoin();
      if (this.left()) return;
      if (data.participants) this.freshRoster.set(data.participants);
      if (!data.configured || !data.app_id || !data.channel) throw fetchError(0, null);
      await client.leave().catch(() => undefined);
      // Through the gate: the holding tile drops the patient's dead track too (the
      // re-published one reaches it through user-published).
      for (const r of this.remotes.list()) this.peer.route(r.uid, null);
      this.remotes.clear();
      // The same uid as before, so the doctor's own tile (keyed by it) stays put.
      const uid = typeof this.selfUid === 'number' ? this.selfUid : data.uid ? data.uid : null;
      await client.join(data.app_id, data.channel, data.token ?? null, uid);
      if (this.left()) {
        await client.leave().catch(() => undefined);
        return;
      }
      await this.publishOwnTracks();
    } catch (err: unknown) {
      if (this.left() || this.refusedBy(err)) return;
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
    if (this.left()) return;
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
    if (!this.heartbeatStop || this.left()) return;
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
      message || (standing === 'terms_required' ? STANDING_TERMS : STANDING_REFUSED),
    );
  }

  /**
   * The API no longer takes this call (410 cancelled / ended — e.g. ended from
   * the appointment page, or cancelled by the clinic). The doctor stays to
   * finish notes or a prescription; the banner says why and offers Leave.
   * Not while ending it here (that refusal is expected) or after leaving.
   */
  private callRefused(code: CallRefusalCode | null, message: string): void {
    if (this.left() || this.ending() || this.callClosed()) return;
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
      this.selectWorkspaceTab('prescriptions');
      return;
    }
    if (label === 'Lab request') {
      this.toolNote.set('');
      this.selectWorkspaceTab('labs');
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
    this.selectWorkspaceTab('followup', id);
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
    if (!this.appointmentId || !this.portalSignedIn() || this.left()) return;
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
    // Signed out (or another doctor signed in): nothing the viewer shows may stay on screen.
    this.viewer.close();
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
   * shared `ApiError` (`apiErrorMessage` reads them). `{ passive: true }` for
   * the timed background requests (transcript poll, metrics report): they
   * never extend the idle session — the call's hold keeps a live call's
   * session alive (see `syncHold`).
   */
  private noteFetch(path: string, init: RequestInit, options?: ApiRequestOptions): Promise<any> {
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined;
    return firstValueFrom(this.api.request<unknown>(init.method ?? 'GET', path, body, options));
  }

  /** The note's save line and, typed, whether it signals a problem (the launcher reads the type, never the words). */
  private setNoteStatus(text: string, issue: NoteIssue = ''): void {
    this.noteSaved.set(text);
    this.noteIssue.set(issue);
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
      if (n.updated_at) this.setNoteStatus('Saved');
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
    this.setNoteStatus('Saving the note kept on this device…');
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
    this.setNoteStatus('Saving…');
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
      this.setNoteStatus('Saved');
      this.noteError.set('');
    } catch (err: unknown) {
      if (isSessionEndError(err) || !this.auth.isAuthenticated()) {
        this.keepNoteOnDevice();
        return;
      }
      this.setNoteStatus('Save failed — retry', 'failed');
      this.noteError.set(apiErrorMessage(err, 'Could not save the note.'));
    }
  }

  /** Keep the note on this device for the doctor it belongs to, until they sign in again. */
  private keepNoteOnDevice(): void {
    const sub = this.noteSub() ?? this.auth.subject();
    if (sub && this.drafts.save(this.appointmentId, sub, this.notePayload())) {
      this.setNoteStatus(NOTE_KEPT_ON_DEVICE, 'device');
      this.noteError.set('');
      return;
    }
    this.setNoteStatus('Not saved — sign in to save', 'signed-out');
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
      this.setNoteStatus('Finalized & locked');
      this.noteError.set('');
    } catch (err: unknown) {
      this.setNoteStatus('Could not finalize — retry', 'failed');
      this.noteError.set(apiErrorMessage(err, 'Could not finalize the note.'));
    } finally {
      this.finalizing.set(false);
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
      this.refError.set('Add who to refer to and the reason for referral.');
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
    if (!this.left() && !asked && !(await this.confirmLeaveCall())) return;
    await this.flushNote();
    await this.teardown();
    if (to === 'schedule') void this.router.navigate(['/']);
    else this.goToAppointment();
  }

  /** A join refused for the doctor's standing: the terms to accept, or the account-status page. */
  protected async openStanding(): Promise<void> {
    const target = this.joinStanding() === 'terms_required' ? '/onboarding/terms' : '/account-status';
    if (!this.left() && !(await this.confirmLeaveCall())) return;
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
    if (this.endOpen() || this.asking > 0 || this.left()) return;
    if (!(await this.confirmDiscardDrafts())) return;
    if (this.endOpen() || this.left()) return;
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
    return this.left() ? true : this.confirmLeaveCall();
  }

  /** In the live call (connected, and the API still takes it). */
  protected inLiveCall(): boolean {
    return this.inLive();
  }

  /** What a leave would lose: a prescription with unsaved changes, a lab request not sent. */
  private unsavedWork(): { readonly rx: boolean; readonly lab: boolean } {
    return { rx: !!this.rxPanel()?.hasUnsavedChanges(), lab: this.labUnsent() };
  }

  /**
   * One question before leaving — never two stacked: "Leave the call?" while
   * in it (the visit stays open, they can rejoin), worded for whatever is at
   * risk (an unsaved prescription, an unsent lab request, or both); once the
   * call is over, only a question about what is at risk. While a lab request
   * is on its way it stays without asking (it may already be on the server;
   * the Sent dialog, or the error, follows). True to leave.
   */
  private confirmLeaveCall(): boolean | Promise<boolean> {
    if (this.left()) return true;
    if (this.labPanel()?.sending()) return false;
    const copy = leaveCallCopy(this.unsavedWork(), this.inLiveCall(), this.patientName());
    return copy ? this.ask(copy) : true;
  }

  /**
   * True when it is fine to destroy the drafts (End): nothing at risk, or the
   * doctor chose to leave anyway — one question naming the prescription, the
   * lab request or both. Asked by the cockpit, as the panels may be hidden
   * behind another tab. Never while a lab request is on its way.
   */
  private confirmDiscardDrafts(): boolean | Promise<boolean> {
    if (this.labPanel()?.sending()) return false;
    const copy = discardDraftsCopy(this.unsavedWork());
    return copy ? this.ask(copy) : true;
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

  /**
   * Report an RTC quality sample every 15s for back-office monitoring — a
   * background request (passive): it never keeps the session alive.
   */
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
          { passive: true },
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

  /** The transcript; `passive` for the 8 s poll (a background read, never activity). */
  private async loadTranscript(passive = false): Promise<void> {
    if (!this.appointmentId || !this.portalSignedIn()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/transcript`,
        { method: 'GET' },
        passive ? { passive: true } : undefined,
      );
      if (Array.isArray(body.data)) this.transcript.set(body.data);
    } catch {
      /* leave prior */
    }
  }

  /**
   * Re-read the transcript every 8 s until teardown — passive: it runs from
   * the clinical load (before join) to leaving, live call or not, so it must
   * never keep the session alive. A live call's session is held by `syncHold`.
   */
  private ensureTranscriptPoll(): void {
    if (this.transcriptPoll) return;
    this.transcriptPoll = setInterval(() => void this.loadTranscript(true), 8000);
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
    this.selectWorkspaceTab('notes');
    this.scheduleSave();
  }

  private async teardown(): Promise<void> {
    this.left.set(true);
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
