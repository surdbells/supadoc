import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { CarePlanDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { rxDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_INPUT,
  CLINICAL_META,
  ClinicalBadge,
  ClinicalEmpty,
  ClinicalHeader,
} from './clinical-ui';

/**
 * Clinical tools → Care plan: an editable, ordered list of steps the patient
 * sees once published. Presentational — the host owns the steps and publishing.
 *
 * Usage:
 * `<doc-clinical-care-plan [items]="careItems()" [plan]="carePlan()" [busy]="sectionBusy()"
 *    [error]="sectionError()" (addStep)="addCare()" (removeStep)="removeCare($event)"
 *    (stepChange)="setCare($event.index, $event.value)" (publish)="saveCare()" />`
 */
@Component({
  selector: 'doc-clinical-care-plan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, ClinicalBadge, ClinicalEmpty, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header icon="list-checks" heading="Care plan" helper="Step-by-step guidance the patient sees after you publish it.">
      @if (plan(); as p) {
        @if (p.published) {
          <doc-clinical-badge tone="success" icon="circle-check" label="Published" />
        } @else {
          <doc-clinical-badge tone="neutral" icon="eye-off" label="Not published" />
        }
      }
    </doc-clinical-header>

    <section class="${CLINICAL_CARD}" aria-label="Care plan steps">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="${CLINICAL_H3}">
          Steps
          @if (items().length > 0) {
            <span class="${CLINICAL_COUNT}">{{ items().length }}</span>
          }
        </h3>
        @if (plan()?.updated_at) {
          <p class="${CLINICAL_META}">
            <span class="inline-flex items-center gap-1"><sd-icon name="clock" [size]="13" />Updated {{ when(plan()?.updated_at) }}</span>
            @if (plan()?.author) {
              <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ plan()?.author }}</span>
            }
          </p>
        }
      </div>

      @if (items().length === 0) {
        <doc-clinical-empty icon="list-checks" message="No steps yet. Add the first step of the patient's care plan." />
      } @else {
        <ol class="flex flex-col gap-3">
          @for (item of items(); track $index) {
            <li class="flex items-center gap-3">
              <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-frost font-sans text-caption font-semibold text-cerulean" aria-hidden="true">{{ $index + 1 }}</span>
              <input
                type="text"
                class="${CLINICAL_INPUT} min-w-0 flex-1"
                placeholder="e.g. Drink plenty of fluids"
                [attr.aria-label]="'Step ' + ($index + 1)"
                [value]="item"
                (input)="stepChange.emit({ index: $index, value: $any($event.target).value })"
              />
              <button
                type="button"
                class="flex size-10 shrink-0 items-center justify-center rounded-field text-slate transition-colors hover:bg-alert/5 hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-label]="'Remove step ' + ($index + 1)"
                (click)="removeStep.emit($index)"
              >
                <sd-icon name="trash-2" [size]="18" />
              </button>
            </li>
          }
        </ol>
      }

      <sd-button variant="ghost" size="sm" class="-ml-1 w-fit" (click)="addStep.emit()">
        <sd-icon name="plus" [size]="16" />Add step
      </sd-button>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      <div class="flex border-t border-cloud pt-5 @md:justify-end">
        <sd-button [full]="true" class="w-full @md:w-auto" [disabled]="busy()" (click)="publish.emit()">
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Publishing…
          } @else {
            <sd-icon name="send" [size]="18" />Publish to patient
          }
        </sd-button>
      </div>
    </section>
  `,
})
export class ClinicalCarePlan {
  readonly items = input.required<string[]>();
  /** The saved plan's status (published / updated) — null until loaded. */
  readonly plan = input<CarePlanDto | null>(null);
  readonly busy = input(false);
  readonly error = input('');

  readonly addStep = output<void>();
  readonly removeStep = output<number>();
  readonly stepChange = output<{ index: number; value: string }>();
  readonly publish = output<void>();

  protected when(iso: string | null | undefined): string {
    return rxDateTime(iso);
  }
}
