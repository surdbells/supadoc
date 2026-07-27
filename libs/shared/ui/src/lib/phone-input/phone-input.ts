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

export interface Country {
  /** ISO 3166-1 alpha-2 code, used as the track key. */
  readonly iso: string;
  readonly name: string;
  /** E.164 country calling code, including the leading `+` (e.g. `+234`). */
  readonly dialCode: string;
}

/**
 * Major African dialing codes (plus a couple of common non-African ones users
 * may need). Ordered with the most common patient markets first. Extend as the
 * product grows.
 */
export const COUNTRIES: readonly Country[] = [
  { iso: 'NG', name: 'Nigeria', dialCode: '+234' },
  { iso: 'GH', name: 'Ghana', dialCode: '+233' },
  { iso: 'KE', name: 'Kenya', dialCode: '+254' },
  { iso: 'ZA', name: 'South Africa', dialCode: '+27' },
  { iso: 'EG', name: 'Egypt', dialCode: '+20' },
  { iso: 'ET', name: 'Ethiopia', dialCode: '+251' },
  { iso: 'TZ', name: 'Tanzania', dialCode: '+255' },
  { iso: 'UG', name: 'Uganda', dialCode: '+256' },
  { iso: 'RW', name: 'Rwanda', dialCode: '+250' },
  { iso: 'CI', name: "Côte d'Ivoire", dialCode: '+225' },
  { iso: 'SN', name: 'Senegal', dialCode: '+221' },
  { iso: 'CM', name: 'Cameroon', dialCode: '+237' },
  { iso: 'MA', name: 'Morocco', dialCode: '+212' },
  { iso: 'DZ', name: 'Algeria', dialCode: '+213' },
  { iso: 'TN', name: 'Tunisia', dialCode: '+216' },
  { iso: 'ZM', name: 'Zambia', dialCode: '+260' },
  { iso: 'ZW', name: 'Zimbabwe', dialCode: '+263' },
  { iso: 'AO', name: 'Angola', dialCode: '+244' },
  { iso: 'MZ', name: 'Mozambique', dialCode: '+258' },
  { iso: 'CD', name: 'DR Congo', dialCode: '+243' },
  { iso: 'BW', name: 'Botswana', dialCode: '+267' },
  { iso: 'NA', name: 'Namibia', dialCode: '+264' },
];

/**
 * Phone number field with a working country-code dropdown. Emits the full
 * E.164 number (dial code + local digits, e.g. `+2347080060034`) as its form
 * value via ControlValueAccessor, or `''` when no local digits are entered so
 * `Validators.required` behaves as expected.
 *
 * Usage: `<sd-phone-input label="Phone" [required]="true" formControlName="phone" />`
 */
@Component({
  selector: 'sd-phone-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => PhoneInputComponent),
      multi: true,
    },
  ],
  template: `
    <div class="flex w-full flex-col gap-2">
      @if (label()) {
        <span class="font-sans text-body font-semibold text-ink">
          {{ label() }}
          @if (required()) {
            <span class="text-alert"> *</span>
          }
        </span>
      }

      <div class="flex gap-2">
        <!-- Country dropdown -->
        <div class="relative shrink-0">
          <button
            type="button"
            [class]="triggerClasses()"
            [disabled]="disabled()"
            [attr.aria-haspopup]="'listbox'"
            [attr.aria-expanded]="open()"
            (click)="toggle()"
          >
            <span class="font-sans text-body text-ink">{{
              selected().dialCode
            }}</span>
            <sd-icon
              name="chevron-down"
              [size]="16"
              class="text-slate transition-transform"
              [class.rotate-180]="open()"
            />
          </button>

          @if (open()) {
            <!-- click-away backdrop -->
            <button
              type="button"
              class="fixed inset-0 z-10 cursor-default"
              tabindex="-1"
              aria-hidden="true"
              (click)="close()"
            ></button>
            <ul
              role="listbox"
              class="absolute left-0 top-[calc(100%+4px)] z-20 max-h-64 w-64 overflow-auto rounded-field border border-[#d7e0e8] bg-white py-1 shadow-lg"
            >
              @for (c of countries; track c.iso) {
                <li>
                  <button
                    type="button"
                    role="option"
                    [attr.aria-selected]="c.iso === selected().iso"
                    class="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left font-sans text-body-sm transition-colors hover:bg-glacier"
                    [class.bg-frost]="c.iso === selected().iso"
                    (click)="select(c)"
                  >
                    <span class="text-ink">{{ c.name }}</span>
                    <span class="shrink-0 text-slate">{{ c.dialCode }}</span>
                  </button>
                </li>
              }
            </ul>
          }
        </div>

        <!-- Local number -->
        <span [class]="fieldClasses()">
          <input
            class="w-full bg-transparent py-4 text-body text-ink placeholder:text-slate/60 focus:outline-none disabled:cursor-not-allowed"
            type="tel"
            inputmode="tel"
            autocomplete="tel-national"
            [placeholder]="placeholder()"
            [value]="local()"
            [disabled]="disabled()"
            (input)="onLocalInput($event)"
            (blur)="onTouched()"
          />
        </span>
      </div>

      @if (error()) {
        <span class="font-label text-caption text-alert">{{ error() }}</span>
      }
    </div>
  `,
})
export class PhoneInputComponent implements ControlValueAccessor {
  readonly label = input<string>();
  readonly placeholder = input('7080060034');
  readonly required = input(false);
  readonly error = input<string>();

  protected readonly countries = COUNTRIES;
  protected readonly selected = signal<Country>(COUNTRIES[0]);
  protected readonly local = signal('');
  protected readonly open = signal(false);
  protected readonly disabled = signal(false);

  protected readonly triggerClasses = computed(() => {
    const border = this.error()
      ? 'border-alert'
      : 'border-[#d7e0e8] focus:border-teal';
    return `flex h-full items-center gap-2 rounded-field border bg-white px-3 transition-colors focus:outline-none focus:ring-2 focus:ring-teal/15 disabled:cursor-not-allowed ${border}`;
  });

  protected readonly fieldClasses = computed(() => {
    const border = this.error()
      ? 'border-alert focus-within:border-alert focus-within:ring-alert/15'
      : 'border-[#d7e0e8] focus-within:border-teal focus-within:ring-teal/15';
    return `flex flex-1 items-center rounded-field border bg-white px-4 transition-colors focus-within:ring-2 ${border}`;
  });

  protected toggle(): void {
    if (this.disabled()) return;
    this.open.update((v) => !v);
  }

  protected close(): void {
    this.open.set(false);
  }

  protected select(country: Country): void {
    this.selected.set(country);
    this.open.set(false);
    this.emit();
  }

  protected onLocalInput(event: Event): void {
    // Keep digits only; the dial code carries the country prefix.
    const digits = (event.target as HTMLInputElement).value.replace(/\D/g, '');
    this.local.set(digits);
    this.emit();
  }

  private emit(): void {
    const digits = this.local();
    this.onChange(digits ? `${this.selected().dialCode}${digits}` : '');
  }

  private onChange: (value: string) => void = () => {
    /* set via registerOnChange */
  };
  protected onTouched: () => void = () => {
    /* set via registerOnTouched */
  };

  writeValue(value: string): void {
    const raw = value ?? '';
    if (!raw) {
      this.local.set('');
      return;
    }
    // Longest dial code first so e.g. +234 wins over any shorter prefix.
    const match = [...COUNTRIES]
      .sort((a, b) => b.dialCode.length - a.dialCode.length)
      .find((c) => raw.startsWith(c.dialCode));
    if (match) {
      this.selected.set(match);
      this.local.set(raw.slice(match.dialCode.length).replace(/\D/g, ''));
    } else {
      this.local.set(raw.replace(/\D/g, ''));
    }
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
