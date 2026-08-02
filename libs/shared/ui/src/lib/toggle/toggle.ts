import { ChangeDetectionStrategy, Component, model } from '@angular/core';

/**
 * Accessible on/off switch. Two-way bindable:
 * `<sd-toggle [(checked)]="prefs.email" />`.
 */
@Component({
  selector: 'sd-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      role="switch"
      [attr.aria-checked]="checked()"
      class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
      [class]="checked() ? 'bg-cerulean' : 'bg-ash/60'"
      (click)="checked.set(!checked())"
    >
      <span
        class="inline-block size-5 rounded-full bg-white shadow transition-transform"
        [class]="checked() ? 'translate-x-[22px]' : 'translate-x-0.5'"
      ></span>
    </button>
  `,
})
export class ToggleComponent {
  readonly checked = model(false);
}
