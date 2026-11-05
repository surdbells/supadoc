import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { LabOptionsDto, LabPriority } from '@supadoc/models';
import { AlertComponent } from '@supadoc/ui';
import { PRIORITY_HELPER, STAT_EMERGENCY } from './lab-ui';

/** The composer's "Priority" card: Routine / Urgent / STAT as one radio group of tiles. */
@Component({
  selector: 'doc-lab-priority-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card">
      <h2 id="lab-priority-title" class="font-sans text-body font-semibold text-ink">Priority</h2>
      <div role="radiogroup" aria-labelledby="lab-priority-title" aria-describedby="lab-priority-help" class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        @for (p of priorities(); track p.value) {
          <label
            class="flex cursor-pointer flex-col gap-0.5 rounded-lg border-[0.5px] p-4 transition-colors focus-within:ring-2 focus-within:ring-cerulean/40"
            [class]="value() === p.value ? 'border-cerulean bg-cerulean/10' : 'border-ash bg-white hover:bg-glacier'"
          >
            <input
              type="radio"
              name="lab-priority"
              class="sr-only"
              [value]="p.value"
              [checked]="value() === p.value"
              (change)="valueChange.emit(p.value)"
            />
            <span class="font-sans text-body-sm font-medium" [class]="value() === p.value ? 'text-cerulean-dark' : 'text-ink'">{{ p.label }}</span>
            <span class="font-sans text-caption text-slate">{{ p.subtitle }}</span>
          </label>
        }
      </div>
      <p id="lab-priority-help" class="font-sans text-caption text-slate">{{ helper }}</p>
    </div>
    @if (value() === 'stat') {
      <sd-alert tone="warning">{{ emergency }}</sd-alert>
    }
  `,
})
export class LabPriorityCard {
  readonly priorities = input.required<LabOptionsDto['priorities']>();
  readonly value = input.required<LabPriority>();
  readonly valueChange = output<LabPriority>();

  protected readonly helper = PRIORITY_HELPER;
  protected readonly emergency = STAT_EMERGENCY;
}
