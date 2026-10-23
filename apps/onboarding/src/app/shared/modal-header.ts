import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '@supadoc/ui';

/**
 * The modal header of the Resume / Track / dialog frames: title (18 Medium
 * Ink), subtitle (15 Slate) and a 20px `x` in a 40px button. Give the
 * `sd-dialog layout="plain"` `labelledBy` = `{baseId}-title` and
 * `describedBy` = `{baseId}-subtitle`.
 */
@Component({
  selector: 'onb-modal-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex items-start justify-between gap-3">
      <h2 [id]="baseId() + '-title'" class="pt-0.5 font-sans text-[18px] font-medium leading-[22px] text-ink">
        {{ title() }}
      </h2>
      <button
        type="button"
        class="-mr-2.5 -mt-2.5 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:bg-glacier hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-50"
        aria-label="Close"
        [disabled]="busy()"
        (click)="closed.emit()"
      >
        <sd-icon name="x" [size]="20" [strokeWidth]="1.5" />
      </button>
    </div>
    @if (subtitle()) {
      <p [id]="baseId() + '-subtitle'" class="mt-3.5 font-sans text-[15px] leading-[18px] tracking-[0.03em] text-slate">
        {{ subtitle() }}
      </p>
    }
  `,
})
export class ModalHeaderComponent {
  readonly baseId = input.required<string>();
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly busy = input(false);
  readonly closed = output<void>();
}
