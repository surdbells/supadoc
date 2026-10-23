import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  forwardRef,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

const LENGTH = 6;

/** `default`: 56px boxes (patient sign-up). `compact`: 48px boxes, 6px corners (doctor applications). */
export type OtpVariant = 'default' | 'compact';

/**
 * Six-box one-time-code input (VideoMed). Auto-advances on entry, steps back on
 * backspace, and exposes the joined code as a form value via ControlValueAccessor.
 * The boxes form a labelled group ("6-digit code"), each named "Digit n of 6";
 * `invalid` gives them alert borders and `aria-invalid`.
 *
 * Usage: `<sd-otp formControlName="code" />` or `<sd-otp variant="compact" [invalid]="wrong()" … />`
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
  // Patient dark mode: the teal/20 focus ring is ~1.2:1 on the dark box; lift it
  // to 0.7 (4.0:1). Light mode is unchanged. The box borders are classes (not
  // inline styles) so the app's dark `border-[#b8c6d4]` rule can reach them.
  styles: `
    :host-context(html[data-theme='dark']) input:focus {
      --tw-ring-color: rgb(77 182 172 / 0.7);
    }
  `,
  template: `
    <div
      role="group"
      [attr.aria-label]="groupLabel()"
      [attr.aria-describedby]="describedBy()"
      [class]="variant() === 'compact' ? 'flex justify-center gap-4' : 'flex gap-3'"
    >
      @for (slot of slots; track slot) {
        <input
          #box
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="1"
          [class]="boxClass(slot)"
          [attr.aria-label]="'Digit ' + (slot + 1) + ' of ' + slots.length"
          [attr.aria-invalid]="invalid() || null"
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
  readonly variant = input<OtpVariant>('default');
  /** Alert borders on every box (e.g. the code was wrong). */
  readonly invalid = input(false);
  /** Accessible name of the group of boxes. */
  readonly groupLabel = input('6-digit code');
  /** Id(s) of text describing the code (an error line, the countdown). */
  readonly describedBy = input<string | null>(null);

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

  protected boxClass(slot: number): string {
    const filled = !!this.digits()[slot];
    if (this.variant() === 'compact') {
      // 48×48, 6px corners (Figma), Slate border, Cerulean focus.
      const border = this.invalid() ? 'border-alert focus:border-alert focus:ring-alert/20' : 'border-slate focus:border-cerulean focus:ring-cerulean/20';
      return (
        'size-12 rounded-md border bg-white text-center font-sans text-body font-semibold text-ink ' +
        `transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed ${border}`
      );
    }
    const border = this.invalid() ? 'border-alert' : filled ? 'border-teal' : 'border-[#b8c6d4]';
    return (
      'size-14 rounded-field border bg-white text-center font-heading text-h4 text-ink transition-colors ' +
      `focus:outline-none focus:ring-2 focus:ring-teal/20 ${border}`
    );
  }

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

  /** Move focus to the first box (e.g. after the code was cleared). */
  focusFirst(): void {
    this.focusBox(0);
  }

  /** Move focus to the first empty box (the last one when all are filled): where an incomplete code continues. */
  focusFirstEmpty(): void {
    const index = this.digits().findIndex((d) => !d);
    this.focusBox(index === -1 ? LENGTH - 1 : index);
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
