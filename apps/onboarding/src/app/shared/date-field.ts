import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  forwardRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { IconComponent } from '@supadoc/ui';
import { parseYmd } from '../core/format';
import { onbControl } from './ui-classes';

/** "DD / MM / YYYY" from up to 8 typed digits. */
export function maskDate(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)} / ${d.slice(2)}`;
  return `${d.slice(0, 2)} / ${d.slice(2, 4)} / ${d.slice(4)}`;
}

/** The form value for what is typed: '' (empty), 'YYYY-MM-DD' (a real date), else the text (invalid). */
export function dateValueOf(text: string): string {
  const d = text.replace(/\D/g, '');
  if (d.length === 0) return '';
  if (d.length === 8) {
    const ymd = `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
    if (parseYmd(ymd)) return ymd;
  }
  return text.trim();
}

/** 'YYYY-MM-DD' → "DD / MM / YYYY". */
function display(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd ?? '';
  return `${String(p.d).padStart(2, '0')} / ${String(p.m).padStart(2, '0')} / ${p.y}`;
}

/**
 * A date typed as "DD / MM / YYYY" (numeric keypad on phones), with a calendar
 * button that opens the browser's own picker (`showPicker()` on a native date
 * input that is rendered but visually hidden: `showPicker()` throws on an
 * element that is not rendered). Value: 'YYYY-MM-DD', '' when empty, or the
 * raw text while it is not a real date (so validation reports it).
 */
@Component({
  selector: 'onb-date-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DateFieldComponent), multi: true }],
  host: { class: 'relative block' },
  template: `
    <input
      #text
      type="text"
      inputmode="numeric"
      placeholder="DD / MM / YYYY"
      maxlength="14"
      [id]="inputId()"
      [class]="controlClass()"
      [value]="shown()"
      [disabled]="disabled()"
      [attr.aria-describedby]="describedBy()"
      [attr.aria-invalid]="invalid() || null"
      [attr.autocomplete]="autocomplete()"
      (input)="onType($event)"
      (blur)="onTouched()"
    />
    <button
      type="button"
      aria-label="Choose date"
      class="absolute right-2 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full text-slate transition-colors hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed"
      [disabled]="disabled()"
      (click)="openPicker()"
    >
      <sd-icon name="calendar" [size]="20" [strokeWidth]="1.5" />
    </button>
    <input
      #native
      type="date"
      tabindex="-1"
      aria-hidden="true"
      class="pointer-events-none absolute bottom-0 right-0 size-px overflow-hidden opacity-0 [clip:rect(0,0,0,0)]"
      [attr.min]="min()"
      [attr.max]="max()"
      [value]="nativeValue()"
      (change)="onPicked($event)"
    />
  `,
})
export class DateFieldComponent implements ControlValueAccessor {
  readonly inputId = input.required<string>();
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);
  /** 'YYYY-MM-DD' bounds for the picker. */
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  readonly autocomplete = input<string>('off');

  protected readonly shown = signal('');
  protected readonly disabled = signal(false);
  private readonly value = signal('');
  protected readonly nativeValue = computed(() => (parseYmd(this.value()) ? this.value() : ''));
  protected readonly controlClass = computed(() => `${onbControl(this.invalid())} pr-14`);

  private readonly text = viewChild.required<ElementRef<HTMLInputElement>>('text');
  private readonly native = viewChild.required<ElementRef<HTMLInputElement>>('native');

  private onChange: (value: string) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  protected onType(event: Event): void {
    const el = event.target as HTMLInputElement;
    const masked = maskDate(el.value);
    el.value = masked;
    this.shown.set(masked);
    this.set(dateValueOf(masked));
  }

  protected onPicked(event: Event): void {
    const ymd = (event.target as HTMLInputElement).value;
    if (!parseYmd(ymd)) return;
    this.shown.set(display(ymd));
    this.set(ymd);
    this.onTouched();
    this.text().nativeElement.focus();
  }

  /** Opens the native picker; where that is impossible, the text input takes focus instead. */
  openPicker(): void {
    const native = this.native().nativeElement as HTMLInputElement & { showPicker?: () => void };
    try {
      if (typeof native.showPicker !== 'function') throw new Error('showPicker unsupported');
      native.showPicker();
    } catch {
      this.text().nativeElement.focus();
    }
  }

  private set(value: string): void {
    this.value.set(value);
    this.onChange(value);
  }

  writeValue(value: string | null): void {
    const v = value ?? '';
    this.value.set(v);
    this.shown.set(parseYmd(v) ? display(v) : v);
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
