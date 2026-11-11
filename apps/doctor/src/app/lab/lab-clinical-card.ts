import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { LabInfectionAlert, LabOptionsDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import type { LabFormState } from './lab-composer-state';
import { fastingWarning } from './lab-ui';

/** One change the clinical card asks the composer to apply. */
export type LabClinicalEdit =
  | { readonly field: 'question' | 'history' | 'medication' | 'allergies'; readonly value: string }
  | { readonly field: 'fasting' | 'pregnant' | 'transfusion'; readonly value: boolean }
  | { readonly field: 'fastingHours' | 'weeksPregnant'; readonly value: string }
  | { readonly field: 'alert'; readonly value: LabInfectionAlert };

const PREFILL_NOTE = "From the patient's record. Changes here don't update it.";

/**
 * "Clinical Information": why the tests are requested (the diagnosis is
 * required), history, medication and allergies (pre-filled from the record),
 * then Fasting?, Pregnant? (only when asked), Infection alert and Transfusion.
 * Presentational: the composer owns the state and applies `edit`.
 */
@Component({
  selector: 'doc-lab-clinical-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex min-w-0 flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card' },
  styles: `
    .rd {
      appearance: none;
      margin: 0;
      width: 16px;
      height: 16px;
      flex: none;
      border: 1px solid var(--color-slate);
      border-radius: 9999px;
      display: inline-grid;
      place-content: center;
      background: #fff;
      cursor: pointer;
    }
    .rd:checked {
      border-color: var(--color-cerulean);
    }
    .rd:checked::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 9999px;
      background: var(--color-cerulean);
    }
    .rd:focus-visible {
      outline: 2px solid var(--color-cerulean);
      outline-offset: 2px;
    }
    @media (min-width: 40rem) {
      .cc-preg {
        width: 220px;
      }
    }
  `,
  template: `
    @let s = state();
    <div class="flex flex-col gap-1">
      <h2 class="font-sans text-body-lg font-semibold text-ink">Clinical Information</h2>
      <p class="font-sans text-caption text-slate">Why you are requesting these tests. Diagnosis is required</p>
    </div>

    <div class="flex flex-col gap-1">
      <label for="lab-question" class="font-sans text-body-sm text-ink">
        Provisional diagnosis / clinical question <span class="text-alert-ink" aria-hidden="true">*</span>
      </label>
      <input
        id="lab-question"
        type="text"
        required
        autocomplete="off"
        placeholder="e.g. Suspected iron-deficiency anaemia"
        [class]="field(errors()['indication'])"
        [maxLength]="limits().question_max"
        [value]="s.question"
        [attr.aria-invalid]="errors()['indication'] ? true : null"
        [attr.aria-describedby]="errors()['indication'] ? 'lab-question-error' : null"
        (input)="emit('question', $any($event.target).value)"
      />
      @if (errors()['indication']) {
        <p id="lab-question-error" class="font-sans text-caption text-alert-ink">{{ errors()['indication'] }}</p>
      }
    </div>

    <div class="flex flex-col gap-1">
      <label for="lab-history" class="font-sans text-body-sm text-ink">Relevant history / symptoms</label>
      <input
        id="lab-history"
        type="text"
        autocomplete="off"
        placeholder="e.g. Fatigue for 3 weeks"
        [class]="field(null)"
        [maxLength]="limits().text_max"
        [value]="s.history"
        (input)="emit('history', $any($event.target).value)"
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="lab-medication" class="font-sans text-body-sm text-ink">Current medication</label>
      <input
        id="lab-medication"
        type="text"
        autocomplete="off"
        placeholder="e.g. Metformin 500mg"
        [class]="field(null)"
        [maxLength]="limits().text_max"
        [value]="s.medication"
        [attr.aria-describedby]="s.prefilled.medication ? 'lab-medication-note' : null"
        (input)="emit('medication', $any($event.target).value)"
      />
      @if (s.prefilled.medication) {
        <p id="lab-medication-note" class="font-sans text-caption text-slate">{{ prefillNote }}</p>
      }
    </div>

    <div class="flex flex-col gap-1">
      <label for="lab-allergies" class="font-sans text-body-sm text-ink">Allergies</label>
      <input
        id="lab-allergies"
        type="text"
        autocomplete="off"
        placeholder="e.g. Contrast media, latex, penicillin or none known"
        [class]="field(null)"
        [maxLength]="limits().text_max"
        [value]="s.allergies"
        [attr.aria-describedby]="s.prefilled.allergies ? 'lab-allergies-note' : null"
        (input)="emit('allergies', $any($event.target).value)"
      />
      @if (s.prefilled.allergies) {
        <p id="lab-allergies-note" class="font-sans text-caption text-slate">{{ prefillNote }}</p>
      }
    </div>

    <div class="flex flex-col gap-4 sm:flex-row sm:justify-between">
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <span id="lab-fasting-q" class="font-sans text-body-sm text-ink">Fasting?</span>
        <div role="radiogroup" aria-labelledby="lab-fasting-q" class="flex gap-6">
          <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
            <input class="rd" type="radio" name="lab-fasting" [checked]="s.fasting === true" (change)="emit('fasting', true)" /> Yes
          </label>
          <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
            <input class="rd" type="radio" name="lab-fasting" [checked]="s.fasting === false" (change)="emit('fasting', false)" /> No
          </label>
        </div>
        @if (s.fasting === true) {
          <div class="flex flex-col gap-1">
            <label for="lab-fasting-hours" class="font-sans text-body-sm text-ink">Fasting duration (hours)</label>
            <input
              id="lab-fasting-hours"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              placeholder="e.g. 8"
              maxlength="2"
              [class]="field(errors()['fasting_hours'])"
              [value]="s.fastingHours"
              [attr.aria-invalid]="errors()['fasting_hours'] ? true : null"
              [attr.aria-describedby]="hoursDescribedBy()"
              (input)="emit('fastingHours', $any($event.target).value)"
            />
            @if (errors()['fasting_hours']) {
              <p id="lab-fasting-hours-error" class="font-sans text-caption text-alert-ink">{{ errors()['fasting_hours'] }}</p>
            }
            @if (s.fastingSource) {
              <p id="lab-fasting-hours-note" class="font-sans text-caption text-slate">Filled in for {{ s.fastingSource }}. Change it if needed.</p>
            }
          </div>
        }
        @if (shortfall(); as sf) {
          <p id="lab-fasting-warning" class="flex items-start gap-1.5 font-sans text-caption text-warning-ink">
            <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ warning(sf.short, sf.hours) }}
          </p>
        }
      </div>

      @if (askPregnancy()) {
        <div class="cc-preg flex min-w-0 flex-col gap-2">
          <span id="lab-pregnant-q" class="font-sans text-body-sm text-ink">Pregnant?</span>
          <div role="radiogroup" aria-labelledby="lab-pregnant-q" class="flex gap-6">
            <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
              <input class="rd" type="radio" name="lab-pregnant" [checked]="s.pregnant === true" (change)="emit('pregnant', true)" /> Yes
            </label>
            <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
              <input class="rd" type="radio" name="lab-pregnant" [checked]="s.pregnant === false" (change)="emit('pregnant', false)" /> No
            </label>
          </div>
          @if (s.pregnant === true) {
            <div class="flex flex-col gap-1">
              <label for="lab-weeks" class="font-sans text-body-sm text-ink">Weeks gone</label>
              <input
                id="lab-weeks"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                placeholder="e.g. 8"
                maxlength="2"
                [class]="field(errors()['weeks'])"
                [value]="s.weeksPregnant"
                [attr.aria-invalid]="errors()['weeks'] ? true : null"
                [attr.aria-describedby]="errors()['weeks'] ? 'lab-weeks-error' : null"
                (input)="emit('weeksPregnant', $any($event.target).value)"
              />
              @if (errors()['weeks']) {
                <p id="lab-weeks-error" class="font-sans text-caption text-alert-ink">{{ errors()['weeks'] }}</p>
              }
            </div>
          }
        </div>
      }
    </div>

    <div class="flex flex-col gap-2">
      <span id="lab-alerts-q" class="font-sans text-body-sm text-ink">Infection alert</span>
      <div role="group" aria-label="Infection alert" class="sd-pill-row-wrap">
        @for (a of alerts(); track a.value) {
          @let on = s.infectionAlerts.includes(a.value);
          <button
            type="button"
            class="sd-pill sd-pill-m sd-filter-solid [--sd-fw:400]"
            [attr.aria-pressed]="on"
            (click)="emit('alert', a.value)"
          >
            {{ a.label }}
          </button>
        }
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <span id="lab-transfusion-q" class="font-sans text-body-sm text-ink">Transfusion in last 3 months?</span>
      <div role="radiogroup" aria-labelledby="lab-transfusion-q" class="flex gap-6">
        <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
          <input class="rd" type="radio" name="lab-transfusion" [checked]="s.transfusion === true" (change)="emit('transfusion', true)" /> Yes
        </label>
        <label class="flex cursor-pointer items-center gap-2 font-sans text-body-sm text-slate">
          <input class="rd" type="radio" name="lab-transfusion" [checked]="s.transfusion === false" (change)="emit('transfusion', false)" /> No
        </label>
      </div>
    </div>
  `,
})
export class LabClinicalCard {
  readonly state = input.required<LabFormState>();
  readonly askPregnancy = input(false);
  readonly alerts = input<LabOptionsDto['infection_alerts']>([]);
  readonly limits = input.required<LabOptionsDto['limits']>();
  /** Inline messages by preflight key (shown after the first failed Preview). */
  readonly errors = input<Readonly<Record<string, string>>>({});
  readonly shortfall = input<{ short: string; hours: number } | null>(null);

  readonly edit = output<LabClinicalEdit>();

  protected readonly prefillNote = PREFILL_NOTE;

  protected emit(field: LabClinicalEdit['field'], value: string | boolean): void {
    this.edit.emit({ field, value } as LabClinicalEdit);
  }

  protected field(error: string | null | undefined): string {
    const border = error ? 'border-alert' : 'border-ash';
    return `h-12 w-full rounded-2xl border ${border} bg-white px-4 font-sans text-body-sm text-ink placeholder:text-slate focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20`;
  }

  protected hoursDescribedBy(): string | null {
    const ids = [
      this.errors()['fasting_hours'] ? 'lab-fasting-hours-error' : '',
      this.state().fastingSource ? 'lab-fasting-hours-note' : '',
      this.shortfall() ? 'lab-fasting-warning' : '',
    ].filter(Boolean);
    return ids.length ? ids.join(' ') : null;
  }

  protected warning(short: string, hours: number): string {
    return fastingWarning(short, hours);
  }
}
