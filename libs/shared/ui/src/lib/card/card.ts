import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Simple surface container used to group content. Usage: `<sd-card>...</sd-card>`. */
@Component({
  selector: 'sd-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="rounded-[var(--radius-card)] border border-surface-200 bg-white p-6 shadow-sm"
    >
      <ng-content />
    </div>
  `,
})
export class CardComponent {}
