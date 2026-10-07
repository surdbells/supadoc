import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AppointmentDto, MedicalDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import {
  allergySeverity,
  AllergySeverityBadge,
  ConditionStatusBadge,
  formatDay,
  formatTime,
  isCurrentCondition,
  isUpcomingVisit,
  MedicationItem,
  RecordSection,
  sortAllergies,
  timeOf,
  VisitStatusBadge,
} from './patient-record-ui';

/** Which record tab a "View all" footer opens. */
export type PatientRecordTab = 'overview' | 'history' | 'prescriptions' | 'visits';

const FOOTER_LINK =
  'mt-auto flex w-full items-center justify-center gap-1 border-t border-cloud px-5 py-3.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cerulean/40';

/**
 * The patient record's Overview tab: the allergy alert, current medication,
 * active conditions and the next / last visit — a pre-consultation briefing.
 */
@Component({
  selector: 'doc-patient-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IconComponent,
    AllergySeverityBadge,
    ConditionStatusBadge,
    MedicationItem,
    RecordSection,
    VisitStatusBadge,
  ],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <!-- Allergy alert -->
    @if (allergies().length > 0) {
      <section
        class="flex flex-col gap-4 rounded-card border p-5 sm:p-6"
        [class]="seriousAllergy() ? 'border-alert/30 bg-alert/5' : 'border-warning/40 bg-warning/5'"
        aria-labelledby="pd-allergy-alert"
      >
        <div class="flex items-start gap-3">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-full" [class]="seriousAllergy() ? 'bg-alert/10 text-alert' : 'bg-warning/15 text-warning'" aria-hidden="true">
            <sd-icon name="shield-alert" [size]="22" />
          </span>
          <div class="flex min-w-0 flex-col gap-0.5">
            <h3 id="pd-allergy-alert" class="font-heading text-body-lg text-ink">
              Allergy alert <span class="font-sans text-body-sm font-semibold text-slate">· {{ allergies().length }} recorded</span>
            </h3>
            <p class="font-sans text-caption text-slate">Check before you prescribe or recommend treatment.</p>
          </div>
        </div>
        <ul class="grid grid-cols-1 gap-3 md:grid-cols-2">
          @for (a of allergies(); track $index) {
            <li class="flex flex-col gap-2 rounded-field border border-cloud bg-white px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <div class="flex min-w-0 flex-col">
                <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ a.allergen }}</span>
                @if (a.reaction) {
                  <span class="font-sans text-caption text-slate">Reaction: {{ a.reaction }}</span>
                }
              </div>
              <doc-allergy-severity-badge [severity]="a.severity" />
            </li>
          }
        </ul>
      </section>
    } @else {
      <section class="flex items-start gap-3 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-6" aria-label="Allergies">
        <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-glacier text-slate" aria-hidden="true">
          <sd-icon name="info" [size]="22" />
        </span>
        <div class="flex min-w-0 flex-col gap-0.5">
          <h3 class="font-heading text-body-lg text-ink">No allergies recorded</h3>
          <p class="font-sans text-caption text-slate">None are listed in the patient's health profile. Ask them before you prescribe.</p>
        </div>
      </section>
    }

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Current medication -->
      <doc-record-section
        icon="pill"
        heading="Current medication"
        [count]="medical().medications.length"
        [empty]="medical().medications.length === 0"
        emptyText="No medications recorded"
      >
        <ul class="flex flex-col divide-y divide-cloud">
          @for (m of medical().medications; track $index) {
            <li class="px-5 py-3.5"><doc-medication-item [med]="m" /></li>
          }
        </ul>
      </doc-record-section>

      <!-- Active conditions -->
      <doc-record-section
        icon="activity"
        heading="Active conditions"
        [count]="currentConditions().length"
        [empty]="currentConditions().length === 0"
        emptyIcon="clipboard-list"
        [emptyText]="medical().conditions.length ? 'No active conditions' : 'No conditions recorded'"
        [emptyHint]="resolvedHint()"
      >
        <ul class="flex flex-col divide-y divide-cloud">
          @for (c of currentConditions(); track $index) {
            <li class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-5 py-3.5">
              <div class="flex min-w-0 flex-col">
                <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ c.condition }}</span>
                @if (c.since) { <span class="font-sans text-caption text-slate">Since {{ c.since }}</span> }
              </div>
              <doc-condition-status-badge [status]="c.status" />
            </li>
          }
        </ul>
        @if (medical().conditions.length > currentConditions().length && currentConditions().length > 0) {
          <button type="button" sectionFooter class="${FOOTER_LINK}" (click)="openTab.emit('history')">
            View full medical history <sd-icon name="arrow-right" [size]="16" />
          </button>
        }
      </doc-record-section>
    </div>

    <!-- Next / last visit -->
    <doc-record-section icon="calendar-days" heading="Visits" [count]="visitCount()">
      <div class="grid grid-cols-1 divide-y divide-cloud sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        @for (slot of visitSlots(); track slot.label) {
          <div class="flex min-w-0 flex-col gap-3 px-5 py-4">
            <span class="font-sans text-caption text-slate">{{ slot.label }}</span>
            @if (slot.visit; as v) {
              <div class="flex flex-col gap-1">
                <span class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink"><sd-icon name="calendar-days" [size]="16" class="shrink-0 text-slate" />{{ day(v.scheduled_at) }}</span>
                <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="shrink-0 text-slate" />{{ time(v.scheduled_at) }}</span>
                <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="video" [size]="16" class="shrink-0 text-slate" />{{ v.type_label }}</span>
              </div>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <doc-visit-status-badge [status]="v.status" [label]="v.status_label" />
                <a [routerLink]="['/appointments', v.id]" class="inline-flex items-center gap-1 rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40">
                  Open chart <sd-icon name="chevron-right" [size]="14" />
                </a>
              </div>
            } @else {
              <p class="font-sans text-body-sm text-slate">{{ slot.emptyText }}</p>
            }
          </div>
        }
      </div>
      @if (visitCount() > 0) {
        <button type="button" sectionFooter class="${FOOTER_LINK}" (click)="openTab.emit('visits')">
          View all visits <sd-icon name="arrow-right" [size]="16" />
        </button>
      }
    </doc-record-section>
  `,
})
export class PatientOverview {
  readonly medical = input.required<MedicalDto>();
  /** The patient's visits with this doctor, newest first. */
  readonly visits = input.required<AppointmentDto[]>();
  readonly visitCount = input(0);
  /** A footer link asked to open another tab. */
  readonly openTab = output<PatientRecordTab>();

  protected readonly allergies = computed(() => sortAllergies(this.medical().allergies));
  protected readonly seriousAllergy = computed(() =>
    this.allergies().some((a) => allergySeverity(a.severity).serious),
  );
  protected readonly currentConditions = computed(() =>
    this.medical().conditions.filter(isCurrentCondition),
  );
  protected readonly resolvedHint = computed(() => {
    const resolved = this.medical().conditions.length - this.currentConditions().length;
    return resolved > 0 ? `${resolved} resolved — see Medical history.` : '';
  });

  /** The soonest upcoming visit and the most recent past one. */
  protected readonly visitSlots = computed(() => {
    const now = Date.now();
    const list = this.visits();
    const upcoming = list.filter((v) => isUpcomingVisit(v, now));
    const next = upcoming.length ? upcoming[upcoming.length - 1] : null;
    // Most recent past visit — preferring one that wasn't cancelled.
    const past = list.filter((v) => timeOf(v.scheduled_at) <= now);
    const last = past.find((v) => v.status !== 'cancelled') ?? past[0] ?? null;
    return [
      { label: 'Next visit', visit: next, emptyText: 'No upcoming visit booked.' },
      { label: 'Last visit', visit: last, emptyText: 'No past visits yet.' },
    ];
  });

  protected day(iso: string): string {
    return formatDay(iso);
  }
  protected time(iso: string): string {
    return formatTime(iso);
  }
}
