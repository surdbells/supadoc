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
import AgoraRTC, {
  IAgoraRTCClient,
  ICameraVideoTrack,
  ILocalVideoTrack,
  IMicrophoneAudioTrack,
} from 'agora-rtc-sdk-ng';
import type {
  ConsentDto,
  CopilotDraftDto,
  JoinInfoDto,
  LabOrderDto,
  PrescriptionDto,
  PrescriptionItem,
  ReferralDto,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { environment } from '../environments/environment';

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
type RecordsTab = 'timeline' | 'documents' | 'imaging' | 'labs';

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
  imports: [IconComponent],
  host: { class: 'sd-call block min-h-screen bg-abyss text-white', '[attr.data-theme]': 'theme()' },
  template: `
    <div class="flex min-h-screen flex-col">
      <!-- Top bar -->
      <header
        class="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
      >
        <div class="flex items-center gap-3">
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
              [attr.title]="!recordingActive() && !recordingConsent() ? 'Patient recording consent required' : null"
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
        class="grid flex-1 gap-4 p-4 xl:grid-cols-[300px_minmax(0,1fr)_320px]"
      >
        <!-- ===================== PATIENT CHART ===================== -->
        <aside class="flex flex-col gap-4 xl:overflow-y-auto">
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

          <button
            type="button"
            class="flex items-center justify-center gap-2 rounded-field border border-white/15 py-2.5 font-sans text-body-sm font-semibold text-white/85 transition-colors hover:bg-white/10"
            (click)="leave()"
          >
            <sd-icon name="file-text" [size]="16" /> View Full EMR
          </button>
        </aside>

        <!-- ===================== STAGE ===================== -->
        <section class="flex min-w-0 flex-col gap-4">
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
                          [disabled]="finalizing()"
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

                  <div class="grid gap-4 lg:grid-cols-2">
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold text-white/60">Subjective</span>
                      <textarea
                        rows="3"
                        placeholder="Patient-reported symptoms and history…"
                        class="resize-y rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 font-sans text-body-sm text-white placeholder:text-white/35 read-only:opacity-70 focus:border-cerulean focus:outline-none"
                        [value]="subjective()"
                        [readOnly]="noteFinalized() || !canDocument()"
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
                        [readOnly]="noteFinalized() || !canDocument()"
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
                        [readOnly]="noteFinalized() || !canDocument()"
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
                        [readOnly]="noteFinalized() || !canDocument()"
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
                  @if (!canDocument()) {
                    <p class="mb-3 rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">
                      Sign in to the doctor portal to prescribe.
                    </p>
                  }
                  <div class="flex flex-col gap-3">
                    @for (row of rxItems(); track $index) {
                      <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          <input placeholder="Medication"
                            class="col-span-2 min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none sm:col-span-1"
                            [value]="row.medication" (input)="updateRx($index,'medication',$any($event.target).value)" />
                          <input placeholder="Strength (e.g. 50mg)"
                            class="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                            [value]="row.strength" (input)="updateRx($index,'strength',$any($event.target).value)" />
                          <input placeholder="Dosage (e.g. 1 tablet)"
                            class="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                            [value]="row.dosage" (input)="updateRx($index,'dosage',$any($event.target).value)" />
                          <input placeholder="Frequency (e.g. daily)"
                            class="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                            [value]="row.frequency" (input)="updateRx($index,'frequency',$any($event.target).value)" />
                          <input placeholder="Duration (e.g. 30 days)"
                            class="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                            [value]="row.duration" (input)="updateRx($index,'duration',$any($event.target).value)" />
                          <input placeholder="Instructions"
                            class="col-span-2 min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-caption text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none sm:col-span-3"
                            [value]="row.instructions" (input)="updateRx($index,'instructions',$any($event.target).value)" />
                        </div>
                        @if (rxItems().length > 1) {
                          <button type="button"
                            class="mt-2 flex items-center gap-1 font-sans text-caption text-white/50 transition-colors hover:text-alert"
                            (click)="removeRxRow($index)">
                            <sd-icon name="trash-2" [size]="13" /> Remove
                          </button>
                        }
                      </div>
                    }
                    <div class="flex flex-wrap items-center gap-2">
                      <button type="button"
                        class="flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/80 transition-colors hover:bg-white/10"
                        (click)="addRxRow()">
                        <sd-icon name="plus" [size]="14" /> Add medication
                      </button>
                      <button type="button"
                        class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                        [disabled]="rxBusy() || !canDocument()" (click)="issueRx()">
                        <sd-icon name="check" [size]="14" /> {{ rxBusy() ? 'Issuing…' : 'Sign & issue' }}
                      </button>
                    </div>
                    @if (rxError()) {
                      <p class="font-sans text-caption text-alert">{{ rxError() }}</p>
                    }
                  </div>

                  @if (issuedRx().length) {
                    <div class="mt-4 border-t border-white/10 pt-3">
                      <p class="mb-2 font-sans text-caption font-semibold text-white/60">Issued this consultation</p>
                      <ul class="flex flex-col gap-2">
                        @for (p of issuedRx(); track p.id) {
                          <li class="flex items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                            <sd-icon name="pill" [size]="16" class="text-sky" />
                            <span class="flex-1 font-sans text-body-sm text-white/85">{{ rxSummary(p) }}</span>
                            <span class="rounded-pill bg-success/15 px-2 py-0.5 font-sans text-[10px] text-success">Signed</span>
                          </li>
                        }
                      </ul>
                    </div>
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
                  <div class="flex flex-col gap-2">
                    @for (item of carePlanItems(); track $index) {
                      <div class="flex items-center gap-2">
                        <sd-icon name="circle-check" [size]="16" class="shrink-0 text-sage" />
                        <input
                          placeholder="e.g. Monitor blood pressure daily"
                          class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 font-sans text-body-sm text-white placeholder:text-white/35 focus:border-cerulean focus:outline-none"
                          [value]="item"
                          (input)="updateCareItem($index, $any($event.target).value)"
                        />
                        @if (carePlanItems().length > 1) {
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
                        class="flex items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/80 transition-colors hover:bg-white/10"
                        (click)="addCareItem()"
                      >
                        <sd-icon name="plus" [size]="14" /> Add item
                      </button>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-1.5 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:opacity-50"
                        [disabled]="carePlanBusy() || !canDocument()"
                        (click)="saveCarePlan()"
                      >
                        <sd-icon name="check" [size]="14" /> Save &amp; publish
                      </button>
                    </div>
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
                  @if (!aiConsent()) {
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
                          [disabled]="noteFinalized()"
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
          </div>
        </section>

        <!-- ===================== RECORDS + PARTICIPANTS ===================== -->
        <aside class="flex flex-col gap-4 xl:overflow-y-auto">
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
            <div class="flex flex-col items-center gap-2 py-6 text-center">
              <sd-icon name="clipboard-list" [size]="26" class="text-white/30" />
              <p class="font-sans text-caption text-white/40">
                Records sync from the patient's EMR — none shared in this session yet.
              </p>
            </div>
          </div>

          <!-- Shared during call -->
          <div class="rounded-card border border-white/10 bg-white/[0.03] p-4">
            <h3 class="mb-2 font-sans text-body-sm font-semibold text-white">Shared During Call</h3>
            <p class="py-3 text-center font-sans text-caption text-white/40">
              Files shared in the call appear here.
            </p>
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
              <sd-icon name="shield-check" [size]="15" [class]="recordingConsent() ? 'text-success' : 'text-white/40'" />
              <span class="font-sans text-caption text-white/60">
                Recording consent:
                <span [class]="recordingConsent() ? 'text-success' : 'text-white/50'">{{ recordingConsent() ? 'granted' : 'not granted' }}</span>
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  `,
})
export class DoctorCall implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

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
  protected readonly recordsTab = signal<RecordsTab>('timeline');
  protected readonly subjective = signal('');
  protected readonly objective = signal('');
  protected readonly assessment = signal('');
  protected readonly plan = signal('');
  protected readonly toolNote = signal('');

  // Clinical-note persistence state.
  protected readonly noteStatus = signal<'draft' | 'finalized'>('draft');
  protected readonly noteSaved = signal('');
  protected readonly finalizing = signal(false);
  protected readonly noteFinalized = computed(() => this.noteStatus() === 'finalized');
  protected readonly canDocument = computed(() => this.doctorToken() !== null);

  // ePrescription builder + issued list.
  protected readonly rxItems = signal<PrescriptionItem[]>([this.emptyRx()]);
  protected readonly rxNotes = signal('');
  protected readonly rxBusy = signal(false);
  protected readonly rxError = signal('');
  protected readonly issuedRx = signal<PrescriptionDto[]>([]);

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

  // Referral form + list.
  protected readonly refType = signal<ReferralDto['referral_type']>('specialist');
  protected readonly refTarget = signal('');
  protected readonly refReason = signal('');
  protected readonly refPriority = signal<'routine' | 'urgent'>('routine');
  protected readonly refBusy = signal(false);
  protected readonly refError = signal('');
  protected readonly referrals = signal<ReferralDto[]>([]);

  // Patient consent decisions (read-only for the doctor).
  protected readonly consents = signal<ConsentDto[]>([]);
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
    { key: 'timeline', label: 'Timeline' },
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
  protected readonly allergiesLabel = computed(() => {
    const a = this.info()?.patient?.allergies ?? [];
    return a.length ? a.map((x) => x.allergen).join(', ') : 'None recorded';
  });
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

  ngAfterViewInit(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    try {
      const data = await this.resolveJoin();
      this.info.set(data);
      this.appointmentId = data.appointment_id;
      void this.loadNote();
      void this.loadPrescriptions();
      void this.loadLabOrders();
      void this.loadCarePlan();
      void this.loadReferrals();
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
      this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
      this.startMetricsReport();
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'This join link is invalid or has expired.');
      this.status.set('error');
    }
  }

  /** The join endpoint is public — the signed token in the path is the credential. */
  private async resolveJoin(): Promise<JoinInfoDto> {
    const res = await fetch(`${this.base}/api/public/call/${encodeURIComponent(this.token)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? 'This join link is invalid or has expired.');
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
    // Certificate lands in a later phase; the rest are live.
    this.toolNote.set(`${label} isn’t wired up yet — coming soon.`);
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
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? 'Request failed');
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
    if (!this.appointmentId || !this.doctorToken()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note`,
        { method: 'GET' },
      );
      const n = body.data;
      this.subjective.set(n.subjective ?? '');
      this.objective.set(n.objective ?? '');
      this.assessment.set(n.assessment ?? '');
      this.plan.set(n.plan ?? '');
      this.noteStatus.set(n.status === 'finalized' ? 'finalized' : 'draft');
      if (n.updated_at) this.noteSaved.set('Saved');
    } catch {
      /* fresh editor on failure */
    }
  }

  /** Debounced auto-save while the note is still a draft. */
  protected scheduleSave(): void {
    if (this.noteFinalized() || !this.doctorToken()) return;
    this.noteSaved.set('Saving…');
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    this.noteSaveTimer = setTimeout(() => void this.saveNote(), 1200);
  }

  private async saveNote(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken()) return;
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note`,
        { method: 'PUT', body: JSON.stringify(this.notePayload()) },
      );
      this.noteSaved.set('Saved');
    } catch {
      this.noteSaved.set('Save failed — retry');
    }
  }

  protected async finalizeNote(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.finalizing()) return;
    this.finalizing.set(true);
    if (this.noteSaveTimer) clearTimeout(this.noteSaveTimer);
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/note/finalize`,
        { method: 'POST', body: JSON.stringify(this.notePayload()) },
      );
      this.noteStatus.set(body.data?.status === 'finalized' ? 'finalized' : 'draft');
      this.noteSaved.set('Finalized & locked');
    } catch {
      this.noteSaved.set('Could not finalize — retry');
    } finally {
      this.finalizing.set(false);
    }
  }

  // ---- ePrescription ----
  private emptyRx(): PrescriptionItem {
    return {
      medication: '',
      strength: '',
      dosage: '',
      frequency: '',
      duration: '',
      quantity: '',
      instructions: '',
    };
  }

  protected addRxRow(): void {
    this.rxItems.update((rows) => [...rows, this.emptyRx()]);
  }

  protected removeRxRow(index: number): void {
    this.rxItems.update((rows) =>
      rows.length <= 1 ? [this.emptyRx()] : rows.filter((_, i) => i !== index),
    );
  }

  protected updateRx(index: number, field: keyof PrescriptionItem, value: string): void {
    this.rxItems.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  private async loadPrescriptions(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/prescriptions`,
        { method: 'GET' },
      );
      this.issuedRx.set(Array.isArray(body.data) ? body.data : []);
    } catch {
      /* leave empty */
    }
  }

  protected async issueRx(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.rxBusy()) return;
    const items = this.rxItems().filter((r) => r.medication.trim() !== '');
    if (items.length === 0) {
      this.rxError.set('Add at least one medication.');
      return;
    }
    this.rxError.set('');
    this.rxBusy.set(true);
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/prescriptions`,
        { method: 'POST', body: JSON.stringify({ items, notes: this.rxNotes() }) },
      );
      this.rxItems.set([this.emptyRx()]);
      this.rxNotes.set('');
      await this.loadPrescriptions();
      this.notesTab.set('prescriptions');
    } catch (err) {
      this.rxError.set((err as { message?: string })?.message ?? 'Could not issue prescription.');
    } finally {
      this.rxBusy.set(false);
    }
  }

  protected rxSummary(p: PrescriptionDto): string {
    return p.items
      .map((i) => [i.medication, i.strength, i.dosage].filter(Boolean).join(' '))
      .join(', ');
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
    } catch (err) {
      this.labError.set((err as { message?: string })?.message ?? 'Could not create order.');
    } finally {
      this.labBusy.set(false);
    }
  }

  // ---- Care plan ----
  private async loadCarePlan(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken()) return;
    try {
      const body = await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/care-plan`,
        { method: 'GET' },
      );
      const items: string[] = Array.isArray(body.data?.items) ? body.data.items : [];
      this.carePlanItems.set(items.length ? items : ['']);
      if (body.data?.published) this.carePlanSaved.set('Published');
    } catch {
      /* leave empty */
    }
  }

  protected addCareItem(): void {
    this.carePlanItems.update((rows) => [...rows, '']);
  }

  protected removeCareItem(index: number): void {
    this.carePlanItems.update((rows) =>
      rows.length <= 1 ? [''] : rows.filter((_, i) => i !== index),
    );
  }

  protected updateCareItem(index: number, value: string): void {
    this.carePlanItems.update((rows) => rows.map((r, i) => (i === index ? value : r)));
  }

  protected async saveCarePlan(): Promise<void> {
    if (!this.appointmentId || !this.doctorToken() || this.carePlanBusy()) return;
    const items = this.carePlanItems().map((s) => s.trim()).filter(Boolean);
    this.carePlanBusy.set(true);
    this.carePlanSaved.set('Saving…');
    try {
      await this.noteFetch(
        `/api/doctor/appointments/${encodeURIComponent(this.appointmentId)}/care-plan`,
        { method: 'PUT', body: JSON.stringify({ items }) },
      );
      this.carePlanSaved.set('Published to patient');
    } catch {
      this.carePlanSaved.set('Could not save — retry');
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
    } catch (err) {
      this.refError.set((err as { message?: string })?.message ?? 'Could not create referral.');
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
    } catch {
      /* leave empty */
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
    } catch (err) {
      this.recordingError.set((err as { message?: string })?.message ?? 'Recording failed.');
    } finally {
      this.recordingBusy.set(false);
    }
  }

  protected async leave(): Promise<void> {
    await this.teardown();
    void this.router.navigate(['/']);
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
      this.copilotError.set('The patient has not granted AI-transcription consent.');
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
    } catch (err) {
      this.copilotError.set((err as { message?: string })?.message ?? 'Could not generate a draft.');
    } finally {
      this.copilotBusy.set(false);
    }
  }

  /** Carry the AI draft into the SOAP editor for the clinician to review + finalize. */
  protected useDraftInNote(): void {
    const d = this.copilotDraft();
    if (!d || this.noteFinalized()) return;
    if (d.subjective) this.subjective.set(d.subjective);
    if (d.objective) this.objective.set(d.objective);
    if (d.assessment) this.assessment.set(d.assessment);
    if (d.plan) this.plan.set(d.plan);
    this.notesTab.set('notes');
    this.scheduleSave();
  }

  private async teardown(): Promise<void> {
    this.left = true;
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
