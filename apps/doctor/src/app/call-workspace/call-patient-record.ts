import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi, doctorStandingCode } from '@supadoc/data-access';
import type { AppointmentDto, DoctorPatientRecordDto, DoctorSharedDocumentDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import type { Subscription } from 'rxjs';
import { PatientMedicalHistory } from '../patients/patient-medical-history';
import { PatientOverview, type PatientRecordTab } from '../patients/patient-overview';
import { ageFrom, capitalise, formatDate, initialsOf, sortVisits } from '../patients/patient-record-ui';
import { PatientVisits } from '../patients/patient-visits';
import { RxHistory } from '../prescriptions/rx-history';
import { patientDocOrigin } from '../viewer/doctor-viewer-sources';
import { CallVisitSummary } from './call-visit-summary';
import { standingText, WS_EMR_DOCS_EMPTY, WS_EMR_DOCS_FAILED, WS_EMR_FAILED, WS_EMR_NO_DETAILS, WS_EMR_SIGNED_OUT, type WorkspaceTab } from './call-workspace-copy';

/** The record's sub-tabs: the page's four, plus the shared documents (the Figma "Schedule Details" briefing has them). */
export type EmrSection = PatientRecordTab | 'documents';

const SECTIONS: ReadonlyArray<{ readonly key: EmrSection; readonly label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'history', label: 'Medical history' },
  { key: 'visits', label: 'Visits' },
  { key: 'prescriptions', label: 'Prescription history' },
  { key: 'documents', label: 'Documents' },
];

// The page's local classes (patient-detail.ts stays untouched).
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';
const PRIMARY_ACTION =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim transition hover:bg-cerulean-dark hover:shadow-btn-hover disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2';
const SECONDARY_ACTION =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-haze bg-white px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none ' +
  FOCUS_RING;
const DOC_VIEW =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none ' +
  FOCUS_RING;
const CHIP = 'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 font-sans text-caption font-medium inset-ring inset-ring-current/15';

/**
 * The call's Full EMR, read-only: the `/patients/:id` components (Overview,
 * Medical history, Visits with an in-modal drill-in and Back, Prescription history
 * with View PDF) plus the documents shared for this consultation. Nothing here
 * navigates the tab or downloads anything: the call is never interrupted.
 */
@Component({
  selector: 'doc-call-patient-record',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CallVisitSummary, IconComponent, PatientMedicalHistory, PatientOverview, PatientVisits, RxHistory],
  host: { class: 'block' },
  template: `
    @if (!signedIn()) {
      <!-- Opened from an emailed join link without a portal session, or the session ended. -->
      <div class="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <span class="flex size-14 items-center justify-center rounded-full bg-white/[0.06] text-frost">
          <sd-icon name="lock" [size]="24" />
        </span>
        <p class="max-w-sm font-sans text-body-sm text-white">{{ signedOutText }}</p>
        <button
          type="button"
          class="flex min-h-11 items-center gap-1.5 rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-cerulean-dark"
          (click)="signIn.emit()"
        >
          <sd-icon name="external-link" [size]="14" /> Sign in to the doctor portal
        </button>
      </div>
    } @else if (!patientId()) {
      <!-- The same stops as the Prescriptions tab: nothing else can find the patient. The icon carries
           the red: --color-alert as text is under 4.5:1 on both cockpit backgrounds. -->
      @if (patientError(); as message) {
        <div class="flex flex-col items-center gap-3 px-2 py-8 text-center">
          <sd-icon name="circle-alert" [size]="26" class="text-alert" />
          <p class="max-w-sm font-sans text-body-sm text-white" role="alert">{{ message }}</p>
          <button
            type="button"
            class="flex min-h-11 items-center gap-1.5 rounded-field border border-white/15 px-3 py-1.5 font-sans text-caption text-white/80 transition-colors hover:bg-white/10"
            (click)="retryPatient.emit()"
          >
            <sd-icon name="refresh-cw" [size]="14" /> Try again
          </button>
        </div>
      } @else if (detailsFailed()) {
        <p class="py-6 text-center font-sans text-body-sm text-white/70">{{ noDetailsText }}</p>
      } @else {
        <div class="flex flex-col gap-2" aria-busy="true">
          <span class="font-sans text-caption text-white/70" role="status">Loading the patient…</span>
          <div class="sd-shimmer h-14 rounded-2xl bg-white/[0.04]"></div>
        </div>
      }
    } @else {
      <!-- Light "paper" surface: the record components use the portal palette, as on /patients/:id. -->
      <div class="sd-rx-zone flex flex-col gap-4 rounded-card bg-glacier p-3 text-ink sm:p-4">
        @if (error(); as message) {
          <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-8 text-center shadow-card" role="alert">
            <sd-icon name="circle-alert" [size]="28" class="text-alert" />
            <p class="max-w-md font-sans text-body-sm text-slate">{{ message }}</p>
            @if (!standing()) {
              <button type="button" class="${SECONDARY_ACTION}" (click)="reload()">
                <sd-icon name="refresh-cw" [size]="16" /> Try again
              </button>
            }
          </div>
        }
        @if (record(); as r) {
          <!-- Profile -->
          <section class="grid gap-5 rounded-card border border-haze bg-white p-4 shadow-card sm:p-5 lg:grid-cols-[1fr_auto]" aria-labelledby="ws-emr-patient-name">
            <div class="flex min-w-0 flex-col gap-4">
              <div class="flex items-start gap-3">
                <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 text-cerulean-dark ring-4 ring-white shadow-control" aria-hidden="true">{{ initials() }}</span>
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <h3 id="ws-emr-patient-name" class="break-words font-heading text-h5 text-ink">{{ r.patient.name }}</h3>
                  <ul class="flex flex-wrap items-center gap-2" aria-label="Patient summary">
                    @if (sex()) {
                      <li class="${CHIP} bg-frost text-cerulean-dark"><sd-icon name="user" [size]="14" /><span class="sr-only">Sex:</span>{{ sex() }}</li>
                    }
                    @if (age() !== null) {
                      <li class="${CHIP} bg-frost text-cerulean-dark"><sd-icon name="calendar-days" [size]="14" /><span class="sr-only">Age:</span>{{ age() }} yrs</li>
                    }
                    <li class="${CHIP} bg-glacier text-ink"><sd-icon name="stethoscope" [size]="14" class="text-slate" />{{ r.visit_count }} visit{{ r.visit_count === 1 ? '' : 's' }} with you</li>
                  </ul>
                </div>
                <button
                  type="button"
                  class="inline-flex size-11 shrink-0 items-center justify-center rounded-field text-slate transition hover:bg-glacier hover:text-ink ${FOCUS_RING}"
                  aria-label="Refresh the patient record"
                  (click)="reload()"
                >
                  <sd-icon name="refresh-cw" [size]="18" />
                </button>
              </div>
              <dl class="flex flex-wrap gap-3">
                @for (row of contactRows(); track row.label) {
                  <div class="flex min-w-0 flex-[1_1_auto] flex-col gap-1 rounded-field border border-cloud px-4 py-3">
                    <dt class="flex items-center gap-2 font-sans text-caption text-slate"><sd-icon [name]="row.icon" [size]="16" class="shrink-0" />{{ row.label }}</dt>
                    @if (row.value) {
                      <dd class="font-sans text-body-sm text-ink [overflow-wrap:anywhere]">{{ row.value }}</dd>
                    } @else {
                      <dd class="font-sans text-body-sm text-slate">Not provided</dd>
                    }
                  </div>
                }
              </dl>
            </div>
            <div class="flex w-full flex-col gap-2 border-t border-cloud pt-4 lg:w-64 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              <button type="button" class="${PRIMARY_ACTION}" (click)="writePrescription.emit()">
                <sd-icon name="pill" [size]="18" /> Write prescription
              </button>
              <button type="button" class="${SECONDARY_ACTION}" (click)="newLabRequest.emit()">
                <sd-icon name="microscope" [size]="18" /> New lab request
              </button>
              @if (latestVisit(); as v) {
                <button type="button" class="${SECONDARY_ACTION}" (click)="drillLatest(v)">
                  <sd-icon name="file-text" [size]="18" /> Open latest visit
                </button>
              }
            </div>
          </section>

          <!-- Sub-tabs: the page's pill bar, wrapping on phones. -->
          <div class="flex w-full flex-wrap gap-1 rounded-card border border-haze bg-glacier p-1 shadow-bar" role="tablist" aria-label="Patient record">
            @for (t of sections; track t.key; let i = $index) {
              <button
                type="button"
                role="tab"
                [id]="'ws-emr-tab-' + t.key"
                [attr.aria-selected]="section() === t.key"
                [attr.aria-controls]="seen().has(t.key) ? 'ws-emr-panel-' + t.key : null"
                [tabIndex]="section() === t.key ? 0 : -1"
                class="flex min-h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition ${FOCUS_RING}"
                [class]="section() === t.key ? 'bg-frost text-cerulean-dark shadow-control' : 'text-slate hover:text-ink'"
                (click)="openSection(t.key, false)"
                (keydown)="onTabKey($event, i)"
              >
                {{ t.label }}
                @if (t.key === 'visits' && r.visit_count > 0) {
                  <span class="flex size-5 items-center justify-center rounded-full text-[11px] font-semibold" [class]="section() === t.key ? 'bg-cerulean text-white' : 'bg-cloud text-slate'" aria-hidden="true">{{ r.visit_count }}</span>
                }
              </button>
            }
          </div>

          <!-- Each panel mounted on first show, then only hidden: a drill-in or a list stays as it was. -->
          @if (seen().has('overview')) {
            <div role="tabpanel" id="ws-emr-panel-overview" aria-labelledby="ws-emr-tab-overview" [hidden]="section() !== 'overview'">
              <doc-patient-overview [medical]="r.medical" [visits]="visits()" [visitCount]="r.visit_count" chartMode="drill" (openTab)="openSection($event, true)" (openVisit)="drill($event, 'overview')" />
            </div>
          }
          @if (seen().has('history')) {
            <div role="tabpanel" id="ws-emr-panel-history" aria-labelledby="ws-emr-tab-history" [hidden]="section() !== 'history'">
              <doc-patient-medical-history [medical]="r.medical" />
            </div>
          }
          @if (seen().has('visits')) {
            <div role="tabpanel" id="ws-emr-panel-visits" aria-labelledby="ws-emr-tab-visits" [hidden]="section() !== 'visits'">
              @if (visit(); as v) {
                <doc-call-visit-summary [visit]="v" [current]="v.id === currentAppointmentId()" (back)="back()" (goTo)="goTo.emit($event)" />
              } @else {
                <doc-patient-visits [visits]="visits()" chartMode="drill" [currentId]="currentAppointmentId()" (openVisit)="drill($event, 'visits')" />
              }
            </div>
          }
          @if (seen().has('prescriptions')) {
            <div role="tabpanel" id="ws-emr-panel-prescriptions" aria-labelledby="ws-emr-tab-prescriptions" [hidden]="section() !== 'prescriptions'">
              <doc-rx-history [patientId]="r.patient.id" [active]="active() && section() === 'prescriptions'" />
            </div>
          }
          @if (seen().has('documents')) {
            <div role="tabpanel" id="ws-emr-panel-documents" aria-labelledby="ws-emr-tab-documents" [hidden]="section() !== 'documents'">
              @switch (documentsState()) {
                @case ('loading') {
                  <div class="flex flex-col gap-3" aria-busy="true">
                    <span class="sr-only" role="status">Loading the shared documents…</span>
                    <div class="sd-shimmer h-16 rounded-card"></div>
                    <div class="sd-shimmer h-16 rounded-card"></div>
                  </div>
                }
                @case ('failed') {
                  <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-10 text-center shadow-card">
                    <sd-icon name="triangle-alert" [size]="28" class="text-alert" />
                    <p class="font-sans text-body-sm text-slate" role="alert">{{ docsFailedText }}</p>
                    <button type="button" class="${SECONDARY_ACTION}" (click)="retryDocuments.emit()">
                      <sd-icon name="refresh-cw" [size]="16" /> Try again
                    </button>
                  </div>
                }
                @default {
                  @if (documents().length) {
                    <ul class="flex flex-col gap-3">
                      @for (d of documents(); track d.id) {
                        <li class="flex flex-wrap items-center gap-3 rounded-card border border-haze bg-white p-4 shadow-card">
                          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-glacier text-slate" aria-hidden="true"><sd-icon name="file-text" [size]="18" /></span>
                          <div class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
                            <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                            <span class="font-sans text-caption text-slate [overflow-wrap:anywhere]">{{ d.type_label }} · {{ d.extension.toUpperCase() }} · {{ d.size_label }}</span>
                            @if (d.viewable === false) {
                              <span class="font-sans text-caption text-slate">Preview not available</span>
                            }
                          </div>
                          <span class="shrink-0 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium" [class]="d.uploader_role === 'patient' ? 'bg-sage/15 text-sage-ink' : 'bg-frost text-cerulean-dark'">{{ origin(d) }}</span>
                          <button
                            type="button"
                            class="${DOC_VIEW}"
                            [attr.aria-label]="'View ' + d.title"
                            [attr.data-doc-id]="d.id"
                            (click)="openDoc(d, $event.currentTarget)"
                          >
                            <sd-icon name="eye" [size]="16" /> View
                          </button>
                        </li>
                      }
                    </ul>
                  } @else {
                    <div class="flex flex-col items-center gap-3 rounded-card border border-dashed border-ash bg-white px-4 py-10 text-center">
                      <span class="flex size-14 items-center justify-center rounded-full bg-glacier text-slate"><sd-icon name="folder-open" [size]="26" /></span>
                      <p class="max-w-md font-sans text-body-sm text-slate">{{ docsEmptyText }}</p>
                    </div>
                  }
                }
              }
            </div>
          }
        } @else if (load() === 'loading' || load() === 'idle') {
          <div class="flex flex-col gap-4" aria-busy="true">
            <span class="sr-only" role="status">Loading the patient record…</span>
            <div class="sd-shimmer h-44 rounded-card"></div>
            <div class="sd-shimmer h-11 w-full max-w-md rounded-pill"></div>
            <div class="sd-shimmer h-28 rounded-card"></div>
          </div>
        }
      </div>
    }
  `,
})
export class CallPatientRecord {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly patientId = input<string | null>(null);
  readonly currentAppointmentId = input<string | null>(null);
  readonly signedIn = input(false);
  /** The tab is on screen in an open workspace (the first load waits for it). */
  readonly active = input(false);
  /** Everything the patient shares with this doctor for this consultation (not narrowed by the cockpit Records' filter), view-only. */
  readonly documents = input<readonly DoctorSharedDocumentDto[]>([]);
  /** The cockpit Records' load state for that list. */
  readonly documentsState = input<'loading' | 'failed' | 'ready'>('ready');
  /** No patient id, and the look-up that should find it failed (the call page's message, as the Prescriptions tab shows it). */
  readonly patientError = input('');
  /** No patient id, and the consultation's details never loaded: nothing can find it. */
  readonly detailsFailed = input(false);
  /** The visit summary's jumps to another tab. */
  readonly goTo = output<WorkspaceTab>();
  /** "Write prescription": the host opens the prescription composer (one being written is kept). */
  readonly writePrescription = output<void>();
  /** "New lab request": the host opens the lab request composer (one being written is kept). */
  readonly newLabRequest = output<void>();
  readonly signIn = output<void>();
  readonly openDocument = output<{ readonly doc: DoctorSharedDocumentDto; readonly opener: HTMLElement | null }>();
  readonly retryDocuments = output<void>();
  readonly retryPatient = output<void>();

  protected readonly sections = SECTIONS;
  protected readonly noDetailsText = WS_EMR_NO_DETAILS;
  protected readonly signedOutText = WS_EMR_SIGNED_OUT;
  protected readonly docsEmptyText = WS_EMR_DOCS_EMPTY;
  protected readonly docsFailedText = WS_EMR_DOCS_FAILED;

  protected readonly record = signal<DoctorPatientRecordDto | null>(null);
  protected readonly load = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  protected readonly error = signal('');
  /** The API refused the doctor for their standing: Try again cannot help. */
  protected readonly standing = signal(false);
  protected readonly section = signal<EmrSection>('overview');
  /** The sub-tabs shown so far (each mounted on first show). */
  protected readonly seen = signal<ReadonlySet<EmrSection>>(new Set(['overview']));
  /** The visit drilled into. */
  protected readonly visit = signal<AppointmentDto | null>(null);
  private drillFrom: { readonly visitId: string; readonly section: 'overview' | 'visits' } | null = null;
  private sub: Subscription | null = null;
  private readonly history = viewChild(RxHistory);

  protected readonly initials = computed(() => initialsOf(this.record()?.patient.name ?? '') || '?');
  protected readonly sex = computed(() => capitalise(this.record()?.patient.gender));
  protected readonly age = computed(() => ageFrom(this.record()?.patient.date_of_birth));
  /** Visits with this doctor, newest first. */
  protected readonly visits = computed(() => sortVisits(this.record()?.appointments ?? []));
  protected readonly latestVisit = computed(() => this.visits()[0] ?? null);
  protected readonly contactRows = computed(() => {
    const p = this.record()?.patient;
    return [
      { label: 'Email address', icon: 'mail', value: p?.email ?? '' },
      { label: 'Phone number', icon: 'phone', value: p?.phone ?? '' },
      { label: 'Date of birth', icon: 'calendar-days', value: formatDate(p?.date_of_birth) },
    ];
  });

  constructor() {
    effect(() => {
      const signedIn = this.signedIn();
      const active = this.active();
      const id = this.patientId();
      untracked(() => {
        // No PHI of an ended session stays on screen (the drill-in and the history go with the record).
        if (!signedIn) this.drop();
        else if (active && id && this.load() === 'idle') this.read(id);
      });
    });
  }

  /** Refresh, or Try again. The history has its own read: hidden, it reads when it next shows. */
  protected reload(): void {
    const id = this.patientId();
    if (!id || !this.signedIn()) return;
    this.read(id);
    if (this.section() === 'prescriptions') this.history()?.load();
  }

  private read(id: string): void {
    this.sub?.unsubscribe();
    this.load.set('loading');
    this.error.set('');
    this.standing.set(false);
    this.sub = this.api
      .patient(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.record.set(res.data);
          this.load.set('ready');
        },
        error: (err: unknown) => {
          const code = doctorStandingCode(err);
          this.standing.set(!!code);
          this.error.set(code ? standingText(code, apiErrorMessage(err, '')) : WS_EMR_FAILED);
          this.load.set('error');
        },
      });
  }

  private drop(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.record.set(null);
    this.visit.set(null);
    this.drillFrom = null;
    this.error.set('');
    this.standing.set(false);
    this.load.set('idle');
    this.seen.set(new Set([this.section()]));
  }

  // ----- sub-tabs -----

  /** `focusTab`: the pressed link is in a panel now hidden (the Overview's footer links, the keyboard). */
  protected openSection(key: EmrSection, focusTab: boolean): void {
    this.section.set(key);
    if (!this.seen().has(key)) this.seen.set(new Set([...this.seen(), key]));
    if (focusTab) this.afterRender(() => this.byId('ws-emr-tab-' + key)?.focus());
  }

  protected onTabKey(e: KeyboardEvent, index: number): void {
    const last = SECTIONS.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1;
    if (next < 0) return;
    e.preventDefault();
    this.openSection(SECTIONS[next].key, true);
  }

  // ----- the visit drill-in -----

  protected drill(v: AppointmentDto, from: 'overview' | 'visits'): void {
    this.drillFrom = { visitId: v.id, section: from };
    this.visit.set(v);
    this.openSection('visits', false);
    this.afterRender(() => this.byId('ws-emr-panel-visits')?.querySelector<HTMLElement>('[data-visit-heading]')?.focus());
  }

  /** "Open latest visit": Back returns to the sub-tab it was pressed on. */
  protected drillLatest(v: AppointmentDto): void {
    this.drill(v, this.section() === 'visits' ? 'visits' : 'overview');
  }

  protected back(): void {
    const from = this.drillFrom;
    this.drillFrom = null;
    this.visit.set(null);
    if (!from) {
      this.openSection('visits', true);
      return;
    }
    this.openSection(from.section, false);
    // Scoped to that panel: the Overview's and the Visits list's buttons both carry data-visit-id.
    this.afterRender(() => {
      const row = this.byId('ws-emr-panel-' + from.section)?.querySelector<HTMLElement>(`[data-visit-id="${from.visitId}"]`);
      (row ?? this.byId('ws-emr-tab-' + from.section))?.focus();
    });
  }

  // ----- documents -----

  protected origin(d: DoctorSharedDocumentDto): string {
    return patientDocOrigin(d);
  }

  protected openDoc(doc: DoctorSharedDocumentDto, opener: EventTarget | null): void {
    this.openDocument.emit({ doc, opener: opener instanceof HTMLElement ? opener : null });
  }

  private afterRender(fn: () => void): void {
    afterNextRender(fn, { injector: this.injector });
  }

  private byId(id: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`[id="${id}"]`);
  }
}
