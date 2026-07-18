import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { IconComponent } from '../icon/icon';

export type InputType =
  'text' | 'email' | 'password' | 'tel' | 'number' | 'date';

/**
 * VideoMed form input: bold label, white 16px-radius field with a light border,
 * optional leading icon and a password reveal toggle. Works with reactive and
 * template-driven forms via ControlValueAccessor.
 *
 * Usage: `<sd-input label="Email" type="email" formControlName="email" />`
 */
@Component({
  selector: 'sd-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => InputComponent),
      multi: true,
    },
  ],
  template: `
    <label class="flex w-full flex-col gap-2">
      @if (label()) {
        <span class="font-sans text-body font-semibold text-ink"
          >{{ label() }}
          @if (required()) {
            <span class="text-alert"> *</span>
          }
        </span>
      }
      <span [class]="fieldClasses()">
        @if (leadingIcon()) {
          <sd-icon [name]="leadingIcon()!" [size]="20" class="text-slate" />
        }
        <input
          class="w-full bg-transparent py-4 text-body text-ink placeholder:text-slate/60 focus:outline-none disabled:cursor-not-allowed"
          [type]="resolvedType()"
          [placeholder]="placeholder()"
          [value]="value()"
          [disabled]="disabled()"
          [attr.inputmode]="type() === 'tel' ? 'tel' : null"
          [attr.autocomplete]="autocomplete() || null"
          (input)="onInput($event)"
          (blur)="onTouched()"
        />
        @if (type() === 'password') {
          <button
            type="button"
            class="shrink-0 text-slate transition-colors hover:text-ink"
            [attr.aria-label]="revealed() ? 'Hide password' : 'Show password'"
            (click)="toggleReveal()"
          >
            <sd-icon [name]="revealed() ? 'eye-off' : 'eye'" [size]="20" />
          </button>
        }
      </span>
      @if (error()) {
        <span class="font-label text-caption text-alert">{{ error() }}</span>
      } @else if (success()) {
        <span class="font-label text-caption text-teal">{{ success() }}</span>
      }
    </label>
  `,
})
export class InputComponent implements ControlValueAccessor {
  readonly label = input<string>();
  readonly placeholder = input('');
  readonly type = input<InputType>('text');
  readonly leadingIcon = input<string>();
  readonly autocomplete = input<string>();
  readonly error = input<string>();
  readonly success = input<string>();
  readonly required = input(false);

  protected readonly value = signal('');
  protected readonly disabled = signal(false);
  protected readonly revealed = signal(false);

  protected readonly resolvedType = computed(() =>
    this.type() === 'password'
      ? this.revealed()
        ? 'text'
        : 'password'
      : this.type(),
  );

  protected readonly fieldClasses = computed(() => {
    const border = this.error()
      ? 'border-alert focus-within:border-alert focus-within:ring-alert/15'
      : 'border-[#d7e0e8] focus-within:border-teal focus-within:ring-teal/15';
    return `flex items-center gap-2 rounded-field border bg-white px-4 transition-colors focus-within:ring-2 ${border}`;
  });

  private onChange: (value: string) => void = () => {
    /* set via registerOnChange */
  };
  protected onTouched: () => void = () => {
    /* set via registerOnTouched */
  };

  protected onInput(event: Event): void {
    const next = (event.target as HTMLInputElement).value;
    this.value.set(next);
    this.onChange(next);
  }

  protected toggleReveal(): void {
    this.revealed.update((v) => !v);
  }

  writeValue(value: string): void {
    this.value.set(value ?? '');
  }
  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }
}
