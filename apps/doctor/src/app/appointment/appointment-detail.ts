import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Observable } from 'rxjs';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type {
  AppointmentDto,
  CarePlanDto,
  ClinicalNoteDto,
  ConsentDto,
  CopilotDraftDto,
  DoctorAppointmentDto,
  DoctorRecordingStateDto,
  LabOrderDto,
  PrescriptionDto,
  PrescriptionItem,
  RecordingFileDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

type TabKey =
  | 'notes'
  | 'prescriptions'
  | 'labs'
  | 'care'
  | 'referrals'
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
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab orders', icon: 'clipboard-list' },
  { key: 'care', label: 'Care plan', icon: 'list' },
  { key: 'referrals', label: 'Referrals', icon: 'share-2' },
  { key: 'consents', label: 'Consents', icon: 'shield-check' },
  { key: 'recording', label: 'Recording', icon: 'circle-play' },
  { key: 'ai', label: 'Transcript & AI', icon: 'activity' },
];

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

const FIELD =
  'w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/**
 * A consultation's clinical chart (route `/appointments/:id`) — review and edit
 * notes, prescriptions, labs, care plan, referrals, consents, recording and the
 * transcript/AI draft, all OUTSIDE the video call. Backed by `DoctorApi`; each
 * tab loads its data on first open.
 */
@Component({
  selector: 'doc-appointment-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a
        routerLink="/schedule"
        class="flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean"
      >
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Schedule
      </a>

      @if (apptError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="calendar-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ apptError() }}</p>
        </div>
      } @else {
        <!-- Header -->
        <header class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6 sm:flex-row sm:items-center sm:justify-between">
          @if (appt(); as a) {
            <div class="flex flex-col gap-1">
              <span class="flex items-center gap-2 font-heading text-h5 text-ink">
                <sd-icon name="user-round" [size]="20" class="text-cerulean" />
                {{ a.patient_name }}
                <span
                  class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold"
                  [class]="statusClass(a.status)"
                  >{{ a.status_label }}</span
                >
              </span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
                <sd-icon name="calendar-days" [size]="16" />{{ when(a.scheduled_at) }}
                <span class="text-cloud">•</span>{{ a.type_label }}
              </span>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              @if (canConfirm(a.status)) {
                <button type="button" class="flex items-center gap-2 rounded-field border border-sage px-4 py-2.5 font-sans text-body-sm font-semibold text-sage transition-colors hover:bg-sage/10 disabled:opacity-60" [disabled]="actionBusy()" (click)="confirm()">
                  <sd-icon name="circle-check" [size]="18" />Confirm
                </button>
              }
              @if (canReschedule(a.status)) {
                <button type="button" class="flex items-center gap-2 rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="toggleReschedule()">
                  <sd-icon name="calendar-clock" [size]="18" />Reschedule
                </button>
              }
              @if (canCancel(a.status)) {
                <button type="button" class="flex items-center gap-2 rounded-field border border-alert px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="actionBusy()" (click)="decline()">
                  <sd-icon name="x" [size]="18" />Decline
                </button>
              }
              <button type="button" class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="join(a)">
                <sd-icon name="video" [size]="18" />Join call
              </button>
            </div>
          } @else {
            <div class="sd-shimmer h-10 w-64 rounded-lg"></div>
          }
        </header>

        @if (rescheduleOpen()) {
          <div class="flex flex-wrap items-end gap-3 rounded-card border border-cloud bg-white p-4">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">New date &amp; time</span>
              <input type="datetime-local" class="rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" [value]="rescheduleAt()" (input)="rescheduleAt.set($any($event.target).value)" />
            </label>
            <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="actionBusy()" (click)="submitReschedule()">{{ actionBusy() ? 'Saving…' : 'Save new time' }}</button>
            <button type="button" class="font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink" (click)="rescheduleOpen.set(false)">Cancel</button>
          </div>
        }
        @if (actionError()) {
          <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ actionError() }}</p>
        }

        <!-- Tabs -->
        <div class="flex flex-wrap gap-2 border-b border-cloud pb-3">
          @for (t of tabs; track t.key) {
            <button
              type="button"
              class="flex items-center gap-2 rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors"
              [class]="tab() === t.key ? 'bg-cerulean/10 text-cerulean' : 'text-slate hover:bg-frost/40'"
              (click)="select(t.key)"
            >
              <sd-icon [name]="t.icon" [size]="16" />{{ t.label }}
            </button>
          }
        </div>

        <section class="rounded-card border border-cloud bg-white p-6">
          @switch (tab()) {
            @case ('notes') {
              <div class="flex flex-col gap-4">
                <div class="flex items-center justify-between">
                  <h2 class="font-heading text-body-lg text-ink">SOAP note</h2>
                  @if (note()) {
                    <span
                      class="rounded-pill px-3 py-1 font-sans text-caption font-semibold"
                      [class]="finalized() ? 'bg-sage/15 text-sage' : 'bg-warning/15 text-warning'"
                      >{{ finalized() ? 'Finalized' : 'Draft' }}</span
                    >
                  }
                </div>
                @for (f of noteFields; track f.key) {
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-slate">{{ f.label }}</span>
                    <textarea
                      rows="3"
                      class="${FIELD}"
                      [disabled]="finalized()"
                      [value]="noteValue(f.key)"
                      (input)="setNote(f.key, $any($event.target).value)"
                    ></textarea>
                  </label>
                }
                @if (!finalized()) {
                  <div class="flex flex-wrap gap-3">
                    <button type="button" class="rounded-field border border-cloud px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="savingNote()" (click)="saveNote(false)">
                      {{ savingNote() ? 'Saving…' : 'Save draft' }}
                    </button>
                    <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="savingNote()" (click)="saveNote(true)">
                      Finalize &amp; sign
                    </button>
                  </div>
                } @else {
                  <p class="font-sans text-caption text-slate">
                    Finalized by {{ note()?.author }} — the patient can now see the summary.
                  </p>
                }
              </div>
            }

            @case ('prescriptions') {
              <div class="flex flex-col gap-6">
                <h2 class="font-heading text-body-lg text-ink">New prescription</h2>
                <div class="flex flex-col gap-4">
                  @for (item of rxItems(); track $index) {
                    <div class="grid grid-cols-1 gap-2 rounded-field bg-glacier p-4 sm:grid-cols-2">
                      <input class="${FIELD}" placeholder="Medication *" [value]="item.medication" (input)="setRx($index,'medication',$any($event.target).value)" />
                      <input class="${FIELD}" placeholder="Strength (e.g. 500mg)" [value]="item.strength ?? ''" (input)="setRx($index,'strength',$any($event.target).value)" />
                      <input class="${FIELD}" placeholder="Dosage (e.g. 1 tablet)" [value]="item.dosage ?? ''" (input)="setRx($index,'dosage',$any($event.target).value)" />
                      <input class="${FIELD}" placeholder="Frequency (e.g. twice daily)" [value]="item.frequency ?? ''" (input)="setRx($index,'frequency',$any($event.target).value)" />
                      <input class="${FIELD}" placeholder="Duration (e.g. 7 days)" [value]="item.duration ?? ''" (input)="setRx($index,'duration',$any($event.target).value)" />
                      <input class="${FIELD}" placeholder="Quantity" [value]="item.quantity ?? ''" (input)="setRx($index,'quantity',$any($event.target).value)" />
                      <input class="${FIELD} sm:col-span-2" placeholder="Instructions" [value]="item.instructions ?? ''" (input)="setRx($index,'instructions',$any($event.target).value)" />
                      @if (rxItems().length > 1) {
                        <button type="button" class="w-fit font-sans text-caption font-semibold text-alert hover:underline" (click)="removeRx($index)">Remove</button>
                      }
                    </div>
                  }
                  <button type="button" class="w-fit font-sans text-body-sm font-semibold text-cerulean hover:underline" (click)="addRx()">+ Add medication</button>
                  <textarea rows="2" class="${FIELD}" placeholder="Notes to the patient (optional)" [value]="rxNotes()" (input)="rxNotes.set($any($event.target).value)"></textarea>
                  @if (sectionError()) { <p class="font-sans text-caption text-alert">{{ sectionError() }}</p> }
                  <button type="button" class="w-fit rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="sectionBusy()" (click)="issuePrescription()">
                    {{ sectionBusy() ? 'Issuing…' : 'Issue prescription' }}
                  </button>
                </div>
                <div class="flex flex-col gap-3">
                  <h3 class="font-heading text-body font-semibold text-slate">Issued</h3>
                  @for (rx of prescriptions(); track rx.id) {
                    <div class="rounded-field border border-cloud p-4">
                      <p class="font-sans text-caption text-slate">{{ date(rx.created_at) }} • {{ rx.status }}</p>
                      <ul class="mt-2 flex flex-col gap-1 font-sans text-body-sm text-ink">
                        @for (it of rx.items; track $index) {
                          <li>{{ it.medication }}<span class="text-slate"> {{ it.strength }} — {{ it.dosage }} {{ it.frequency }} {{ it.duration }}</span></li>
                        }
                      </ul>
                    </div>
                  } @empty { <p class="font-sans text-body-sm text-slate">No prescriptions issued.</p> }
                </div>
              </div>
            }

            @case ('labs') {
              <div class="flex flex-col gap-6">
                <h2 class="font-heading text-body-lg text-ink">New lab order</h2>
                <div class="flex flex-col gap-3">
                  <textarea rows="3" class="${FIELD}" placeholder="One test per line (e.g. Full blood count)" [value]="labTests()" (input)="labTests.set($any($event.target).value)"></textarea>
                  <div class="flex flex-wrap items-center gap-3">
                    <select class="${FIELD} w-auto" [value]="labPriority()" (change)="labPriority.set($any($event.target).value)">
                      <option value="routine">Routine</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                  <input class="${FIELD}" placeholder="Instructions (optional)" [value]="labInstructions()" (input)="labInstructions.set($any($event.target).value)" />
                  @if (sectionError()) { <p class="font-sans text-caption text-alert">{{ sectionError() }}</p> }
                  <button type="button" class="w-fit rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="sectionBusy()" (click)="orderLab()">
                    {{ sectionBusy() ? 'Ordering…' : 'Place order' }}
                  </button>
                </div>
                <div class="flex flex-col gap-3">
                  <h3 class="font-heading text-body font-semibold text-slate">Ordered</h3>
                  @for (lo of labOrders(); track lo.id) {
                    <div class="rounded-field border border-cloud p-4">
                      <p class="font-sans text-caption text-slate">{{ date(lo.created_at) }} • {{ lo.priority }}</p>
                      <p class="mt-1 font-sans text-body-sm text-ink">{{ lo.tests.join(', ') }}</p>
                    </div>
                  } @empty { <p class="font-sans text-body-sm text-slate">No lab orders.</p> }
                </div>
              </div>
            }

            @case ('care') {
              <div class="flex flex-col gap-4">
                <h2 class="font-heading text-body-lg text-ink">Care plan</h2>
                @for (item of careItems(); track $index) {
                  <div class="flex items-center gap-2">
                    <input class="${FIELD}" [value]="item" (input)="setCare($index,$any($event.target).value)" />
                    <button type="button" class="shrink-0 text-slate hover:text-alert" (click)="removeCare($index)"><sd-icon name="x" [size]="18" /></button>
                  </div>
                }
                <button type="button" class="w-fit font-sans text-body-sm font-semibold text-cerulean hover:underline" (click)="addCare()">+ Add step</button>
                @if (sectionError()) { <p class="font-sans text-caption text-alert">{{ sectionError() }}</p> }
                <button type="button" class="w-fit rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="sectionBusy()" (click)="saveCare()">
                  {{ sectionBusy() ? 'Publishing…' : 'Publish to patient' }}
                </button>
              </div>
            }

            @case ('referrals') {
              <div class="flex flex-col gap-6">
                <h2 class="font-heading text-body-lg text-ink">New referral</h2>
                <div class="flex flex-col gap-3">
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <select class="${FIELD}" [value]="refType()" (change)="refType.set($any($event.target).value)">
                      <option value="specialist">Specialist</option>
                      <option value="hospital">Hospital</option>
                      <option value="laboratory">Laboratory</option>
                      <option value="imaging">Imaging</option>
                    </select>
                    <select class="${FIELD}" [value]="refPriority()" (change)="refPriority.set($any($event.target).value)">
                      <option value="routine">Routine</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                  <input class="${FIELD}" placeholder="Refer to (name / facility)" [value]="refTarget()" (input)="refTarget.set($any($event.target).value)" />
                  <input class="${FIELD}" placeholder="Reason for referral" [value]="refReason()" (input)="refReason.set($any($event.target).value)" />
                  <textarea rows="2" class="${FIELD}" placeholder="Clinical summary (optional)" [value]="refSummary()" (input)="refSummary.set($any($event.target).value)"></textarea>
                  @if (sectionError()) { <p class="font-sans text-caption text-alert">{{ sectionError() }}</p> }
                  <button type="button" class="w-fit rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="sectionBusy()" (click)="createReferral()">
                    {{ sectionBusy() ? 'Creating…' : 'Create referral' }}
                  </button>
                </div>
                <div class="flex flex-col gap-3">
                  <h3 class="font-heading text-body font-semibold text-slate">Raised</h3>
                  @for (r of referrals(); track r.id) {
                    <div class="rounded-field border border-cloud p-4">
                      <p class="font-sans text-body-sm font-semibold text-ink">{{ r.referral_type }} → {{ r.target }}</p>
                      <p class="font-sans text-caption text-slate">{{ r.reason }} • {{ r.priority }}</p>
                    </div>
                  } @empty { <p class="font-sans text-body-sm text-slate">No referrals.</p> }
                </div>
              </div>
            }

            @case ('consents') {
              <div class="flex flex-col gap-3">
                <h2 class="font-heading text-body-lg text-ink">Patient consents</h2>
                @for (c of consents(); track c.type) {
                  <div class="flex items-center justify-between rounded-field border border-cloud p-4">
                    <span class="font-sans text-body-sm text-ink">{{ consentLabel(c.type) }}</span>
                    <span class="flex items-center gap-1.5 font-sans text-caption font-semibold" [class]="c.granted ? 'text-sage' : 'text-slate'">
                      <sd-icon [name]="c.granted ? 'circle-check' : 'x'" [size]="16" />{{ c.granted ? 'Granted' : 'Not granted' }}
                    </span>
                  </div>
                } @empty { <p class="font-sans text-body-sm text-slate">No consent decisions yet.</p> }
              </div>
            }

            @case ('recording') {
              <div class="flex flex-col gap-4">
                <h2 class="font-heading text-body-lg text-ink">Cloud recording</h2>
                @if (recording(); as rec) {
                  @if (!rec.configured) {
                    <p class="rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate">Recording isn't configured on this environment.</p>
                  } @else {
                    <div class="flex items-center gap-2 font-sans text-body-sm">
                      <span class="size-2.5 rounded-full" [class]="rec.active ? 'bg-alert' : 'bg-slate/40'"></span>
                      {{ rec.active ? 'Recording in progress' : 'Not recording' }}
                    </div>
                    @if (sectionError()) { <p class="font-sans text-caption text-alert">{{ sectionError() }}</p> }
                    @if (rec.active) {
                      <button type="button" class="w-fit rounded-field border border-alert px-5 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="sectionBusy()" (click)="stopRecording()">Stop recording</button>
                    } @else {
                      <button type="button" class="w-fit rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="sectionBusy()" (click)="startRecording()">Start recording</button>
                      <p class="font-sans text-caption text-slate">Requires the patient's recording consent (see the Consents tab).</p>
                    }
                  }
                } @else {
                  <div class="sd-shimmer h-16 rounded-field"></div>
                }

                <div class="flex flex-col gap-2 border-t border-cloud pt-4">
                  <h3 class="font-heading text-body font-semibold text-slate">Recorded files</h3>
                  @for (f of recordingFiles(); track f.key) {
                    <div class="flex items-center justify-between gap-3 rounded-field border border-cloud px-4 py-2.5">
                      <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink">
                        <sd-icon name="file-text" [size]="18" class="shrink-0 text-slate" />
                        <span class="truncate">{{ f.name }}</span>
                      </span>
                      @if (f.url) {
                        <a [href]="f.url" target="_blank" rel="noopener" class="flex shrink-0 items-center gap-1.5 font-sans text-caption font-semibold text-cerulean hover:underline">
                          <sd-icon name="download" [size]="16" />Download
                        </a>
                      } @else {
                        <span class="shrink-0 font-sans text-caption text-slate">Storage not configured</span>
                      }
                    </div>
                  } @empty {
                    <p class="font-sans text-body-sm text-slate">No recorded files yet.</p>
                  }
                </div>
              </div>
            }

            @case ('ai') {
              <div class="flex flex-col gap-6">
                <div class="flex flex-col gap-3">
                  <h2 class="font-heading text-body-lg text-ink">Transcript</h2>
                  @for (seg of transcript(); track seg.id) {
                    <div class="rounded-field bg-glacier px-4 py-2 font-sans text-body-sm">
                      <span class="font-semibold" [class]="seg.role === 'doctor' ? 'text-cerulean' : 'text-sage'">{{ seg.role }}:</span>
                      <span class="text-ink"> {{ seg.text }}</span>
                    </div>
                  } @empty { <p class="font-sans text-body-sm text-slate">No transcript captured. Live transcription runs inside the call.</p> }
                </div>
                <div class="flex flex-col gap-3">
                  <div class="flex items-center justify-between">
                    <h2 class="font-heading text-body-lg text-ink">AI copilot draft</h2>
                    <button type="button" class="rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="sectionBusy()" (click)="generateCopilot()">
                      {{ sectionBusy() ? 'Generating…' : 'Generate' }}
                    </button>
                  </div>
                  @if (sectionError()) { <p class="font-sans text-caption text-alert">{{ sectionError() }}</p> }
                  @if (copilot(); as d) {
                    <div class="flex flex-col gap-2 rounded-field bg-glacier p-4 font-sans text-body-sm text-ink">
                      @if (d.summary) { <p><span class="font-semibold text-slate">Summary:</span> {{ d.summary }}</p> }
                      @if (d.assessment) { <p><span class="font-semibold text-slate">Assessment:</span> {{ d.assessment }}</p> }
                      @if (d.plan) { <p><span class="font-semibold text-slate">Plan:</span> {{ d.plan }}</p> }
                      <p class="font-sans text-caption text-slate">AI-generated — review before use. {{ date(d.generated_at) }}</p>
                    </div>
                  } @else {
                    <p class="font-sans text-body-sm text-slate">No draft yet.</p>
                  }
                </div>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
})
export class DoctorAppointmentDetail implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tabs = TABS;
  protected readonly noteFields = [
    { key: 'subjective', label: 'Subjective' },
    { key: 'objective', label: 'Objective' },
    { key: 'assessment', label: 'Assessment' },
    { key: 'plan', label: 'Plan' },
  ] as const;

  private id = '';
  protected readonly appt = signal<DoctorAppointmentDto | null>(null);
  protected readonly apptError = signal('');

  // Lifecycle actions (confirm / decline / reschedule)
  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal('');
  protected readonly rescheduleOpen = signal(false);
  protected readonly rescheduleAt = signal('');

  protected readonly tab = signal<TabKey>('notes');
  private readonly loaded = new Set<TabKey>();

  protected readonly sectionBusy = signal(false);
  protected readonly sectionError = signal('');

  // Notes
  protected readonly note = signal<ClinicalNoteDto | null>(null);
  private readonly noteDraft = signal<Record<string, string>>({
    subjective: '',
    objective: '',
    assessment: '',
    plan: '',
  });
  protected readonly savingNote = signal(false);
  protected readonly finalized = computed(() => this.note()?.status === 'finalized');

  // Prescriptions
  protected readonly prescriptions = signal<PrescriptionDto[]>([]);
  protected readonly rxItems = signal<PrescriptionItem[]>([{ medication: '' }]);
  protected readonly rxNotes = signal('');

  // Labs
  protected readonly labOrders = signal<LabOrderDto[]>([]);
  protected readonly labTests = signal('');
  protected readonly labPriority = signal<'routine' | 'urgent'>('routine');
  protected readonly labInstructions = signal('');

  // Care plan
  protected readonly careItems = signal<string[]>([]);

  // Referrals
  protected readonly referrals = signal<ReferralDto[]>([]);
  protected readonly refType = signal<ReferralDto['referral_type']>('specialist');
  protected readonly refTarget = signal('');
  protected readonly refReason = signal('');
  protected readonly refSummary = signal('');
  protected readonly refPriority = signal<'routine' | 'urgent'>('routine');

  // Consents / recording / AI
  protected readonly consents = signal<ConsentDto[]>([]);
  protected readonly recording = signal<DoctorRecordingStateDto | null>(null);
  protected readonly recordingFiles = signal<RecordingFileDto[]>([]);
  protected readonly transcript = signal<TranscriptSegmentDto[]>([]);
  protected readonly copilot = signal<CopilotDraftDto | null>(null);

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    // The header comes from the schedule list (there is no single-appointment GET).
    this.api
      .schedule()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const found = res.data.appointments.find((a) => a.id === this.id) ?? null;
          if (found) this.appt.set(found);
          else this.apptError.set('Appointment not found.');
        },
        error: () => this.apptError.set('Could not load the appointment.'),
      });
    this.select('notes');
  }

  protected select(tab: TabKey): void {
    this.tab.set(tab);
    this.sectionError.set('');
    if (this.loaded.has(tab)) return;
    this.loaded.add(tab);
    this.loadTab(tab);
  }

  private loadTab(tab: TabKey): void {
    switch (tab) {
      case 'notes':
        this.api.getNote(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (r) => {
            this.note.set(r.data);
            this.noteDraft.set({
              subjective: r.data.subjective ?? '',
              objective: r.data.objective ?? '',
              assessment: r.data.assessment ?? '',
              plan: r.data.plan ?? '',
            });
          },
          error: () => undefined,
        });
        break;
      case 'prescriptions':
        this.api.listPrescriptions(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.prescriptions.set(r.data), error: () => undefined });
        break;
      case 'labs':
        this.api.listLabOrders(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.labOrders.set(r.data), error: () => undefined });
        break;
      case 'care':
        this.api.getCarePlan(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.careItems.set(r.data.items ?? []), error: () => undefined });
        break;
      case 'referrals':
        this.api.listReferrals(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.referrals.set(r.data), error: () => undefined });
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

  // ----- Notes -----
  protected noteValue(key: string): string {
    return this.noteDraft()[key] ?? '';
  }
  protected setNote(key: string, value: string): void {
    this.noteDraft.update((d) => ({ ...d, [key]: value }));
  }
  protected saveNote(finalize: boolean): void {
    this.savingNote.set(true);
    this.sectionError.set('');
    const d = this.noteDraft();
    const input = { subjective: d['subjective'], objective: d['objective'], assessment: d['assessment'], plan: d['plan'] };
    const call = finalize ? this.api.finalizeNote(this.id, input) : this.api.saveNote(this.id, input);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.note.set(r.data);
        this.savingNote.set(false);
      },
      error: () => {
        this.sectionError.set('Could not save the note.');
        this.savingNote.set(false);
      },
    });
  }

  // ----- Prescriptions -----
  protected addRx(): void {
    this.rxItems.update((list) => [...list, { medication: '' }]);
  }
  protected removeRx(i: number): void {
    this.rxItems.update((list) => list.filter((_, idx) => idx !== i));
  }
  protected setRx(i: number, field: keyof PrescriptionItem, value: string): void {
    this.rxItems.update((list) => list.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
  }
  protected issuePrescription(): void {
    const items = this.rxItems().filter((it) => it.medication.trim() !== '');
    if (items.length === 0) {
      this.sectionError.set('Add at least one medication.');
      return;
    }
    this.runSection(this.api.createPrescription(this.id, { items, notes: this.rxNotes() || null }), () => {
      this.rxItems.set([{ medication: '' }]);
      this.rxNotes.set('');
      this.api.listPrescriptions(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.prescriptions.set(r.data), error: () => undefined });
    });
  }

  // ----- Labs -----
  protected orderLab(): void {
    const tests = this.labTests().split('\n').map((t) => t.trim()).filter(Boolean);
    if (tests.length === 0) {
      this.sectionError.set('Add at least one test.');
      return;
    }
    this.runSection(this.api.createLabOrder(this.id, { tests, priority: this.labPriority(), instructions: this.labInstructions() || null }), () => {
      this.labTests.set('');
      this.labInstructions.set('');
      this.api.listLabOrders(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.labOrders.set(r.data), error: () => undefined });
    });
  }

  // ----- Care plan -----
  protected addCare(): void {
    this.careItems.update((list) => [...list, '']);
  }
  protected removeCare(i: number): void {
    this.careItems.update((list) => list.filter((_, idx) => idx !== i));
  }
  protected setCare(i: number, value: string): void {
    this.careItems.update((list) => list.map((v, idx) => (idx === i ? value : v)));
  }
  protected saveCare(): void {
    const items = this.careItems().map((v) => v.trim()).filter(Boolean);
    this.runSection(this.api.saveCarePlan(this.id, items), (r) => this.careItems.set((r.data as CarePlanDto).items ?? items));
  }

  // ----- Referrals -----
  protected createReferral(): void {
    if (this.refTarget().trim() === '' || this.refReason().trim() === '') {
      this.sectionError.set('Please complete the referral.');
      return;
    }
    this.runSection(
      this.api.createReferral(this.id, {
        referral_type: this.refType(),
        target: this.refTarget(),
        reason: this.refReason(),
        clinical_summary: this.refSummary() || null,
        priority: this.refPriority(),
      }),
      () => {
        this.refTarget.set('');
        this.refReason.set('');
        this.refSummary.set('');
        this.api.listReferrals(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.referrals.set(r.data), error: () => undefined });
      },
    );
  }

  // ----- Recording -----
  protected startRecording(): void {
    this.runSection(this.api.startRecording(this.id), () => this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined }), 'Could not start recording — check the patient has granted recording consent.');
  }
  protected stopRecording(): void {
    this.runSection(this.api.stopRecording(this.id), () => {
      this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined });
      this.api.recordingFiles(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recordingFiles.set(r.data.files), error: () => undefined });
    });
  }

  // ----- AI -----
  protected generateCopilot(): void {
    this.runSection(this.api.generateCopilot(this.id), (r) => this.copilot.set(r.data as CopilotDraftDto), 'Could not generate a draft — AI or transcription consent may be unavailable.');
  }

  /** Run a section mutation with shared busy/error handling. */
  private runSection<T>(
    call: Observable<T>,
    onSuccess: (res: T) => void,
    errorMessage = 'Something went wrong. Please try again.',
  ): void {
    this.sectionBusy.set(true);
    this.sectionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        onSuccess(res);
        this.sectionBusy.set(false);
      },
      error: () => {
        this.sectionError.set(errorMessage);
        this.sectionBusy.set(false);
      },
    });
  }

  protected join(a: DoctorAppointmentDto): void {
    const marker = '/call/join/';
    const idx = a.join_url.indexOf(marker);
    const token = idx >= 0 ? a.join_url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = a.join_url;
  }

  // ----- Lifecycle actions -----
  protected canConfirm(s: string): boolean {
    return s === 'pending' || s === 'rescheduled';
  }
  protected canReschedule(s: string): boolean {
    return ['pending', 'confirmed', 'rescheduled'].includes(s);
  }
  protected canCancel(s: string): boolean {
    return ['pending', 'confirmed', 'rescheduled'].includes(s);
  }
  protected toggleReschedule(): void {
    this.rescheduleOpen.update((v) => !v);
    this.actionError.set('');
  }
  protected confirm(): void {
    this.runAction(this.api.confirm(this.id));
  }
  protected decline(): void {
    if (!window.confirm('Decline this appointment? Any payment will be refunded to the patient.')) return;
    this.runAction(this.api.decline(this.id));
  }
  protected submitReschedule(): void {
    if (this.rescheduleAt().trim() === '') {
      this.actionError.set('Choose a new date and time.');
      return;
    }
    this.runAction(
      this.api.reschedule(this.id, new Date(this.rescheduleAt()).toISOString()),
      () => this.rescheduleOpen.set(false),
    );
  }
  private runAction(call: Observable<SuccessResponse<AppointmentDto>>, onOk?: () => void): void {
    this.actionBusy.set(true);
    this.actionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.appt.update((a) =>
          a ? { ...a, status: res.data.status, status_label: res.data.status_label, scheduled_at: res.data.scheduled_at } : a,
        );
        this.actionBusy.set(false);
        onOk?.();
      },
      error: (err) => {
        this.actionError.set(apiErrorMessage(err, 'Could not update the appointment.'));
        this.actionBusy.set(false);
      },
    });
  }

  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
  protected consentLabel(type: string): string {
    return type === 'ai_transcription' ? 'AI transcription' : type === 'data_sharing' ? 'Data sharing' : 'Recording';
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
