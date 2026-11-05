import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

let nextId = 0;

interface Option {
  value: string;
  label: string;
}

/** A row of the combobox list (the "clear" row has value ''). */
interface Row extends Option {
  /** DOM id, stable while the list is filtered (`aria-activedescendant`). */
  readonly domId: string;
}

/** Rows PageUp / PageDown move in the combobox list. */
const PAGE = 8;

/**
 * A searchable single-select dropdown (combobox). Two-way bindable and driven by
 * signals in the callers, so use the explicit form:
 * `<sd-search-select [value]="loc()" (valueChange)="loc.set($event)"
 *   [options]="locations()" placeholder="Location" icon="map-pin" />`.
 * Options may be plain strings or `{ value, label }`.
 *
 * Opt-in extras (the defaults keep the original look and behaviour):
 * - `pattern="combobox"`: the APG combobox (as `sd-time-zone-picker`). The
 *   search box is the combobox (`aria-activedescendant` on a listbox of
 *   `role="option"` rows): ↑ ↓ PageUp PageDown move, Enter picks, Esc closes
 *   back to the field (never the dialog around it), Tab / Shift+Tab close the
 *   list and move on as from the field, and focus leaving the field closes the
 *   list. A press anywhere in the list keeps focus in the search box. A letter
 *   typed on the closed field opens it searching for that letter. The search
 *   matches anywhere in the label, ignoring case; a polite status says how many
 *   match (`noOptionsText` when there are no options at all, e.g. still loading).
 * - `menu="inline"`: the list opens in the flow, pushing the content below
 *   down — for a dialog or any scrolling box, which would clip a floating list.
 * - `theme="call"`: the call cockpit's palette (its dark default and its light
 *   theme), with ≥ 3:1 field borders and AA text in both.
 * - `labelledBy`: id of a (visible or sr-only) label; the trigger reads
 *   "label, value", the search box "label, search placeholder", and the list
 *   is named by it.
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

      /* The combobox's active row (keyboard / pointer): a tint and a 2px
         cerulean ring (5.1:1), so it never relies on the tint alone. */
      .sd-ss-active {
        background-color: var(--color-glacier);
        box-shadow: inset 0 0 0 2px var(--color-cerulean);
      }

      /* theme="call": the dark cockpit (default). Text 14.0, muted 8.7, field
         border 4.4 and open / active ring 8.4 / 5.0 on the cockpit's row box;
         native parts (scrollbar) follow the cockpit. */
      .sd-ss-call {
        --ss-surface: rgb(255 255 255 / 0.05);
        --ss-text: #fcfcfc;
        --ss-muted: rgb(255 255 255 / 0.75);
        --ss-border: rgb(255 255 255 / 0.45);
        --ss-border-hover: rgb(255 255 255 / 0.65);
        --ss-focus: #6cc0ff;
        --ss-error: #ff8a80;
        --ss-menu: #1c2b3a;
        --ss-menu-border: rgb(255 255 255 / 0.15);
        --ss-divider: rgb(255 255 255 / 0.1);
        --ss-hover: rgb(255 255 255 / 0.08);
        --ss-active: rgb(255 255 255 / 0.12);
        --ss-selected: #bbdefb;
        color-scheme: dark;
      }
      /* …and the light cockpit: ink 14.4, slate 5.4, border 3.4 on white. */
      :host-context(.sd-call[data-theme='light']) .sd-ss-call {
        --ss-surface: #ffffff;
        --ss-text: #1c2b3a;
        --ss-muted: #546e7a;
        --ss-border: #78909c;
        --ss-border-hover: #546e7a;
        --ss-focus: #0b62e4;
        --ss-error: #b71c1c;
        --ss-menu: #ffffff;
        --ss-menu-border: #d9e2e6;
        --ss-divider: #eceff1;
        --ss-hover: #f1f9ff;
        --ss-active: #e3f0fd;
        --ss-selected: #0a4fbf;
        color-scheme: light;
      }
      /* Own rule (not a utility): a portal's dark-mode menu fill must not reach it. */
      .sd-ss-call .sd-menu {
        background-color: var(--ss-menu);
      }
      .sd-ss-call .sd-ss-active {
        background-color: var(--ss-active);
        box-shadow: inset 0 0 0 2px var(--ss-focus);
      }
      /* Forced colours (Windows High Contrast) drop the tint and the shadow:
         an outline survives, in the system highlight colour. */
      @media (forced-colors: active) {
        .sd-ss-active {
          outline: 2px solid Highlight;
          outline-offset: -2px;
        }
      }
    `,
  ],
  template: `
    <div [class]="rootClass()" (focusout)="onFocusOut($event)">
      <button
        #trigger
        type="button"
        [id]="inputId()"
        [class]="triggerClass()"
        [attr.aria-labelledby]="labelledBy() ? labelledBy() + ' ' + valueId() : null"
        aria-haspopup="listbox"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="combobox() && open() ? listId() : null"
        [attr.aria-describedby]="describedBy()"
        [attr.aria-invalid]="invalid() || null"
        (click)="toggle()"
        (keydown)="onTriggerKeydown($event)"
      >
        @if (icon()) {
          <sd-icon [name]="icon()!" [size]="16" class="shrink-0" [class]="t().icon" />
        }
        <span
          [attr.id]="labelledBy() ? valueId() : null"
          class="min-w-0 flex-1 truncate text-left"
          [class]="value() ? t().value : t().muted"
        >
          {{ display() }}
        </span>
        <sd-icon
          name="chevron-down"
          [size]="size() === 'field' ? 20 : 16"
          class="shrink-0 transition-transform"
          [class]="t().icon"
          [class.rotate-180]="open()"
        />
      </button>

      @if (open()) {
        <!-- click-away backdrop (the combobox puts focus back on the field) -->
        <button
          type="button"
          class="fixed inset-0 z-20 cursor-default"
          tabindex="-1"
          aria-hidden="true"
          (click)="close(combobox())"
        ></button>

        <!-- tabindex -1: a click inside (Safari does not focus clicked buttons) keeps focus in the control.
             The combobox keeps it in the search box itself, where its keys work. -->
        <div
          #menuEl
          tabindex="-1"
          [class]="menuClass()"
          (mousedown)="onMenuMousedown($event)"
          (focusin)="onMenuFocusin($event)"
        >
          <div class="flex items-center gap-2 border-b px-3 py-2" [class]="t().divider">
            <sd-icon name="search" [size]="16" class="shrink-0" [class]="t().icon" />
            <input
              #q
              type="text"
              [value]="filter()"
              (input)="onSearch($any($event.target).value)"
              (keydown)="onSearchKeydown($event)"
              [placeholder]="searchPlaceholder()"
              [attr.aria-label]="labelledBy() ? null : searchPlaceholder()"
              [attr.aria-labelledby]="labelledBy() ? labelledBy() + ' ' + searchLabelId() : null"
              [attr.role]="combobox() ? 'combobox' : null"
              [attr.aria-autocomplete]="combobox() ? 'list' : null"
              [attr.aria-expanded]="combobox() ? 'true' : null"
              [attr.aria-controls]="combobox() ? listId() : null"
              [attr.aria-activedescendant]="combobox() ? activeDomId() : null"
              [attr.autocomplete]="combobox() ? 'off' : null"
              [attr.spellcheck]="combobox() ? 'false' : null"
              [class]="searchClass()"
            />
            @if (labelledBy()) {
              <span hidden [id]="searchLabelId()">{{ searchPlaceholder() }}</span>
            }
          </div>
          @if (combobox()) {
            <!-- Focus stays in the search box (aria-activedescendant); rows only take a click.
                 tabindex -1: Chrome makes a scroller without tab stops one itself, which Tab would land in. -->
            <div
              #list
              role="listbox"
              tabindex="-1"
              [id]="listId()"
              [attr.aria-labelledby]="labelledBy()"
              [attr.aria-label]="labelledBy() ? null : placeholder()"
              class="max-h-56 overflow-y-auto"
              [class.py-1]="rows().length > 0"
            >
              @for (r of rows(); track r.domId) {
                <div
                  role="option"
                  tabindex="-1"
                  [id]="r.domId"
                  [attr.aria-selected]="r.value === value()"
                  class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left font-sans text-body-sm transition-colors focus:outline-none"
                  [class]="rowClass(r)"
                  (click)="pick(r.value)"
                  (keydown.enter)="pick(r.value)"
                  (mousemove)="active.set(r.value)"
                >
                  <span class="min-w-0 truncate">{{ r.label }}</span>
                  @if (r.value !== '' && r.value === value()) {
                    <sd-icon name="check" [size]="16" class="shrink-0" />
                  }
                </div>
              }
            </div>
            @if (filtered().length === 0) {
              <p class="px-3 py-2 font-sans text-body-sm" [class]="t().muted">
                {{ normalized().length === 0 ? noOptionsText() : 'No matches' }}
              </p>
            }
            <span class="sr-only" role="status">{{ matchStatus() }}</span>
          } @else {
            <ul role="listbox" class="max-h-56 overflow-y-auto py-1">
              @if (clearable()) {
                <li role="none">
                  <button
                    type="button"
                    role="option"
                    [attr.aria-selected]="value() === ''"
                    class="w-full px-3 py-2 text-left font-sans text-body-sm transition-colors"
                    [class]="t().muted + ' ' + t().hover"
                    (keydown.escape)="close(true)"
                    (click)="pick('')"
                  >
                    {{ placeholder() }}
                  </button>
                </li>
              }
              @for (o of filtered(); track o.value) {
                <li role="none">
                  <button
                    type="button"
                    role="option"
                    [attr.aria-selected]="o.value === value()"
                    class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-sans text-body-sm transition-colors"
                    [class]="(o.value === value() ? t().selected : t().option) + ' ' + t().hover"
                    (keydown.escape)="close(true)"
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
                <li role="none" class="px-3 py-2 font-sans text-body-sm" [class]="t().muted">
                  No matches
                </li>
              }
            </ul>
          }
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
  /**
   * 'md' (compact, default), 'lg' to match sd-input's field height in forms, or
   * 'field' for a 48px control with 14px text (the doctor application forms).
   */
  readonly size = input<'md' | 'lg' | 'field'>('md');
  readonly error = input<string>();
  /** Id of the trigger button, for an outside `<label for>`. */
  readonly inputId = input<string>(`sd-search-select-${++nextId}`);
  /** Id(s) of the helper / error text describing the trigger. */
  readonly describedBy = input<string | null>(null);
  /** Alert border and `aria-invalid` (an outside error is shown). */
  readonly invalid = input(false);
  /**
   * `menu` (default): a search box over option buttons (Tab moves through
   * them). `combobox`: the APG combobox (see the class comment).
   */
  readonly pattern = input<'menu' | 'combobox'>('menu');
  /**
   * `overlay` (default) floats the list over the content below. `inline` opens
   * it in the flow, pushing that content down: use it inside a dialog or any
   * scrolling box, which would otherwise clip a floating list to its own height.
   */
  readonly menu = input<'overlay' | 'inline'>('overlay');
  /** `light` (default; a portal's dark mode re-points it) or `call` (the call cockpit). */
  readonly theme = input<'light' | 'call'>('light');
  /** Id of the element that labels the field: the trigger reads "label, value". */
  readonly labelledBy = input<string | null>(null);
  /** Combobox: shown (and announced) in the list when there are no options at all, e.g. still loading. */
  readonly noOptionsText = input('No options');

  private readonly injector = inject(Injector);
  protected readonly open = signal(false);
  protected readonly combobox = computed(() => this.pattern() === 'combobox');
  protected readonly valueId = computed(() => `${this.inputId()}-value`);
  protected readonly listId = computed(() => `${this.inputId()}-list`);
  protected readonly searchLabelId = computed(() => `${this.inputId()}-search-label`);

  /** Colour classes: `light` is the original look (the portal's dark mode re-points it). */
  protected readonly t = computed(() =>
    this.theme() === 'call'
      ? {
          icon: 'text-(--ss-muted)',
          value: 'text-(--ss-text)',
          muted: 'text-(--ss-muted)',
          divider: 'border-(--ss-divider)',
          option: 'text-(--ss-text)',
          selected: 'text-(--ss-selected)',
          hover: 'hover:bg-(--ss-hover)',
        }
      : {
          icon: 'text-slate',
          value: 'text-ink',
          muted: 'text-slate',
          divider: 'border-cloud',
          option: 'text-ink',
          selected: 'text-cerulean',
          hover: 'hover:bg-glacier',
        },
  );

  protected readonly rootClass = computed(() => (this.theme() === 'call' ? 'sd-ss-call relative' : 'relative'));

  /**
   * Trigger button classes. Matches sd-input's field treatment: soft base
   * shadow, cerulean focus ring when open, alert ring on error.
   */
  protected readonly triggerClass = computed(() => {
    const size =
      this.size() === 'lg'
        ? 'px-4 py-4 text-body'
        : this.size() === 'field'
          ? 'px-4 py-3 text-body-sm'
          : 'px-4 py-2.5 text-body-sm';
    if (this.theme() === 'call') {
      const state =
        this.error() || this.invalid()
          ? 'border-(--ss-error) ring-2 ring-(--ss-error)/25'
          : this.open()
            ? 'border-(--ss-focus) ring-2 ring-(--ss-focus)/30'
            : 'border-(--ss-border) hover:border-(--ss-border-hover)';
      return (
        'flex w-full items-center gap-2 rounded-field border bg-(--ss-surface) font-sans ' +
        'transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ss-focus) ' +
        `${size} ${state}`
      );
    }
    // `shadow-control` sits on the resting states (not the base) because a
    // named shadow utility sorts after an arbitrary one and would hide the
    // open-state focus glow.
    const state = this.error() || this.invalid()
      ? 'border-alert ring-2 ring-alert/20 shadow-control'
      : this.open()
        ? 'border-cerulean ring-2 ring-cerulean/20 shadow-[0_2px_10px_rgba(21,101,192,0.08)]'
        : 'border-[#b8c6d4] hover:border-slate/50 shadow-control';
    return (
      'flex w-full items-center gap-2 rounded-field border bg-white font-sans ' +
      'transition-all duration-200 ' +
      `${size} ${state}`
    );
  });

  protected readonly menuClass = computed(() => {
    const place = this.menu() === 'inline' ? 'relative' : 'absolute left-0 right-0';
    const look =
      this.theme() === 'call' ? 'border-(--ss-menu-border) shadow-overlay' : 'border-haze bg-white shadow-overlay';
    return `sd-menu ${place} z-30 mt-2 min-w-[200px] overflow-hidden rounded-card border ${look} focus:outline-none`;
  });

  /** The search box: 'field' (doctor application) uses a Slate placeholder for AA; the others keep Slate/60. */
  protected readonly searchClass = computed(() =>
    this.theme() === 'call'
      ? 'w-full bg-transparent font-sans text-body-sm text-(--ss-text) placeholder:text-(--ss-muted) focus:outline-none'
      : 'w-full bg-transparent font-sans text-body-sm text-ink focus:outline-none ' +
        (this.size() === 'field' ? 'placeholder:text-slate' : 'placeholder:text-slate/60'),
  );
  protected readonly filter = signal('');
  /** The combobox's active row (its value), or null. */
  protected readonly active = signal<string | null>(null);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('q');
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly menuEl = viewChild<ElementRef<HTMLElement>>('menuEl');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  protected readonly normalized = computed<Option[]>(() =>
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

  /** The combobox list: the "clear" row (when clearable), then the matches. */
  protected readonly rows = computed<Row[]>(() => {
    const list = this.listId();
    const index = new Map(this.normalized().map((o, i) => [o.value, i]));
    const rows: Row[] = this.filtered().map((o) => ({ ...o, domId: `${list}-${index.get(o.value)}` }));
    return this.clearable() ? [{ value: '', label: this.placeholder(), domId: `${list}-none` }, ...rows] : rows;
  });

  /**
   * The row ↓ ↑ Enter act on: the active row while it is listed, else the
   * starting row (the options arrived, or changed, with the list open).
   */
  protected readonly current = computed(() => {
    const a = this.active();
    if (a !== null && this.rows().some((r) => r.value === a)) return a;
    return this.startRow(this.filter())?.value ?? null;
  });

  protected readonly activeDomId = computed(() => {
    const a = this.current();
    return a === null ? null : (this.rows().find((r) => r.value === a)?.domId ?? null);
  });

  /** Announced politely while searching: how many options match (or that there are none at all). */
  protected readonly matchStatus = computed(() => {
    if (this.normalized().length === 0) return this.noOptionsText();
    if (this.filter().trim() === '') return '';
    const n = this.filtered().length;
    return n === 0 ? 'No matches' : n === 1 ? '1 match' : `${n} matches`;
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

  protected rowClass(r: Row): string {
    const t = this.t();
    const look = r.value === '' ? t.muted : r.value === this.value() ? t.selected : t.option;
    return `${look} ${t.hover}${r.value === this.current() ? ' sd-ss-active' : ''}`;
  }

  protected toggle(): void {
    if (this.combobox()) {
      if (this.open()) this.close(true);
      else this.openMenu('');
      return;
    }
    this.open.update((v) => !v);
    if (this.open()) this.filter.set('');
  }

  protected close(refocus = false): void {
    this.open.set(false);
    if (refocus) this.trigger()?.nativeElement.focus();
  }

  protected pick(value: string): void {
    this.value.set(value);
    this.close(true);
  }

  protected onSearch(text: string): void {
    this.filter.set(text);
    if (this.combobox()) this.setActive(this.filtered()[0]?.value ?? null);
  }

  /** Closed combobox: ↓ / ↑ open it; a letter opens it searching for that letter. */
  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (!this.combobox() || this.open()) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.openMenu('');
    } else if (
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      this.openMenu(event.key);
    }
  }

  protected onSearchKeydown(event: KeyboardEvent): void {
    if (!this.combobox()) {
      if (event.key === 'Escape') this.close(true);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) this.close(true);
        else this.move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        this.move(PAGE);
        break;
      case 'PageUp':
        event.preventDefault();
        this.move(-PAGE);
        break;
      case 'Enter': {
        if (event.isComposing) return;
        // Never the form or dialog around the field.
        event.preventDefault();
        event.stopPropagation();
        const a = this.current();
        if (a !== null) this.pick(a);
        break;
      }
      case 'Escape':
        // Closes just the list: the dialog around the field ignores a handled Esc.
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
        break;
      case 'Tab':
        // The browser moves on as from the field (APG; nothing picked): forward
        // past the list (no tab stops in it), back from the trigger. Focus
        // leaving the field then closes the list (onFocusOut) — not here, as
        // removing the focused box first would drop focus to the page.
        if (event.shiftKey) this.trigger()?.nativeElement.focus();
        break;
    }
  }

  /** Combobox: a press in the list (icon, padding, a row, "No matches") leaves focus in the search box. */
  protected onMenuMousedown(event: MouseEvent): void {
    if (this.combobox() && event.target !== this.searchInput()?.nativeElement) event.preventDefault();
  }

  /** Combobox: focus landing elsewhere in the list (AT, touch) goes back to the search box, where its keys work. */
  protected onMenuFocusin(event: FocusEvent): void {
    const box = this.searchInput()?.nativeElement;
    if (this.combobox() && box && event.target !== box) box.focus();
  }

  /** Focus left the field (combobox): close the list, leaving focus where it went. */
  protected onFocusOut(event: FocusEvent): void {
    if (!this.combobox() || !this.open()) return;
    const next = event.relatedTarget as Node | null;
    const root = event.currentTarget as HTMLElement;
    if (next && root.contains(next)) return;
    this.close(false);
  }

  private openMenu(query: string): void {
    this.filter.set(query);
    this.open.set(true);
    this.active.set(this.startRow(query)?.value ?? null);
    afterNextRender(
      () => {
        const box = this.searchInput()?.nativeElement;
        box?.focus();
        box?.setSelectionRange(query.length, query.length);
        // Inline: bring the whole list into the scrolling box (dialog body).
        if (this.menu() === 'inline') this.menuEl()?.nativeElement.scrollIntoView?.({ block: 'nearest' });
        this.scrollActiveIntoView();
      },
      { injector: this.injector },
    );
  }

  /** Start on the chosen option, else the first (the first match when searching). */
  private startRow(query: string): Option | undefined {
    const options = this.filtered();
    const v = this.value();
    return query.trim() === '' ? (options.find((o) => o.value === v) ?? options[0]) : options[0];
  }

  private move(delta: number): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.value === this.current());
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(Math.max(at + delta, 0), rows.length - 1);
    this.setActive(rows[next].value);
  }

  private setActive(value: string | null): void {
    this.active.set(value);
    afterNextRender(() => this.scrollActiveIntoView(), { injector: this.injector });
  }

  private scrollActiveIntoView(): void {
    const id = this.activeDomId();
    const el = id ? this.list()?.nativeElement.ownerDocument.getElementById(id) : null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }
}
