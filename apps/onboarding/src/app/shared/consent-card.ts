import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { IconComponent } from '@supadoc/ui';

/**
 * A consent statement as a checkbox card (Figma Component 134): white with a
 * 0.5px Haze border; ticked, Cerulean/10 with a 0.5px Cerulean border and a
 * Cerulean box with a white tick. A native checkbox inside the label carries
 * the state; the drawn box is decoration.
 */
@Component({
  selector: 'onb-consent-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <label [class]="cardClass()">
      <input
        type="checkbox"
        class="peer sr-only"
        [id]="inputId()"
        [checked]="checked()"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="describedBy()"
        (change)="changed.emit($any($event.target).checked)"
      />
      <span [class]="boxClass()" aria-hidden="true">
        @if (checked()) {
          <sd-icon name="check" [size]="12" [strokeWidth]="3" />
        }
      </span>
      <span class="font-sans text-body-sm text-ink"><ng-content /></span>
    </label>
  `,
})
export class ConsentCardComponent {
  readonly inputId = input.required<string>();
  readonly checked = input(false);
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);
  readonly changed = output<boolean>();

  protected readonly cardClass = computed(() => {
    const state = this.checked()
      ? 'border-cerulean bg-cerulean/10'
      : this.invalid()
        ? 'border-alert bg-white shadow-card'
        : 'border-haze bg-white shadow-card';
    return (
      'flex cursor-pointer items-start gap-3 rounded-[24px] border-[0.5px] px-5 py-[18px] transition-colors ' +
      `focus-within:ring-2 focus-within:ring-cerulean/40 ${state}`
    );
  });

  protected readonly boxClass = computed(
    () =>
      'mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-[2px] border ' +
      (this.checked() ? 'border-cerulean bg-cerulean text-white' : 'border-slate bg-white'),
  );
}
