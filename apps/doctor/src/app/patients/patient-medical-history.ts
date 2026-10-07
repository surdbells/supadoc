import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MedicalDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import {
  AllergySeverityBadge,
  ConditionStatusBadge,
  MedicationItem,
  RecordSection,
  sortAllergies,
} from './patient-record-ui';

/**
 * The patient record's Medical history tab: the patient's health profile as
 * four design-system cards — Allergies, Conditions, Medications and Past
 * medical history — each with its own empty state.
 */
@Component({
  selector: 'doc-patient-medical-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AllergySeverityBadge, ConditionStatusBadge, MedicationItem, RecordSection],
  host: { class: 'grid grid-cols-1 items-start gap-6 lg:grid-cols-2' },
  template: `
    <doc-record-section
      icon="shield-alert"
      iconClass="text-alert"
      heading="Allergies"
      [count]="allergies().length"
      [empty]="allergies().length === 0"
      emptyText="No allergies recorded"
      emptyHint="Ask the patient before you prescribe."
    >
      <ul class="flex flex-col divide-y divide-cloud">
        @for (a of allergies(); track $index) {
          <li class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-5 py-3.5">
            <div class="flex min-w-0 flex-col">
              <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ a.allergen }}</span>
              @if (a.reaction) { <span class="font-sans text-caption text-slate">Reaction: {{ a.reaction }}</span> }
            </div>
            <doc-allergy-severity-badge [severity]="a.severity" />
          </li>
        }
      </ul>
    </doc-record-section>

    <doc-record-section
      icon="clipboard-list"
      heading="Conditions"
      [count]="medical().conditions.length"
      [empty]="medical().conditions.length === 0"
      emptyText="No conditions recorded"
    >
      <ul class="flex flex-col divide-y divide-cloud">
        @for (c of medical().conditions; track $index) {
          <li class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-5 py-3.5">
            <div class="flex min-w-0 flex-col">
              <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ c.condition }}</span>
              @if (c.since) { <span class="font-sans text-caption text-slate">Since {{ c.since }}</span> }
            </div>
            <doc-condition-status-badge [status]="c.status" />
          </li>
        }
      </ul>
    </doc-record-section>

    <doc-record-section
      icon="pill"
      heading="Medications"
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

    <doc-record-section
      icon="history"
      heading="Past medical history"
      [count]="medical().history.length"
      [empty]="medical().history.length === 0"
      emptyText="No past medical history recorded"
    >
      <ul class="flex flex-col divide-y divide-cloud">
        @for (h of medical().history; track $index) {
          <li class="flex items-start gap-3 px-5 py-3.5">
            <sd-icon name="check" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ h.condition }}</span>
                @if (h.year) {
                  <span class="inline-flex items-center gap-1 rounded-pill bg-glacier px-2.5 py-0.5 font-sans text-caption font-medium text-ink">
                    <sd-icon name="calendar-days" [size]="12" class="text-slate" />{{ h.year }}
                  </span>
                }
              </div>
              @if (h.note) { <p class="break-words font-sans text-caption text-slate">{{ h.note }}</p> }
            </div>
          </li>
        }
      </ul>
    </doc-record-section>
  `,
})
export class PatientMedicalHistory {
  readonly medical = input.required<MedicalDto>();
  protected readonly allergies = computed(() => sortAllergies(this.medical().allergies));
}
