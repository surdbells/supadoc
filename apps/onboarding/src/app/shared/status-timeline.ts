import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ApplicationTimelineRowDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/**
 * The status timeline (Figma App 24): an ordered list of rows. Done rows have
 * a Sage check, pending ones an empty Slate circle; the current row is Ink with
 * a "Current status" pill, its description and the projected extras (the
 * page's `[current]` content). Rejected is an Alert `circle-x` with an Alert
 * pill. Each icon has a text equivalent.
 */
@Component({
  selector: 'onb-status-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <ol class="flex flex-col gap-3.5">
      @for (row of rows(); track row.key) {
        <li [attr.aria-current]="row.state === 'current' ? 'step' : null">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            @if (row.state === 'current' && row.key === 'rejected') {
              <sd-icon name="circle-x" [size]="20" [strokeWidth]="1.5" class="shrink-0 text-alert" />
            } @else if (row.state === 'pending') {
              <sd-icon name="circle" [size]="20" [strokeWidth]="1.5" class="shrink-0 text-slate" />
            } @else {
              <sd-icon name="circle-check" [size]="20" [strokeWidth]="1.5" class="shrink-0 text-sage" />
            }
            <span class="sr-only">{{ stateText(row) }}:</span>
            <span class="font-sans text-body-sm" [class]="row.state === 'current' ? 'text-ink' : 'text-slate'">{{
              row.label
            }}</span>
            @if (row.state === 'current') {
              <span
                class="ml-2 inline-flex h-6 items-center rounded-pill px-2.5 font-sans text-caption"
                [class]="row.key === 'rejected' ? 'bg-alert/10 text-alert-ink' : 'bg-cerulean/10 text-cerulean-dark'"
              >
                Current status
              </span>
            }
          </div>
          @if (row.state === 'current') {
            <div class="mt-1.5 pl-7">
              @if (row.description) {
                <p class="font-sans text-caption text-slate">{{ row.description }}</p>
              }
              <ng-content />
            </div>
          }
        </li>
      }
    </ol>
  `,
})
export class StatusTimelineComponent {
  readonly rows = input<readonly ApplicationTimelineRowDto[]>([]);

  protected stateText(row: ApplicationTimelineRowDto): string {
    if (row.state === 'current') return 'Current';
    return row.state === 'done' ? 'Done' : 'Not yet';
  }
}
