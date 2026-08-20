import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

export type AlertTone = 'error' | 'success' | 'info' | 'warning';

/**
 * Inline status message with a leading icon and a tone. Consolidates the
 * hand-rolled `bg-alert/10 … text-alert` banners.
 *
 * Usage: `<sd-alert tone="error">Invalid email or password</sd-alert>`.
 */
@Component({
  selector: 'sd-alert',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="flex items-start gap-2.5 rounded-field px-4 py-3 font-sans text-body-sm {{
        toneClass()
      }}"
      [attr.role]="tone() === 'error' || tone() === 'warning' ? 'alert' : 'status'"
    >
      <sd-icon [name]="icon()" [size]="18" class="mt-0.5 shrink-0" />
      <span class="min-w-0 flex-1"><ng-content /></span>
    </div>
  `,
})
export class AlertComponent {
  readonly tone = input<AlertTone>('error');

  protected readonly icon = computed(
    () =>
      ({
        error: 'triangle-alert',
        success: 'circle-check',
        info: 'info',
        warning: 'triangle-alert',
      })[this.tone()],
  );

  protected readonly toneClass = computed(
    () =>
      ({
        error: 'bg-alert/10 text-alert',
        success: 'bg-sage/10 text-sage',
        info: 'bg-frost/50 text-cerulean',
        warning: 'bg-warning/10 text-warning',
      })[this.tone()],
  );
}
