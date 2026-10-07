import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  ILocalVideoTrack,
  IMicrophoneAudioTrack,
} from 'agora-rtc-sdk-ng';
import { SessionTimeoutService, StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type {
  ConsentDto,
  CopilotDraftDto,
  JoinInfoDto,
  LabOrderDto,
  MedicalCertificateDto,
  MedicalDocumentDto,
  ReferralDto,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { ConfirmDialogComponent, IconComponent } from '@supadoc/ui';
import { environment } from '../environments/environment';
import { RxPanel } from './prescriptions/rx-panel';
import { CanLeave, LeavePrompt } from './prescriptions/unsaved-changes.guard';

/** Load state of something the editor must not overwrite before it has loaded. */
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type NotesTab = 'notes' | 'prescriptions' | 'labs' | 'followup' | 'copilot';

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
 * Centre: the video (patient on the main stage, doctor picture-in-picture), call
 * controls and SOAP notes. Right: records and participants.
 */
@Component({
  selector: 'doc-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialogComponent, IconComponent, RxPanel],
  host: {
    class: 'sd-call block min-h-screen bg-abyss text-white',
    '[attr.data-theme]': 'theme()',
    // Signing in to the portal happens in another tab — re-check on return.
    '(window:focus)': 'recheckPortalSignIn()',
  },
  styles: [
    `
      /* Subtle, near-invisible scrollbars — the cockpit scrolls its panels
         internally without heavy browser scroll chrome. */
      :host ::-webkit-scrollbar { width: 6px; height: 6px; }
      :host ::-webkit-scrollbar-track { background: transparent; }
      :host ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: 999px; }
      :host ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }
      :host * { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.18) transparent; }

      /* The prescribing panel is a light "paper" surface in both cockpit
         themes. The light theme's global .sd-call .text-white override would
         turn its white-on-colour button text dark — keep it white there. */
      :host([data-theme='light']) ::ng-deep .sd-rx-zone .text-white { color: #ffffff; }
    `,
  ],
  template: `
    <div class="flex min-h-screen flex-col xl:h-screen xl:overflow-hidden">
      <!-- Top bar -->
      <header
        class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-white/10 px-4 py-3"
      >
        <div class="flex min-w-0 items-center gap-3">
          <button
            type="button"
            class="flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Back to schedule"
            (click)="leave()"
          >
            <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          </button>
          <span class="font-heading text-h5 tracking-tight">
            <span class="text-frost">Video</span><span class="text-sage">Med</span>
            <span class="ml-1.5 align-middle font-sans text-caption text-white/50">Doctor</span>
          </span>
        </div>

        <div class="flex items-center gap-2">
          <span
            class="flex items-center gap-2 rounded-pill bg-white/5 px-3 py-1.5 font-sans text-caption text-white/70"
          >
            <span class="size-1.5 rounded-full bg-alert"></span>
            <span class="hidden sm:inline">Secure Call</span>
            <span class="font-label tabular-nums text-white/85">{{ elapsedLabel() }}</span>
          </span>
          <span
            class="hidden items-center gap-1.5 rounded-pill bg-white/5 px-3 py-1.5 font-sans text-caption text-white/70 md:flex"
          >
            <sd-icon name="shield-check" [size]="14" class="text-success" />
            End-to-end Encrypted
          </span>
          <span
            class="flex items-center gap-1.5 rounded-pill bg-white/5 px-3 py-1.5 font-sans text-caption text-white/70"
          >
            <sd-icon name="users" [size]="14" /> {{ participantCount() }}
          </span>

          <button
            type="button"
            class="flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            [attr.aria-label]="theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
            (click)="toggleTheme()"
          >
            <sd-icon name="lightbulb" [size]="18" />
          </button>

          @if (recordingConfigured()) {
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-sans text-caption transition-colors disabled:opacity-50"
              [class]="recordingActive() ? 'bg-alert/20 text-alert hover:bg-alert/30' : 'bg-white/5 text-white/70 hover:bg-white/10'"
              [disabled]="recordingBusy() || (!recordingActive() && !recordingConsent())"
              [attr.title]="!recordingActive() && !recordingConsent() ? (consentsError() || 'Patient recording consent required') : null"
              (click)="toggleRecording()"
            >
              <span class="size-2 rounded-full" [class]="recordingActive() ? 'animate-pulse bg-alert' : 'bg-white/40'"></span>
              {{ recordingActive() ? 'Recording' : (recordingBusy() ? '…' : 'Record') }}
            </button>
          }
        </div>
      </header>
      @if (recordingError()) {
        <p class="border-b border-alert/20 bg-alert/10 px-4 py-2 text-center font-sans text-caption text-alert">
          {{ recordingError() }}
        </p>
      }

      <!-- Cockpit -->
      <div
        class="grid flex-1 gap-4 p-4 xl:min-h-0 xl:grid-cols-[300px_minmax(0,1fr)_320px] xl:overflow-hidden"
      >
        <!-- ===================== PATIENT CHART ===================== -->
        <aside class="flex flex-col gap-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <div class="flex items-center gap-3">
              <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-cerulean/20 font-heading text-body font-semibold text-frost">
                {{ patientInitials() }}
              </span>
              <div class="min-w-0">
                <p class="truncate font-heading text-body font-semibold text-white">
                  {{ patientName() }}
                </p>
                <p class="font-sans text-caption text-white/50">
                  {{ patientMeta() }}
                </p>
              </div>
            </div>

            <!-- Allergies -->
            <div class="mt-4 rounded-2xl bg-alert/10 p-3">
              <span class="flex items-center gap-1.5 font-sans text-caption font-semibold text-alert">
                <sd-icon name="triangle-alert" [size]="14" /> Allergies
              </span>
              <p class="mt-1 font-sans text-body-sm text-white/85">{{ allergiesLabel() }}</p>
            </div>
          </div>

          <!-- Vitals -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-3 font-sans text-body-sm font-semibold text-white">Vitals</h3>
            <div class="grid grid-cols-3 gap-2">
              @for (v of vitals; track v.label) {
                <div class="rounded-xl bg-white/[0.04] p-2 text-center">
                  <p class="font-heading text-body font-semibold text-white">{{ v.value }}</p>
                  <p class="font-sans text-[10px] text-white/45">{{ v.label }}</p>
                </div>
              }
            </div>
            <p class="mt-2 font-sans text-[10px] text-white/40">
              No readings captured for this visit yet.
            </p>
          </div>

          <!-- Conditions -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-2 flex items-center gap-1.5 font-sans text-body-sm font-semibold text-white">
              <sd-icon name="heart-pulse" [size]="15" class="text-sage" /> Current Conditions
            </h3>
            @if (conditions().length) {
              <ul class="flex flex-col gap-1.5">
                @for (c of conditions(); track c.condition) {
                  <li class="flex items-center justify-between gap-2 font-sans text-body-sm text-white/80">
                    <span>{{ c.condition }}</span>
                    <span class="size-2 shrink-0 rounded-full bg-sage"></span>
                  </li>
                }
              </ul>
            } @else {
              <p class="font-sans text-body-sm text-white/40">None recorded.</p>
            }
          </div>

          <!-- Medications -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-2 flex items-center gap-1.5 font-sans text-body-sm font-semibold text-white">
              <sd-icon name="pill" [size]="15" class="text-sky" /> Medications
            </h3>
            @if (medications().length) {
              <ul class="flex flex-col gap-2">
                @for (m of medications(); track m.name) {
                  <li class="flex items-center justify-between gap-2">
                    <span class="font-sans text-body-sm text-white/85">{{ m.name }}</span>
                    <span class="font-sans text-caption text-white/45">{{ m.dosage }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="font-sans text-body-sm text-white/40">None recorded.</p>
            }
          </div>

          <!-- Medical History -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-2 flex items-center gap-1.5 font-sans text-body-sm font-semibold text-white">
              <sd-icon name="clipboard-list" [size]="15" class="text-frost" /> Medical History
            </h3>
            @if (history().length) {
              <ul class="flex flex-col gap-2">
                @for (h of history(); track $index) {
                  <li class="flex flex-col">
                    <span class="font-sans text-body-sm text-white/85">
                      {{ h.condition }}@if (h.year) { <span class="text-white/45"> · {{ h.year }}</span> }
                    </span>
                    @if (h.note) {
                      <span class="font-sans text-caption text-white/45">{{ h.note }}</span>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="font-sans text-body-sm text-white/40">None recorded.</p>
            }
          </div>

          @if (info()?.patient?.id) {
            <button
              type="button"
              class="flex items-center justify-center gap-2 rounded-field border border-white/15 py-2.5 font-sans text-body-sm font-semibold text-white/85 transition-colors hover:bg-white/10"
              (click)="openRecord()"
            >
              <sd-icon name="file-text" [size]="16" /> View Full EMR
            </button>
          }
        </aside>

        <!-- ===================== STAGE ===================== -->
        <section class="flex min-w-0 flex-col gap-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <div class="sd-stage relative aspect-[16/10] w-full overflow-hidden rounded-card bg-ink xl:aspect-auto xl:min-h-[420px] xl:flex-1">
            <div #remoteVideo class="absolute inset-0 bg-ink"></div>

            <!-- Doctor PiP. Kept in the DOM (hidden until in-call) so the camera
                 can attach before status flips — otherwise the local tile is black. -->
            <div
              class="absolute bottom-24 right-4 z-10 h-32 w-24 overflow-hidden rounded-2xl border border-white/15 bg-abyss shadow-lg sm:h-40 sm:w-28"
              [class.hidden]="status() !== 'in-call'"
            >
              <div #localVideo class="h-full w-full"></div>
              @if (!camOn()) {
                <div class="absolute inset-0 flex items-center justify-center bg-abyss text-white/60">
                  <sd-icon name="video-off" [size]="22" />
                </div>
              }
              <span class="absolute bottom-1.5 left-1.5 rounded bg-abyss/70 px-1.5 py-0.5 font-sans text-[10px] text-white/80">
                You
              </span>
            </div>

            @if (!remoteJoined() && status() === 'in-call') {
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white/75">
                <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                  <sd-icon name="user-round" [size]="30" />
                </span>
                <p class="font-sans text-body">Waiting for {{ patientName() }} to join…</p>
              </div>
            }

            @if (status() === 'loading') {
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/85">
                <span class="size-10 animate-spin rounded-full border-2 border-white/20 border-t-white"></span>
                <p class="font-sans text-body">Connecting to the consultation…</p>
              </div>
            }

            @if (status() === 'error') {
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white/85">
                <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                  <sd-icon name="video-off" [size]="28" />
                </span>
                <p class="max-w-sm font-sans text-body">{{ errorMessage() }}</p>
                <button
                  type="button"
                  class="rounded-field bg-white/10 px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-white/20"
                  (click)="leave()"
                >
                  Back to schedule
                </button>
              </div>
            }

            @if (status() === 'in-call') {
              <!-- Patient name tag -->
              <div class="absolute left-4 top-4 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur">
                <span class="font-sans text-body-sm font-medium text-white">{{ patientName() }}</span>
              </div>
              <!-- Connection quality -->
              <div class="absolute right-4 top-4 flex items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur">
                <span class="font-label text-caption font-semibold text-white">HD</span>
                <span class="size-2 rounded-full bg-success"></span>
              </div>

              <!-- Controls -->
              <div class="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-pill bg-abyss/75 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-4">
                <button type="button" class="flex flex-col items-center gap-1" [attr.aria-label]="micOn() ? 'Mute' : 'Unmute'" (click)="toggleMic()">
                  <span class="flex size-11 items-center justify-center rounded-full transition-colors" [class]="micOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'">
                    <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">{{ micOn() ? 'Mute' : 'Unmute' }}</span>
                </button>
                <button type="button" class="flex flex-col items-center gap-1" [attr.aria-label]="camOn() ? 'Stop video' : 'Start video'" (click)="toggleCam()">
                  <span class="flex size-11 items-center justify-center rounded-full transition-colors" [class]="camOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'">
                    <sd-icon [name]="camOn() ? 'video' : 'video-off'" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">{{ camOn() ? 'Stop Video' : 'Start' }}</span>
                </button>
                <button type="button" class="flex flex-col items-center gap-1" aria-label="Share screen" (click)="toggleScreen()">
                  <span class="flex size-11 items-center justify-center rounded-full transition-colors" [class]="screenOn() ? 'bg-sky hover:bg-sky/80' : 'bg-white/15 hover:bg-white/25'">
                    <sd-icon name="monitor-smartphone" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">Share</span>
                </button>
                <button type="button" class="flex flex-col items-center gap-1" aria-label="Leave call" (click)="leave()">
                  <span class="flex size-11 items-center justify-center rounded-full bg-alert transition-colors hover:bg-alert/80">
                    <sd-icon name="phone-off" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">End</span>
                </button>
              </div>
            }
          </div>

          <!-- Agora status bar -->
          <div class="flex items-center gap-3 rounded-pill bg-white/[0.03] px-4 py-2 font-sans text-caption text-white/50">
            <span class="rounded bg-white/[0.06] px-1.5 py-0.5 font-label text-[10px] text-success">HD</span>
            <span>Adaptive</span>
            <span class="flex items-center gap-1"><span class="size-1.5 rounded-full bg-success"></span> Noise Cancellation</span>
          </div>

          <!-- Notes -->
          <div class="rounded-card border border-white/10 bg-white/[0.03]">
            <div class="flex gap-1 overflow-x-auto border-b border-white/10 px-2">
              @for (t of notesTabs; track t.key) {
                <button
                  type="button"
                  class="relative whitespace-nowrap px-3 py-3 font-sans text-body-sm transition-colors"
                  [class]="notesTab() === t.key ? 'text-white' : 'text-white/50 hover:text-white/80'"
                  (click)="notesTab.set(t.key)"
                >
                  {{ t.label }}
                  @if (notesTab() === t.key) {
                    <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span>
                  }
                </button>
              }
            </div>

            <div class="p-4">
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
                    <p class="mb-3 rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">
                      Sign in to the doctor portal to document this consultation.
                    </p>
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
                    <p class="mb-2 font-sans text-caption font-semibold text-white/60">Tools</p>
                    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      @for (tool of tools; track tool.label) {
                        <button
                          type="button"
                          class="flex flex-col items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.04] px-2 py-3 text-center transition-colors hover:bg-white/[0.08]"
                          (click)="useTool(tool.label)"
                        >
                          <sd-icon [name]="tool.icon" [size]="18" class="text-frost" />
                          <span class="font-sans text-caption text-white/80">{{ tool.label }}</span>
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
                  @if (!canDocument()) {
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
                  <div class="mt-4 border-t border-white/10 pt-3">
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
                  <div class="mt-4 border-t border-white/10 pt-3">
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
                          <input type="date" class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none" [value]="certFrom()" (input)="certFrom.set($any($event.target).value)" /></label>
                        <label class="flex flex-col gap-1"><span class="font-sans text-[10px] text-white/45">To</span>
                          <input type="date" class="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white focus:border-cerulean focus:outline-none" [value]="certTo()" (input)="certTo.set($any($event.target).value)" /></label>
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

              <!-- Prescribing panel. Once opened it stays mounted for the rest of
                   the call — hidden on the other tabs, kept while the portal
                   session is signed out — so a half-written prescription is
                   never thrown away by a tab switch or a re-sign-in. -->
              @if (rxMounted() && rxPatientId(); as pid) {
                <div [class.hidden]="notesTab() !== 'prescriptions'">
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
        </section>

        <!-- ===================== RECORDS + PARTICIPANTS ===================== -->
        <aside class="flex flex-col gap-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-3 font-sans text-body font-semibold text-white">Medical Records</h3>
            <div class="mb-3 flex gap-1 overflow-x-auto">
              @for (t of recordsTabs; track t.key) {
                <button
                  type="button"
                  class="whitespace-nowrap rounded-pill px-3 py-1.5 font-sans text-caption transition-colors"
                  [class]="recordsTab() === t.key ? 'bg-cerulean text-white' : 'bg-white/[0.04] text-white/60 hover:bg-white/10'"
                  (click)="recordsTab.set(t.key)"
                >
                  {{ t.label }}
                </button>
              }
            </div>
            @if (docsLoading()) {
              <div class="flex flex-col gap-2">
                @for (i of [1, 2]; track i) { <div class="sd-shimmer h-12 rounded-2xl bg-white/[0.04]"></div> }
              </div>
            } @else if (docsError()) {
              <div class="flex flex-col items-center gap-2 py-6 text-center">
                <sd-icon name="wifi-off" [size]="26" class="text-alert" />
                <p class="font-sans text-caption text-alert">{{ docsError() }}</p>
              </div>
            } @else if (visibleDocs().length) {
              <ul class="flex flex-col gap-2">
                @for (d of visibleDocs(); track d.id) {
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-2.5 text-left transition-colors hover:bg-white/[0.07]"
                      (click)="openPatientDoc(d)"
                      [attr.title]="'Open ' + d.title"
                    >
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-white/70">
                        <sd-icon [name]="docIcon(d)" [size]="16" />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate font-sans text-body-sm text-white">{{ d.title }}</span>
                        <span class="truncate font-sans text-[10px] uppercase text-white/45">{{ d.type_label }} · {{ d.extension }} · {{ d.size_label }}</span>
                      </span>
                      <span class="shrink-0 rounded-pill px-2 py-0.5 font-sans text-[10px]" [class]="d.uploader_role === 'patient' ? 'bg-sage/15 text-sage' : 'bg-frost/15 text-frost'">{{ d.uploader_role === 'patient' ? 'Patient' : 'Clinician' }}</span>
                    </button>
                  </li>
                }
              </ul>
            } @else {
              <div class="flex flex-col items-center gap-2 py-6 text-center">
                <sd-icon name="clipboard-list" [size]="26" class="text-white/30" />
                <p class="font-sans text-caption text-white/40">{{ docsEmptyLabel() }}</p>
              </div>
            }
            @if (docOpenError()) {
              <p class="mt-3 flex items-start gap-1.5 font-sans text-caption text-alert" role="alert">
                <sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" /> {{ docOpenError() }}
              </p>
            }
            @if (docLink(); as l) {
              <!-- The browser blocked the new tab; never open it here (that would end the call). -->
              <p class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl bg-white/[0.04] px-3 py-2 font-sans text-caption text-white/70" role="status">
                <span>Your browser blocked the new tab.</span>
                <a
                  class="inline-flex items-center gap-1 font-semibold text-frost underline"
                  [href]="l.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  (click)="clearDocLinkSoon()"
                >Open {{ l.title }} <sd-icon name="external-link" [size]="12" /></a>
              </p>
            }
          </div>

          <!-- Participants -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-3 font-sans text-body-sm font-semibold text-white">
              Participants ({{ participantCount() }})
            </h3>
            <ul class="flex flex-col gap-3">
              <li class="flex items-center gap-3">
                <span class="flex size-9 items-center justify-center rounded-full bg-cerulean/20 font-heading text-caption font-semibold text-frost">
                  {{ doctorInitials() }}
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm text-white">{{ doctorName() }} (You)</span>
                  <span class="font-sans text-caption text-white/45">Host</span>
                </span>
                <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="15" [class]="micOn() ? 'text-white/60' : 'text-alert'" />
                <sd-icon [name]="camOn() ? 'video' : 'video-off'" [size]="15" [class]="camOn() ? 'text-white/60' : 'text-alert'" />
              </li>
              <li class="flex items-center gap-3">
                <span class="flex size-9 items-center justify-center rounded-full bg-white/10 font-heading text-caption font-semibold text-white/80">
                  {{ patientInitials() }}
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm text-white">{{ patientName() }}</span>
                  <span class="font-sans text-caption text-white/45">Patient</span>
                </span>
                <span
                  class="size-2 rounded-full"
                  [class]="remoteJoined() ? 'bg-success' : 'bg-white/25'"
                  [attr.title]="remoteJoined() ? 'In the call' : 'Not joined yet'"
                ></span>
              </li>
            </ul>
            <div class="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
              @if (consentsError()) {
                <sd-icon name="shield-check" [size]="15" class="shrink-0 text-alert" />
                <span class="font-sans text-caption text-alert">{{ consentsError() }}</span>
              } @else {
                <sd-icon name="shield-check" [size]="15" [class]="recordingConsent() ? 'text-success' : 'text-white/40'" />
                <span class="font-sans text-caption text-white/60">
                  Recording consent:
                  <span [class]="recordingConsent() ? 'text-success' : 'text-white/50'">{{ recordingConsent() ? 'granted' : 'not granted' }}</span>
                </span>
              }
            </div>
          </div>
        </aside>
      </div>
    </div>

    <!-- In .sd-rx-zone so the light theme keeps the dialog's white button text. -->
    <div class="sd-rx-zone">
      <sd-confirm-dialog
        [open]="leavePrompt.open()"
        title="Leave with an unsaved prescription?"
        message="Your latest changes to the prescription have not been saved. Leaving now loses them."
        confirmLabel="Leave without saving"
        cancelLabel="Keep editing"
        icon="triangle-alert"
        [danger]="true"
        (confirm)="leavePrompt.answer(true)"
        (cancel)="leavePrompt.answer(false)"
      />
    </div>
  `,
})
export class DoctorCall implements AfterViewInit, OnDestroy, CanLeave {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(StaffAuthService);
  private readonly doctorApi = inject(DoctorApi);
  private readonly session = inject(SessionTimeoutService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly localVideo = viewChild<ElementRef<HTMLDivElement>>('localVideo');
  private readonly remoteVideo = viewChild<ElementRef<HTMLDivElement>>('remoteVideo');

  protected readonly status = signal<'loading' | 'in-call' | 'error'>('loading');
  protected readonly errorMessage = signal('');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly screenOn = signal(false);
  protected readonly remoteJoined = signal(false);
  protected readonly elapsed = signal(0);

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
  protected readonly canDocument = computed(() => this.doctorToken() !== null);
  protected readonly noteEditable = computed(
    () => this.noteLoad() === 'ready' && !this.noteFinalized() && this.canDocument(),
  );

  // ePrescribing (GVM-RX-02) — the shared <doc-rx-panel>, over the portal
  // session (DoctorApi + staffAuthInterceptor, which refreshes tokens).
  /** Bumped when the window regains focus, so the portal sign-in is re-checked. */
  private readonly authCheck = signal(0);
  /**
   * Signed in to the doctor portal in this browser? The cockpit can be opened
   * from an emailed join link without one. StaffAuthService mirrors a sign-in
   * made in another tab; the focus tick re-evaluates on return to this tab.
   */
  protected readonly portalSignedIn = computed(() => {
    this.authCheck();
    return this.auth.isAuthenticated();
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
  /** "Leave with an unsaved prescription?" (End call, Back, browser Back). */
  protected readonly leavePrompt = new LeavePrompt();

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

  // The patient's uploaded medical documents (reviewed in-call, right panel).
  protected readonly patientDocs = signal<MedicalDocumentDto[]>([]);
  protected readonly docsLoading = signal(false);
  protected readonly docsError = signal('');
  /** Why the last document could not be opened (when there is no tab to say it in). */
  protected readonly docOpenError = signal('');
  /** A document whose new tab was blocked — offered as a link, never opened in this tab. */
  protected readonly docLink = signal<{ url: string; title: string } | null>(null);
  private docLinkTimer?: ReturnType<typeof setTimeout>;

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

  // Vitals aren't captured in-app yet — honest placeholders (no fabricated values).
  protected readonly vitals: ReadonlyArray<{ label: string; value: string }> = [
    { label: 'SYS', value: '—' },
    { label: 'DIA', value: '—' },
    { label: 'BPM', value: '—' },
    { label: '°F', value: '—' },
    { label: 'SpO₂', value: '—' },
    { label: 'RPM', value: '—' },
  ];

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
  /** Documents shown for the active Records tab (all / imaging / labs). */
  protected readonly visibleDocs = computed(() => {
    const tab = this.recordsTab();
    const docs = this.patientDocs();
    if (tab === 'imaging') return docs.filter((d) => DoctorCall.IMAGING_TYPES.has(d.document_type));
    if (tab === 'labs') return docs.filter((d) => DoctorCall.LAB_TYPES.has(d.document_type));
    return docs; // timeline + documents show everything
  });
  protected docsEmptyLabel(): string {
    switch (this.recordsTab()) {
      case 'imaging':
        return 'No imaging on file.';
      case 'labs':
        return 'No lab reports on file.';
      default:
        return 'No documents uploaded yet.';
    }
  }
  protected docIcon(d: MedicalDocumentDto): string {
    const ext = d.extension.toLowerCase();
    if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png'].includes(ext)) return 'camera';
    return 'file-text';
  }

  protected readonly participantCount = computed(() => (this.remoteJoined() ? 2 : 1));
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
  private readonly DOCTOR_TOKEN_KEY = 'videomed.doctor.token';
  private left = false;

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
      this.session.release('call');
      this.leavePrompt.answer(false);
      this.clearDocLink();
    });

    // Keep the prescribing panel mounted once it has been shown.
    effect(() => {
      if (this.rxMounted() && !untracked(this.rxKeep)) untracked(() => this.rxKeep.set(true));
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
    void this.start();
  }

  /** Window regained focus — the doctor may have just signed in in another tab. */
  protected recheckPortalSignIn(): void {
    this.authCheck.update((n) => n + 1);
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
      .schedule()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.patientLookup = 'done';
          const found = res.data.appointments.find((a) => a.id === appointmentId);
          if (found?.patient_id) this.lookedUpPatientId.set(found.patient_id);
          else this.rxPatientError.set('Could not find the patient for this consultation in your schedule.');
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
      void this.loadNote();
      void this.loadLabOrders();
      void this.loadCarePlan();
      void this.loadReferrals();
      void this.loadCertificates();
      void this.loadPatientDocuments();
      void this.loadConsents();
      void this.loadRecording();
      void this.loadCopilot();

      if (!data.configured || !data.app_id || !data.channel) {
        this.errorMessage.set('Video calling isn’t enabled on this environment yet.');
        this.status.set('error');
        return;
      }

      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      this.client = client;

      client.on('user-published', async (user, mediaType) => {
        await client.subscribe(user, mediaType);
        if (mediaType === 'video') {
          const el = this.remoteVideo()?.nativeElement;
          if (el) user.videoTrack?.play(el);
          this.remoteJoined.set(true);
        } else if (mediaType === 'audio') {
          user.audioTrack?.play();
        }
      });
      client.on('user-unpublished', (_user, mediaType) => {
        if (mediaType === 'video') this.remoteJoined.set(false);
      });
      client.on('token-privilege-will-expire', () => void this.renewToken());
      client.on('network-quality', (s) => {
        this.netUplink = s.uplinkNetworkQuality ?? 0;
        this.netDownlink = s.downlinkNetworkQuality ?? 0;
      });

      await client.join(
        data.app_id,
        data.channel,
        data.token ?? null,
        data.uid === 0 ? null : (data.uid ?? null),
      );
      if (this.left) return;

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      this.micTrack = mic;
      this.camTrack = cam;
      const localEl = this.localVideo()?.nativeElement;
      if (localEl) cam.play(localEl);
      await client.publish([mic, cam]);

      this.status.set('in-call');
      // Nobody touches the keyboard for long stretches in a consultation —
      // pause the portal idle timeout until the doctor leaves (see teardown).
      if (!this.left) this.session.hold('call');
      this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
      this.startMetricsReport();
    } catch (err: unknown) {
      this.errorMessage.set(apiErrorMessage(err, 'This join link is invalid or has expired.'));
      this.status.set('error');
    }
  }

  /** The join endpoint is public — the signed token in the path is the credential. */
  private async resolveJoin(): Promise<JoinInfoDto> {
    const res = await rawFetch(`${this.base}/api/public/call/${encodeURIComponent(this.token)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw fetchError(res.status, body);
    return body.data as JoinInfoDto;
  }

  private async renewToken(): Promise<void> {
    try {
      const data = await this.resolveJoin();
      if (data.token) await this.client?.renewToken(data.token);
    } catch {
      /* the SDK re-fires the event; a transient failure isn't fatal yet */
    }
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
      this.notesTab.set('followup');
      return;
    }
    if (label === 'Certificate') {
      this.toolNote.set('');
      this.notesTab.set('followup');
      return;
    }
    this.toolNote.set('');
  }

  // ---- Patient medical documents (in-call review) ----
  private async loadPatientDocuments(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken()) return;
    this.docsLoading.set(true);
    this.docsError.set('');
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/patient-documents`,
        { method: 'GET' },
      );
      this.patientDocs.set(Array.isArray(body.data) ? body.data : []);
    } catch (err: unknown) {
      this.docsError.set(apiErrorMessage(err, "Could not load the patient's documents."));
    } finally {
      this.docsLoading.set(false);
    }
  }

  /**
   * Open a patient document in a new tab (authenticated blob — no public URL).
   * Never opens it in THIS tab: leaving the cockpit would end the call. If the
   * browser blocks (or the doctor closes) the new tab, a link is offered here.
   */
  protected openPatientDoc(doc: MedicalDocumentDto): void {
    this.docOpenError.set('');
    this.clearDocLink();
    let tab: Window | null = null;
    try {
      tab = window.open('', '_blank');
    } catch {
      tab = null;
    }
    if (tab) {
      tab.opener = null;
      tab.document.write(
        '<!doctype html><meta charset="utf-8"><title>Opening…</title>' +
          '<body style="margin:0;font-family:sans-serif;color:#546e7a;display:flex;align-items:center;justify-content:center;height:100vh">Opening document…</body>',
      );
    }
    const token = this.doctorToken();
    rawFetch(
      `${this.base}/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/patient-documents/${encodeURIComponent(doc.id)}/file`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
      .then(async (res) => {
        if (!res.ok) throw fetchError(res.status, await res.json().catch(() => null));
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (tab && !tab.closed) {
          tab.location.href = url;
          setTimeout(() => URL.revokeObjectURL(url), 120_000);
        } else {
          this.showDocLink(url, doc.title);
        }
      })
      .catch((err: unknown) => {
        const msg = apiErrorMessage(err, 'Could not open the document.');
        if (!tab || tab.closed) {
          this.docOpenError.set(msg);
          return;
        }
        // textContent (never innerHTML): the message comes from the API response.
        const box = tab.document.createElement('div');
        box.setAttribute('style', 'padding:24px;font-family:sans-serif;color:#c62828');
        box.textContent = msg;
        tab.document.body.replaceChildren(box);
      });
  }

  /** Offer a blocked document as a link for two minutes (then the blob URL is freed). */
  private showDocLink(url: string, title: string): void {
    this.clearDocLink();
    this.docLink.set({ url, title });
    this.docLinkTimer = setTimeout(() => this.clearDocLink(), 120_000);
  }

  /** The doctor opened the link: free it shortly after the new tab has loaded it. */
  protected clearDocLinkSoon(): void {
    const link = this.docLink();
    if (!link) return;
    if (this.docLinkTimer) clearTimeout(this.docLinkTimer);
    this.docLinkTimer = setTimeout(() => this.clearDocLink(), 30_000);
  }

  private clearDocLink(): void {
    if (this.docLinkTimer) clearTimeout(this.docLinkTimer);
    this.docLinkTimer = undefined;
    const link = this.docLink();
    if (link) {
      URL.revokeObjectURL(link.url);
      this.docLink.set(null);
    }
  }

  // ---- Medical certificate ----
  private async loadCertificates(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/certificates`,
        { method: 'GET' },
      );
      this.issuedCerts.set(Array.isArray(body.data) ? body.data : []);
    } catch {
      /* leave empty */
    }
  }

  protected async issueCertificate(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.certBusy()) return;
    if (this.certStatement().trim() === '') {
      this.certError.set('Add a certifying statement.');
      return;
    }
    if (this.certType() === 'sick_leave' && (this.certFrom() === '' || this.certTo() === '')) {
      this.certError.set('Set the leave period.');
      return;
    }
    this.certError.set('');
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
    } finally {
      this.certBusy.set(false);
    }
  }

  // ---- Clinical note (SOAP) persistence ----
  private doctorToken(): string | null {
    try {
      return localStorage.getItem(this.DOCTOR_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private async noteFetch(path: string, init: RequestInit): Promise<any> {
    const token = this.doctorToken();
    const res = await rawFetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const body = await res.json().catch(() => null);
    // Carries the status + the API body's message/errors for `apiErrorMessage`.
    if (!res.ok) throw fetchError(res.status, body);
    return body;
  }

  private notePayload(): Record<string, string> {
    return {
      subjective: this.subjective(),
      objective: this.objective(),
      assessment: this.assessment(),
      plan: this.plan(),
    };
  }

  private async loadNote(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.noteLoad() === 'loading') return;
    this.noteLoad.set('loading');
    this.noteError.set('');
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
      this.noteLoad.set('ready');
    } catch (err: unknown) {
      // The editor stays read-only (and nothing is saved) until a retry
      // succeeds — otherwise auto-save would overwrite the real note.
      this.noteError.set(apiErrorMessage(err, 'Could not load the saved note.'));
      this.noteLoad.set('error');
    }
  }

  protected retryLoadNote(): void {
    void this.loadNote();
  }

  /** Debounced auto-save while the note is still a draft (only once it has loaded). */
  protected scheduleSave(): void {
    if (!this.noteEditable() || !this.doctorToken()) return;
    this.noteSaved.set('Saving…');
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    this.noteSaveTimer = setTimeout(() => void this.saveNote(), 1200);
  }

  private async saveNote(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.noteLoad() !== 'ready') return;
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note`,
        { method: 'PUT', body: JSON.stringify(this.notePayload()) },
      );
      this.noteSaved.set('Saved');
      this.noteError.set('');
    } catch (err: unknown) {
      this.noteSaved.set('Save failed — retry');
      this.noteError.set(apiErrorMessage(err, 'Could not save the note.'));
    }
  }

  protected async finalizeNote(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.finalizing()) return;
    // Never lock in a note that may be blank only because it failed to load.
    if (this.noteLoad() !== 'ready') return;
    this.finalizing.set(true);
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note/finalize`,
        { method: 'POST', body: JSON.stringify(this.notePayload()) },
      );
      this.noteStatus.set(body.data?.status === 'finalized' ? 'finalized' : 'draft');
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
    if (!this.appointmentId || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken() || this.labBusy()) return;
    const tests = this.labTests()
      .split(/\r?\n|,/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tests.length === 0) {
      this.labError.set('Add at least one test.');
      return;
    }
    this.labError.set('');
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
    if (!this.appointmentId || !this.doctorToken() || this.carePlanLoad() === 'loading') return;
    this.carePlanLoad.set('loading');
    this.carePlanError.set('');
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/care-plan`,
        { method: 'GET' },
      );
      const items: string[] = Array.isArray(body?.data?.items) ? body.data.items : [];
      this.carePlanItems.set(items.length ? items : ['']);
      if (body?.data?.published) this.carePlanSaved.set('Published');
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
    if (!this.appointmentId || !this.doctorToken() || this.carePlanBusy()) return;
    if (this.carePlanLoad() !== 'ready') return;
    const items = this.carePlanItems().map((s) => s.trim()).filter(Boolean);
    this.carePlanBusy.set(true);
    this.carePlanSaved.set('Saving…');
    this.carePlanError.set('');
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/care-plan`,
        { method: 'PUT', body: JSON.stringify({ items }) },
      );
      this.carePlanSaved.set('Published to patient');
    } catch (err: unknown) {
      this.carePlanSaved.set('Could not save — retry');
      this.carePlanError.set(apiErrorMessage(err, 'Could not publish the care plan.'));
    } finally {
      this.carePlanBusy.set(false);
    }
  }

  // ---- Referrals ----
  private async loadReferrals(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken() || this.refBusy()) return;
    if (this.refTarget().trim() === '' || this.refReason().trim() === '') {
      this.refError.set('Target and reason are required.');
      return;
    }
    this.refError.set('');
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
    if (!this.appointmentId || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken() || this.recordingBusy()) return;
    this.recordingError.set('');
    this.recordingBusy.set(true);
    const path = this.recordingActive() ? 'recording/stop' : 'recording/start';
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/${path}`,
        { method: 'POST' },
      );
      this.recordingActive.set(!this.recordingActive());
    } catch (err: unknown) {
      this.recordingError.set(apiErrorMessage(err, 'Recording failed.'));
    } finally {
      this.recordingBusy.set(false);
    }
  }

  /** End call / Back to schedule — asks first if a prescription is half-written. */
  protected async leave(): Promise<void> {
    if (!this.left && !(await this.confirmDiscardPrescription())) return;
    await this.teardown();
    void this.router.navigate(['/']);
  }

  /** Route guard hook (e.g. the browser Back button) — same question as leave(). */
  canLeave(): boolean | Promise<boolean> {
    return this.left ? true : this.confirmDiscardPrescription();
  }

  /**
   * True when it is fine to destroy the prescribing panel: nothing unsaved, or
   * the doctor chose to leave anyway. Asked with the cockpit's own dialog, as
   * the panel itself may be hidden behind another tab.
   */
  private confirmDiscardPrescription(): boolean | Promise<boolean> {
    return this.rxPanel()?.hasUnsavedChanges() ? this.leavePrompt.ask() : true;
  }

  /** Open the patient's full record in a NEW tab — without leaving the live call. */
  protected openRecord(): void {
    const id = this.info()?.patient?.id;
    if (id) window.open('/patients/' + encodeURIComponent(id), '_blank', 'noopener');
  }

  /** Report an RTC quality sample every 15s for back-office monitoring. */
  private startMetricsReport(): void {
    const report = async (): Promise<void> => {
      if (!this.client || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken()) return;
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
    if (!this.appointmentId || !this.doctorToken() || this.copilotBusy()) return;
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
    this.session.release('call');
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    if (this.timer) clearInterval(this.timer);
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.transcriptPoll) clearInterval(this.transcriptPoll);
    this.stopRecognition();
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
