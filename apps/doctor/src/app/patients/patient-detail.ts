import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorPatientRecordDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { RxPanel } from '../prescriptions/rx-panel';
import { PatientMedicalHistory } from './patient-medical-history';
import { PatientOverview, type PatientRecordTab } from './patient-overview';
import {
  ageFrom,
  capitalise,
  formatDate,
  formatDay,
  initialsOf,
  sortVisits,
} from './patient-record-ui';
import { PatientVisits } from './patient-visits';

interface RecordTab {
  readonly key: PatientRecordTab;
  readonly label: string;
}

const TABS: readonly RecordTab[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'history', label: 'Medical history' },
  { key: 'prescriptions', label: 'Prescriptions' },
  { key: 'visits', label: 'Visits' },
];

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

const PRIMARY_ACTION =
  'inline-flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white shadow-[0_2px_10px_rgba(21,101,192,0.25)] transition-colors hover:bg-cerulean-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2';

const SECONDARY_ACTION =
  'inline-flex items-center justify-center gap-2 rounded-field border border-cloud bg-white px-5 py-3 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean ' +
  FOCUS_RING;

const CHIP =
  'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 font-sans text-caption font-medium';

/** A patient's record for the doctor (route `/patients/:id`). */
@Component({
  selector: 'doc-patient-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    EmptyStateComponent,
    IconComponent,
    PatientMedicalHistory,
    PatientOverview,
    PatientVisits,
    RxPanel,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-heading text-h3 text-ink">Patient Details</h1>
        <a routerLink="/patients" class="flex shrink-0 items-center gap-1 rounded-field font-sans text-body text-slate transition-colors hover:text-cerulean ${FOCUS_RING}" aria-label="Back to patients">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" /> Patients
        </a>
      </div>

      @if (error()) {
        <div class="rounded-card border border-cloud bg-white px-4" role="alert">
          <sd-empty-state icon="user-x" tone="error" title="We couldn't open this patient" [message]="error()">
            <a routerLink="/patients" class="${SECONDARY_ACTION}">
              <sd-icon name="users" [size]="18" />Back to patients
            </a>
          </sd-empty-state>
        </div>
      } @else if (record(); as r) {
        <!-- Profile header + quick actions -->
        <section class="grid gap-6 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-6 lg:grid-cols-[1fr_auto]" aria-labelledby="pd-patient-name">
          <div class="flex min-w-0 flex-col gap-5">
            <div class="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
              <span class="flex size-20 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h4 text-cerulean sm:size-24 sm:text-h3" aria-hidden="true">{{ initials() }}</span>
              <div class="flex min-w-0 flex-1 flex-col gap-2.5">
                <h2 id="pd-patient-name" class="break-words font-heading text-h4 text-ink">{{ r.patient.name }}</h2>
                <ul class="flex flex-wrap items-center justify-center gap-2 sm:justify-start" aria-label="Patient summary">
                  @if (sex()) {
                    <li class="${CHIP} bg-frost text-cerulean"><sd-icon name="user" [size]="14" /><span class="sr-only">Sex:</span>{{ sex() }}</li>
                  }
                  @if (age() !== null) {
                    <li class="${CHIP} bg-frost text-cerulean"><sd-icon name="calendar-days" [size]="14" /><span class="sr-only">Age:</span>{{ age() }} yrs</li>
                  }
                  <li class="${CHIP} bg-glacier text-ink"><sd-icon name="stethoscope" [size]="14" class="text-slate" />{{ r.visit_count }} visit{{ r.visit_count === 1 ? '' : 's' }} with you</li>
                </ul>
              </div>
            </div>

            <!-- Tiles size to their value and wrap, so a long email gets its own row. -->
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

          <div class="flex w-full flex-col gap-3 border-t border-cloud pt-5 lg:w-64 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <span class="font-heading text-body-lg text-ink">Quick actions</span>
            <a routerLink="/prescriptions/new" [queryParams]="{ patientId: id }" class="${PRIMARY_ACTION}">
              <sd-icon name="pill" [size]="18" /> Write prescription
            </a>
            @if (latestVisit(); as v) {
              <a [routerLink]="['/appointments', v.id]" class="${SECONDARY_ACTION}">
                <sd-icon name="file-text" [size]="18" /> Open latest chart
              </a>
              <p class="flex items-center justify-center gap-1.5 font-sans text-caption text-slate lg:justify-start">
                <sd-icon name="calendar-days" [size]="13" />Latest appointment · {{ day(v.scheduled_at) }}
              </p>
            }
          </div>
        </section>

        <!-- Record tabs: a 2×2 grid on phones (all four visible), the pill bar from sm up. -->
        <div class="grid w-full grid-cols-2 gap-1 rounded-card border border-cloud bg-white p-1 sm:flex sm:w-fit sm:max-w-full sm:rounded-pill" role="tablist" aria-label="Patient record">
          @for (t of tabs; track t.key; let i = $index) {
            <button
              #tabButton
              type="button"
              role="tab"
              [id]="tabId(t.key)"
              [attr.aria-selected]="tab() === t.key"
              [attr.aria-controls]="tab() === t.key || t.key === 'prescriptions' ? panelId(t.key) : null"
              [tabIndex]="tab() === t.key ? 0 : -1"
              class="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors sm:px-5 ${FOCUS_RING}"
              [class]="tab() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
              (click)="selectTab(t.key)"
              (keydown)="onTabKeydown($event, i)"
            >
              {{ t.label }}
              @if (t.key === 'visits' && r.visit_count > 0) {
                <span class="flex size-5 items-center justify-center rounded-full text-[11px] font-semibold" [class]="tab() === t.key ? 'bg-cerulean text-white' : 'bg-cloud text-slate'" aria-hidden="true">{{ r.visit_count }}</span>
              }
            </button>
          }
        </div>

        @if (tab() !== 'prescriptions') {
          <div role="tabpanel" [id]="panelId(tab())" [attr.aria-labelledby]="tabId(tab())" tabindex="0" class="rounded-card ${FOCUS_RING}">
            @switch (tab()) {
              @case ('overview') {
                <doc-patient-overview [medical]="r.medical" [visits]="visits()" [visitCount]="r.visit_count" (openTab)="openTab($event)" />
              }
              @case ('history') {
                <doc-patient-medical-history [medical]="r.medical" />
              }
              @case ('visits') {
                <doc-patient-visits [visits]="visits()" />
              }
            }
          </div>
        }

        <!--
          This doctor's prescriptions for the patient (any consultation or standalone).
          Kept mounted while hidden so an open composer survives switching tabs.
          Sits straight on the page (its rows are cards), as in the chart's Prescriptions sub-tab.
        -->
        <div role="tabpanel" [id]="panelId('prescriptions')" [attr.aria-labelledby]="tabId('prescriptions')" [hidden]="tab() !== 'prescriptions'" tabindex="0" class="rounded-card ${FOCUS_RING}">
          <doc-rx-panel [patientId]="id" [appointmentId]="null" />
        </div>
      } @else {
        <div class="flex flex-col gap-6" aria-busy="true">
          <span class="sr-only" role="status">Loading the patient record…</span>
          <div class="sd-shimmer h-72 rounded-card sm:h-56"></div>
          <div class="sd-shimmer h-11 w-full max-w-md rounded-pill"></div>
          <div class="sd-shimmer h-28 rounded-card"></div>
          <div class="grid gap-6 lg:grid-cols-2">
            <div class="sd-shimmer h-56 rounded-card"></div>
            <div class="sd-shimmer h-56 rounded-card"></div>
          </div>
        </div>
      }
    </div>
  `,
})
export class DoctorPatientDetail implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  protected readonly record = signal<DoctorPatientRecordDto | null>(null);
  protected readonly error = signal('');
  /** The patient id (route param). */
  protected id = '';

  protected readonly tabs = TABS;
  protected readonly tab = signal<PatientRecordTab>('overview');

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

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    this.api
      .patient(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.record.set(res.data),
        error: (err: unknown) => this.error.set(apiErrorMessage(err, 'Patient not found.')),
      });
  }

  /** The prescribing panel on the Prescriptions tab, when it is on screen. */
  private readonly rxPanel = viewChild(RxPanel);

  /** Route guard hook: never drop an unsaved prescription when leaving the page. */
  canLeave(): boolean | Promise<boolean> {
    return this.rxPanel()?.canLeave() ?? true;
  }

  /** Leaving the Prescriptions tab unmounts the composer — confirm unsaved edits first. */
  protected async selectTab(key: PatientRecordTab): Promise<void> {
    if (this.tab() === 'prescriptions' && key !== 'prescriptions' && !(await (this.rxPanel()?.canLeave() ?? true))) return;
    this.tab.set(key);
  }

  /** A link inside a tab opened another tab: switch and move focus to it. */
  protected async openTab(key: PatientRecordTab): Promise<void> {
    await this.selectTab(key);
    if (this.tab() !== key) return; // the doctor chose to stay
    this.focusTab(this.tabs.findIndex((t) => t.key === key));
  }

  /** Arrow / Home / End keys move between tabs (WAI-ARIA tabs pattern). */
  protected onTabKeydown(event: KeyboardEvent, index: number): void {
    const last = this.tabs.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    void this.selectTab(this.tabs[next].key);
    this.focusTab(next);
  }

  protected tabId(key: PatientRecordTab): string {
    return `pd-tab-${key}`;
  }
  protected panelId(key: PatientRecordTab): string {
    return `pd-panel-${key}`;
  }
  protected day(iso: string): string {
    return formatDay(iso);
  }

  private focusTab(index: number): void {
    this.tabButtons()[index]?.nativeElement.focus();
  }
}
