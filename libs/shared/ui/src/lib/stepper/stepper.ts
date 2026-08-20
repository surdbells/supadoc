import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

/**
 * Shared multi-step progress indicator. Completed steps show a check, the
 * current step is filled with a soft glow, and upcoming steps are faded.
 *
 * Usage: `<sd-stepper [count]="7" [current]="step()" />` (current is 1-based).
 */
@Component({
  selector: 'sd-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex max-w-full items-center justify-center overflow-x-auto pb-1">
      @for (n of steps(); track n; let last = $last) {
        <span
          class="flex size-9 shrink-0 items-center justify-center rounded-full font-sans text-body-sm font-semibold transition-all duration-200"
          [class]="circleClass(n)"
        >
          @if (n < current()) {
            <sd-icon name="check" [size]="18" />
          } @else {
            {{ n }}
          }
        </span>
        @if (!last) {
          <span
            class="h-0.5 w-8 shrink-0 transition-colors duration-200 sm:w-12"
            [class]="n < current() ? 'bg-sage' : 'bg-cerulean/25'"
          ></span>
        }
      }
    </div>
  `,
})
export class StepperComponent {
  /** Total number of steps. */
  readonly count = input.required<number>();
  /** The active step, 1-based. */
  readonly current = input.required<number>();

  protected readonly steps = computed(() =>
    Array.from({ length: this.count() }, (_, i) => i + 1),
  );

  protected circleClass(n: number): string {
    if (n < this.current()) return 'bg-sage text-white';
    if (n === this.current())
      return 'bg-cerulean text-white shadow-[0_2px_10px_rgba(21,101,192,0.35)]';
    return 'bg-cerulean/15 text-cerulean';
  }
}
