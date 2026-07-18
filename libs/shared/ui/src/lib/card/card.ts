import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Surface container used to group content. Usage: `<sd-card>...</sd-card>`. */
@Component({
  selector: 'sd-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="rounded-card bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)] ring-1 ring-cloud/70"
    >
      <ng-content />
    </div>
  `,
})
export class CardComponent {}
