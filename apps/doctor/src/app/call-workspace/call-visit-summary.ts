import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi, doctorStandingCode, LabRequestsApi } from '@supadoc/data-access';
import type {
  AppointmentDto,
  CarePlanDto,
  ClinicalNoteDto,
  LabRequestSummaryDto,
  MedicalCertificateDto,
  PrescriptionDto,
  ReferralDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { DocumentViewerService } from '@supadoc/viewer';
import { map, type Observable, type Subscription } from 'rxjs';
import { statusKey } from '../appointment/appointment-status';
import { doctorStatusLabel } from '../appointment/follow-ups';
import { DoctorClock } from '../doctor-clock';
import { LabFiles } from '../lab/lab-files';
import { labStatusMeta, numberParts } from '../lab/lab-ui';
import { formatDay, formatTime, RecordSection, VisitStatusBadge } from '../patients/patient-record-ui';
import { RxFiles } from '../prescriptions/rx-files';
import { medicinesLabel, RX_ACTION, rxDate, RxStatusBadge } from '../prescriptions/rx-shared';
import { clinicalDocumentSource } from '../viewer/doctor-viewer-sources';
import { standingText, WS_VISIT_CURRENT, type WorkspaceTab } from './call-workspace-copy';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';
const ACTION = `${RX_ACTION} min-h-11 shrink-0 ${FOCUS_RING}`;

/** One section's read. `standing`: the API refused the doctor for their standing, Try again cannot help. */
interface SectionRead<T> {
  readonly status: 'loading' | 'ready' | 'error' | 'standing';
  readonly data: T | null;
  readonly message: string;
}

const LOADING: SectionRead<never> = { status: 'loading', data: null, message: '' };

/**
 * One past visit inside the call's Full EMR, read-only: its note, prescriptions,
 * lab requests, referrals, certificates and care plan (every read keyed by the
 * visit's own id, never the call's). The consultation this call IS has no reads:
 * its note and orders are the workspace's other tabs. Nothing here navigates;
 * documents open in the shared viewer, over the workspace.
 */
@Component({
  selector: 'doc-call-visit-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RecordSection, RxStatusBadge, VisitStatusBadge],
  host: { class: 'flex flex-col gap-4' },
  template: `
    <div>
      <button
        type="button"
        class="inline-flex min-h-11 items-center gap-1.5 rounded-field px-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-cerulean-dark ${FOCUS_RING}"
        (click)="back.emit()"
      >
        <sd-icon name="arrow-left" [size]="16" /> Back to visits
      </button>
    </div>

    <section class="flex flex-col gap-2 rounded-card border border-haze bg-white p-4 shadow-card sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h4 #heading tabindex="-1" data-visit-heading class="break-words font-heading text-body-lg text-ink outline-none">{{ visit().type_label }}</h4>
        <doc-visit-status-badge [status]="key()" [label]="label()" />
      </div>
      <p class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-body-sm text-ink">
        <span class="inline-flex items-center gap-1.5"><sd-icon name="calendar-days" [size]="16" class="shrink-0 text-slate" />{{ day() }}</span>
        <span class="inline-flex items-center gap-1.5"><sd-icon name="clock" [size]="16" class="shrink-0 text-slate" />{{ time() }}</span>
      </p>
      @if (visit().notes) {
        <p class="break-words font-sans text-body-sm text-slate">{{ visit().notes }}</p>
      }
    </section>

    @if (current()) {
      <section class="flex flex-col gap-3 rounded-card border border-haze bg-white p-4 shadow-card sm:p-5">
        <p class="font-sans text-body-sm text-ink">{{ currentText }}</p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="${ACTION}" (click)="goTo.emit('notes')"><sd-icon name="square-pen" [size]="14" /> Consultation Notes</button>
          <button type="button" class="${ACTION}" (click)="goTo.emit('prescriptions')"><sd-icon name="pill" [size]="14" /> Prescriptions</button>
          <button type="button" class="${ACTION}" (click)="goTo.emit('labs')"><sd-icon name="flask-conical" [size]="14" /> Lab requests</button>
        </div>
      </section>
    } @else {
      <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <!-- Consultation note -->
        <doc-record-section icon="square-pen" heading="Consultation note" [empty]="false">
          <div class="flex flex-col gap-3 px-5 py-4">
            @switch (note().status) {
              @case ('loading') {
                <div class="sd-shimmer h-16 rounded-field" aria-busy="true"><span class="sr-only">Loading…</span></div>
              }
              @case ('ready') {
                @if (note().data; as n) {
                  @if (noteEmpty()) {
                    <p class="font-sans text-body-sm text-slate">No note was written.</p>
                  } @else {
                    <dl class="flex flex-col gap-3">
                      @for (row of noteRows(); track row.label) {
                        @if (row.value) {
                          <div class="flex flex-col gap-0.5">
                            <dt class="font-sans text-caption font-semibold text-slate">{{ row.label }}</dt>
                            <dd class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ row.value }}</dd>
                          </div>
                        }
                      }
                    </dl>
                    <p class="font-sans text-caption text-slate">
                      {{ n.status === 'finalized' ? 'Signed ' + date(n.finalized_at) + (n.author ? ' by ' + n.author : '') : 'Draft — not finalized' }}
                    </p>
                  }
                }
              }
              @default {
                <p class="font-sans text-body-sm text-alert-ink" role="alert">{{ note().message }}</p>
                @if (note().status === 'error') {
                  <button type="button" class="${ACTION} w-fit" (click)="readNote()"><sd-icon name="refresh-cw" [size]="14" /> Try again</button>
                }
              }
            }
          </div>
        </doc-record-section>

        <!-- Prescriptions -->
        <doc-record-section icon="pill" heading="Prescriptions" [count]="prescriptions().data?.length ?? null" [empty]="prescriptions().status === 'ready' && !prescriptions().data?.length" emptyText="No prescriptions from this visit">
          @switch (prescriptions().status) {
            @case ('loading') {
              <div class="px-5 py-4"><div class="sd-shimmer h-16 rounded-field" aria-busy="true"><span class="sr-only">Loading…</span></div></div>
            }
            @case ('ready') {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (rx of prescriptions().data; track rx.id) {
                  <li class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <div class="flex min-w-0 flex-col gap-1">
                      <span class="flex flex-wrap items-center gap-2">
                        <span class="break-all font-sans text-body-sm font-semibold text-ink">{{ rx.number }}</span>
                        <doc-rx-status-badge [status]="rx.status" />
                      </span>
                      <span class="font-sans text-caption text-slate">
                        {{ rx.sent_at ? 'Sent ' + date(rx.sent_at) : 'Created ' + date(rx.created_at) }} · {{ medicines(rx.items_count) }}
                      </span>
                    </div>
                    @if (rx.status !== 'draft') {
                      <button type="button" class="${ACTION}" [attr.aria-label]="'View PDF of ' + rx.number" (click)="viewRx(rx, $event.currentTarget)">
                        <sd-icon name="file-text" [size]="14" /> View PDF
                      </button>
                    }
                  </li>
                }
              </ul>
            }
            @default {
              <div class="flex flex-col gap-3 px-5 py-4">
                <p class="font-sans text-body-sm text-alert-ink" role="alert">{{ prescriptions().message }}</p>
                @if (prescriptions().status === 'error') {
                  <button type="button" class="${ACTION} w-fit" (click)="readPrescriptions()"><sd-icon name="refresh-cw" [size]="14" /> Try again</button>
                }
              </div>
            }
          }
        </doc-record-section>

        <!-- Lab requests -->
        <doc-record-section icon="flask-conical" heading="Lab requests" [count]="labs().data?.length ?? null" [empty]="labs().status === 'ready' && !labs().data?.length" emptyText="No lab requests from this visit">
          @switch (labs().status) {
            @case ('loading') {
              <div class="px-5 py-4"><div class="sd-shimmer h-16 rounded-field" aria-busy="true"><span class="sr-only">Loading…</span></div></div>
            }
            @case ('ready') {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (lab of labs().data; track lab.id) {
                  <li class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <div class="flex min-w-0 flex-col gap-1">
                      <span class="font-sans text-body-sm font-semibold text-ink [overflow-wrap:anywhere]">@for (p of parts(lab.number); track $index) {<span>{{ p }}</span><wbr />}</span>
                      <span class="font-sans text-caption text-slate [overflow-wrap:anywhere]">{{ lab.tests_label }}</span>
                      <span class="sd-chip w-fit" [class]="chip(lab).cls">{{ chip(lab).label }}</span>
                    </div>
                    <button type="button" class="${ACTION}" [attr.aria-label]="'View PDF of ' + lab.number" (click)="viewLab(lab, $event.currentTarget)">
                      <sd-icon name="file-text" [size]="14" /> View PDF
                    </button>
                  </li>
                }
              </ul>
            }
            @default {
              <div class="flex flex-col gap-3 px-5 py-4">
                <p class="font-sans text-body-sm text-alert-ink" role="alert">{{ labs().message }}</p>
                @if (labs().status === 'error') {
                  <button type="button" class="${ACTION} w-fit" (click)="readLabs()"><sd-icon name="refresh-cw" [size]="14" /> Try again</button>
                }
              </div>
            }
          }
        </doc-record-section>

        <!-- Referrals -->
        <doc-record-section icon="user-round" heading="Referrals" [count]="referrals().data?.length ?? null" [empty]="referrals().status === 'ready' && !referrals().data?.length" emptyText="No referrals from this visit">
          @switch (referrals().status) {
            @case ('loading') {
              <div class="px-5 py-4"><div class="sd-shimmer h-16 rounded-field" aria-busy="true"><span class="sr-only">Loading…</span></div></div>
            }
            @case ('ready') {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (r of referrals().data; track r.id) {
                  <li class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <div class="flex min-w-0 flex-col gap-1">
                      <span class="break-words font-sans text-body-sm font-semibold text-ink"><span class="capitalize">{{ r.referral_type }}</span> → {{ r.target }}</span>
                      <span class="font-sans text-caption text-slate">{{ r.priority === 'urgent' ? 'Urgent' : 'Routine' }}</span>
                      <span class="break-words font-sans text-caption text-slate">{{ r.reason }}</span>
                    </div>
                    <button type="button" class="${ACTION}" [attr.aria-label]="'View PDF of the referral to ' + r.target" (click)="viewReferral(r, $event.currentTarget)">
                      <sd-icon name="file-text" [size]="14" /> View PDF
                    </button>
                  </li>
                }
              </ul>
            }
            @default {
              <div class="flex flex-col gap-3 px-5 py-4">
                <p class="font-sans text-body-sm text-alert-ink" role="alert">{{ referrals().message }}</p>
                @if (referrals().status === 'error') {
                  <button type="button" class="${ACTION} w-fit" (click)="readReferrals()"><sd-icon name="refresh-cw" [size]="14" /> Try again</button>
                }
              </div>
            }
          }
        </doc-record-section>

        <!-- Certificates -->
        <doc-record-section icon="file-text" heading="Certificates" [count]="certificates().data?.length ?? null" [empty]="certificates().status === 'ready' && !certificates().data?.length" emptyText="No certificates from this visit">
          @switch (certificates().status) {
            @case ('loading') {
              <div class="px-5 py-4"><div class="sd-shimmer h-16 rounded-field" aria-busy="true"><span class="sr-only">Loading…</span></div></div>
            }
            @case ('ready') {
              <ul class="flex flex-col divide-y divide-cloud">
                @for (c of certificates().data; track c.id) {
                  <li class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <div class="flex min-w-0 flex-col gap-1">
                      <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ c.type_label }}</span>
                      @if (c.from_date && c.to_date) {
                        <span class="font-sans text-caption text-slate">{{ c.from_date }} → {{ c.to_date }}</span>
                      }
                    </div>
                    <button type="button" class="${ACTION}" [attr.aria-label]="'View PDF of ' + c.type_label" (click)="viewCertificate(c, $event.currentTarget)">
                      <sd-icon name="file-text" [size]="14" /> View PDF
                    </button>
                  </li>
                }
              </ul>
            }
            @default {
              <div class="flex flex-col gap-3 px-5 py-4">
                <p class="font-sans text-body-sm text-alert-ink" role="alert">{{ certificates().message }}</p>
                @if (certificates().status === 'error') {
                  <button type="button" class="${ACTION} w-fit" (click)="readCertificates()"><sd-icon name="refresh-cw" [size]="14" /> Try again</button>
                }
              </div>
            }
          }
        </doc-record-section>

        <!-- Care plan -->
        <doc-record-section icon="clipboard-list" heading="Care plan" [empty]="carePlan().status === 'ready' && !carePlan().data?.items?.length" emptyText="No care plan from this visit">
          @switch (carePlan().status) {
            @case ('loading') {
              <div class="px-5 py-4"><div class="sd-shimmer h-16 rounded-field" aria-busy="true"><span class="sr-only">Loading…</span></div></div>
            }
            @case ('ready') {
              <div class="flex flex-col gap-2 px-5 py-4">
                <ul class="flex flex-col gap-2">
                  @for (item of carePlan().data?.items; track $index) {
                    <li class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="circle-check" [size]="16" class="mt-0.5 shrink-0 text-sage-ink" /><span class="min-w-0 break-words">{{ item }}</span></li>
                  }
                </ul>
                <p class="font-sans text-caption text-slate">{{ carePlan().data?.published ? 'Published' : 'Not published' }}</p>
              </div>
            }
            @default {
              <div class="flex flex-col gap-3 px-5 py-4">
                <p class="font-sans text-body-sm text-alert-ink" role="alert">{{ carePlan().message }}</p>
                @if (carePlan().status === 'error') {
                  <button type="button" class="${ACTION} w-fit" (click)="readCarePlan()"><sd-icon name="refresh-cw" [size]="14" /> Try again</button>
                }
              </div>
            }
          }
        </doc-record-section>
      </div>
    }
  `,
})
export class CallVisitSummary {
  private readonly api = inject(DoctorApi);
  private readonly labApi = inject(LabRequestsApi);
  private readonly rxFiles = inject(RxFiles);
  private readonly labFiles = inject(LabFiles);
  private readonly viewer = inject(DocumentViewerService);
  private readonly clock = inject(DoctorClock);
  private readonly destroyRef = inject(DestroyRef);

  readonly visit = input.required<AppointmentDto>();
  /** The consultation this call is (its note and orders are the other tabs). */
  readonly current = input(false);
  readonly back = output<void>();
  readonly goTo = output<WorkspaceTab>();

  protected readonly currentText = WS_VISIT_CURRENT;
  protected readonly parts = numberParts;
  protected readonly note = signal<SectionRead<ClinicalNoteDto>>(LOADING);
  protected readonly prescriptions = signal<SectionRead<PrescriptionDto[]>>(LOADING);
  protected readonly labs = signal<SectionRead<LabRequestSummaryDto[]>>(LOADING);
  protected readonly referrals = signal<SectionRead<ReferralDto[]>>(LOADING);
  protected readonly certificates = signal<SectionRead<MedicalCertificateDto[]>>(LOADING);
  protected readonly carePlan = signal<SectionRead<CarePlanDto>>(LOADING);

  protected readonly key = computed(() => statusKey(this.visit()));
  protected readonly label = computed(() => doctorStatusLabel(this.visit()));
  protected readonly day = computed(() => formatDay(this.visit().scheduled_at, this.clock.zone()));
  protected readonly time = computed(() => formatTime(this.visit().scheduled_at, this.clock.zone()));
  protected readonly noteRows = computed(() => {
    const n = this.note().data;
    return [
      { label: 'Subjective', value: n?.subjective ?? '' },
      { label: 'Objective', value: n?.objective ?? '' },
      { label: 'Assessment', value: n?.assessment ?? '' },
      { label: 'Plan', value: n?.plan ?? '' },
    ];
  });
  protected readonly noteEmpty = computed(() => this.noteRows().every((r) => !r.value.trim()));
  /** The id alone: a refreshed copy of the same visit reads nothing again. */
  private readonly visitId = computed(() => this.visit().id);
  /** Each section's read still out, by the signal it would write. */
  private readonly inFlight = new Map<object, Subscription>();

  constructor() {
    // Not on init: the host's @if keeps this instance when the drill-in moves to another visit, and
    // nothing of the older visit may stay (or arrive late) under the newer visit's heading.
    effect(() => {
      this.visitId();
      const current = this.current();
      untracked(() => {
        this.inFlight.forEach((s) => s.unsubscribe());
        this.inFlight.clear();
        if (current) return;
        this.readNote();
        this.readPrescriptions();
        this.readLabs();
        this.readReferrals();
        this.readCertificates();
        this.readCarePlan();
      });
    });
  }

  private read<T>(target: WritableSignal<SectionRead<T>>, request: Observable<T>, fallback: string): void {
    this.inFlight.get(target)?.unsubscribe();
    target.set(LOADING);
    this.inFlight.set(
      target,
      request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (data) => target.set({ status: 'ready', data, message: '' }),
        error: (err: unknown) => {
          const code = doctorStandingCode(err);
          target.set(
            code
              ? { status: 'standing', data: null, message: standingText(code, apiErrorMessage(err, '')) }
              : { status: 'error', data: null, message: fallback },
          );
        },
      }),
    );
  }

  protected readNote(): void {
    this.read(this.note, this.api.getNote(this.visit().id).pipe(map((r) => r.data)), 'Could not load the note.');
  }

  protected readPrescriptions(): void {
    this.read(this.prescriptions, this.api.listPrescriptions(this.visit().id).pipe(map((r) => r.data)), 'Could not load the prescriptions.');
  }

  protected readLabs(): void {
    this.read(
      this.labs,
      this.labApi.list({ appointment_id: this.visit().id, per_page: 50 }).pipe(map((r) => [...r.data])),
      'Could not load the lab requests.',
    );
  }

  protected readReferrals(): void {
    this.read(this.referrals, this.api.listReferrals(this.visit().id).pipe(map((r) => r.data)), 'Could not load the referrals.');
  }

  protected readCertificates(): void {
    this.read(this.certificates, this.api.listCertificates(this.visit().id).pipe(map((r) => r.data)), 'Could not load the certificates.');
  }

  protected readCarePlan(): void {
    this.read(this.carePlan, this.api.getCarePlan(this.visit().id).pipe(map((r) => r.data)), 'Could not load the care plan.');
  }

  protected date(value: string | null): string {
    return rxDate(value, this.clock.zone());
  }

  protected medicines(n: number): string {
    return medicinesLabel(n);
  }

  protected chip(lab: LabRequestSummaryDto): { readonly label: string; readonly cls: string } {
    return labStatusMeta(lab);
  }

  protected viewRx(rx: PrescriptionDto, opener: EventTarget | null): void {
    this.rxFiles.view(rx, opener instanceof HTMLElement ? opener : null);
  }

  protected viewLab(lab: LabRequestSummaryDto, opener: EventTarget | null): void {
    this.labFiles.view(lab, opener instanceof HTMLElement ? opener : null);
  }

  protected viewReferral(r: ReferralDto, opener: EventTarget | null): void {
    const doc = { id: r.id, label: r.target, issued_at: r.created_at };
    this.viewer.open(clinicalDocumentSource(this.api, this.visit().id, 'referral', doc, this.clock.zone()), {
      opener: opener instanceof HTMLElement ? opener : null,
    });
  }

  protected viewCertificate(c: MedicalCertificateDto, opener: EventTarget | null): void {
    const doc = { id: c.id, label: c.type_label, issued_at: c.created_at };
    this.viewer.open(clinicalDocumentSource(this.api, this.visit().id, 'certificate', doc, this.clock.zone()), {
      opener: opener instanceof HTMLElement ? opener : null,
    });
  }
}
