import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  forwardRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { IconComponent } from '../icon/icon';

export interface Country {
  /** ISO 3166-1 alpha-2 code, used as the track key. */
  readonly iso: string;
  readonly name: string;
  /** E.164 country calling code, including the leading `+` (e.g. `+234`). */
  readonly dialCode: string;
  /**
   * For a calling code several countries share (+1, +44, +7…): the one a stored
   * number with that code is shown as. Exactly one entry per shared code has it.
   */
  readonly primary?: boolean;
}

/**
 * Major African dialing codes (plus a couple of common non-African ones users
 * may need). Ordered with the most common patient markets first. Extend as the
 * product grows. `WORLD_COUNTRIES` (./countries) is the full ISO list.
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

/** Above this many countries the dropdown gets a search box. */
const SEARCH_FROM = 30;

let nextId = 0;

/**
 * The country a stored E.164 number belongs to: the longest matching calling
 * code wins, and among countries sharing it the `primary` one (else the first).
 */
export function countryForNumber(raw: string, countries: readonly Country[]): Country | null {
  let best: Country | null = null;
  for (const c of countries) {
    if (!raw.startsWith(c.dialCode)) continue;
    if (
      !best ||
      c.dialCode.length > best.dialCode.length ||
      (c.dialCode.length === best.dialCode.length && c.primary && !best.primary)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Phone number field with a working country-code dropdown. Emits the full
 * E.164 number (dial code + local digits, e.g. `+2347080060034`) as its form
 * value via ControlValueAccessor, or `''` when no local digits are entered so
 * `Validators.required` behaves as expected.
 *
 * - `countries`: the list offered (default: the African `COUNTRIES`; pass
 *   `WORLD_COUNTRIES` for every country). The first is selected until a value
 *   says otherwise. Lists over 30 entries get a search box.
 * - `size`: `lg` (default, 56px) or `md` (a 48px control with 14px text).
 * - `inputId` / `describedBy` / `invalid`: wire the number input to an outside
 *   `<label for>`, helper / error text and `aria-invalid`.
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
        <label [for]="inputId()" [class]="labelClasses()">
          {{ label() }}
          @if (required()) {
            <span class="text-alert" aria-hidden="true"> *</span>
            <span class="sr-only"> (required)</span>
          }
        </label>
      }

      <div class="flex gap-2">
        <!-- Country dropdown -->
        <div class="relative shrink-0">
          <button
            #trigger
            type="button"
            [class]="triggerClasses()"
            [disabled]="disabled()"
            [attr.aria-haspopup]="'listbox'"
            [attr.aria-expanded]="open()"
            [attr.aria-label]="'Country code: ' + current().name + ' ' + current().dialCode"
            (click)="toggle()"
          >
            <span [class]="dialClasses()">{{ current().dialCode }}</span>
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
            <!-- tabindex -1: a click inside (Safari does not focus clicked buttons) keeps focus in the control. -->
            <div
              tabindex="-1"
              class="absolute left-0 top-[calc(100%+4px)] z-20 w-64 overflow-hidden rounded-field border border-haze bg-white shadow-overlay focus:outline-none"
            >
              @if (searchable()) {
                <div class="flex items-center gap-2 border-b border-cloud px-3 py-2">
                  <sd-icon name="search" [size]="16" class="shrink-0 text-slate" />
                  <input
                    #search
                    type="text"
                    aria-label="Search countries"
                    placeholder="Search countries"
                    autocomplete="off"
                    (keydown.escape)="close(true)"
                    [value]="filter()"
                    (input)="filter.set($any($event.target).value)"
                    class="w-full bg-transparent font-sans text-body-sm text-ink placeholder:text-slate focus:outline-none"
                  />
                </div>
              }
              <ul role="listbox" aria-label="Country code" class="max-h-64 overflow-auto py-1">
                @for (c of filtered(); track c.iso) {
                  <li role="none">
                    <button
                      type="button"
                      role="option"
                      [attr.aria-selected]="c.iso === current().iso"
                      class="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left font-sans text-body-sm transition-colors hover:bg-glacier"
                      [class.bg-frost]="c.iso === current().iso"
                      (keydown.escape)="close(true)"
                      (click)="select(c)"
                    >
                      <span class="text-ink">{{ c.name }}</span>
                      <span class="shrink-0 text-slate">{{ c.dialCode }}</span>
                    </button>
                  </li>
                } @empty {
                  <li class="px-4 py-2.5 font-sans text-body-sm text-slate">No matches</li>
                }
              </ul>
            </div>
          }
        </div>

        <!-- Local number -->
        <span [class]="fieldClasses()">
          <input
            [id]="inputId()"
            [class]="inputClasses()"
            type="tel"
            inputmode="tel"
            autocomplete="tel-national"
            [placeholder]="placeholder()"
            [value]="local()"
            [disabled]="disabled()"
            [attr.aria-describedby]="describedBy()"
            [attr.aria-invalid]="invalid() || !!error() || null"
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
  /** The countries offered; the first is selected until a value says otherwise. */
  readonly countries = input<readonly Country[]>(COUNTRIES);
  /** `lg` (56px, default) or `md` (a 48px control with 14px text). */
  readonly size = input<'md' | 'lg'>('lg');
  /** Id of the number input, for an outside `<label for>`. */
  readonly inputId = input<string>(`sd-phone-${++nextId}`);
  /** Id(s) of the helper / error text describing the number input. */
  readonly describedBy = input<string | null>(null);
  /** Alert border and `aria-invalid` (an outside error is shown). */
  readonly invalid = input(false);

  /** The chosen country; null = the first of `countries()`. */
  private readonly chosen = signal<Country | null>(null);
  protected readonly current = computed(() => this.chosen() ?? this.countries()[0] ?? COUNTRIES[0]);
  protected readonly local = signal('');
  protected readonly open = signal(false);
  protected readonly disabled = signal(false);
  protected readonly filter = signal('');
  protected readonly searchable = computed(() => this.countries().length > SEARCH_FROM);

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const all = this.countries();
    if (!q) return all;
    const digits = q.replace(/[^\d]/g, '');
    return all.filter(
      (c) => c.name.toLowerCase().includes(q) || (digits !== '' && c.dialCode.slice(1).startsWith(digits)),
    );
  });

  private readonly alert = computed(() => this.invalid() || !!this.error());

  protected readonly labelClasses = computed(() =>
    this.size() === 'md' ? 'font-sans text-body-sm font-normal text-ink' : 'font-sans text-body font-semibold text-ink',
  );

  protected readonly dialClasses = computed(() =>
    this.size() === 'md' ? 'font-sans text-body-sm text-ink' : 'font-sans text-body text-ink',
  );

  protected readonly inputClasses = computed(() => {
    const size = this.size() === 'md' ? 'py-3 text-body-sm' : 'py-4 text-body';
    // md (doctor application): Slate placeholder for AA (Slate/60 is ~2.4:1); lg keeps the patient look.
    const placeholder = this.size() === 'md' ? 'placeholder:text-slate' : 'placeholder:text-slate/60';
    return (
      `w-full bg-transparent ${size} text-ink ${placeholder} focus:outline-none ` +
      'disabled:cursor-not-allowed'
    );
  });

  protected readonly triggerClasses = computed(() => {
    const border = this.alert()
      ? 'border-alert focus:border-alert focus:ring-alert/20'
      : 'border-[#b8c6d4] hover:border-slate/50 focus:border-cerulean focus:ring-cerulean/20';
    return (
      'flex h-full items-center gap-2 rounded-field border bg-white px-3 ' +
      'shadow-control transition-all duration-200 ' +
      `focus:outline-none focus:ring-2 disabled:cursor-not-allowed ${border}`
    );
  });

  protected readonly fieldClasses = computed(() => {
    const border = this.alert()
      ? 'border-alert focus-within:border-alert focus-within:ring-alert/20'
      : 'border-[#b8c6d4] hover:border-slate/50 focus-within:border-cerulean focus-within:ring-cerulean/20';
    return (
      'flex min-w-0 flex-1 items-center rounded-field border bg-white px-4 ' +
      'shadow-control transition-all duration-200 ' +
      `focus-within:ring-2 focus-within:shadow-[0_2px_10px_rgba(21,101,192,0.08)] ${border}`
    );
  });

  constructor() {
    // Focus the search box when a searchable list opens.
    effect(() => {
      if (this.open()) this.search()?.nativeElement.focus();
    });
  }

  protected toggle(): void {
    if (this.disabled()) return;
    this.filter.set('');
    this.open.update((v) => !v);
  }

  protected close(refocus = false): void {
    this.open.set(false);
    if (refocus) this.trigger()?.nativeElement.focus();
  }

  protected select(country: Country): void {
    this.chosen.set(country);
    this.close(true);
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
    this.onChange(digits ? `${this.current().dialCode}${digits}` : '');
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
    // Longest dial code first (so +234 wins over any shorter prefix); among
    // countries sharing a code, the `primary` one (a resumed +44… shows GB).
    const match = countryForNumber(raw, this.countries());
    if (match) {
      this.chosen.set(match);
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
