import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

interface Option {
  value: string;
  label: string;
}

/**
 * A searchable single-select dropdown (combobox). Two-way bindable and driven by
 * signals in the callers, so use the explicit form:
 * `<sd-search-select [value]="loc()" (valueChange)="loc.set($event)"
 *   [options]="locations()" placeholder="Location" icon="map-pin" />`.
 * Options may be plain strings or `{ value, label }`.
 */
@Component({
  selector: 'sd-search-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  styles: [
    `
      @keyframes sdMenuIn {
        from {
          opacity: 0;
          transform: translateY(-4px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      .sd-menu {
        transform-origin: top;
        animation: sdMenuIn 0.15s ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .sd-menu {
          animation: none;
        }
      }
    `,
  ],
  template: `
    <div class="relative">
      <button
        type="button"
        [class]="triggerClass()"
        (click)="toggle()"
      >
        @if (icon()) {
          <sd-icon [name]="icon()!" [size]="16" class="shrink-0 text-slate" />
        }
        <span
          class="min-w-0 flex-1 truncate text-left"
          [class]="value() ? 'text-ink' : 'text-slate'"
        >
          {{ display() }}
        </span>
        <sd-icon
          name="chevron-down"
          [size]="16"
          class="shrink-0 text-slate transition-transform"
          [class.rotate-180]="open()"
        />
      </button>

      @if (open()) {
        <!-- click-away backdrop -->
        <button
          type="button"
          class="fixed inset-0 z-20 cursor-default"
          tabindex="-1"
          aria-hidden="true"
          (click)="close()"
        ></button>

        <div
          class="sd-menu absolute left-0 right-0 z-30 mt-2 min-w-[200px] overflow-hidden rounded-card border border-cloud bg-white shadow-[0_12px_32px_rgba(10,22,40,0.12)] ring-1 ring-black/5"
        >
          <div class="flex items-center gap-2 border-b border-cloud px-3 py-2">
            <sd-icon name="search" [size]="16" class="shrink-0 text-slate" />
            <input
              #q
              type="text"
              [value]="filter()"
              (input)="filter.set($any($event.target).value)"
              (keydown.escape)="close()"
              [placeholder]="searchPlaceholder()"
              class="w-full bg-transparent font-sans text-body-sm text-ink placeholder:text-slate/60 focus:outline-none"
            />
          </div>
          <ul class="max-h-56 overflow-y-auto py-1">
            @if (clearable()) {
              <li>
                <button
                  type="button"
                  class="w-full px-3 py-2 text-left font-sans text-body-sm text-slate transition-colors hover:bg-glacier"
                  (click)="pick('')"
                >
                  {{ placeholder() }}
                </button>
              </li>
            }
            @for (o of filtered(); track o.value) {
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-sans text-body-sm transition-colors hover:bg-glacier"
                  [class]="o.value === value() ? 'text-cerulean' : 'text-ink'"
                  (click)="pick(o.value)"
                >
                  <span class="truncate">{{ o.label }}</span>
                  @if (o.value === value()) {
                    <sd-icon name="check" [size]="16" class="shrink-0" />
                  }
                </button>
              </li>
            }
            @if (filtered().length === 0) {
              <li class="px-3 py-2 font-sans text-body-sm text-slate">
                No matches
              </li>
            }
          </ul>
        </div>
      }
      @if (error()) {
        <span class="mt-1 block font-label text-caption text-alert">{{
          error()
        }}</span>
      }
    </div>
  `,
})
export class SearchSelectComponent {
  readonly value = model('');
  readonly options = input<readonly (string | Option)[]>([]);
  readonly placeholder = input('Select');
  readonly searchPlaceholder = input('Search…');
  readonly icon = input<string | undefined>(undefined);
  readonly clearable = input(true);
  /** 'md' (compact, default) or 'lg' to match sd-input's field height in forms. */
  readonly size = input<'md' | 'lg'>('md');
  readonly error = input<string>();

  protected readonly open = signal(false);

  /**
   * Trigger button classes. Matches sd-input's field treatment: soft base
   * shadow, cerulean focus ring when open, alert ring on error.
   */
  protected readonly triggerClass = computed(() => {
    const size =
      this.size() === 'lg' ? 'px-4 py-4 text-body' : 'px-4 py-2.5 text-body-sm';
    const state = this.error()
      ? 'border-alert ring-2 ring-alert/20'
      : this.open()
        ? 'border-cerulean ring-2 ring-cerulean/20 shadow-[0_2px_10px_rgba(21,101,192,0.08)]'
        : 'border-cloud hover:border-slate/40';
    return (
      'flex w-full items-center gap-2 rounded-field border bg-white font-sans ' +
      'shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 ' +
      `${size} ${state}`
    );
  });
  protected readonly filter = signal('');
  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>('q');

  private readonly normalized = computed<Option[]>(() =>
    this.options().map((o) =>
      typeof o === 'string' ? { value: o, label: o } : o,
    ),
  );

  protected readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const all = this.normalized();
    return q === ''
      ? all
      : all.filter((o) => o.label.toLowerCase().includes(q));
  });

  protected readonly display = computed(
    () =>
      this.normalized().find((o) => o.value === this.value())?.label ??
      this.placeholder(),
  );

  constructor() {
    // Focus the search box when the menu opens.
    effect(() => {
      if (this.open()) this.searchInput()?.nativeElement.focus();
    });
  }

  protected toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) this.filter.set('');
  }

  protected close(): void {
    this.open.set(false);
  }

  protected pick(value: string): void {
    this.value.set(value);
    this.close();
  }
}
