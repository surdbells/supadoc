import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { LabMobility, LabOptionsDto, LabYesNo } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { LabSelect } from './lab-select';
import { CONTRAST_WARNING } from './lab-ui';

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

/** One change the safety screen asks the composer to apply. */
export type LabSafetyEdit =
  | { readonly field: 'pregnant'; readonly value: boolean }
  | { readonly field: 'contrastAllergy'; readonly value: LabYesNo }
  | { readonly field: 'mobility'; readonly value: LabMobility };

/**
 * The imaging safety screen (Component 150): amber "required before sending"
 * until every field has an answer, then sage "complete". Its Pregnant? is the
 * clinical card's Pregnant? (one answer, mirrored both ways).
 */
@Component({
  selector: 'doc-lab-safety-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, LabSelect],
  host: { class: 'block' },
  styles: `
    .ss-box {
      gap: 18px;
    }
  `,
  template: `
    <section
      class="ss-box flex flex-col rounded-2xl border p-2"
      [class]="complete() ? 'border-sage bg-sage/10' : 'border-warning bg-warning/10'"
      aria-labelledby="lab-safety-title"
    >
      <h3 id="lab-safety-title" class="flex items-center gap-1.5 px-2 pt-1 font-sans text-body-sm font-semibold text-ink">
        @if (complete()) {
          Safety screen · complete <sd-icon name="check" [size]="16" class="text-sage-ink" aria-hidden="true" />
        } @else {
          Safety screen · required before sending
        }
      </h3>
      <div class="grid grid-cols-1 gap-4 px-2 pb-2 sm:grid-cols-2">
        @if (askPregnancy()) {
          <doc-lab-select
            id="lab-safety-pregnant"
            label="Pregnant?"
            [options]="yesNo"
            [value]="pregnant() === true ? 'yes' : pregnant() === false ? 'no' : null"
            (valueChange)="edit.emit({ field: 'pregnant', value: $event === 'yes' })"
          />
        }
        <div class="flex min-w-0 flex-col gap-1">
          <doc-lab-select
            id="lab-safety-contrast"
            label="Contrast allergy?"
            [options]="yesNo"
            [value]="contrastAllergy()"
            (valueChange)="edit.emit({ field: 'contrastAllergy', value: $any($event) })"
          />
          @if (contrastAllergy() === 'yes') {
            <p class="flex items-start gap-1.5 font-sans text-caption text-warning-ink">
              <sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ contrastWarning }}
            </p>
          }
        </div>
        <doc-lab-select
          id="lab-safety-mobility"
          label="Mobility"
          [options]="mobilityOptions()"
          [value]="mobility()"
          (valueChange)="edit.emit({ field: 'mobility', value: $any($event) })"
        />
      </div>
    </section>
  `,
})
export class LabSafetyScreen {
  readonly askPregnancy = input(false);
  readonly pregnant = input<boolean | null>(null);
  readonly contrastAllergy = input<LabYesNo | null>(null);
  readonly mobility = input<LabMobility | null>(null);
  readonly mobilityList = input<LabOptionsDto['mobility']>([]);
  readonly complete = input(false);

  readonly edit = output<LabSafetyEdit>();

  protected readonly yesNo = YES_NO;
  protected readonly contrastWarning = CONTRAST_WARNING;
  protected readonly mobilityOptions = computed(() => this.mobilityList().map((m) => ({ value: m.value, label: m.label })));
}
