import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

/** The call dock's controls. */
export type CallControlId = 'mic' | 'cam' | 'share' | 'captions' | 'record' | 'documents' | 'more' | 'end';

/** One control of the dock's control bar. */
export interface CallControl {
  id: CallControlId;
  /** Visible text == the start of the accessible name (WCAG 2.5.3); constant for aria-pressed toggles. */
  label: string;
  /** Only to extend the label, e.g. 'End call' for label 'End'. */
  ariaLabel?: string;
  /** An `sd-icon` name. */
  icon: string;
  /** Circle colour: default white/10 · active sky · off / danger alert. */
  tone?: 'default' | 'active' | 'off' | 'danger';
  /**
   * `aria-pressed`, for true toggles only (share, captions, record). The label
   * never changes while this is set ("Record" stays "Record").
   */
  pressed?: boolean | null;
  /** A count shown as a pill; the name becomes "{label}, {n} new". */
  badge?: number | null;
  /** Dimmed but still focusable (`aria-disabled`); pressing shows `reason`. */
  disabled?: boolean;
  /** Why it is disabled: announced as its description, and shown for 6 s when pressed (never a `title`). */
  reason?: string | null;
  hidden?: boolean;
  /** Moves into the More menu while the bar is compact (needs a `more` control). */
  overflow?: 'menu';
}

/**
 * One More-menu item. `checked` true / false makes it a `menuitemradio` (with
 * a `group`) or a `menuitemcheckbox`; null / absent a plain `menuitem`.
 */
export interface CallMenuItem {
  id: string;
  label: string;
  icon?: string;
  checked?: boolean | null;
  group?: string;
  description?: string | null;
}

/** Below this size (inline; block size in a rail) the bar is compact and overflow controls move into More. */
export const CALL_BAR_COMPACT_PX = 352;
/** How long a disabled control's reason stays on screen. */
export const CALL_CONTROL_REASON_MS = 6_000;

type MenuRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';

interface ControlView {
  readonly c: CallControl;
  readonly name: string;
  readonly badge: number;
  /** The reason's id, for `aria-describedby`. */
  readonly reasonId: string | null;
  readonly align: 'start' | 'center' | 'end';
}

interface MenuEntry {
  readonly key: string;
  readonly kind: 'control' | 'item';
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly icon: string | null;
  readonly role: MenuRole;
  readonly checked: boolean;
  readonly description: string | null;
  readonly descriptionId: string | null;
  readonly disabled: boolean;
  readonly badge: number;
}

interface MenuSection {
  readonly key: string;
  readonly group: string | null;
  readonly entries: readonly MenuEntry[];
}

const TONES: Record<NonNullable<CallControl['tone']>, string> = {
  default: 'bg-white/10 group-hover:bg-white/20',
  active: 'bg-sky',
  off: 'bg-alert group-hover:bg-alert/85',
  danger: 'bg-alert group-hover:bg-alert/85',
};

let nextId = 0;

function badgeName(base: string, badge: number): string {
  return badge > 0 ? `${base}, ${badge} new` : base;
}

function nextFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

/**
 * The call dock's control bar — a WAI-ARIA APG toolbar under the video (never
 * over it). Round 44px buttons with their label below (`text-white/80`;
 * visible once the bar's `callbar` container is 34rem wide, else `sr-only`,
 * so the accessible name never changes). Roving tabindex: Left / Right (Up /
 * Down in a rail), Home, End.
 *
 * Under 22rem the bar is compact: controls marked `overflow: 'menu'` leave it
 * and become the first More-menu items (a `menuitemcheckbox` when they have
 * `pressed`), their badges added to More's. Choosing one emits `pressed` with
 * its id, as the button would. More opens a `role="menu"` above the bar (below
 * in a rail): arrow keys, Home / End, Esc closes and returns focus to More, a
 * click outside closes it; plain items emit `menuSelect`.
 *
 * A disabled control stays focusable (`aria-disabled`) with its `reason` as
 * its description; pressing it shows the reason for 6 s in a `role="status"`
 * bubble. Put the bar in an inline-size container named `callbar`:
 * `<div class="min-w-0 flex-1 [container-name:callbar] [container-type:inline-size]">`.
 */
@Component({
  selector: 'sd-call-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'relative block',
    '[class.h-full]': "layout() === 'rail'",
    '(document:click)': 'onDocumentClick($event)',
  },
  template: `
    <div
      role="toolbar"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-orientation]="layout() === 'rail' ? 'vertical' : 'horizontal'"
      class="flex justify-center"
      [class]="layout() === 'rail' ? 'h-full flex-col items-center gap-2' : 'items-start gap-1.5 sm:gap-3'"
    >
      @for (v of bar(); track v.c.id; let i = $index) {
        <div class="relative flex flex-col items-center">
          <button
            type="button"
            class="group flex min-w-11 flex-col items-center gap-1 rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
            [class.cursor-not-allowed]="v.c.disabled"
            [id]="buttonId(v.c.id)"
            [attr.data-control]="v.c.id"
            [tabIndex]="v.c.id === activeControl() ? 0 : -1"
            [attr.aria-label]="v.name"
            [attr.aria-pressed]="isToggle(v.c) ? !!v.c.pressed : null"
            [attr.aria-disabled]="v.c.disabled ? true : null"
            [attr.aria-describedby]="v.reasonId"
            [attr.aria-haspopup]="v.c.id === 'more' ? 'menu' : null"
            [attr.aria-expanded]="v.c.id === 'more' ? menuOpen() : null"
            [attr.aria-controls]="v.c.id === 'more' && menuOpen() ? menuId : null"
            (click)="press(v.c)"
            (keydown)="onBarKeydown($event)"
            (focus)="activeId.set(v.c.id)"
          >
            <span
              class="relative flex size-11 items-center justify-center rounded-full text-white transition-colors motion-reduce:transition-none"
              [class]="circleClass(v.c)"
              aria-hidden="true"
            >
              <sd-icon [name]="v.c.icon" [size]="20" />
              @if (v.badge > 0) {
                <span
                  class="absolute -right-1 -top-1 min-w-5 rounded-pill bg-cerulean px-1 text-center font-sans text-caption font-semibold text-white"
                  >{{ badgeText(v.badge) }}</span
                >
              }
            </span>
            <!-- not-sr-only resets white-space, so the no-wrap lives on the inner span. -->
            <span
              class="font-sans text-caption text-white/80"
              [class]="showLabels() === 'never' ? 'sr-only' : 'sr-only callbar:not-sr-only'"
              aria-hidden="true"
              ><span class="whitespace-nowrap">{{ v.c.label }}</span></span
            >
          </button>
          @if (v.reasonId) {
            <span [id]="v.reasonId" class="sr-only">{{ v.c.reason }}</span>
          }
          <!-- Pressing a disabled control (or a disabled item from More) shows why. -->
          <span role="status" [class]="bubbleClass(v)">{{ reasonText(v.c.id) }}</span>

          @if (v.c.id === 'more' && menuOpen()) {
            <div
              role="menu"
              tabindex="-1"
              [id]="menuId"
              [attr.aria-labelledby]="buttonId('more')"
              class="absolute right-0 z-40 flex w-max min-w-56 max-w-[min(20rem,calc(100vw-1.5rem))] flex-col rounded-card border border-white/10 bg-ink p-1 text-left shadow-overlay focus:outline-none"
              [class]="layout() === 'rail' ? 'top-full mt-2' : 'bottom-full mb-2'"
              (keydown)="onMenuKeydown($event)"
            >
              @for (s of sections(); track s.key; let first = $first) {
                @if (!first) {
                  <div role="separator" class="mx-2 my-1 h-px bg-white/10"></div>
                }
                <div [attr.role]="s.group ? 'group' : 'none'" class="flex flex-col">
                  @for (e of s.entries; track e.key) {
                    <button
                      type="button"
                      tabindex="-1"
                      class="flex min-h-11 w-full items-center gap-3 rounded-field px-3 py-2 text-left font-sans text-body-sm text-white hover:bg-white/10 focus:outline-none focus-visible:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-frost"
                      [class.opacity-60]="e.disabled"
                      [attr.role]="e.role"
                      [attr.data-entry]="e.key"
                      [attr.aria-label]="e.name"
                      [attr.aria-checked]="e.role === 'menuitem' ? null : e.checked"
                      [attr.aria-disabled]="e.disabled ? true : null"
                      [attr.aria-describedby]="e.descriptionId"
                      (click)="choose(e)"
                    >
                      <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                        @if (e.role !== 'menuitem') {
                          @if (e.checked) {
                            <sd-icon name="check" [size]="16" />
                          }
                        } @else if (e.icon) {
                          <sd-icon [name]="e.icon" [size]="16" />
                        }
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col" aria-hidden="true">
                        <span class="truncate">{{ e.label }}</span>
                        @if (e.description) {
                          <span class="text-caption text-white/70">{{ e.description }}</span>
                        }
                      </span>
                      @if (e.badge > 0) {
                        <span
                          class="min-w-5 shrink-0 rounded-pill bg-cerulean px-1 text-center font-sans text-caption font-semibold text-white"
                          aria-hidden="true"
                          >{{ badgeText(e.badge) }}</span
                        >
                      }
                      @if (e.descriptionId) {
                        <span [id]="e.descriptionId" class="sr-only">{{ e.description }}</span>
                      }
                    </button>
                  }
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class CallControlsComponent {
  /** The controls, in bar order (hidden ones are left out). */
  readonly controls = input.required<readonly CallControl[]>();
  /** More-menu items, after any overflowed controls. */
  readonly menu = input<readonly CallMenuItem[]>([]);
  readonly ariaLabel = input('Call controls');
  /** `bar` (horizontal, below the video) or `rail` (vertical, beside it: phone landscape). */
  readonly layout = input<'bar' | 'rail'>('bar');
  /** `auto`: labels visible once the `callbar` container is 34rem wide; `never`: always screen-reader only. */
  readonly showLabels = input<'auto' | 'never'>('auto');

  /** A control was pressed (from the bar, or as an overflowed More item). Not for disabled ones. */
  readonly pressed = output<CallControlId>();
  /** A More-menu item was chosen. */
  readonly menuSelect = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  private readonly uid = `sd-callbar-${++nextId}`;
  protected readonly menuId = `${this.uid}-menu`;

  private readonly compactState = signal(false);
  /** The bar is under 22rem (block size in a rail): overflow controls are in More. */
  readonly compact = this.compactState.asReadonly();
  protected readonly menuOpen = signal(false);
  protected readonly activeId = signal<CallControlId | null>(null);
  private readonly reason = signal<{ anchor: CallControlId; text: string } | null>(null);
  private reasonTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly visible = computed(() => this.controls().filter((c) => !c.hidden));
  private readonly hasMore = computed(() => this.visible().some((c) => c.id === 'more'));
  /** Controls moved into More (compact bar with a More control). */
  private readonly overflowed = computed(() =>
    this.compact() && this.hasMore() ? this.visible().filter((c) => c.overflow === 'menu' && c.id !== 'more') : [],
  );
  private readonly moreBadge = computed(() => {
    const more = this.visible().find((c) => c.id === 'more');
    return (more?.badge ?? 0) + this.overflowed().reduce((n, c) => n + (c.badge ?? 0), 0);
  });

  protected readonly bar = computed<readonly ControlView[]>(() => {
    const moved = new Set(this.overflowed().map((c) => c.id));
    const shown = this.visible().filter((c) => !moved.has(c.id));
    return shown.map((c, i) => {
      const badge = c.id === 'more' ? this.moreBadge() : (c.badge ?? 0);
      return {
        c,
        badge,
        name: badgeName(c.ariaLabel || c.label, badge),
        reasonId: c.disabled && c.reason ? `${this.uid}-${c.id}-reason` : null,
        align: shown.length > 1 && i === 0 ? 'start' : i === shown.length - 1 && shown.length > 1 ? 'end' : 'center',
      };
    });
  });

  /** The control in the tab order: the last one focused, else the first. */
  protected readonly activeControl = computed(() => {
    const ids = this.bar().map((v) => v.c.id);
    const active = this.activeId();
    return active && ids.includes(active) ? active : (ids[0] ?? null);
  });

  protected readonly sections = computed<readonly MenuSection[]>(() => {
    const sections: MenuSection[] = [];
    const moved = this.overflowed().map<MenuEntry>((c) => {
      const badge = c.badge ?? 0;
      const description = c.disabled && c.reason ? c.reason : null;
      return {
        key: `c:${c.id}`,
        kind: 'control',
        id: c.id,
        label: c.label,
        name: badgeName(c.ariaLabel || c.label, badge),
        icon: c.icon,
        role: typeof c.pressed === 'boolean' ? 'menuitemcheckbox' : 'menuitem',
        checked: c.pressed === true,
        description,
        descriptionId: description ? `${this.uid}-c-${c.id}-desc` : null,
        disabled: !!c.disabled,
        badge,
      };
    });
    if (moved.length) sections.push({ key: 'controls', group: null, entries: moved });
    // Then the items: consecutive items of one group (or ungrouped ones) share a section.
    let current: { key: string; group: string | null; entries: MenuEntry[] } | null = null;
    this.menu().forEach((m, i) => {
      const checkable = typeof m.checked === 'boolean';
      const group = m.group ?? null;
      const entry: MenuEntry = {
        key: `m:${m.id}`,
        kind: 'item',
        id: m.id,
        label: m.label,
        name: m.label,
        icon: m.icon ?? null,
        role: checkable ? (group ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem',
        checked: m.checked === true,
        description: m.description ?? null,
        descriptionId: m.description ? `${this.uid}-m-${i}-desc` : null,
        disabled: false,
        badge: 0,
      };
      if (current && current.group === group) {
        current.entries.push(entry);
      } else {
        current = { key: `s${i}`, group, entries: [entry] };
        sections.push(current);
      }
    });
    return sections;
  });

  private readonly entries = computed(() => this.sections().flatMap((s) => s.entries));

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      let cancel: (() => void) | null = null;
      const observer = new ResizeObserver((records) => {
        const rect = records[records.length - 1]?.contentRect;
        if (!rect) return;
        const size = this.layout() === 'rail' ? rect.height : rect.width;
        cancel?.();
        cancel = nextFrame(() => {
          cancel = null;
          if (size > 0) this.compactState.set(size < CALL_BAR_COMPACT_PX);
        });
      });
      observer.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => {
        observer.disconnect();
        cancel?.();
      });
    });
    destroyRef.onDestroy(() => {
      if (this.reasonTimer) clearTimeout(this.reasonTimer);
    });
  }

  protected buttonId(id: CallControlId): string {
    return `${this.uid}-${id}`;
  }

  protected isToggle(c: CallControl): boolean {
    return typeof c.pressed === 'boolean';
  }

  protected circleClass(c: CallControl): string {
    const tone = c.id === 'more' && this.menuOpen() ? 'bg-white/20' : TONES[c.tone ?? 'default'];
    return c.disabled ? `${tone} opacity-50` : tone;
  }

  protected badgeText(n: number): string {
    return n > 99 ? '99+' : String(n);
  }

  protected reasonText(id: CallControlId): string {
    const r = this.reason();
    return r && r.anchor === id ? r.text : '';
  }

  protected bubbleClass(v: ControlView): string {
    if (!this.reasonText(v.c.id)) return 'sr-only';
    const place =
      this.layout() === 'rail'
        ? 'right-full top-1/2 mr-2 -translate-y-1/2'
        : v.align === 'start'
          ? 'bottom-full left-0 mb-2'
          : v.align === 'end'
            ? 'bottom-full right-0 mb-2'
            : 'bottom-full left-1/2 mb-2 -translate-x-1/2';
    return `absolute z-40 w-max max-w-[16rem] rounded-field border border-white/15 bg-ink px-3 py-2 text-left font-sans text-caption text-white shadow-overlay ${place}`;
  }

  protected press(c: CallControl): void {
    if (c.disabled) {
      if (c.reason) this.showReason(c.id, c.reason);
      return;
    }
    if (c.id === 'more' && this.entries().length) {
      if (this.menuOpen()) this.closeMenu(true);
      else this.openMenu('first');
      return;
    }
    this.pressed.emit(c.id);
  }

  protected choose(e: MenuEntry): void {
    if (e.kind === 'control') {
      if (e.disabled) {
        this.closeMenu(true);
        if (e.description) this.showReason('more', e.description);
        return;
      }
      this.closeMenu(true);
      this.pressed.emit(e.id as CallControlId);
      return;
    }
    this.closeMenu(true);
    this.menuSelect.emit(e.id);
  }

  protected onBarKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (event.key === 'Escape' && this.reason()) {
      this.clearReason();
      return;
    }
    const ids = this.bar().map((v) => v.c.id);
    const current = target.closest<HTMLElement>('[data-control]')?.dataset['control'] as CallControlId | undefined;
    const i = current ? ids.indexOf(current) : -1;
    if (i < 0 || !ids.length) return;
    const rail = this.layout() === 'rail';
    let next: number;
    switch (event.key) {
      case rail ? 'ArrowUp' : 'ArrowLeft':
        next = (i - 1 + ids.length) % ids.length;
        break;
      case rail ? 'ArrowDown' : 'ArrowRight':
        next = (i + 1) % ids.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.focusControl(ids[next]);
  }

  protected onMenuKeydown(event: KeyboardEvent): void {
    const items = this.menuItems();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = at < 0 ? 0 : (at + 1) % items.length;
        break;
      case 'ArrowUp':
        next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu(true);
        return;
      case 'Tab':
        this.closeMenu(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  protected onDocumentClick(event: Event): void {
    if (!this.menuOpen()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.closeMenu(false);
  }

  private openMenu(focus: 'first' | 'last'): void {
    this.menuOpen.set(true);
    afterNextRender(
      () => {
        const items = this.menuItems();
        (focus === 'first' ? items[0] : items[items.length - 1])?.focus();
      },
      { injector: this.injector },
    );
  }

  private closeMenu(returnFocus: boolean): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    if (returnFocus) this.focusControl('more');
  }

  private menuItems(): HTMLElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLElement>(`#${this.menuId} [data-entry]`)];
  }

  private focusControl(id: CallControlId): void {
    this.activeId.set(id);
    this.host.nativeElement.querySelector<HTMLElement>(`[data-control="${id}"]`)?.focus();
  }

  private showReason(anchor: CallControlId, text: string): void {
    if (this.reasonTimer) clearTimeout(this.reasonTimer);
    this.reason.set({ anchor, text });
    this.reasonTimer = setTimeout(() => this.clearReason(), CALL_CONTROL_REASON_MS);
  }

  private clearReason(): void {
    if (this.reasonTimer) clearTimeout(this.reasonTimer);
    this.reasonTimer = null;
    this.reason.set(null);
  }
}
