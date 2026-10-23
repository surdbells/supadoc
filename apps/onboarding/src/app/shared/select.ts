import { ChangeDetectionStrategy, Component, computed, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { IconComponent } from '@supadoc/ui';
import { onbControl } from './ui-classes';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** A native `<select>` drawn as the 48px control with a `chevron-down` (Gender, withdraw reason). */
@Component({
  selector: 'onb-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SelectComponent), multi: true }],
  host: { class: 'relative block' },
  template: `
    <select
      [id]="inputId()"
      [class]="controlClass()"
      [disabled]="disabled()"
      [attr.aria-describedby]="describedBy()"
      [attr.aria-invalid]="invalid() || null"
      (change)="onPick($event)"
      (blur)="onTouched()"
    >
      <option value="" [selected]="value() === ''">{{ placeholder() }}</option>
      @for (o of options(); track o.value) {
        <option [value]="o.value" [selected]="o.value === value()">{{ o.label }}</option>
      }
    </select>
    <span class="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate" aria-hidden="true">
      <sd-icon name="chevron-down" [size]="20" [strokeWidth]="1.5" />
    </span>
  `,
})
export class SelectComponent implements ControlValueAccessor {
  readonly inputId = input.required<string>();
  readonly options = input<readonly SelectOption[]>([]);
  readonly placeholder = input('Select');
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);

  protected readonly value = signal('');
  protected readonly disabled = signal(false);
  protected readonly controlClass = computed(
    () => `${onbControl(this.invalid())} appearance-none pr-12 ${this.value() ? 'text-ink' : 'text-slate'}`,
  );

  private onChange: (value: string) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  protected onPick(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.value.set(v);
    this.onChange(v);
  }

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }
  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }
}
