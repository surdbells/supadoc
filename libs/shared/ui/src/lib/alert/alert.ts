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
 * Contrast (WCAG 2.2 AA): each tone keeps its tint but sets its text in the
 * tone's darker "ink" shade from tailwind/theme.css (`alert-ink`, `sage-ink`,
 * `cerulean-dark`, `warning-ink`). The base tones were 1.8–4.5:1 on their own
 * tints in light mode; the inks are ≥ 5.2:1 over the card and the page, and the
 * patient app's dark mode re-points the same ink classes to light shades
 * (≥ 6.7:1). The icon and the ring follow the text colour (`currentColor`), so
 * the icon has the text's ratio. Content needs no `text-ink` / `text-*-ink`
 * wrapper. The ratios are recorded in alert.spec.ts.
 *
 * Place alerts on the neutral surfaces (white card, glacier page, snow, cloud;
 * all ≥ 4.8:1). Blue surfaces leave too little margin: on `bg-haze` the
 * warning text is 4.48:1 and on `bg-frost` error/warning drop to about 4.0:1.
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
      class="flex items-start gap-2.5 rounded-field px-4 py-3 font-sans text-body-sm inset-ring inset-ring-current/15 {{
        toneClass()
      }}"
      [attr.role]="
        tone() === 'error' || tone() === 'warning' ? 'alert' : 'status'
      "
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
        error: 'bg-alert/10 text-alert-ink',
        success: 'bg-sage/10 text-sage-ink',
        info: 'bg-frost/50 text-cerulean-dark',
        warning: 'bg-warning/10 text-warning-ink',
      })[this.tone()],
  );
}
