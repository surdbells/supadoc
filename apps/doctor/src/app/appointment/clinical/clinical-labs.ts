import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
} from '@angular/core';
import type { LabOrderDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { rxDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_HINT,
  CLINICAL_INPUT_ICON,
  CLINICAL_INPUT_WITH_ICON,
  CLINICAL_LABEL,
  CLINICAL_LIST_ITEM,
  CLINICAL_META,
  CLINICAL_SEGMENT,
  CLINICAL_SEGMENTED,
  CLINICAL_TEXTAREA,
  ClinicalBadge,
  ClinicalEmpty,
  ClinicalHeader,
  PRIORITY_META,
} from './clinical-ui';

type Priority = 'routine' | 'urgent';

let nextUid = 0;

/**
 * Clinical tools → Lab orders: the new-order form and the orders placed for
 * this consultation. Presentational — the host owns the form values (two-way
 * bound), validation and the API call.
 *
 * Usage:
 * `<doc-clinical-labs [orders]="labOrders()" [(tests)]="labTests" [(priority)]="labPriority"
 *    [(instructions)]="labInstructions" [busy]="sectionBusy()" [error]="sectionError()" (placeOrder)="orderLab()" />`
 */
@Component({
  selector: 'doc-clinical-labs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, ClinicalBadge, ClinicalEmpty, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header icon="clipboard-list" heading="Lab orders" helper="Request investigations for this consultation." />

    <section class="${CLINICAL_CARD}" aria-label="New lab order">
      <h3 class="${CLINICAL_H3}"><sd-icon name="plus" [size]="18" class="text-cerulean" />New lab order</h3>

      <div class="flex flex-col gap-2">
        <label class="${CLINICAL_LABEL}" [for]="uid + '-tests'">Tests <span class="text-alert">*</span></label>
        <textarea
          rows="4"
          class="${CLINICAL_TEXTAREA}"
          [id]="uid + '-tests'"
          [attr.aria-describedby]="uid + '-tests-hint'"
          placeholder="e.g. Full blood count"
          [value]="tests()"
          (input)="tests.set($any($event.target).value)"
        ></textarea>
        <p class="flex items-start justify-between gap-3 ${CLINICAL_HINT}" [id]="uid + '-tests-hint'">
          <span>One test per line.</span>
          @if (testCount() > 0) {
            <span class="shrink-0 font-semibold text-ink">{{ testCount() }} test{{ testCount() === 1 ? '' : 's' }}</span>
          }
        </p>
      </div>

      <fieldset>
        <legend class="mb-2 ${CLINICAL_LABEL}">Priority</legend>
        <div class="${CLINICAL_SEGMENTED}">
          @for (p of priorities; track p.key) {
            <label class="${CLINICAL_SEGMENT}">
              <input
                type="radio"
                class="sr-only"
                [name]="uid + '-priority'"
                [value]="p.key"
                [checked]="priority() === p.key"
                (change)="priority.set(p.key)"
              />
              <sd-icon [name]="p.icon" [size]="16" />{{ p.label }}
            </label>
          }
        </div>
      </fieldset>

      <div class="flex flex-col gap-2">
        <label class="${CLINICAL_LABEL}" [for]="uid + '-instructions'">
          Instructions <span class="font-normal text-slate">(optional)</span>
        </label>
        <div class="relative">
          <sd-icon name="info" [size]="18" class="${CLINICAL_INPUT_ICON}" />
          <input
            type="text"
            class="${CLINICAL_INPUT_WITH_ICON}"
            [id]="uid + '-instructions'"
            placeholder="e.g. Fasting sample"
            [value]="instructions()"
            (input)="instructions.set($any($event.target).value)"
          />
        </div>
      </div>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      <div class="flex border-t border-cloud pt-5 @md:justify-end">
        <sd-button [full]="true" class="w-full @md:w-auto" [disabled]="busy()" (click)="placeOrder.emit()">
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Ordering…
          } @else {
            <sd-icon name="send" [size]="18" />Place order
          }
        </sd-button>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-label="Lab orders placed">
      <h3 class="${CLINICAL_H3}">
        Ordered
        @if (orders().length > 0) {
          <span class="${CLINICAL_COUNT}">{{ orders().length }}</span>
        }
      </h3>
      @if (orders().length === 0) {
        <doc-clinical-empty icon="clipboard-list" message="No lab orders yet for this consultation." />
      } @else {
        <ul class="flex flex-col gap-3">
          @for (lo of orders(); track lo.id) {
            <li class="flex items-start gap-3 ${CLINICAL_LIST_ITEM}">
              <span class="hidden size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean @md:flex">
                <sd-icon name="clipboard-list" [size]="18" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-heading text-body font-semibold text-ink">
                    {{ lo.tests.length }} test{{ lo.tests.length === 1 ? '' : 's' }}
                  </span>
                  <doc-clinical-badge [tone]="priorityMeta(lo.priority).tone" [icon]="priorityMeta(lo.priority).icon" [label]="priorityMeta(lo.priority).label" />
                </div>
                <ul class="flex flex-wrap gap-2" aria-label="Tests">
                  @for (t of lo.tests; track $index) {
                    <li class="rounded-pill bg-frost px-3 py-1 font-sans text-caption font-medium text-cerulean">{{ t }}</li>
                  }
                </ul>
                @if (lo.instructions) {
                  <p class="break-words font-sans text-body-sm text-ink"><span class="text-slate">Instructions:</span> {{ lo.instructions }}</p>
                }
                <p class="${CLINICAL_META}">
                  <span class="inline-flex items-center gap-1"><sd-icon name="calendar-days" [size]="13" />{{ when(lo.created_at) }}</span>
                  @if (lo.author) {
                    <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ lo.author }}</span>
                  }
                </p>
              </div>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ClinicalLabs {
  readonly orders = input.required<LabOrderDto[]>();
  readonly busy = input(false);
  /** The section's error (validation or real API message). */
  readonly error = input('');

  /** One test per line. */
  readonly tests = model.required<string>();
  readonly priority = model.required<Priority>();
  readonly instructions = model.required<string>();

  readonly placeOrder = output<void>();

  protected readonly uid = `clinical-labs-${++nextUid}`;
  protected readonly priorities = (['routine', 'urgent'] as const).map((key) => ({ key, ...PRIORITY_META[key] }));
  protected readonly testCount = computed(
    () => this.tests().split('\n').map((t) => t.trim()).filter(Boolean).length,
  );

  protected priorityMeta(p: Priority): (typeof PRIORITY_META)[Priority] {
    return PRIORITY_META[p] ?? PRIORITY_META.routine;
  }

  protected when(iso: string): string {
    return rxDateTime(iso);
  }
}
