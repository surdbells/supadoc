import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

export type EmptyStateTone = 'neutral' | 'brand' | 'error';

/**
 * Consistent, premium empty / no-result / error panel: a haloed icon, a title,
 * an optional message, and a projected action. Replaces the hand-rolled blocks
 * scattered across the list screens.
 *
 * Usage:
 * `<sd-empty-state icon="calendar-off" title="No appointments" message="…">
 *    <sd-button>Book</sd-button>
 *  </sd-empty-state>`
 */
@Component({
  selector: 'sd-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  styles: [
    `
      @keyframes sdRise {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      .sd-es {
        animation: sdRise 0.3s ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .sd-es {
          animation: none;
        }
      }
    `,
  ],
  template: `
    <div class="sd-es flex flex-col items-center gap-5 py-20 text-center">
      <span
        class="flex size-20 items-center justify-center rounded-full ring-8 {{
          circleClass()
        }}"
      >
        <sd-icon [name]="icon()" [size]="34" />
      </span>
      <div class="flex max-w-sm flex-col gap-2">
        @if (title()) {
          <h2 class="font-heading text-h5 text-ink">{{ title() }}</h2>
        }
        @if (message()) {
          <p class="font-sans text-body-sm text-slate">{{ message() }}</p>
        }
      </div>
      <ng-content />
    </div>
  `,
})
export class EmptyStateComponent {
  readonly icon = input<string>('inbox');
  readonly title = input<string>('');
  readonly message = input<string>('');
  readonly tone = input<EmptyStateTone>('neutral');

  protected readonly circleClass = computed(
    () =>
      ({
        neutral: 'bg-glacier text-slate ring-cloud/25',
        brand: 'bg-frost/60 text-cerulean ring-frost/30',
        error: 'bg-alert/10 text-alert ring-alert/10',
      })[this.tone()],
  );
}
