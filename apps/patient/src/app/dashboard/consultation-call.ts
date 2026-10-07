import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  ILocalVideoTrack,
  IMicrophoneAudioTrack,
  UID,
} from 'agora-rtc-sdk-ng';
import { SessionTimeoutService } from '@supadoc/auth';
import {
  apiErrorMessage,
  AppointmentsApi,
  DocumentsApi,
  openBlobDocument,
  openPendingTab,
  PatientApi,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type {
  AllergyRow,
  AppointmentDto,
  ConditionRow,
  ConsentDto,
  ConsultationSummaryDto,
  HealthProfileDto,
  LabOrderDto,
  MedicalDocumentDto,
  MedicationRow,
  PatientCarePlanDto,
  PatientProfileDto,
  PrescriptionDto,
  PrescriptionStatus,
  ReferralDto,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { IconComponent, SmoothHeightDirective } from '@supadoc/ui';

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
 * Left: the video stage (doctor on the main stage, patient picture-in-picture)
 * with the call controls, plus the consultation notes tabs and an in-call chat.
 * Right: the patient's own health summary, latest vitals and shared records.
 *
 * The video credentials come from GET .../call-token (server-minted RTC token);
 * the health summary is the signed-in patient's real allergies / conditions /
 * medications. Route: /dashboard/call/:id.
 */
@Component({
  selector: 'pat-consultation-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SmoothHeightDirective],
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
                class="flex items-center gap-2 rounded-pill border border-white/15 px-3 py-1.5 font-sans text-body-sm text-white/85 transition-colors hover:bg-white/10"
                (click)="invite()"
              >
                <sd-icon name="users" [size]="16" />
                <span class="hidden sm:inline">Invite Someone</span>
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

          <!-- Video stage — pinned to the top while the notes below are read or
               tabs are switched, so the consultation never scrolls out of view. -->
          <div
            class="sd-stage sticky top-2 z-20 [container-name:stage] [container-type:size] aspect-[4/3] max-h-[50vh] w-full overflow-hidden rounded-card bg-ink shadow-[0_12px_32px_rgba(0,0,0,0.35)] sm:aspect-video lg:aspect-[16/10]"
          >
            <!-- Remote (doctor) main stage -->
            <div #remoteVideo class="absolute inset-0 bg-ink"></div>

            <!-- Local (patient) picture-in-picture. Kept in the DOM (hidden until
                 in-call) so the camera can attach before status flips — otherwise
                 the element doesn't exist yet and the local tile stays black.
                 Top-right on a small stage; above the controls on a roomy one — never
                 over them. -->
            <div
              class="absolute right-3 top-3 z-10 h-24 w-[4.5rem] overflow-hidden rounded-2xl border border-white/15 bg-abyss shadow-lg roomy:top-auto roomy:right-4 roomy:bottom-32 roomy:h-32 roomy:w-24"
              [class.hidden]="status() !== 'in-call'"
            >
              <div #localVideo class="h-full w-full"></div>
              @if (!camOn()) {
                <div class="absolute inset-0 flex items-center justify-center bg-abyss text-white/60">
                  <sd-icon name="video-off" [size]="22" />
                </div>
              }
              <span
                class="absolute bottom-1.5 left-1.5 rounded bg-abyss/70 px-1.5 py-0.5 font-sans text-[10px] text-white/80"
              >
                You
              </span>
            </div>

            <!-- No video from the doctor: not here yet, camera off, or gone -->
            @if (!remoteJoined() && status() === 'in-call') {
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-3 pb-16 pl-6 pr-[5.5rem] pt-12 text-center text-white/75 roomy:pt-24 roomy:pb-32 roomy:pr-36"
              >
                @if (remoteLeft()) {
                  <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                    <sd-icon name="user-x" [size]="30" />
                  </span>
                  <p class="font-sans text-body-sm roomy:text-body">{{ doctorName() }} has left the call</p>
                  <p class="hidden max-w-sm font-sans text-caption text-white/50 roomy:block">
                    If your consultation is finished, press End to leave.
                  </p>
                } @else if (remotePresent()) {
                  <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                    <sd-icon name="video-off" [size]="30" />
                  </span>
                  <p class="font-sans text-body-sm roomy:text-body">{{ doctorName() }}’s camera is off</p>
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
                    Anything your doctor shares appears in Prescriptions and your consultation history.
                  </p>
                } @else {
                  <p class="max-w-sm font-sans text-body">You were disconnected from the call.</p>
                  <p class="max-w-sm font-sans text-caption text-white/60">
                    Check your internet connection, then rejoin.
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
                    class="rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                    (click)="leave()"
                  >
                    Back to appointments
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
                <button
                  type="button"
                  class="rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                  (click)="leave()"
                >
                  Back to appointments
                </button>
              </div>
            }

            <!-- Doctor name tag -->
            @if (status() === 'in-call') {
              <!-- …with the recording notice beside it (small stage) or under it -->
              <div
                class="absolute left-4 top-4 z-10 flex max-w-[calc(100%-7rem)] items-center gap-2 roomy:max-w-[calc(100%-8rem)] roomy:flex-col roomy:items-start"
              >
                <div class="flex min-w-0 max-w-full items-center rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur">
                  <span class="truncate font-sans text-body-sm font-medium text-white">
                    {{ doctorName() }}
                  </span>
                </div>
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

              <!-- HD badge (small stage: the PiP has this corner) -->
              <div
                class="absolute right-4 top-4 hidden items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur roomy:flex"
              >
                <span class="font-label text-caption font-semibold text-white">HD</span>
                <span class="size-2 rounded-full bg-success"></span>
              </div>

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
                  [attr.aria-label]="micOn() ? 'Mute microphone' : 'Unmute microphone'"
                  (click)="toggleMic()"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 transition-colors"
                    [class]="micOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                  >
                    <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="20" />
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">
                    {{ micOn() ? 'Mute' : 'Unmute' }}
                  </span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  [attr.aria-label]="camOn() ? 'Turn camera off' : 'Turn camera on'"
                  (click)="toggleCam()"
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-full roomy:size-11 transition-colors"
                    [class]="camOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                  >
                    <sd-icon [name]="camOn() ? 'video' : 'video-off'" [size]="20" />
                  </span>
                  <span class="hidden font-sans text-[10px] text-white/70 roomy:block">
                    {{ camOn() ? 'Stop Video' : 'Start Video' }}
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
                  class="flex flex-col items-center gap-1"
                  aria-label="Leave call"
                  (click)="leave()"
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
            <div class="mb-3 flex items-center justify-between">
              <h3 class="font-sans text-body font-semibold text-white">Latest Vitals</h3>
              <span class="font-sans text-caption text-white/40">{{ vitalsAsOf }}</span>
            </div>
            <div class="grid grid-cols-2 gap-2.5">
              @for (v of vitals; track v.label) {
                <div class="rounded-2xl bg-white/[0.04] p-3 text-center">
                  <p class="font-sans text-caption text-white/50">{{ v.label }}</p>
                  <p class="mt-0.5 font-heading text-h5 font-semibold text-white">{{ v.value }}</p>
                  <p class="font-sans text-[10px] text-white/40">{{ v.unit }}</p>
                </div>
              }
            </div>
          </div>

          <!-- Documents & records -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-3 font-sans text-body font-semibold text-white">Documents &amp; Records</h3>
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
                  <li class="flex items-center gap-3 py-2.5">
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-white/70">
                      <sd-icon [name]="r.kind === 'imaging' ? 'camera' : 'file-text'" [size]="18" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-sans text-body-sm font-medium text-white">{{ r.title }}</span>
                      <span class="font-sans text-caption text-white/45">{{ r.date }}</span>
                    </span>
                    <span class="rounded bg-white/[0.06] px-1.5 py-0.5 font-label text-[10px] text-white/60">
                      {{ r.badge }}
                    </span>
                    <button
                      type="button"
                      class="flex size-8 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
                      aria-label="Open document"
                      [disabled]="!r.url && !r.docId"
                      (click)="download(r)"
                    >
                      <sd-icon name="download" [size]="16" />
                    </button>
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

          <!-- Feedback -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4 text-center">
            <p class="font-sans text-body-sm font-medium text-white">How was your consultation?</p>
            <div class="mt-2 flex items-center justify-center gap-1.5">
              @for (n of stars; track n) {
                <button
                  type="button"
                  class="transition-transform hover:scale-110"
                  [attr.aria-label]="'Rate ' + n + ' star' + (n === 1 ? '' : 's')"
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
            <p class="mt-1.5 font-sans text-caption text-white/45">
              {{ rating() ? 'Thanks for your feedback!' : 'Your feedback helps us improve' }}
            </p>
          </div>
        </div>
      </div>
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

  private readonly localVideo = viewChild<ElementRef<HTMLDivElement>>('localVideo');
  private readonly remoteVideo = viewChild<ElementRef<HTMLDivElement>>('remoteVideo');
  private readonly previewVideo = viewChild<ElementRef<HTMLVideoElement>>('previewVideo');

  // ---- Call state ----
  protected readonly status = signal<'loading' | 'in-call' | 'ended' | 'error'>('loading');
  protected readonly errorMessage = signal('');
  /** Why the call ended on its own (set with status 'ended'). */
  protected readonly endedReason = signal<CallEndReason>('dropped');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly screenOn = signal(false);
  /** The doctor's video is on the main stage. */
  protected readonly remoteJoined = signal(false);
  /** Someone else (the doctor, a guest) is in the channel, camera on or off. */
  protected readonly remotePresent = signal(false);
  /** Everyone else who was in the call has left it. */
  protected readonly remoteLeft = signal(false);
  protected readonly moreOpen = signal(false);
  protected readonly elapsed = signal(0);

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
  private readonly patient = signal<PatientProfileDto | null>(null);
  private readonly health = signal<HealthProfileDto | null>(null);
  // The doctor's finalized write-up (available:false until they sign it).
  protected readonly summary = signal<ConsultationSummaryDto | null>(null);
  // Prescriptions the doctor has issued for this consultation.
  protected readonly issuedRx = signal<PrescriptionDto[]>([]);
  protected readonly labs = signal<LabOrderDto[]>([]);
  protected readonly carePlan = signal<PatientCarePlanDto | null>(null);
  protected readonly referrals = signal<ReferralDto[]>([]);
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

  // Vitals aren't captured in-app yet — show the panel structure with honest
  // empty values (never fabricated readings). Wire to a vitals endpoint later.
  protected readonly vitalsAsOf = 'Not yet recorded';
  protected readonly vitals: ReadonlyArray<{ label: string; value: string; unit: string }> = [
    { label: 'Blood Pressure', value: '—', unit: 'mmHg' },
    { label: 'Heart Rate', value: '—', unit: 'bpm' },
    { label: 'SpO₂', value: '—', unit: '%' },
    { label: 'Weight', value: '—', unit: 'kg' },
  ];
  /** The patient's medical-document library (loaded once in-call). */
  private readonly libraryDocs = signal<MedicalDocumentDto[]>([]);

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
  private appointmentId = '';
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
    this.remoteUids.clear();
    this.remoteSeen = false;
    this.firstWaitOver = false;
    this.remotePresent.set(false);
    this.remoteLeft.set(false);
    this.remoteJoined.set(false);
    let client: IAgoraRTCClient | undefined;
    try {
      const { data } = await firstValueFrom(this.appointments.callToken(this.appointmentId));
      if (this.left) return; // left while the token was on its way

      client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      const self = client;
      this.client = self;

      // Presence, not just video: the doctor may join with the camera off.
      self.on('user-joined', (user) => this.onRemoteJoined(self, user.uid));
      self.on('user-left', (user) => this.onRemoteLeft(self, user.uid));
      self.on('user-published', async (user, mediaType) => {
        this.onRemoteJoined(self, user.uid);
        await self.subscribe(user, mediaType);
        if (mediaType === 'video') {
          const el = this.remoteVideo()?.nativeElement;
          if (el) user.videoTrack?.play(el);
          this.remoteJoined.set(true);
        } else if (mediaType === 'audio') {
          user.audioTrack?.play();
        }
      });
      self.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'video') this.remoteJoined.set(false);
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
      // assigns the uid; any non-zero uid is honoured as-is.
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

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      if (this.left || this.client !== self) {
        // The call ended while the browser asked for the camera — don't leave it on.
        mic.close();
        cam.close();
        return;
      }
      this.micTrack = mic;
      this.camTrack = cam;

      const localEl = this.localVideo()?.nativeElement;
      if (localEl) cam.play(localEl);
      await self.publish([mic, cam]);
      if (this.left || this.client !== self) return;

      this.status.set('in-call');
      this.startTimer();
      if (this.holding) this.startLivePolls();
    } catch (err) {
      if (this.left || (client && this.client !== client)) return; // already handled
      // Not in a working call — let the idle timeout run again.
      this.connected = false;
      this.syncHold();
      this.session.release(CALL_HOLD);
      this.clearFirstWait();
      this.clearReconnectWatch();
      const failed = this.client;
      this.client = undefined;
      void this.releaseMedia(failed);
      this.errorMessage.set(apiErrorMessage(err, 'We couldn’t start the call. Please try again.'));
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
    this.remotePresent.set(true);
    this.remoteLeft.set(false);
    this.clearFirstWait();
    this.syncHold();
  }

  private onRemoteLeft(client: IAgoraRTCClient, uid: UID): void {
    if (client !== this.client || !this.remoteUids.delete(uid)) return;
    if (this.remoteUids.size > 0) return;
    // Everyone else has gone: the consultation is over unless they come back.
    this.remotePresent.set(false);
    this.remoteJoined.set(false);
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
    try {
      const res = await firstValueFrom(this.appointments.getMine(this.appointmentId));
      this.appointment.set(res.data);
      if (res.data.status !== 'completed' && res.data.status !== 'cancelled') return;
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
    this.syncHold();
    this.clearFirstWait();
    this.clearReconnectWatch();
    this.stopLivePolls();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopCaptions();
    this.client = undefined;
    void this.releaseMedia(client);
    this.remoteUids.clear();
    this.remotePresent.set(false);
    this.remoteLeft.set(false);
    this.remoteJoined.set(false);
    this.screenOn.set(false);
    this.recordingActive.set(false);
    this.endedReason.set(reason);
    this.status.set('ended');
    // One last look, so the notes show everything issued during the visit.
    void this.refreshClinical();
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
    try {
      for (const t of tracks) t?.close();
      await client?.leave();
    } catch {
      /* releasing devices — nothing actionable on failure */
    }
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
      const docs = await firstValueFrom(this.documentsApi.list({ per_page: 100 }));
      this.libraryDocs.set(docs.data ?? []);
    } catch {
      /* library optional in-call */
    }
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
      if (!this.client) return;
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
    if (!this.micTrack) return;
    const on = !this.micOn();
    await this.micTrack.setEnabled(on);
    this.micOn.set(on);
  }

  protected async toggleCam(): Promise<void> {
    if (!this.camTrack) return;
    const on = !this.camOn();
    await this.camTrack.setEnabled(on);
    this.camOn.set(on);
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
        if (this.camTrack) {
          await this.client.publish(this.camTrack);
          const el = this.localVideo()?.nativeElement;
          if (el) this.camTrack.play(el);
        }
        this.screenOn.set(false);
      } else {
        const track = (await AgoraRTC.createScreenVideoTrack({}, 'disable')) as ILocalVideoTrack;
        if (this.camTrack) await this.client.unpublish(this.camTrack);
        this.screenTrack = track;
        await this.client.publish(track);
        const el = this.localVideo()?.nativeElement;
        if (el) track.play(el);
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

  protected rate(n: number): void {
    this.rating.set(n);
  }

  protected invite(): void {
    // Guest invites are issued from the appointment (adds the guest fee); until
    // that flow is wired in-call, send the patient to manage it there.
    void this.router.navigate(['/dashboard/appointments']);
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

  protected async leave(): Promise<void> {
    await this.teardown();
    void this.router.navigate(['/dashboard/appointments']);
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
    await this.releaseMedia(client);
  }

  ngOnDestroy(): void {
    // Safety net: always drop the idle-timer hold, however the page is left.
    this.session.release(CALL_HOLD);
    void this.teardown();
  }
}
