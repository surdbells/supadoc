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
} from 'agora-rtc-sdk-ng';
import { AppointmentsApi, PatientApi } from '@supadoc/data-access';
import type {
  AllergyRow,
  AppointmentDto,
  ConditionRow,
  HealthProfileDto,
  MedicationRow,
  PatientProfileDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

type NotesTab = 'notes' | 'prescriptions' | 'labs' | 'followup';
type DocsTab = 'all' | 'labs' | 'imaging' | 'reports';

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
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="rounded-card bg-abyss p-3 text-white sm:p-4 lg:p-5">
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
        <!-- ============================ MAIN ============================ -->
        <div class="flex min-w-0 flex-col gap-4">
          <!-- Action bar -->
          <div class="flex items-center justify-between gap-3">
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
                aria-label="More options"
                (click)="moreOpen.set(!moreOpen())"
              >
                <span class="text-body-lg leading-none tracking-widest">⋯</span>
              </button>
            </div>
          </div>

          <!-- Video stage -->
          <div
            class="relative aspect-[16/10] w-full overflow-hidden rounded-card bg-ink"
          >
            <!-- Remote (doctor) main stage -->
            <div #remoteVideo class="absolute inset-0 bg-ink"></div>

            <!-- Waiting for doctor -->
            @if (!remoteJoined() && status() === 'in-call') {
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white/75"
              >
                <span class="flex size-16 items-center justify-center rounded-full bg-white/10">
                  <sd-icon name="user-round" [size]="30" />
                </span>
                <p class="font-sans text-body">
                  Waiting for {{ doctorName() }} to join…
                </p>
                <p class="font-sans text-caption text-white/50">
                  {{ doctorSpecialty() }}
                </p>
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
              <div
                class="absolute left-4 top-4 flex items-center gap-2 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur"
              >
                <span class="font-sans text-body-sm font-medium text-white">
                  {{ doctorName() }}
                </span>
              </div>

              <!-- HD badge -->
              <div
                class="absolute right-4 top-4 flex items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur"
              >
                <span class="font-label text-caption font-semibold text-white">HD</span>
                <span class="size-2 rounded-full bg-success"></span>
              </div>

              <!-- Local (patient) picture-in-picture -->
              <div
                class="absolute bottom-24 right-4 h-32 w-24 overflow-hidden rounded-2xl border border-white/15 bg-abyss shadow-lg sm:h-40 sm:w-28"
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

              <!-- Controls -->
              <div
                class="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-pill bg-abyss/75 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-4"
              >
                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  [attr.aria-label]="micOn() ? 'Mute microphone' : 'Unmute microphone'"
                  (click)="toggleMic()"
                >
                  <span
                    class="flex size-11 items-center justify-center rounded-full transition-colors"
                    [class]="micOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                  >
                    <sd-icon [name]="micOn() ? 'mic' : 'mic-off'" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">
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
                    class="flex size-11 items-center justify-center rounded-full transition-colors"
                    [class]="camOn() ? 'bg-white/15 hover:bg-white/25' : 'bg-alert hover:bg-alert/80'"
                  >
                    <sd-icon [name]="camOn() ? 'video' : 'video-off'" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">
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
                    class="flex size-11 items-center justify-center rounded-full transition-colors"
                    [class]="screenOn() ? 'bg-sky hover:bg-sky/80' : 'bg-white/15 hover:bg-white/25'"
                  >
                    <sd-icon name="monitor-smartphone" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">Share</span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  aria-label="Toggle chat"
                  (click)="chatOpen.set(!chatOpen())"
                >
                  <span
                    class="relative flex size-11 items-center justify-center rounded-full transition-colors"
                    [class]="chatOpen() ? 'bg-sky hover:bg-sky/80' : 'bg-white/15 hover:bg-white/25'"
                  >
                    <sd-icon name="message-square" [size]="20" />
                    @if (unreadChat() > 0 && !chatOpen()) {
                      <span class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-alert"></span>
                    }
                  </span>
                  <span class="font-sans text-[10px] text-white/70">Chat</span>
                </button>

                <button
                  type="button"
                  class="flex flex-col items-center gap-1"
                  aria-label="Leave call"
                  (click)="leave()"
                >
                  <span
                    class="flex size-11 items-center justify-center rounded-full bg-alert transition-colors hover:bg-alert/80"
                  >
                    <sd-icon name="phone-off" [size]="20" />
                  </span>
                  <span class="font-sans text-[10px] text-white/70">End</span>
                </button>
              </div>

              <!-- Elapsed timer -->
              <div
                class="absolute bottom-6 right-4 hidden items-center gap-1.5 rounded-pill bg-abyss/60 px-3 py-1.5 backdrop-blur sm:flex"
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
                  <div class="grid gap-5 sm:grid-cols-2">
                    <div class="flex flex-col gap-4">
                      <div>
                        <h4 class="font-sans text-body-sm font-semibold text-white">
                          Today’s Visit Summary
                        </h4>
                        <p class="mt-1.5 font-sans text-body-sm leading-relaxed text-white/60">
                          {{ visitSummary() }}
                        </p>
                      </div>
                      @if (conditions().length) {
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
                  @if (medications().length) {
                    <ul class="flex flex-col divide-y divide-white/10">
                      @for (m of medications(); track m.name) {
                        <li class="flex items-center gap-3 py-3">
                          <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-sky/15 text-sky">
                            <sd-icon name="pill" [size]="18" />
                          </span>
                          <span class="flex min-w-0 flex-col">
                            <span class="font-sans text-body-sm font-medium text-white">{{ m.name }}</span>
                            <span class="font-sans text-caption text-white/50">
                              {{ m.dosage }}@if (m.frequency) { · {{ m.frequency }} }
                            </span>
                          </span>
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="py-6 text-center font-sans text-body-sm text-white/40">
                      No active prescriptions.
                    </p>
                  }
                }
                @case ('labs') {
                  <p class="py-6 text-center font-sans text-body-sm text-white/40">
                    No lab orders for this consultation yet.
                  </p>
                }
                @case ('followup') {
                  <div class="flex flex-col gap-3">
                    <h4 class="font-sans text-body-sm font-semibold text-white">Follow-up Plan</h4>
                    <ul class="flex list-disc flex-col gap-1 pl-4">
                      @for (s of nextSteps(); track s) {
                        <li class="font-sans text-body-sm text-white/60">{{ s }}</li>
                      }
                    </ul>
                  </div>
                }
              }
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
                @for (r of visibleRecords(); track r.title) {
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
                      aria-label="Download"
                      [disabled]="!r.url"
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
    </div>
  `,
})
export class ConsultationCall implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);
  private readonly patientApi = inject(PatientApi);

  private readonly localVideo = viewChild<ElementRef<HTMLDivElement>>('localVideo');
  private readonly remoteVideo = viewChild<ElementRef<HTMLDivElement>>('remoteVideo');

  // ---- Call state ----
  protected readonly status = signal<'loading' | 'in-call' | 'error'>('loading');
  protected readonly errorMessage = signal('');
  protected readonly micOn = signal(true);
  protected readonly camOn = signal(true);
  protected readonly screenOn = signal(false);
  protected readonly remoteJoined = signal(false);
  protected readonly moreOpen = signal(false);
  protected readonly elapsed = signal(0);

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

  // ---- Data ----
  protected readonly appointment = signal<AppointmentDto | null>(null);
  private readonly patient = signal<PatientProfileDto | null>(null);
  private readonly health = signal<HealthProfileDto | null>(null);

  // ---- Derived: people ----
  protected readonly doctorName = computed(
    () => this.appointment()?.specialist?.name ?? 'your specialist',
  );
  protected readonly doctorSpecialty = computed(
    () => this.appointment()?.specialist?.specialty ?? '',
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

  protected readonly visitSummary = computed(
    () =>
      this.appointment()?.notes?.trim() ||
      'Your consultation notes will appear here once your specialist adds them.',
  );
  protected readonly nextSteps = computed<string[]>(() => {
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
  private readonly records = computed<RecordItem[]>(() => {
    const list: RecordItem[] = [];
    const doc = this.appointment()?.document_url ?? null;
    if (doc) {
      list.push({
        title: 'Uploaded document',
        date: 'This appointment',
        kind: 'reports',
        badge: 'FILE',
        url: this.patientApi.assetUrl(doc),
      });
    }
    return list;
  });
  protected readonly visibleRecords = computed(() => {
    const tab = this.docsTab();
    const all = this.records();
    return tab === 'all' ? all : all.filter((r) => r.kind === tab);
  });

  // ---- Agora ----
  private client?: IAgoraRTCClient;
  private micTrack?: IMicrophoneAudioTrack;
  private camTrack?: ICameraVideoTrack;
  private screenTrack?: ILocalVideoTrack;
  private timer?: ReturnType<typeof setInterval>;
  private appointmentId = '';
  private left = false;

  ngAfterViewInit(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    this.appointmentId = this.route.snapshot.paramMap.get('id') ?? '';
    // Load the surrounding context in parallel with the call — none of it blocks
    // the join, and a failure just leaves that panel on its placeholder.
    void this.loadContext();

    try {
      const { data } = await firstValueFrom(this.appointments.callToken(this.appointmentId));

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
      // Long consultations outlive a single token — re-mint and renew in place.
      client.on('token-privilege-will-expire', () => void this.renewToken());

      // uid 0 from the backend means "wildcard token" → join with null so Agora
      // assigns the uid; any non-zero uid is honoured as-is.
      await client.join(
        data.app_id,
        data.channel,
        data.token ?? null,
        data.uid === 0 ? null : data.uid,
      );
      if (this.left) return; // component destroyed mid-join

      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      this.micTrack = mic;
      this.camTrack = cam;

      const localEl = this.localVideo()?.nativeElement;
      if (localEl) cam.play(localEl);
      await client.publish([mic, cam]);

      this.status.set('in-call');
      this.startTimer();
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.errorMessage.set(message ?? 'We couldn’t start the call. Please try again.');
      this.status.set('error');
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
    this.timer = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
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
    if (r.url) window.open(r.url, '_blank', 'noopener');
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

  private async teardown(): Promise<void> {
    this.left = true;
    if (this.timer) clearInterval(this.timer);
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

  ngOnDestroy(): void {
    void this.teardown();
  }
}
