import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design-system icon, backed by Lucide. Usage: `<sd-icon name="stethoscope" />`.
 * The `name` must be part of the registered set (see `provideSupadocIcons`).
 */
@Component({
  selector: 'sd-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  template: `<svg
    [lucideIcon]="name()"
    [size]="size()"
    [strokeWidth]="strokeWidth()"
  ></svg>`,
})
export class IconComponent {
  readonly name = input.required<string>();
  readonly size = input<number | string>(20);
  readonly strokeWidth = input<number | string>(2);
}
