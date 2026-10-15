import {
  afterNextRender,
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  ILocalTrack,
  IMicrophoneAudioTrack,
  UID,
} from 'agora-rtc-sdk-ng';
import { SessionTimeoutService } from '@supadoc/auth';
import {
  apiErrorFields,
  apiErrorMessage,
  AppointmentsApi,
  sendCallPresence,
  startCallPresence,
} from '@supadoc/data-access';
import type {
  CallMeetingDto,
  CallParticipantDto,
  CallParticipantRole,
  GuestConsentStateDto,
} from '@supadoc/models';
import {
  buildCallTiles,
  CallTilesComponent,
  CallUid,
  CallVideoPlayConfig,
  CallVideoTrack,
  IconComponent,
  RemoteParticipant,
  RemoteParticipants,
} from '@supadoc/ui';
import {
  callRefusal,
  type CallRefusal,
  callWhen,
  countdownLabel,
  deviceProblem,
  type DeviceProblem,
  deviceProblemText,
  doctorTitle,
  httpStatus,
  isFinalRefusal,
} from './call-helpers';
import { openLocalMedia } from './call-media';

/** Idle-timer hold key while a consultation is actually going on. */
const CALL_HOLD = 'call';
/**
 * How long someone alone in the channel keeps the idle timer paused while
 * waiting for the other side to first arrive (ms).
 */
const FIRST_JOIN_WAIT_MS = 30 * 60_000;
/**
 * Agora retries a lost connection on its own (RECONNECTING) without a time
 * limit; give up after this long (ms) so a dead connection can't keep the idle
 * timer paused. The user can rejoin.
 */
const RECONNECT_GIVE_UP_MS = 2 * 60_000;
/** How often a guest in the call re-reads whether the consultation is being recorded (ms). */
const RECORDING_CHECK_MS = 20_000;
/**
 * The consultation was completed while others are still talking (saying
 * goodbye): leave when they have gone, or after this long at the latest (ms).
 */
const ENDED_GRACE_MS = 60_000;
/** A guest's name in the call (the API's limit). */
const MAX_NAME = 60;
/**
 * An early guest's camera and microphone switch on for the check this long
 * before joining opens (ms) — not for the whole countdown, unless asked to.
 */
const MEDIA_LEAD_MS = 10 * 60_000;
/** This page's own 1:1 self view, as it has always been: top-right, larger than the consultation room's. */
const SELF_VIEW_CLASS = 'right-5 top-5 h-40 w-28 rounded-2xl border border-white/15 bg-ink shadow-lg sm:h-44 sm:w-32';
/** The grid's padding, its bottom row clear of this page's bigger controls (bottom-6, 48px buttons). */
const GRID_CLASS = 'p-1.5 pb-[6.5rem] roomy:p-2 roomy:pb-[7rem]';

/** Where the page is. */
type Stage = 'checking' | 'lobby' | 'joining' | 'in-call' | 'left' | 'final' | 'not-configured' | 'error';

interface DeviceOption {
  readonly id: string;
  readonly label: string;
}

/** A link that can't be used any more (or yet): what the final screen says. */
interface FinalScreen {
  readonly title: string;
  readonly message: string;
  readonly icon: string;
}

const FINAL: Record<string, { title: string; icon: string }> = {
  cancelled: { title: 'This consultation was cancelled', icon: 'calendar-off' },
  ended: { title: 'This consultation has ended', icon: 'circle-check' },
  withdrawn: { title: 'This invitation was withdrawn', icon: 'user-x' },
  not_confirmed: { title: 'This consultation isn’t confirmed yet', icon: 'hourglass' },
  // A doctor's link refused for their standing (the API's message says what to do).
  doctor_suspended: { title: 'Your account can no longer take consultations', icon: 'lock' },
  doctor_not_approved: { title: 'Your account can’t take consultations yet', icon: 'lock' },
  terms_required: { title: 'Accept the updated practitioner terms first', icon: 'scroll-text' },
};

const ROLE_LABEL: Record<CallParticipantRole, string> = {
  patient: 'patient',
  doctor: 'doctor',
  guest: 'guest',
};

/**
 * Preauthenticated call join (Agora RTC). Public route `/call/join/:token` — the
 * signed token from the invite email IS the credential, so patient, doctor and
 * guests join the same appointment channel without logging in.
 *
 * First a lobby (GET .../lobby): the consultation (doctor, local time, who
 * invited a guest), the name a guest shows as, a camera + microphone preview
 * with device pickers and on/off switches, and — for a guest — the privacy
 * notice (and recording consent when recording could happen) to accept, which
 * is POSTed before joining. An early guest counts down to when joining opens
 * (their camera and microphone stay off until 10 minutes before, unless they
 * check them); a cancelled / ended / withdrawn link gets a final screen. A missing, blocked
 * or busy device is named as such, and the call can be joined audio-only or
 * without either.
 *
 * In the call, everyone gets their own tile (`<sd-call-tiles>`): today's 1:1
 * stage with one other person, a grid from three. The RTC token is renewed
 * before it expires, the heartbeat pushes a removed guest out (410), and a
 * guest sees when the consultation is being recorded.
 */
@Component({
  selector: 'pat-call-join',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CallTilesComponent, IconComponent],
  host: { class: 'block min-h-dvh bg-abyss' },
  template: `
    <div class="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 p-4">
      <!-- Brand + who -->
      <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-white">
        <span class="font-heading text-h5 tracking-tight">
          <span class="text-frost">Video</span><span class="text-sage">Med</span>
        </span>
        <div class="flex min-w-0 items-center gap-2">
          @if (recordingActive() && stage() === 'in-call') {
            <span
              class="flex shrink-0 items-center gap-1.5 rounded-pill bg-alert/90 px-3 py-1 font-sans text-caption font-medium text-white"
            >
              <span class="size-2 animate-pulse rounded-full bg-white" aria-hidden="true"></span>
              Recording
            </span>
          }
          @if (meeting(); as m) {
            <span class="truncate font-sans text-caption text-white/70">
              {{ m.you.name }} · joining as {{ roleLabel(m.you.role) }}
            </span>
          }
        </div>
      </header>

      <!-- Call state changes, for screen readers -->
      <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>

      @switch (stage()) {
        @case ('checking') {
          <div class="flex flex-1 flex-col items-center justify-center gap-4 text-white/85" role="status">
            <span class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white"></span>
            <p class="font-sans text-body">Checking your link…</p>
          </div>
        }

        @case ('lobby') {
          @if (meeting(); as m) {
            <div class="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start">
              <!-- Camera + microphone check -->
              <section
                class="flex flex-col gap-3 rounded-card border border-white/10 bg-white/[0.03] p-3 sm:p-4"
                aria-labelledby="devices-title"
              >
                <h2 id="devices-title" class="sr-only">Camera and microphone check</h2>
                <div class="relative aspect-video w-full overflow-hidden rounded-2xl bg-ink">
                  <div #preview class="absolute inset-0"></div>
                  @if (!mediaChecked()) {
                    <!-- Early: the camera and microphone stay off until shortly before joining opens -->
                    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
                      <p class="max-w-xs font-sans text-body-sm">
                        Your camera and microphone stay off until 10 minutes before joining opens.
                      </p>
                      <button
                        type="button"
                        class="flex min-h-11 items-center gap-2 rounded-field bg-white/10 px-4 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                        (click)="checkDevices()"
                      >
                        <sd-icon name="video" [size]="16" /> Check camera and microphone
                      </button>
                    </div>
                  } @else if (!previewHasVideo()) {
                    <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/60">
                      <span
                        class="flex size-16 items-center justify-center rounded-full bg-white/10 font-heading text-h5 font-semibold text-white"
                        aria-hidden="true"
                      >
                        {{ initials() }}
                      </span>
                      <p class="font-sans text-body-sm">
                        {{ camOn() ? (mediaBusy() ? 'Starting your camera…' : 'Camera unavailable') : 'Your camera is off' }}
                      </p>
                    </div>
                  }
                  <!-- On / off switches over the preview -->
                  @if (mediaChecked()) {
                    <div class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-pill bg-abyss/70 px-3 py-2 backdrop-blur">
                      <button
                        type="button"
                        class="flex size-11 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60"
                        [class]="micLive() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                        [attr.aria-label]="micLive() ? 'Turn microphone off' : 'Turn microphone on'"
                        [disabled]="mediaBusy() || joinBusy()"
                        (click)="toggleMic()"
                      >
                        <sd-icon [name]="micLive() ? 'mic' : 'mic-off'" [size]="20" />
                      </button>
                      <button
                        type="button"
                        class="flex size-11 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60"
                        [class]="camLive() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                        [attr.aria-label]="camLive() ? 'Turn camera off' : 'Turn camera on'"
                        [disabled]="mediaBusy() || joinBusy()"
                        (click)="toggleCam()"
                      >
                        <sd-icon [name]="camLive() ? 'video' : 'video-off'" [size]="20" />
                      </button>
                    </div>
                  }
                </div>

                @if (mediaChecked()) {
                  <!-- Microphone level -->
                  <div class="flex items-center gap-2">
                    <sd-icon
                      [name]="micOn() && hasMic() ? 'mic' : 'mic-off'"
                      [size]="16"
                      [class]="micOn() && hasMic() ? 'text-success' : 'text-white/40'"
                    />
                    <span class="whitespace-nowrap font-sans text-body-sm text-white/80">
                      {{ micOn() ? (hasMic() ? 'Microphone' : 'Microphone unavailable') : 'Microphone off' }}
                    </span>
                    <span class="h-2 flex-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
                      <span
                        class="block h-full rounded-full bg-success transition-[width] duration-100"
                        [style.width.%]="micLevel() * 100"
                      ></span>
                    </span>
                  </div>

                  <!-- Device pickers -->
                  <div class="grid gap-3 sm:grid-cols-2">
                    <label class="flex min-w-0 flex-col gap-1">
                      <span class="font-sans text-caption font-semibold text-white/70">Camera</span>
                      <select
                        class="min-h-11 w-full rounded-field border border-white/15 bg-white/5 px-3 font-sans text-body-sm text-white focus:border-sky focus:outline-none disabled:opacity-60"
                        [disabled]="cameras().length === 0 || mediaBusy()"
                        (change)="pickCamera($any($event.target).value)"
                      >
                        @for (d of cameras(); track d.id) {
                          <option class="bg-white text-ink" [value]="d.id" [selected]="d.id === cameraId()">{{ d.label }}</option>
                        } @empty {
                          <option class="bg-white text-ink" value="">No camera found</option>
                        }
                      </select>
                    </label>
                    <label class="flex min-w-0 flex-col gap-1">
                      <span class="font-sans text-caption font-semibold text-white/70">Microphone</span>
                      <select
                        class="min-h-11 w-full rounded-field border border-white/15 bg-white/5 px-3 font-sans text-body-sm text-white focus:border-sky focus:outline-none disabled:opacity-60"
                        [disabled]="microphones().length === 0 || mediaBusy()"
                        (change)="pickMicrophone($any($event.target).value)"
                      >
                        @for (d of microphones(); track d.id) {
                          <option class="bg-white text-ink" [value]="d.id" [selected]="d.id === microphoneId()">{{ d.label }}</option>
                        } @empty {
                          <option class="bg-white text-ink" value="">No microphone found</option>
                        }
                      </select>
                    </label>
                  </div>
                }

                <!-- What went wrong with a device, and what to do -->
                @if (camOn() && camProblem(); as p) {
                  <p class="flex items-start gap-2 font-sans text-caption text-warning" role="alert">
                    <sd-icon name="camera-off" [size]="16" class="mt-0.5 shrink-0" />{{ problemText('camera', p) }}
                  </p>
                }
                @if (micOn() && micProblem(); as p) {
                  <p class="flex items-start gap-2 font-sans text-caption text-warning" role="alert">
                    <sd-icon name="mic-off" [size]="16" class="mt-0.5 shrink-0" />{{ problemText('microphone', p) }}
                  </p>
                }
                @if ((camOn() && camProblem()) || (micOn() && micProblem())) {
                  <button
                    type="button"
                    class="flex min-h-11 w-fit items-center gap-2 rounded-field border border-white/15 px-4 font-sans text-body-sm font-semibold text-white/85 transition-colors hover:bg-white/10 disabled:opacity-60"
                    [disabled]="mediaBusy()"
                    (click)="retryDevices()"
                  >
                    <sd-icon name="refresh-cw" [size]="16" /> Try again
                  </button>
                }
              </section>

              <!-- The consultation, the notice, Join -->
              <section
                class="flex flex-col gap-4 rounded-card border border-white/10 bg-white/[0.03] p-4 text-white sm:p-5"
                aria-labelledby="lobby-title"
              >
                <div class="flex flex-col gap-1.5">
                  <h1 id="lobby-title" class="font-heading text-h5 text-white">
                    @if (isGuest()) {
                      {{ inviter() }} invited you to join their video consultation
                    } @else {
                      Your video consultation
                    }
                  </h1>
                  <p class="flex items-center gap-1.5 font-sans text-body-sm text-white/80">
                    <sd-icon name="stethoscope" [size]="16" class="shrink-0 text-frost" />
                    with {{ doctorName() }}@if (m.specialist.specialty) { · {{ m.specialist.specialty }} }
                  </p>
                  <p class="flex items-center gap-1.5 font-sans text-body-sm text-white/80">
                    <sd-icon name="calendar-clock" [size]="16" class="shrink-0 text-frost" />
                    {{ when() }}
                  </p>
                </div>

                @if (isGuest()) {
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-white/70">Your name in the call</span>
                    <input
                      #nameInput
                      type="text"
                      autocomplete="name"
                      [attr.maxlength]="maxName"
                      class="min-h-11 w-full rounded-field border bg-white/5 px-3 font-sans text-body-sm text-white placeholder:text-white/40 focus:border-sky focus:outline-none"
                      [class]="nameError() ? 'border-alert' : 'border-white/15'"
                      [attr.aria-invalid]="!!nameError()"
                      aria-describedby="name-hint"
                      [value]="displayName()"
                      [disabled]="joinBusy()"
                      (input)="setName($any($event.target).value)"
                    />
                    <span id="name-hint" class="font-sans text-caption" [class]="nameError() ? 'text-alert' : 'text-white/50'">
                      {{ nameError() || 'The doctor and ' + inviter() + ' see this name.' }}
                    </span>
                  </label>

                  <!-- Privacy notice (+ recording consent when recording could happen) -->
                  <div class="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 sm:p-4">
                    <p class="flex items-center gap-1.5 font-sans text-body-sm font-semibold text-white">
                      <sd-icon name="shield-check" [size]="16" class="text-frost" />
                      {{ consentRequired() ? 'Privacy and recording notice' : 'Privacy notice' }}
                    </p>
                    <ul class="flex list-disc flex-col gap-1.5 pl-5 font-sans text-caption text-white/70">
                      <li>
                        You’re joining a private medical consultation as {{ inviter() }}’s guest. Please keep
                        what you see and hear confidential.
                      </li>
                      <li>
                        Everyone in the call sees your name, and your camera and microphone while they’re on.
                        You can turn them off, or leave, at any time.
                      </li>
                      @if (consent()?.recording_active) {
                        <li class="font-semibold text-white/85">
                          This consultation is being recorded for the patient’s medical record. Joining means you
                          agree to be included in the recording.
                        </li>
                      } @else if (consent()?.recording_possible) {
                        <li class="font-semibold text-white/85">
                          This consultation may be recorded for the patient’s medical record. You’ll see a
                          “Recording” sign while it is. Joining means you agree to be included.
                        </li>
                      } @else {
                        <li>
                          If the consultation is recorded later, you’ll see a “Recording” sign, and accepting this
                          notice covers being included.
                        </li>
                      }
                      <li>Guests never see the patient’s health records.</li>
                    </ul>
                    <label class="flex min-h-11 cursor-pointer items-start gap-3">
                      <input
                        #agreeBox
                        type="checkbox"
                        class="mt-0.5 size-5 shrink-0 accent-cerulean"
                        [checked]="agreed()"
                        [disabled]="joinBusy()"
                        (change)="setAgreed($any($event.target).checked)"
                      />
                      <span class="font-sans text-body-sm text-white/85">
                        {{
                          consentRequired()
                            ? 'I agree to the privacy notice and to being recorded'
                            : 'I have read and agree to the privacy notice'
                        }}
                      </span>
                    </label>
                  </div>
                }

                @if (lobbyError()) {
                  <p class="flex items-start gap-2 rounded-field bg-alert/15 px-3 py-2.5 font-sans text-body-sm text-white" role="alert">
                    <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0 text-alert" />{{ lobbyError() }}
                  </p>
                }

                @if (!canJoinNow()) {
                  <p class="flex items-start gap-2 rounded-field bg-white/5 px-3 py-2.5 font-sans text-body-sm text-white/85">
                    <sd-icon name="timer" [size]="16" class="mt-0.5 shrink-0 text-frost" />
                    <span>
                      Joining opens 15 minutes before the start, in
                      <span class="font-semibold tabular-nums text-white">{{ countdown() }}</span>. This page
                      lets you in then.
                    </span>
                  </p>
                }

                <button
                  type="button"
                  class="flex min-h-12 w-full items-center justify-center gap-2 rounded-field bg-cerulean px-6 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:cursor-not-allowed disabled:opacity-60"
                  [disabled]="!canJoinNow() || joinBusy()"
                  (click)="join()"
                >
                  @if (joinBusy()) {
                    <sd-icon name="loader-circle" [size]="20" class="animate-spin" />
                  } @else {
                    <sd-icon [name]="canJoinNow() ? 'video' : 'timer'" [size]="20" />
                  }
                  {{ joinLabel() }}
                </button>
                @if (canJoinNow() && (camOn() || micOn())) {
                  <button
                    type="button"
                    class="min-h-11 font-sans text-body-sm text-white/60 underline-offset-2 transition-colors hover:text-white hover:underline disabled:opacity-60"
                    [disabled]="joinBusy()"
                    (click)="joinWithoutDevices()"
                  >
                    Join without camera or microphone
                  </button>
                }
              </section>
            </div>
          }
        }

        @case ('final') {
          @if (finalScreen(); as f) {
            <div class="flex flex-1 items-center justify-center">
              <section
                class="flex w-full max-w-md flex-col items-center gap-4 rounded-card border border-white/10 bg-white/[0.03] px-6 py-10 text-center text-white/85"
                aria-labelledby="final-title"
              >
                <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                  <sd-icon [name]="f.icon" [size]="28" />
                </span>
                <h1 #finalHeading id="final-title" tabindex="-1" class="font-heading text-h5 text-white outline-none">
                  {{ f.title }}
                </h1>
                <p class="font-sans text-body-sm text-white/70">{{ f.message }}</p>
                @if (meeting()) {
                  <p class="font-sans text-caption text-white/50">{{ doctorName() }} · {{ when() }}</p>
                }
                <p class="font-sans text-caption text-white/50">You can close this page.</p>
              </section>
            </div>
          }
        }

        @case ('not-configured') {
          <div class="flex flex-1 items-center justify-center">
            <section class="flex w-full max-w-md flex-col items-center gap-4 rounded-card border border-white/10 bg-white/[0.03] px-6 py-10 text-center text-white/85">
              <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                <sd-icon name="calendar-check" [size]="28" />
              </span>
              @if (meeting()) {
                <p class="font-sans text-body">
                  You're confirmed for a consultation with
                  <span class="font-semibold text-white">{{ doctorName() }}</span>.
                </p>
                <p class="font-sans text-body-sm text-white/70">{{ when() }}</p>
              }
              <p class="max-w-sm font-sans text-caption text-white/60">
                Video calling isn't enabled on this environment yet. Your join link stays valid — reopen it once
                video is live.
              </p>
            </section>
          </div>
        }

        @case ('error') {
          <div class="flex flex-1 items-center justify-center">
            <section class="flex w-full max-w-md flex-col items-center gap-4 rounded-card border border-white/10 bg-white/[0.03] px-6 py-10 text-center text-white/85">
              <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                <sd-icon name="video-off" [size]="28" />
              </span>
              <h1 #finalHeading tabindex="-1" class="max-w-sm font-sans text-body text-white outline-none">{{ errorMessage() }}</h1>
              @if (canRetry()) {
                <button
                  type="button"
                  class="flex min-h-11 items-center gap-2 rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                  (click)="retryLink()"
                >
                  <sd-icon name="refresh-cw" [size]="16" /> Try again
                </button>
              }
            </section>
          </div>
        }
      }

      <!-- A camera / microphone that isn't in the call (above the stage, never over a tile) -->
      @if (stage() === 'in-call' && inCallNotice()) {
        <p class="flex items-start gap-2 rounded-field bg-white/5 px-3 py-2 font-sans text-caption text-white/85" role="status">
          <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-warning" />{{ inCallNotice() }}
        </p>
      }

      <!-- The call stage — always in the page (hidden outside the call), so every
           participant's video has a tile to play in. 1:1 looks as this page always
           has: the other person full size, your own view top-right, big controls. -->
      <div
        class="sd-stage relative min-h-[24rem] flex-1 overflow-hidden rounded-card bg-abyss [container-name:stage] [container-type:size]"
        [class.hidden]="!onStage()"
      >
        <sd-call-tiles [tiles]="tiles()" [showRole]="true" [selfViewClass]="selfViewClass" [gridClass]="gridClass" />

        @if (stage() === 'joining') {
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/85" role="status">
            <span class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white"></span>
            <p class="font-sans text-body">Connecting to the consultation…</p>
          </div>
        }

        <!-- Nobody else here (yet, or any more) -->
        @if (stage() === 'in-call' && !hasRemoteTile()) {
          <div
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 pb-20 pt-12 text-center text-white/80"
          >
            @if (remoteLeft()) {
              <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                <sd-icon name="user-x" [size]="30" />
              </span>
              <p class="font-sans text-body-sm roomy:text-body">Everyone else has left the call.</p>
              <p class="hidden max-w-sm font-sans text-caption text-white/60 roomy:block">
                If the consultation is finished, press the red button to leave.
              </p>
            } @else {
              <span class="hidden size-16 items-center justify-center rounded-full bg-white/10 tall:flex">
                <sd-icon name="user-round" [size]="30" />
              </span>
              <p class="font-sans text-body-sm roomy:text-body">{{ waitingText() }}</p>
              @if (meeting()) {
                <p class="hidden font-sans text-caption text-white/60 roomy:block">{{ when() }}</p>
              }
            }
          </div>
        }

        <!-- Left / dropped -->
        @if (stage() === 'left') {
          <div class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-ink px-6 text-center text-white/85">
            <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
              <sd-icon [name]="endedReason() === 'left' ? 'phone-off' : 'wifi-off'" [size]="28" />
            </span>
            @if (endedReason() === 'left') {
              <p class="max-w-sm font-sans text-body">You left the call.</p>
            } @else {
              <p class="max-w-sm font-sans text-body">You were disconnected from the call.</p>
              <p class="max-w-sm font-sans text-caption text-white/60">
                Check your internet connection, then rejoin. If you opened this link in another tab or on another
                device, the call carries on there.
              </p>
            }
            <button
              type="button"
              class="flex min-h-11 items-center gap-2 rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-60"
              [disabled]="joinBusy()"
              (click)="rejoin()"
            >
              <sd-icon name="refresh-cw" [size]="16" /> Rejoin call
            </button>
          </div>
        }

        @if (stage() === 'in-call') {
          <!-- Controls (48px targets; the grid keeps its bottom row clear of them) -->
          <div
            class="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-4 rounded-pill bg-abyss/70 px-5 py-3 backdrop-blur"
          >
            <button
              type="button"
              class="flex size-12 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60"
              [class]="micLive() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
              [attr.aria-label]="micLive() ? 'Mute microphone' : 'Unmute microphone'"
              [disabled]="mediaBusy()"
              (click)="toggleMic()"
            >
              <sd-icon [name]="micLive() ? 'mic' : 'mic-off'" [size]="22" />
            </button>
            <button
              type="button"
              class="flex size-12 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60"
              [class]="camLive() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
              [attr.aria-label]="camLive() ? 'Turn camera off' : 'Turn camera on'"
              [disabled]="mediaBusy()"
              (click)="toggleCam()"
            >
              <sd-icon [name]="camLive() ? 'video' : 'video-off'" [size]="22" />
            </button>
            <button
              type="button"
              class="flex size-12 items-center justify-center rounded-full bg-alert text-white transition-colors hover:bg-alert/80"
              aria-label="Leave call"
              (click)="leave()"
            >
              <sd-icon name="phone-off" [size]="22" />
            </button>
          </div>
        }
      </div>
    </div>
  `,
})
export class CallJoin implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly appointments = inject(AppointmentsApi);
  private readonly injector = inject(Injector);
  /**
   * Provided app-wide. A patient signed in to the portal in this browser must
   * not get the idle warning (or be signed out) over a live call; a no-op for
   * a guest who isn't signed in.
   */
  private readonly session = inject(SessionTimeoutService);

  private readonly preview = viewChild<ElementRef<HTMLDivElement>>('preview');
  private readonly stageTiles = viewChild(CallTilesComponent);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly agreeBox = viewChild<ElementRef<HTMLInputElement>>('agreeBox');
  private readonly finalHeading = viewChild<ElementRef<HTMLElement>>('finalHeading');

  /** The signed join link — a bearer credential: never logged. */
  private readonly token = this.route.snapshot.paramMap.get('token') ?? '';
  protected readonly maxName = MAX_NAME;
  protected readonly selfViewClass = SELF_VIEW_CLASS;
  protected readonly gridClass = GRID_CLASS;

  protected readonly stage = signal<Stage>('checking');
  protected readonly meeting = signal<CallMeetingDto | null>(null);
  /** Everyone who may be in the call, by Agora uid (names only) — labels the tiles. */
  private readonly participants = signal<readonly CallParticipantDto[]>([]);
  protected readonly consent = signal<GuestConsentStateDto | null>(null);
  protected readonly finalScreen = signal<FinalScreen | null>(null);
  protected readonly errorMessage = signal('');
  /** The error screen offers "Try again" (a network or server hiccup, not a bad link). */
  protected readonly canRetry = signal(false);
  protected readonly lobbyError = signal('');
  protected readonly joinBusy = signal(false);
  /** How the call ended (stage 'left'). */
  protected readonly endedReason = signal<'left' | 'dropped'>('left');
  protected readonly announcement = signal('');
  protected readonly recordingActive = signal(false);
  /** A device that failed or went away during the call. */
  protected readonly inCallNotice = signal('');

  // ---- Lobby form ----
  protected readonly displayName = signal('');
  protected readonly nameError = signal('');
  protected readonly agreed = signal(false);

  // ---- When joining opens (a guest, early) — counted on the server's clock ----
  /** Server time minus this device's time (ms), so a wrong device clock doesn't matter. */
  private serverOffset = 0;
  /** Joining opens then (ms, server clock); null = open now. */
  private readonly opensAt = signal<number | null>(null);
  private readonly now = signal(Date.now());
  private clockTimer?: ReturnType<typeof setInterval>;

  // ---- Devices ----
  /** The person wants their microphone / camera on (whether or not it opened). */
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  /** The microphone / camera track is open. */
  protected readonly hasMic = signal(false);
  protected readonly hasCam = signal(false);
  protected readonly micProblem = signal<DeviceProblem | null>(null);
  protected readonly camProblem = signal<DeviceProblem | null>(null);
  protected readonly mediaBusy = signal(false);
  protected readonly cameras = signal<DeviceOption[]>([]);
  protected readonly microphones = signal<DeviceOption[]>([]);
  protected readonly cameraId = signal('');
  protected readonly microphoneId = signal('');
  protected readonly micLevel = signal(0);
  /** The devices have been asked for (on opening the lobby, near the start, or "Check camera and microphone"). */
  protected readonly mediaChecked = signal(false);
  private meterTimer?: ReturnType<typeof setInterval>;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  /** Bumped whenever the tracks are released, so devices that open late are closed again. */
  private mediaGen = 0;
  private mediaTask: Promise<void> | null = null;
  private readonly onDeviceChange = (): void => void this.refreshDevices();

  // ---- The call ----
  private client?: IAgoraRTCClient;
  /** The uid this page joined as ('self' when Agora assigned one). */
  private readonly selfUid = signal<CallUid>('self');
  private readonly remoteList = signal<readonly RemoteParticipant[]>([]);
  private readonly remotes = new RemoteParticipants((list) => this.remoteList.set(list));
  private unbindRemotes?: () => void;
  /** Video tracks handed to the stage, by uid — replayed if its tiles are re-created. */
  private readonly videos = new Map<string, { uid: CallUid; track: CallVideoTrack; config?: CallVideoPlayConfig }>();
  /** Everyone else who was in the call has left it. */
  protected readonly remoteLeft = signal(false);
  /** This page is going away — final. */
  private destroyed = false;
  /** Joined to the channel (false again once the call is left or drops). */
  private connected = false;
  /** Was in the call at some point (the final screen thanks them). */
  private everJoined = false;
  /** Whether this page currently holds the idle timer. */
  private holding = false;
  private readonly remoteUids = new Set<UID>();
  private remoteSeen = false;
  private firstWaitOver = false;
  private firstWaitTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private recordingTimer?: ReturnType<typeof setInterval>;
  /** The guest's join window has closed mid-call: the recording state comes from the join payload. */
  private recordingViaJoin = false;
  /** The consultation was completed while others are still here: leave once they go. */
  private endedPending: CallRefusal | null = null;
  private endedGraceTimer?: ReturnType<typeof setTimeout>;
  /** Stops the "in the call" heartbeat; set only while one is running. */
  private heartbeatStop?: () => void;

  // ---- Derived ----
  protected readonly isGuest = computed(() => this.meeting()?.you.role === 'guest');
  protected readonly inviter = computed(() => this.meeting()?.invited_by?.first_name?.trim() || 'The patient');
  protected readonly doctorName = computed(() => doctorTitle(this.meeting()?.specialist.name));
  protected readonly when = computed(() => callWhen(this.meeting()?.scheduled_at));
  protected readonly consentRequired = computed(() => this.isGuest() && !!this.consent()?.required);
  private readonly remainingMs = computed(() => {
    const at = this.opensAt();
    return at === null ? 0 : at - (this.now() + this.serverOffset);
  });
  protected readonly canJoinNow = computed(() => this.remainingMs() <= 0);
  protected readonly countdown = computed(() => countdownLabel(this.remainingMs()));
  protected readonly onStage = computed(() => ['joining', 'in-call', 'left'].includes(this.stage()));
  protected readonly previewHasVideo = computed(() => this.camOn() && this.hasCam());
  protected readonly micLive = computed(() => this.micOn() && this.hasMic());
  protected readonly camLive = computed(() => this.camOn() && this.hasCam());
  protected readonly initials = computed(() => {
    const words = this.displayName().trim().split(/\s+/).filter(Boolean);
    return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[words.length - 1][0] ?? '') : '')).toUpperCase() || '?';
  });
  protected readonly joinLabel = computed(() => {
    if (this.joinBusy()) return 'Joining…';
    if (!this.canJoinNow()) return `Join opens in ${this.countdown()}`;
    const video = this.camOn() && this.hasCam();
    const audio = this.micOn() && this.hasMic();
    if (video && audio) return 'Join call';
    if (audio) return 'Join with audio only';
    if (video) return 'Join without microphone';
    return 'Join without camera or microphone';
  });
  protected readonly waitingText = computed(() => {
    const role = this.meeting()?.you.role;
    if (role === 'doctor') return 'Waiting for the patient to join…';
    if (role === 'guest') return `Waiting for ${this.inviter()} and ${this.doctorName()} to join…`;
    return `Waiting for ${this.doctorName()} to join…`;
  });

  /** Everyone on the stage: the other people connected, by uid, and this person. */
  protected readonly tiles = computed(() => {
    const you = this.meeting()?.you;
    return buildCallTiles({
      remotes: this.remoteList(),
      roster: this.participants(),
      self:
        this.stage() === 'in-call' && you
          ? {
              uid: this.selfUid(),
              role: you.role,
              name: you.name,
              hasVideo: this.camLive(),
              muted: !this.micLive(),
            }
          : null,
    });
  });
  protected readonly hasRemoteTile = computed(() => this.tiles().some((t) => !t.self));

  constructor() {
    // The stage's tiles exist from the first render; replay any video handed
    // over before then (or if they are ever re-created).
    effect(() => {
      const tiles = this.stageTiles();
      if (!tiles) return;
      untracked(() => {
        for (const v of this.videos.values()) tiles.attach(v.uid, v.track, v.config);
      });
    });
  }

  ngAfterViewInit(): void {
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
    void this.loadLobby();
  }

  protected roleLabel(role: CallParticipantRole): string {
    return ROLE_LABEL[role] ?? 'guest';
  }

  protected problemText(device: 'camera' | 'microphone', p: DeviceProblem): string {
    return deviceProblemText(device, p);
  }

  // ---- Lobby ----

  /** What the link is for and whether it can be used, without joining. */
  private async loadLobby(): Promise<void> {
    this.stage.set('checking');
    try {
      let lobby: CallMeetingDto & { server_time?: string; can_join?: boolean };
      try {
        lobby = (await firstValueFrom(this.appointments.joinLobby(this.token))).data;
      } catch (err) {
        // An API without the lobby yet: the join payload carries the same details.
        if (httpStatus(err) !== 404 && httpStatus(err) !== 405) throw err;
        lobby = (await firstValueFrom(this.appointments.joinInfo(this.token))).data;
      }
      if (this.destroyed) return;
      this.applyMeeting(lobby);
      this.serverOffset = lobby.server_time ? Date.parse(lobby.server_time) - Date.now() : 0;
      if (!Number.isFinite(this.serverOffset)) this.serverOffset = 0;
      const opens = lobby.can_join === false && lobby.opens_at ? Date.parse(lobby.opens_at) : NaN;
      this.opensAt.set(Number.isFinite(opens) ? opens : null);
      this.displayName.set(lobby.you.name);
      this.agreed.set(!!lobby.consent?.given);
      this.enterLobby();
      this.lobbyMedia();
    } catch (err) {
      this.failLink(err);
    }
  }

  /** The meeting details from any call payload (lobby, join, consent). */
  private applyMeeting(m: CallMeetingDto): void {
    this.meeting.set(m);
    if (m.participants) this.participants.set(m.participants);
    if (m.consent) {
      this.consent.set(m.consent);
      this.setRecording(m.consent.recording_active);
    }
  }

  private enterLobby(): void {
    this.stage.set('lobby');
    this.startClock();
    this.startMeter();
    this.showLocalVideo();
  }

  /** The link can't be opened: a final screen (cancelled, ended, withdrawn…) or an error. */
  private failLink(err: unknown): void {
    if (this.destroyed) return;
    const refusal = callRefusal(err);
    if (refusal && isFinalRefusal(refusal)) {
      this.showFinal(refusal);
      return;
    }
    const status = httpStatus(err);
    this.canRetry.set(status === 0 || status >= 500);
    this.errorMessage.set(
      status === 401 || status === 404
        ? 'This join link is invalid or has expired. Ask the person who sent it for a new one.'
        : apiErrorMessage(err, 'We couldn’t open this call. Please try again.'),
    );
    this.stopEverything();
    this.stage.set('error');
    this.focusLater(() => this.finalHeading()?.nativeElement);
  }

  protected retryLink(): void {
    if (this.stage() !== 'error') return;
    void this.loadLobby();
  }

  /** A cancelled / ended / withdrawn / unconfirmed consultation: nothing more to do here. */
  private showFinal(refusal: CallRefusal): void {
    const known = refusal.code ? FINAL[refusal.code] : undefined;
    const fallback = refusal.status === 409 ? FINAL['not_confirmed'] : FINAL['ended'];
    const { title, icon } = known ?? fallback;
    // The API's sentence, unless it only repeats the title.
    const said = refusal.message.trim().replace(/\.$/, '');
    const message =
      said && said.toLowerCase() !== title.toLowerCase()
        ? refusal.message
        : refusal.code === 'ended'
          ? this.everJoined
            ? 'Thank you for joining.'
            : 'It’s over, so this link can’t be used any more.'
          : 'There is no call to join with this link.';
    this.stopEverything();
    this.finalScreen.set({ title, message, icon });
    this.stage.set('final');
    this.announce(title);
    this.focusLater(() => this.finalHeading()?.nativeElement);
  }

  protected setName(value: string): void {
    this.displayName.set(value);
    if (this.nameError()) this.nameError.set('');
  }

  protected setAgreed(value: boolean): void {
    this.agreed.set(value);
    if (value && this.lobbyError()) this.lobbyError.set('');
  }

  /** Ticks the countdown while joining isn't open yet; says so when it opens. */
  private startClock(): void {
    if (this.clockTimer || this.opensAt() === null) return;
    this.now.set(Date.now());
    this.clockTimer = setInterval(() => {
      this.now.set(Date.now());
      // Nearly time: the camera and microphone come on for the check.
      if (!this.mediaChecked() && this.stage() === 'lobby' && this.remainingMs() <= MEDIA_LEAD_MS) this.lobbyMedia();
      if (this.canJoinNow()) {
        this.stopClock();
        this.opensAt.set(null);
        if (this.stage() === 'lobby') this.announce('Joining is open — you can join the call now.');
      }
    }, 1000);
  }

  private stopClock(): void {
    clearInterval(this.clockTimer);
    this.clockTimer = undefined;
  }

  // ---- Devices ----

  /**
   * The lobby's camera and microphone: on at once when joining is open or
   * nearly so; an early guest's stay off (no camera light for hours) until
   * {@link MEDIA_LEAD_MS} before, or until they check them.
   */
  private lobbyMedia(): void {
    if (!this.mediaChecked() && this.remainingMs() > MEDIA_LEAD_MS) return;
    this.checkDevices();
  }

  /** "Check camera and microphone" (and the lobby's automatic check). */
  protected checkDevices(): void {
    this.mediaChecked.set(true);
    void this.ensureMedia();
  }

  /**
   * Open the devices the person wants and doesn't have yet (one request at a
   * time). Used by the lobby, by turning a device on, and before (re)joining.
   */
  private ensureMedia(): Promise<void> {
    this.mediaTask ??= this.openWanted().finally(() => (this.mediaTask = null));
    return this.mediaTask;
  }

  private async openWanted(): Promise<void> {
    const wantMic = this.micOn() && !this.micTrack;
    const wantCam = this.camOn() && !this.camTrack;
    if (!wantMic && !wantCam) return;
    const gen = this.mediaGen;
    this.mediaBusy.set(true);
    try {
      const media = await openLocalMedia({
        audio: wantMic,
        video: wantCam,
        microphoneId: this.microphoneId() || undefined,
        cameraId: this.cameraId() || undefined,
      });
      if (this.destroyed || gen !== this.mediaGen) {
        // The call ended (or the page went) while the browser asked — don't leave a device on.
        media.mic?.close();
        media.cam?.close();
        return;
      }
      const { mic, cam } = media;
      if (wantMic) {
        this.micTrack = mic ?? undefined;
        this.hasMic.set(!!mic);
        this.micProblem.set(media.micProblem);
        // Unplugged (or taken by another app) later: say so, and let it be reopened.
        mic?.on('track-ended', () => this.deviceEnded('mic', mic));
      }
      if (wantCam) {
        this.camTrack = cam ?? undefined;
        this.hasCam.set(!!cam);
        this.camProblem.set(media.camProblem);
        cam?.on('track-ended', () => this.deviceEnded('cam', cam));
      }
      // Switched off while it was opening: honour it.
      if (media.mic && !this.micOn()) await media.mic.setEnabled(false);
      if (media.cam && !this.camOn()) await media.cam.setEnabled(false);
      void this.refreshDevices();
      this.showLocalVideo();
      const client = this.client;
      if (client && this.connected) {
        this.inCallNotice.set(this.missingDevicesText());
        await this.publishLocal(client);
      }
    } catch {
      /* a publish that failed — the toggle stays usable */
    } finally {
      this.mediaBusy.set(false);
    }
  }

  /** A device stopped (unplugged, or the browser took it away): drop it, say so, offer Try again. */
  private deviceEnded(kind: 'mic' | 'cam', track: IMicrophoneAudioTrack | ICameraVideoTrack): void {
    if (kind === 'mic' ? this.micTrack !== track : this.camTrack !== track) return;
    const client = this.client;
    if (client && client.localTracks.includes(track as ILocalTrack)) void client.unpublish(track).catch(() => undefined);
    try {
      track.close();
    } catch {
      /* already gone */
    }
    if (kind === 'mic') {
      this.micTrack = undefined;
      this.hasMic.set(false);
      this.micProblem.set('missing');
    } else {
      this.camTrack = undefined;
      this.hasCam.set(false);
      this.camProblem.set('missing');
      this.hideVideo(this.selfUid());
    }
    if (this.stage() === 'in-call') {
      this.inCallNotice.set(
        kind === 'mic'
          ? 'Your microphone was disconnected — others can’t hear you. Reconnect it, then switch it on again.'
          : 'Your camera was disconnected. Reconnect it, then switch it on again.',
      );
    }
    void this.refreshDevices();
  }

  /** The cameras and microphones to pick from (labels need the permission granted first). */
  private async refreshDevices(): Promise<void> {
    const [cams, mics] = await Promise.all([
      AgoraRTC.getCameras(true).catch(() => [] as MediaDeviceInfo[]),
      AgoraRTC.getMicrophones(true).catch(() => [] as MediaDeviceInfo[]),
    ]);
    if (this.destroyed) return;
    const options = (list: MediaDeviceInfo[], noun: string): DeviceOption[] =>
      list
        .filter((d) => d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }));
    this.cameras.set(options(cams, 'Camera'));
    this.microphones.set(options(mics, 'Microphone'));
    const camId = this.camTrack?.getMediaStreamTrack().getSettings().deviceId;
    const micId = this.micTrack?.getMediaStreamTrack().getSettings().deviceId;
    if (camId) this.cameraId.set(camId);
    if (micId) this.microphoneId.set(micId);
  }

  protected async pickCamera(id: string): Promise<void> {
    if (!id || id === this.cameraId()) return;
    this.cameraId.set(id);
    if (!this.camTrack) {
      void this.ensureMedia();
      return;
    }
    try {
      await this.camTrack.setDevice(id);
      this.camProblem.set(null);
    } catch (err) {
      this.camProblem.set(deviceProblem(err));
    }
  }

  protected async pickMicrophone(id: string): Promise<void> {
    if (!id || id === this.microphoneId()) return;
    this.microphoneId.set(id);
    if (!this.micTrack) {
      void this.ensureMedia();
      return;
    }
    try {
      await this.micTrack.setDevice(id);
      this.micProblem.set(null);
    } catch (err) {
      this.micProblem.set(deviceProblem(err));
    }
  }

  /** "Try again" after a device problem: drop the failed device and ask again. */
  protected retryDevices(): void {
    if (this.camProblem() && !this.camTrack) this.camProblem.set(null);
    if (this.micProblem() && !this.micTrack) this.micProblem.set(null);
    void this.ensureMedia();
  }

  /**
   * Where this person's camera plays: the lobby preview, or their own tile in
   * the call. `replay` restarts it there (after the camera is switched back on).
   */
  private showLocalVideo(replay = false): void {
    const cam = this.camTrack;
    if (!cam) return;
    if (this.stage() === 'in-call') {
      if (replay) this.hideVideo(this.selfUid());
      this.showVideo(this.selfUid(), cam);
      return;
    }
    afterNextRender(
      () => {
        const el = this.preview()?.nativeElement;
        if (!el || this.camTrack !== cam || this.stage() !== 'lobby') return;
        // It may still be bound to a preview the page has since replaced.
        cam.stop();
        cam.play(el);
      },
      { injector: this.injector },
    );
  }

  /** The lobby's microphone level meter. */
  private startMeter(): void {
    if (this.meterTimer) return;
    this.meterTimer = setInterval(() => {
      const mic = this.micTrack;
      const level = mic && this.micOn() ? mic.getVolumeLevel() : 0;
      this.micLevel.set(Math.min(1, level * 2));
    }, 120);
  }

  private stopMeter(): void {
    clearInterval(this.meterTimer);
    this.meterTimer = undefined;
    this.micLevel.set(0);
  }

  /** Flips what the button shows: an unavailable device "turns on" by being asked for again. */
  protected async toggleMic(): Promise<void> {
    const on = !this.micLive();
    this.micOn.set(on);
    if (on) this.micProblem.set(null);
    const mic = this.micTrack;
    if (!mic) {
      if (on) await this.ensureMedia();
      return;
    }
    try {
      await mic.setEnabled(on);
      const client = this.client;
      if (on && client && this.connected) await this.publishLocal(client);
    } catch {
      /* the switch shows the wanted state; the next toggle tries again */
    }
  }

  protected async toggleCam(): Promise<void> {
    const on = !this.camLive();
    this.camOn.set(on);
    if (on) this.camProblem.set(null);
    const cam = this.camTrack;
    if (!cam) {
      if (on) await this.ensureMedia();
      return;
    }
    try {
      await cam.setEnabled(on);
      if (on) this.showLocalVideo(true);
      const client = this.client;
      if (on && client && this.connected) await this.publishLocal(client);
    } catch {
      /* the switch shows the wanted state; the next toggle tries again */
    }
  }

  /** Publish every open, switched-on track that isn't published yet. */
  private async publishLocal(client: IAgoraRTCClient): Promise<void> {
    const tracks = [this.micTrack, this.camTrack].filter(
      (t): t is IMicrophoneAudioTrack | ICameraVideoTrack =>
        !!t && t.enabled && !client.localTracks.includes(t as ILocalTrack),
    );
    if (tracks.length) await client.publish(tracks);
  }

  // ---- Joining ----

  protected async join(): Promise<void> {
    const m = this.meeting();
    if (!m || this.joinBusy() || !this.canJoinNow() || this.stage() !== 'lobby') return;
    this.lobbyError.set('');
    const name = this.displayName().replace(/\s+/g, ' ').trim();
    if (this.isGuest()) {
      if (!name || name.length > MAX_NAME) {
        this.nameError.set(`Enter the name to show in the call (up to ${MAX_NAME} characters).`);
        this.nameInput()?.nativeElement.focus();
        return;
      }
      if (!this.agreed()) {
        this.lobbyError.set(
          this.consentRequired()
            ? 'Please accept the privacy and recording notice to join.'
            : 'Please accept the privacy notice to join.',
        );
        this.agreeBox()?.nativeElement.focus();
        return;
      }
    }
    this.joinBusy.set(true);
    try {
      if (this.isGuest()) {
        // Always recorded: a recording started later then finds this guest ready.
        const res = await firstValueFrom(
          this.appointments.consentToCall(this.token, {
            accepted: true,
            display_name: name !== m.you.name ? name : undefined,
          }),
        );
        if (this.destroyed) return;
        this.consent.set(res.data.consent);
        this.participants.set(res.data.participants);
        this.meeting.update((cur) => (cur ? { ...cur, you: res.data.you } : cur));
        this.displayName.set(res.data.you.name);
      }
      await this.connect();
    } catch (err) {
      this.joinFailed(err);
    } finally {
      this.joinBusy.set(false);
    }
  }

  /** Join with neither camera nor microphone (they can be switched on in the call). */
  protected joinWithoutDevices(): void {
    if (this.joinBusy() || !this.canJoinNow()) return;
    this.micOn.set(false);
    this.camOn.set(false);
    this.releaseTracks();
    void this.join();
  }

  /** "Rejoin call" after leaving or a dropped connection (the link stays valid). */
  protected async rejoin(): Promise<void> {
    if (this.destroyed || this.stage() !== 'left' || this.joinBusy()) return;
    this.joinBusy.set(true);
    try {
      await this.connect();
    } catch (err) {
      this.joinFailed(err);
    } finally {
      this.joinBusy.set(false);
    }
  }

  /**
   * Fresh RTC credentials (the same checks as the lobby, plus the time window
   * and the notice), then into the channel with the devices from the lobby.
   * Throws for the caller's {@link joinFailed}.
   */
  private async connect(): Promise<void> {
    this.stage.set('joining');
    this.stopClock();
    this.stopMeter();
    this.inCallNotice.set('');
    const { data } = await firstValueFrom(this.appointments.joinInfo(this.token));
    if (this.destroyed || this.stage() !== 'joining') return;
    this.applyMeeting(data);
    // token may be null in App-ID-only mode — that's a valid token-less join.
    if (!data.configured || !data.app_id || !data.channel) {
      this.stopEverything();
      this.stage.set('not-configured');
      return;
    }
    await this.ensureMedia(); // still open from the lobby, or reopened for a rejoin
    if (this.destroyed || this.stage() !== 'joining') return;

    this.resetRemotes();
    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.client = client;
    this.unbindRemotes = this.remotes.bind(client);
    // Presence, not just video: others may join with the camera off.
    client.on('user-joined', (user) => this.onRemoteJoined(client, user.uid));
    client.on('user-left', (user) => {
      this.hideVideo(user.uid);
      this.onRemoteLeft(client, user.uid);
    });
    client.on('user-published', async (user, mediaType) => {
      this.onRemoteJoined(client, user.uid);
      try {
        await client.subscribe(user, mediaType);
      } catch {
        return; // they left or unpublished meanwhile
      }
      if (client !== this.client) return;
      if (mediaType === 'video' && user.videoTrack) this.showVideo(user.uid, user.videoTrack);
      else if (mediaType === 'audio') user.audioTrack?.play();
    });
    // Only that person's video goes — everyone else's tiles keep playing.
    client.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'video') this.hideVideo(user.uid);
    });
    client.on('token-privilege-will-expire', () => void this.renew(client));
    // The token lapsed, or Agora dropped us for good (network blips it
    // retries itself, as RECONNECTING): the call is over on this side.
    client.on('token-privilege-did-expire', () => this.dropped(client));
    client.on('connection-state-change', (state, _prev, reason) => {
      if (state === 'DISCONNECTED') {
        // Kicked by the server (guest removed, consultation cancelled): ask the
        // API why, so the guest sees the final screen rather than Rejoin.
        if (reason === 'UID_BANNED' || reason === 'CHANNEL_BANNED') void this.afterKick(client);
        else this.dropped(client);
      } else if (state === 'RECONNECTING') this.watchReconnect(client);
      else if (state === 'CONNECTED') this.clearReconnectWatch();
    });

    const uid = data.uid ?? data.you.uid ?? 0;
    this.selfUid.set(uid > 0 ? uid : 'self');
    try {
      // uid 0 → wildcard token, join with null; any non-zero uid is honoured.
      await client.join(data.app_id, data.channel, data.token ?? null, uid > 0 ? uid : null);
    } catch (err) {
      if (this.client === client) {
        this.client = undefined;
        this.resetRemotes();
        void client.leave().catch(() => undefined);
      }
      throw new CallConnectError(err);
    }
    if (this.destroyed || this.client !== client) return; // left / dropped mid-join
    // Connected: pause the idle timeout while the consultation is going on.
    this.connected = true;
    this.everJoined = true;
    if (this.remoteUids.size === 0) this.startFirstWait();
    this.syncHold();
    this.stage.set('in-call');
    this.camTrack?.stop(); // out of the lobby preview, into this person's tile
    this.showLocalVideo();
    client.enableAudioVolumeIndicator();
    try {
      await this.publishLocal(client);
    } catch {
      this.inCallNotice.set('Your camera or microphone couldn’t be shared. Switch it off and on to try again.');
    }
    if (this.destroyed || this.client !== client) return;
    this.startHeartbeat();
    if (this.isGuest()) this.startRecordingCheck();
    this.announce('You joined the call.');
    const missing = this.missingDevicesText();
    if (missing) this.inCallNotice.set(missing);
  }

  /** "You joined without your camera" — when a wanted device didn't open. */
  private missingDevicesText(): string {
    const cam = this.camOn() && !this.hasCam();
    const mic = this.micOn() && !this.hasMic();
    if (cam && mic) return 'Your camera and microphone aren’t available — others can’t see or hear you.';
    if (cam) return 'Your camera isn’t available — you joined with audio only.';
    if (mic) return 'Your microphone isn’t available — others can’t hear you.';
    return '';
  }

  /** Joining didn't work: say why in the lobby, or show a final screen. */
  private joinFailed(err: unknown): void {
    if (this.destroyed) return;
    if (err instanceof CallConnectError) {
      this.backToLobby('We couldn’t connect you to the call. Check your internet connection and try again.');
      return;
    }
    const refusal = callRefusal(err);
    if (refusal?.code === 'too_early') {
      if (refusal.serverTime) {
        const offset = Date.parse(refusal.serverTime) - Date.now();
        if (Number.isFinite(offset)) this.serverOffset = offset;
      }
      const opens = refusal.opensAt ? Date.parse(refusal.opensAt) : NaN;
      this.opensAt.set(Number.isFinite(opens) ? opens : null);
      // The API's sentence names the clinic's time zone; say it in the guest's own.
      const when = callWhen(refusal.opensAt);
      this.backToLobby(when ? `Joining opens ${when}.` : refusal.message);
      return;
    }
    if (refusal?.code === 'consent_required') {
      this.consent.update((c) => (c ? { ...c, required: true, given: false } : c));
      this.agreed.set(false);
      this.backToLobby(refusal.message);
      return;
    }
    if (refusal && isFinalRefusal(refusal)) {
      this.showFinal(refusal);
      return;
    }
    const status = httpStatus(err);
    if (status === 401 || status === 404) {
      this.failLink(err);
      return;
    }
    // The name was refused: say so under it.
    const nameProblem = apiErrorFields(err)['display_name'];
    if (nameProblem) {
      this.nameError.set(nameProblem);
      this.backToLobby('');
      this.focusLater(() => this.nameInput()?.nativeElement);
      return;
    }
    // e.g. the connection dropped: try again from the lobby.
    this.backToLobby(apiErrorMessage(err, 'We couldn’t join the call. Please try again.'));
  }

  private backToLobby(message: string): void {
    this.lobbyError.set(message);
    this.enterLobby();
    this.lobbyMedia();
  }

  /** On token-privilege-will-expire: the same link again gives a fresh RTC token. */
  private async renew(client: IAgoraRTCClient, attempt = 0): Promise<void> {
    try {
      const { data } = await firstValueFrom(this.appointments.joinInfo(this.token));
      if (client !== this.client) return;
      this.applyMeeting(data);
      if (data.token) await client.renewToken(data.token);
    } catch (err) {
      if (client !== this.client) return;
      const refusal = callRefusal(err);
      if (refusal && isFinalRefusal(refusal)) {
        this.closedMidCall(refusal);
        return;
      }
      // A hiccup: keep trying (5 tries, 5 s apart) before the short-lived guest
      // token runs out — then it drops, with Rejoin. Same as the doctor's cockpit.
      if (attempt < 4) setTimeout(() => void this.renew(client, attempt + 1), 5_000);
    }
  }

  /** Disconnected by the server: a final refusal gets its screen, anything else is a drop. */
  private async afterKick(client: IAgoraRTCClient): Promise<void> {
    try {
      await firstValueFrom(this.appointments.joinLobby(this.token));
      this.dropped(client);
    } catch (err) {
      const refusal = callRefusal(err);
      if (client === this.client && refusal && isFinalRefusal(refusal)) this.showFinal(refusal);
      else this.dropped(client);
    }
  }

  /** A guest re-reads whether the consultation is being recorded. */
  private startRecordingCheck(): void {
    this.stopRecordingCheck();
    this.recordingTimer = setInterval(() => void this.checkRecording(), RECORDING_CHECK_MS);
  }

  private stopRecordingCheck(): void {
    clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
  }

  private async checkRecording(): Promise<void> {
    const client = this.client;
    try {
      const { data } = this.recordingViaJoin
        ? await firstValueFrom(this.appointments.joinInfo(this.token))
        : await firstValueFrom(this.appointments.joinLobby(this.token));
      if (client !== this.client || !this.connected) return;
      if (data.participants) this.participants.set(data.participants);
      if (data.consent) {
        this.consent.set(data.consent);
        this.setRecording(data.consent.recording_active);
      }
    } catch (err) {
      // Past the end of the guest's window the lobby answers "ended", but a
      // call running over carries on: the join payload still answers a guest
      // who is in it (heartbeating), so read the recording state from there.
      // Otherwise the heartbeat decides whether this person may stay.
      if (!this.recordingViaJoin && callRefusal(err)?.code === 'ended' && client === this.client && this.connected) {
        this.recordingViaJoin = true;
        void this.checkRecording();
      }
    }
  }

  private setRecording(active: boolean): void {
    const was = this.recordingActive();
    this.recordingActive.set(active);
    if (this.stage() !== 'in-call' || was === active) return;
    this.announce(active ? 'This consultation is now being recorded.' : 'Recording has stopped.');
  }

  // ---- Is the consultation still going on? ----

  /**
   * Hold the idle timer only while a consultation is actually going on: joined
   * and someone else is in the call, or (for a bounded time) waiting for them
   * to first arrive. Released the moment the others leave, the call drops, the
   * user leaves or the page goes away.
   */
  private syncHold(): void {
    const want =
      this.connected &&
      !this.destroyed &&
      (this.remoteUids.size > 0 || (!this.remoteSeen && !this.firstWaitOver));
    if (want === this.holding) return;
    this.holding = want;
    if (want) this.session.hold(CALL_HOLD);
    else this.session.release(CALL_HOLD);
  }

  private onRemoteJoined(client: IAgoraRTCClient, uid: UID): void {
    if (client !== this.client || this.destroyed) return;
    this.remoteUids.add(uid);
    this.remoteSeen = true;
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
    const pending = this.endedPending;
    if (pending) this.closedMidCall(pending, true);
  }

  private resetRemotes(): void {
    this.unbindRemotes?.();
    this.unbindRemotes = undefined;
    this.remotes.clear();
    this.remoteUids.clear();
    this.remoteSeen = false;
    this.firstWaitOver = false;
    this.remoteLeft.set(false);
    for (const v of [...this.videos.values()]) {
      if (String(v.uid) !== String(this.selfUid())) this.hideVideo(v.uid);
    }
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
      this.dropped(client);
    }, RECONNECT_GIVE_UP_MS);
  }

  private clearReconnectWatch(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * Tell the API this person is in the call (a guest by their guest id). The
   * answer refreshes the tile names; a refusal (410 / 409) means the call is
   * over for this link — e.g. the patient removed this guest. Restarted after
   * a rejoin; never two at once.
   */
  private startHeartbeat(): void {
    if (this.heartbeatStop) return;
    const url = this.appointments.joinPresenceUrl(this.token);
    const client = this.client;
    this.heartbeatStop = startCallPresence((s) =>
      sendCallPresence(url, s, {}, {
        onBeat: (beat) => {
          if (client === this.client && beat.participants) this.participants.set(beat.participants);
        },
        onRefused: (status, code, message) => {
          if (client !== this.client || !this.connected) return;
          this.closedMidCall({ status, code, message: message || 'This call is over.', opensAt: null, serverTime: null });
        },
      }),
    );
  }

  /** Stop the heartbeat, saying "out" (a no-op when none is running). */
  private stopHeartbeat(): void {
    this.heartbeatStop?.();
    this.heartbeatStop = undefined;
  }

  /**
   * The call closed for this link while in it. Removed / cancelled: leave now.
   * Completed: let the goodbyes finish — leave once everyone else has, or
   * after a short grace.
   */
  private closedMidCall(refusal: CallRefusal, now = false): void {
    if (!now && refusal.code === 'ended' && this.remoteUids.size > 0) {
      if (this.endedPending) return;
      this.endedPending = refusal;
      this.endedGraceTimer = setTimeout(() => this.closedMidCall(refusal, true), ENDED_GRACE_MS);
      return;
    }
    this.showFinal(refusal);
  }

  /** Agora dropped this client (or its token lapsed) while in the call. */
  private dropped(client: IAgoraRTCClient): void {
    if (client !== this.client || this.destroyed || !this.connected) return;
    this.endCall('dropped');
  }

  /** Out of the call: release the hold at once, free the devices, offer Rejoin. */
  private endCall(reason: 'left' | 'dropped'): void {
    this.leaveChannel();
    this.endedReason.set(reason);
    this.stage.set('left');
    this.announce(reason === 'left' ? 'You left the call.' : 'You were disconnected from the call.');
  }

  /** Leave the channel and stop everything that belongs to being in it. */
  private leaveChannel(): void {
    this.connected = false;
    this.stopHeartbeat();
    this.stopRecordingCheck();
    this.syncHold();
    this.clearFirstWait();
    this.clearReconnectWatch();
    clearTimeout(this.endedGraceTimer);
    this.endedGraceTimer = undefined;
    this.endedPending = null;
    // Forget the client first, so its own DISCONNECTED event is ignored.
    const client = this.client;
    this.client = undefined;
    this.resetRemotes();
    this.releaseTracks();
    void client?.leave().catch(() => undefined);
  }

  /** Close the camera and microphone (the light goes off); devices that open late are closed too. */
  private releaseTracks(): void {
    this.mediaGen++;
    const self = this.selfUid();
    if (this.videos.has(String(self))) this.hideVideo(self);
    for (const t of [this.micTrack, this.camTrack]) {
      try {
        t?.close();
      } catch {
        /* releasing devices — nothing actionable on failure */
      }
    }
    this.micTrack = undefined;
    this.camTrack = undefined;
    this.hasMic.set(false);
    this.hasCam.set(false);
  }

  /** Nothing more happens on this page (final screen, error, not configured, destroyed). */
  private stopEverything(): void {
    if (this.client || this.connected) this.leaveChannel();
    else this.releaseTracks();
    this.stopClock();
    this.stopMeter();
  }

  protected leave(): void {
    if (this.stage() !== 'in-call') return;
    this.endCall('left');
  }

  // ---- Video tiles ----

  /** Play a uid's video in its tile (now, or once the tile renders). */
  private showVideo(uid: CallUid, track: CallVideoTrack, config?: CallVideoPlayConfig): void {
    this.videos.set(String(uid), { uid, track, config });
    this.stageTiles()?.attach(uid, track, config);
  }

  private hideVideo(uid: CallUid): void {
    this.videos.delete(String(uid));
    this.stageTiles()?.detach(uid);
  }

  // ---- Helpers ----

  private announce(text: string): void {
    // Re-set even when unchanged, so a repeat is read again.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(text));
  }

  private focusLater(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.stopEverything();
    // Always drop the idle-timer hold, however the page is left.
    this.holding = false;
    this.session.release(CALL_HOLD);
  }
}

/** Agora couldn't connect (as opposed to the API refusing the link). */
class CallConnectError extends Error {
  constructor(readonly reason: unknown) {
    super('Could not connect to the call');
  }
}
