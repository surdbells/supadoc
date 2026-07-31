import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  forwardRef,
  signal,
  viewChildren,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

const LENGTH = 6;

/**
 * Six-box one-time-code input (VideoMed). Auto-advances on entry, steps back on
 * backspace, and exposes the joined code as a form value via ControlValueAccessor.
 *
 * Usage: `<sd-otp formControlName="code" />`
 */
@Component({
  selector: 'sd-otp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => OtpComponent),
      multi: true,
    },
  ],
  template: `
    <div class="flex gap-3">
      @for (slot of slots; track slot) {
        <input
          #box
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="1"
          class="size-14 rounded-field border bg-white text-center font-heading text-h4 text-ink transition-colors focus:outline-none focus:ring-2 focus:ring-teal/20"
          [style.borderColor]="digits()[slot] ? '#00897b' : '#d7e0e8'"
          [value]="digits()[slot]"
          [disabled]="disabled()"
          (input)="handleInput(slot, $event)"
          (keydown)="handleKeydown(slot, $event)"
          (paste)="handlePaste(slot, $event)"
          (focus)="select($event)"
        />
      }
    </div>
  `,
})
export class OtpComponent implements ControlValueAccessor {
  protected readonly slots = Array.from({ length: LENGTH }, (_, i) => i);
  protected readonly digits = signal<string[]>(Array(LENGTH).fill(''));
  protected readonly disabled = signal(false);
  private readonly boxes = viewChildren<ElementRef<HTMLInputElement>>('box');

  private onChange: (value: string) => void = () => {
    /* set via registerOnChange */
  };
  protected onTouched: () => void = () => {
    /* set via registerOnTouched */
  };

  protected handleInput(index: number, event: Event): void {
    const el = event.target as HTMLInputElement;
    const value = el.value.replace(/\D/g, '').slice(-1);
    const next = [...this.digits()];
    next[index] = value;
    this.digits.set(next);
    el.value = value;
    this.emit();
    if (value && index < LENGTH - 1) this.focusBox(index + 1);
  }

  protected handleKeydown(index: number, event: KeyboardEvent): void {
    if (event.key === 'Backspace' && !this.digits()[index] && index > 0) {
      this.focusBox(index - 1);
    }
  }

  /** Paste a whole code: fill boxes from where the paste started. */
  protected handlePaste(index: number, event: ClipboardEvent): void {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') ?? '')
      .replace(/\D/g, '')
      .slice(0, LENGTH - index);
    if (!pasted) return;
    const next = [...this.digits()];
    for (let i = 0; i < pasted.length; i++) next[index + i] = pasted[i];
    this.digits.set(next);
    this.emit();
    // Focus the box after the last one filled (or the final box).
    this.focusBox(Math.min(index + pasted.length, LENGTH - 1));
  }

  protected select(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  private focusBox(index: number): void {
    this.boxes()[index]?.nativeElement.focus();
  }

  private emit(): void {
    this.onChange(this.digits().join(''));
    this.onTouched();
  }

  writeValue(value: string): void {
    const arr = Array(LENGTH).fill('');
    (value ?? '')
      .split('')
      .slice(0, LENGTH)
      .forEach((c, i) => (arr[i] = c));
    this.digits.set(arr);
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
