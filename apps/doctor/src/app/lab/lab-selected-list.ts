import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import type { LabFormItem } from './lab-composer-state';

/**
 * "Selected (n)": every test on the active tab as a chip — the label (a toggle
 * choosing the item the specimen / preparation row edits, on Laboratory and
 * Imaging) and a ✕ that removes it.
 */
@Component({
  selector: 'doc-lab-selected-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex flex-col gap-2' },
  styles: `
    .sl-label {
      padding: 4px 4px 4px 12px;
    }
  `,
  template: `
    <p class="font-sans text-caption text-slate">Selected ({{ items().length }})</p>
    @if (items().length) {
      <ul class="flex flex-wrap gap-2" aria-label="Selected tests">
        @for (i of items(); track i.code) {
          <li class="flex items-center rounded-2xl border-[0.5px] font-sans text-body-sm" [class]="i.code === active() ? 'border-cerulean bg-cerulean/10 text-cerulean-dark' : 'border-ash bg-white text-ink'">
            @if (toggles()) {
              <button
                type="button"
                class="sl-label rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-pressed]="i.code === active()"
                (click)="activate.emit(i.code)"
              >
                {{ i.label }}
              </button>
            } @else {
              <span class="sl-label">{{ i.label }}</span>
            }
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-full text-slate transition-colors hover:text-alert focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [attr.aria-label]="'Remove ' + i.label"
              (click)="remove.emit(i.code)"
            >
              <sd-icon name="x" [size]="14" />
            </button>
          </li>
        }
      </ul>
    } @else {
      <p class="font-sans text-caption text-slate">No tests added yet.</p>
    }
  `,
})
export class LabSelectedList {
  readonly items = input<readonly LabFormItem[]>([]);
  /** The active item's code (its chip shows pressed). */
  readonly active = input<string | null>(null);
  /** Laboratory and Imaging: the label is a toggle. */
  readonly toggles = input(true);

  readonly activate = output<string>();
  readonly remove = output<string>();
}
