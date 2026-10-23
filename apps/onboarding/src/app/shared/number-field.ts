import { ChangeDetectionStrategy, Component, computed, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { IconComponent } from '@supadoc/ui';
import { onbControl } from './ui-classes';

/**
 * A whole number typed on the numeric keypad (digits only). Value: a number,
 * or null when empty. With `stepper`, the drawn `chevrons-up-down` icon is two
 * buttons, "Increase" and "Decrease", each with a 40×40 hit area; ArrowUp /
 * ArrowDown do the same. The input is a `spinbutton` with its bounds and value.
 */
@Component({
  selector: 'onb-number-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => NumberFieldComponent), multi: true }],
  host: { class: 'relative block' },
  template: `
    <input
      type="text"
      inputmode="numeric"
      autocomplete="off"
      role="spinbutton"
      [id]="inputId()"
      [class]="controlClass()"
      [placeholder]="placeholder()"
      [attr.maxlength]="maxLength()"
      [value]="text()"
      [disabled]="disabled()"
      [attr.aria-valuemin]="min()"
      [attr.aria-valuemax]="max()"
      [attr.aria-valuenow]="value()"
      [attr.aria-describedby]="describedBy()"
      [attr.aria-invalid]="invalid() || null"
      (input)="onType($event)"
      (keydown)="onKey($event)"
      (blur)="onTouched()"
    />
    @if (stepper()) {
      <span class="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate" aria-hidden="true">
        <sd-icon name="chevrons-up-down" [size]="20" [strokeWidth]="1.5" />
      </span>
      <button
        type="button"
        aria-label="Increase"
        tabindex="-1"
        class="absolute -top-4 right-2 h-10 w-10 rounded-md focus:outline-none disabled:cursor-not-allowed"
        [disabled]="disabled()"
        (click)="stepBy(1)"
      ></button>
      <button
        type="button"
        aria-label="Decrease"
        tabindex="-1"
        class="absolute -bottom-4 right-2 h-10 w-10 rounded-md focus:outline-none disabled:cursor-not-allowed"
        [disabled]="disabled()"
        (click)="stepBy(-1)"
      ></button>
    }
  `,
})
export class NumberFieldComponent implements ControlValueAccessor {
  readonly inputId = input.required<string>();
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);
  readonly min = input(0);
  readonly max = input(9999);
  readonly placeholder = input('');
  readonly stepper = input(false);

  protected readonly text = signal('');
  protected readonly disabled = signal(false);
  protected readonly value = computed(() => (this.text() === '' ? null : Number(this.text())));
  protected readonly maxLength = computed(() => String(this.max()).length);
  protected readonly controlClass = computed(() => `${onbControl(this.invalid())}${this.stepper() ? ' pr-14' : ''}`);

  private onChange: (value: number | null) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  protected onType(event: Event): void {
    const el = event.target as HTMLInputElement;
    const digits = el.value.replace(/\D/g, '').slice(0, this.maxLength());
    el.value = digits;
    this.update(digits);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.stepBy(1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.stepBy(-1);
    }
  }

  /** One up or down, within [min, max]; empty starts at min. */
  stepBy(delta: number): void {
    if (this.disabled()) return;
    const current = this.value();
    const next = current === null ? this.min() : Math.min(this.max(), Math.max(this.min(), current + delta));
    this.update(String(next));
    this.onTouched();
  }

  private update(digits: string): void {
    this.text.set(digits);
    this.onChange(digits === '' ? null : Number(digits));
  }

  writeValue(value: number | string | null): void {
    this.text.set(value === null || value === undefined || value === '' ? '' : String(value));
  }
  registerOnChange(fn: (value: number | null) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }
}
