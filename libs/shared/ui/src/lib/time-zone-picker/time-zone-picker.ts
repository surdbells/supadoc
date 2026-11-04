import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import {
  CLINIC_TIME_ZONE,
  detectTimeZone,
  isValidTimeZone,
  ZONE_ABBR,
  zoneOptionLabel,
} from '@supadoc/data-access';
import { IconComponent } from '../icon/icon';

/** Suggested after the detected zone, in this order. */
export const SUGGESTED_TIME_ZONES: readonly string[] = [
  CLINIC_TIME_ZONE,
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
];

/** When the browser can't list its zones: the shared table plus a few common ones. */
const FALLBACK_ZONES: readonly string[] = [
  ...Object.keys(ZONE_ABBR),
  'Asia/Dubai',
  'Asia/Riyadh',
  'Australia/Sydney',
  'America/Sao_Paulo',
  'UTC',
];

/** Every zone this browser knows (IANA order), plus UTC; the fallback list when it can't say. */
export function availableTimeZones(): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
    if (!zones.length) throw new Error('empty');
  } catch {
    zones = [...FALLBACK_ZONES];
  }
  return zones.includes('UTC') ? [...zones] : [...zones, 'UTC'];
}

interface ZoneOption {
  /** Unique per list (a zone can be both suggested and listed). */
  readonly key: string;
  readonly domId: string;
  readonly value: string;
  readonly label: string;
  /** Lower-cased label + the IANA name with spaces, for search. */
  readonly haystack: string;
}

interface ZoneGroup {
  readonly key: string;
  readonly label: string;
  readonly options: readonly ZoneOption[];
}

let nextId = 0;

/**
 * Choose an IANA time zone: a labelled combobox in the `sd-search-select`
 * look (same field, menu and option classes, so the patient app's dark-mode
 * guards apply), with a "Suggested" group first — "Detected on this device"
 * (when detectable), West Africa Time, the main US zones and London — then
 * every zone the browser lists. Options read "Central Time — America/Chicago
 * (CST)"; the search matches the IANA name, the long name and the
 * abbreviation. The current `value` and the detected zone are always offered,
 * even when the browser lists them under another spelling (Asia/Kolkata vs
 * Asia/Calcutta).
 *
 * `theme="call"` uses the call cockpit's dark vocabulary (re-pointed by the
 * light cockpit in theme.css). Two-way: `[(value)]`.
 */
@Component({
  selector: 'sd-time-zone-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  // `id` is the trigger's: never leave it on the host too (duplicate ids).
  host: { class: 'block', '[attr.id]': 'null' },
  styles: [
    `
      @keyframes sdTzMenuIn {
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
        animation: sdTzMenuIn 0.15s ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .sd-menu {
          animation: none;
        }
      }
    `,
  ],
  template: `
    <label [id]="labelId()" [for]="id()" class="mb-2 block font-sans text-body-sm font-semibold" [class]="t().label">{{
      label()
    }}</label>
    <div class="relative">
      <!-- Named by the label AND the chosen zone, so both are announced. -->
      <button
        #trigger
        type="button"
        [id]="id()"
        [class]="triggerClass()"
        [attr.aria-labelledby]="labelId() + ' ' + valueId()"
        aria-haspopup="listbox"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="open() ? listId : null"
        [attr.aria-describedby]="describedBy()"
        [attr.aria-invalid]="invalid() ? true : null"
        (click)="toggle()"
        (keydown)="onTriggerKeydown($event)"
      >
        <sd-icon name="globe" [size]="16" class="shrink-0" [class]="t().icon" />
        <span [id]="valueId()" class="min-w-0 flex-1 truncate text-left" [class]="value() ? t().text : t().muted">{{
          display()
        }}</span>
        <sd-icon name="chevron-down" [size]="16" class="shrink-0 transition-transform" [class]="t().icon" [class.rotate-180]="open()" />
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

        <!-- tabindex -1: a click inside (Safari does not focus clicked buttons) keeps focus in the control. -->
        <div tabindex="-1" data-testid="tz-menu" [class]="menuClass()">
          <div class="flex items-center gap-2 border-b px-3 py-2" [class]="t().divider">
            <sd-icon name="search" [size]="16" class="shrink-0" [class]="t().icon" />
            <input
              #search
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              [attr.aria-controls]="listId"
              [attr.aria-activedescendant]="activeDomId()"
              aria-label="Search time zones"
              placeholder="Search by city, name or abbreviation"
              autocomplete="off"
              spellcheck="false"
              class="w-full bg-transparent font-sans text-body-sm focus:outline-none"
              [class]="t().search"
              [value]="query()"
              (input)="onSearch($any($event.target).value)"
              (keydown)="onSearchKeydown($event)"
            />
          </div>
          <div #list role="listbox" [id]="listId" [attr.aria-label]="label()" class="max-h-64 overflow-y-auto py-1">
            @for (g of groups(); track g.key) {
              <div role="group" [attr.aria-label]="g.label">
                <div class="px-3 pb-1 pt-2 font-sans text-caption font-semibold" [class]="t().muted" aria-hidden="true">
                  {{ g.label }}
                </div>
                @for (o of g.options; track o.key) {
                  <!-- Focus stays in the search box (aria-activedescendant); tabindex -1 only takes a click. -->
                  <div
                    role="option"
                    tabindex="-1"
                    [id]="o.domId"
                    [attr.aria-selected]="o.value === value()"
                    class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 font-sans text-body-sm transition-colors focus:outline-none"
                    [class]="optionClass(o)"
                    (click)="pick(o.value)"
                    (keydown.enter)="pick(o.value)"
                    (mousemove)="activeKey.set(o.key)"
                  >
                    <span class="min-w-0 truncate">{{ o.label }}</span>
                    @if (o.value === value()) {
                      <sd-icon name="check" [size]="16" class="shrink-0" />
                    }
                  </div>
                }
              </div>
            }
            @if (!groups().length) {
              <div class="px-3 py-2 font-sans text-body-sm" [class]="t().muted">No matching time zones</div>
            }
          </div>
        </div>
      }
    </div>
    @if (hint()) {
      <p [id]="hintId()" class="mt-1.5 font-sans text-caption" [class]="t().muted">{{ hint() }}</p>
    }
    @if (invalid()) {
      <p [id]="errorId()" class="mt-1 flex items-center gap-1 font-label text-caption" [class]="t().error">
        <sd-icon name="circle-alert" [size]="14" class="shrink-0" [class]="t().errorIcon" />
        {{ invalid() }}
      </p>
    }
  `,
})
export class TimeZonePickerComponent {
  /** The chosen IANA zone (null: none yet). Two-way: `[(value)]`. */
  readonly value = model<string | null>(null);
  readonly label = input.required<string>();
  readonly hint = input<string | undefined>(undefined);
  /** Id of the trigger (the `<label for>` target). */
  readonly id = input.required<string>();
  /** An error message to show (and mark the field invalid). */
  readonly invalid = input<string | null | undefined>(null);
  /** `light` (forms, default) or `call` (inside a call cockpit). */
  readonly theme = input<'light' | 'call'>('light');
  /**
   * `overlay` (default) floats the list over the content below. `inline` opens
   * it in the flow, pushing that content down: use it inside a dialog or any
   * scrolling box, which would otherwise clip a floating list to its own height.
   */
  readonly menu = input<'overlay' | 'inline'>('overlay');

  private readonly injector = inject(Injector);
  protected readonly listId = `sd-tz-${++nextId}-list`;
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly activeKey = signal<string | null>(null);
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  /** The device's zone when it can be trusted (never UTC behind a VPN). */
  private readonly detected = detectTimeZone();
  /** Built on first open (labels for ~420 zones), then reused. */
  private zonesCache: string[] | null = null;
  private readonly labels = new Map<string, string>();

  protected readonly labelId = computed(() => `${this.id()}-label`);
  protected readonly valueId = computed(() => `${this.id()}-value`);
  protected readonly hintId = computed(() => `${this.id()}-hint`);
  protected readonly errorId = computed(() => `${this.id()}-error`);
  protected readonly describedBy = computed(
    () => [this.hint() ? this.hintId() : null, this.invalid() ? this.errorId() : null].filter(Boolean).join(' ') || null,
  );

  protected readonly menuClass = computed(
    () =>
      'sd-menu z-30 mt-2 min-w-[240px] overflow-hidden rounded-card border focus:outline-none ' +
      (this.menu() === 'inline' ? 'relative' : 'absolute left-0 right-0') +
      ' ' +
      this.t().menu,
  );

  protected readonly display = computed(() => {
    const v = this.value();
    return v ? this.labelFor(v) : 'Choose a time zone';
  });

  protected readonly t = computed(() =>
    this.theme() === 'call'
      ? {
          label: 'text-white',
          text: 'text-white',
          muted: 'text-white/70',
          icon: 'text-white/70',
          menu: 'border-white/10 bg-ink shadow-overlay',
          divider: 'border-white/10',
          search: 'text-white placeholder:text-white/60',
          option: 'text-white hover:bg-white/10',
          active: 'bg-white/10',
          selected: 'text-frost',
          error: 'text-white/85',
          errorIcon: 'text-alert',
        }
      : {
          label: 'text-ink',
          text: 'text-ink',
          muted: 'text-slate',
          icon: 'text-slate',
          menu: 'border-haze bg-white shadow-overlay',
          divider: 'border-cloud',
          search: 'text-ink placeholder:text-slate',
          option: 'text-ink hover:bg-glacier',
          active: 'bg-glacier',
          selected: 'text-cerulean',
          error: 'text-alert-ink',
          errorIcon: 'text-alert-ink',
        },
  );

  protected readonly triggerClass = computed(() => {
    const call = this.theme() === 'call';
    const state = this.invalid()
      ? 'border-alert ring-2 ring-alert/20'
      : this.open()
        ? 'border-cerulean ring-2 ring-cerulean/20'
        : call
          ? 'border-white/15 hover:border-white/30'
          : 'border-[#b8c6d4] hover:border-slate/50 shadow-control';
    const surface = call ? 'bg-white/[0.04] text-white' : 'bg-white';
    return `flex min-h-12 w-full items-center gap-2 rounded-field border px-4 py-3 font-sans text-body-sm transition-all duration-200 ${surface} ${state}`;
  });

  /** Suggested first, then every zone; both filtered by the search. */
  protected readonly groups = computed<readonly ZoneGroup[]>(() => {
    if (!this.open()) return [];
    const terms = this.query().trim().toLowerCase().replace(/_/g, ' ').split(/\s+/).filter(Boolean);
    const matches = (o: ZoneOption) => terms.every((t) => o.haystack.includes(t));
    const suggested: ZoneOption[] = [];
    const seen = new Set<string>();
    if (this.detected) {
      suggested.push(this.option('s', 0, this.detected, `Detected on this device · ${this.labelFor(this.detected)}`));
      seen.add(this.detected);
    }
    for (const tz of SUGGESTED_TIME_ZONES) {
      if (!seen.has(tz) && isValidTimeZone(tz)) {
        suggested.push(this.option('s', suggested.length, tz, this.labelFor(tz)));
        seen.add(tz);
      }
    }
    const all = this.zones().map((tz, i) => this.option('a', i, tz, this.labelFor(tz)));
    return [
      { key: 'suggested', label: 'Suggested', options: suggested.filter(matches) },
      { key: 'all', label: 'All time zones', options: all.filter(matches) },
    ].filter((g) => g.options.length > 0);
  });

  private readonly flat = computed(() => this.groups().flatMap((g) => g.options));

  protected readonly activeDomId = computed(() => {
    const key = this.activeKey();
    return this.flat().find((o) => o.key === key)?.domId ?? null;
  });

  protected optionClass(o: ZoneOption): string {
    const t = this.t();
    const active = o.key === this.activeKey() ? ` ${t.active}` : '';
    return (o.value === this.value() ? t.selected : t.option) + active;
  }

  protected toggle(): void {
    if (this.open()) this.close(true);
    else this.openMenu();
  }

  protected close(refocus = false): void {
    this.open.set(false);
    if (refocus) this.trigger()?.nativeElement.focus();
  }

  protected pick(value: string): void {
    this.value.set(value);
    this.close(true);
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !this.open()) {
      event.preventDefault();
      this.openMenu();
    }
  }

  protected onSearch(text: string): void {
    this.query.set(text);
    this.activeKey.set(this.flat()[0]?.key ?? null);
  }

  protected onSearchKeydown(event: KeyboardEvent): void {
    const options = this.flat();
    const at = options.findIndex((o) => o.key === this.activeKey());
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.setActive(options[at < 0 ? 0 : Math.min(at + 1, options.length - 1)]);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.setActive(options[at <= 0 ? 0 : at - 1]);
        break;
      case 'PageDown':
        event.preventDefault();
        this.setActive(options[Math.min((at < 0 ? 0 : at) + 8, options.length - 1)]);
        break;
      case 'PageUp':
        event.preventDefault();
        this.setActive(options[Math.max((at < 0 ? 0 : at) - 8, 0)]);
        break;
      case 'Enter':
        event.preventDefault();
        if (at >= 0) this.pick(options[at].value);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
        break;
      case 'Tab':
        // Back to the field (focus would otherwise drop to the page as the popup closes).
        event.preventDefault();
        this.close(true);
        break;
    }
  }

  private openMenu(): void {
    this.query.set('');
    this.open.set(true);
    // Start on the chosen zone (in the full list, where it sits among its neighbours).
    const v = this.value();
    const options = this.flat();
    const start = (v && (options.find((o) => o.key.startsWith('a:') && o.value === v) ?? options.find((o) => o.value === v))) || options[0];
    this.activeKey.set(start?.key ?? null);
    afterNextRender(
      () => {
        this.searchBox()?.nativeElement.focus();
        this.scrollActiveIntoView();
      },
      { injector: this.injector },
    );
  }

  private setActive(o: ZoneOption | undefined): void {
    if (!o) return;
    this.activeKey.set(o.key);
    afterNextRender(() => this.scrollActiveIntoView(), { injector: this.injector });
  }

  private scrollActiveIntoView(): void {
    const id = this.activeDomId();
    const el = id ? this.list()?.nativeElement.querySelector<HTMLElement>(`#${id}`) : null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }

  /** The browser's zones, plus the current value and the detected zone when it spells them differently. */
  private zones(): string[] {
    if (!this.zonesCache) this.zonesCache = availableTimeZones();
    const out = this.zonesCache;
    const extra = [this.value(), this.detected].filter((tz): tz is string => isValidTimeZone(tz) && !out.includes(tz));
    return extra.length ? [...out, ...extra].sort((a, b) => a.localeCompare(b)) : out;
  }

  private labelFor(tz: string): string {
    let label = this.labels.get(tz);
    if (!label) {
      label = zoneOptionLabel(tz);
      this.labels.set(tz, label);
    }
    return label;
  }

  private option(prefix: 's' | 'a', index: number, tz: string, label: string): ZoneOption {
    const key = `${prefix}:${tz}`;
    return {
      key,
      domId: `${this.listId}-${prefix}${index}`,
      value: tz,
      label,
      haystack: `${label} ${tz.replace(/_/g, ' ')}`.toLowerCase(),
    };
  }
}
