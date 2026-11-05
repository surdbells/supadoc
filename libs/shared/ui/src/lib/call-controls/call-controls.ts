import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

/** The dock's controls: the call's own (mic … end), then its settings' buttons. */
export type CallControlId =
  | 'mic'
  | 'cam'
  | 'share'
  | 'captions'
  | 'record'
  | 'documents'
  | 'end'
  | 'self'
  | 'theme'
  | 'privacy'
  | 'invite';

/** One button of the dock: a call control, or a setting's toggle / action. */
export interface CallControl {
  id: CallControlId;
  /** Visible text == the start of the accessible name (WCAG 2.5.3); constant for aria-pressed toggles. */
  label: string;
  /** Only to extend the label, e.g. 'End call' for label 'End'. */
  ariaLabel?: string;
  /** An `sd-icon` name. */
  icon: string;
  /** A call control's circle: default white/10 · active sky · off / danger alert. (Settings are outlined.) */
  tone?: 'default' | 'active' | 'off' | 'danger';
  /**
   * `aria-pressed`, for true toggles only (share, captions, record, Hide my
   * preview, Light cockpit). The label never changes while this is set.
   */
  pressed?: boolean | null;
  /** A count shown as a pill; the name becomes "{label}, {n} new". */
  badge?: number | null;
  /** Dimmed but still focusable (`aria-disabled`); pressing shows `reason`. */
  disabled?: boolean;
  /** Why it is disabled: announced as its description, and shown for 6 s when pressed (never a `title`). */
  reason?: string | null;
  hidden?: boolean;
}

/** One option of a segmented choice. */
export interface CallChoiceOption {
  value: string;
  /** Visible text (short). */
  label: string;
  /** Only to extend the label, e.g. 'Fit whole picture' for 'Fit'. */
  ariaLabel?: string;
}

/** A setting chosen from a few options: a segmented control (an APG radio group in the toolbar). */
export interface CallChoice {
  id: string;
  /** The group's name (its accessible name, and the caption under it). */
  label: string;
  options: readonly CallChoiceOption[];
  /** The chosen option's value. */
  value: string;
  hidden?: boolean;
}

/** A setting after the call's controls: a toggle / action button, or a segmented choice. */
export type CallSetting = CallControl | CallChoice;

/** A segmented choice changed (`id`: the choice's, `value`: the option's). */
export interface CallChoiceChange {
  id: string;
  value: string;
}

/** How long a disabled control's reason stays on screen. */
export const CALL_CONTROL_REASON_MS = 6_000;
/** Rail packing (px): a control, one segment of a choice, and the gaps between them. */
const RAIL_CONTROL_PX = 44;
const RAIL_SEGMENT_PX = 36;
const RAIL_SEGMENT_GAP_PX = 2;
/** A rail choice's border and padding (p-[3px] and a 1px border, top and bottom). */
const RAIL_TRACK_PX = 8;
const RAIL_GAP_PX = 8;
/**
 * The space between a 44px control and what opens beside a rail (a reason
 * bubble, a tooltip): a call screen's rail has a 1px border and px-1, and the
 * toolbar px-[9px], so its first column of controls is 14px from the rail's
 * edge, then 8px. (Literal classes: Tailwind finds them in the source.)
 */
const RAIL_SIDE_MARGIN = 'mr-[1.375rem]';
const RAIL_SIDE_PADDING = 'pr-[1.375rem]';
/** The space a reason bubble keeps from the screen's edges (px). */
const REASON_EDGE_PX = 8;

interface ButtonView {
  readonly kind: 'button';
  readonly key: string;
  readonly c: CallControl;
  /** A setting (outlined, after the divider), not a call control. */
  readonly setting: boolean;
  readonly name: string;
  readonly badge: number;
  /** The reason's id, for `aria-describedby`. */
  readonly reasonId: string | null;
  readonly align: 'start' | 'center' | 'end';
}

interface ChoiceView {
  readonly kind: 'choice';
  readonly key: string;
  readonly c: CallChoice;
  readonly options: readonly { readonly o: CallChoiceOption; readonly key: string; readonly checked: boolean }[];
}

type ItemView = ButtonView | ChoiceView;

/** The call's controls, or the settings: their items in columns (one in a bar; packed to the height in a rail). */
interface BoxView {
  readonly key: 'controls' | 'settings';
  readonly cols: readonly (readonly ItemView[])[];
}

const TONES: Record<NonNullable<CallControl['tone']>, string> = {
  default: 'bg-white/10 text-white group-hover:bg-white/20',
  active: 'bg-sky text-white',
  off: 'bg-alert text-white group-hover:bg-alert/85',
  danger: 'bg-alert text-white group-hover:bg-alert/85',
};
/** A setting's circle: outlined (lighter than a call control), filled white while pressed. */
const SETTING_CIRCLE = 'border border-white/15 text-white group-hover:bg-white/10';
const SETTING_CIRCLE_PRESSED = 'border border-white bg-white text-ink';

let nextId = 0;

function badgeName(base: string, badge: number): string {
  return badge > 0 ? `${base}, ${badge} new` : base;
}

function isChoice(s: CallSetting): s is CallChoice {
  return 'options' in s;
}

function nextFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

/** An item's height in a rail (labels are screen-reader only there). */
function railHeight(it: ItemView): number {
  if (it.kind === 'button') return RAIL_CONTROL_PX;
  const n = it.options.length;
  return n * RAIL_SEGMENT_PX + Math.max(0, n - 1) * RAIL_SEGMENT_GAP_PX + RAIL_TRACK_PX;
}

/** Items in columns no taller than `height` (each column holds at least one). */
function pack(items: readonly ItemView[], height: number): ItemView[][] {
  if (!(height > 0)) return [[...items]];
  const cols: ItemView[][] = [];
  let used = 0;
  for (const it of items) {
    const h = railHeight(it);
    const col = cols[cols.length - 1];
    if (col && used + RAIL_GAP_PX + h <= height + 0.5) {
      col.push(it);
      used += RAIL_GAP_PX + h;
    } else {
      cols.push([it]);
      used = h;
    }
  }
  return cols;
}

/**
 * The call dock's control bar — a WAI-ARIA APG toolbar under the video (never
 * over it), with nothing hidden behind a menu.
 *
 * First the call's controls (`controls`: round 44px buttons with their label
 * below), then, past a subtle divider, its settings (`settings`, a labelled
 * group at a lighter weight): toggles and actions as outlined buttons, and
 * segmented choices (the video size, fit / fill) as APG radio groups.
 *
 * Labels show once the bar's `callbar` container is 34rem wide; below that
 * (and always in a rail) they are `sr-only`, so the accessible name never
 * changes, and a tooltip names the control on hover / focus (Esc hides it).
 * When both groups fit one row they share it; otherwise the settings stack
 * under the controls, and each group wraps onto more rows — never a horizontal
 * scroll. In a rail (a phone held sideways) the items are packed into as many
 * columns as the rail's height needs.
 *
 * Roving tabindex across every control and option: Left / Right (Up / Down in
 * a rail), Home, End; on an option the other arrows choose the previous / next
 * one (APG toolbar). A disabled control stays focusable (`aria-disabled`) with
 * its `reason` as its description; pressing it shows the reason for 6 s in a
 * `role="status"` bubble. Put the bar in an inline-size container named
 * `callbar`: `<div class="min-w-0 flex-1 [container-name:callbar] [container-type:inline-size]">`
 * (a rail's box must not be one: it is as wide as its columns).
 */
@Component({
  selector: 'sd-call-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'relative block',
    '[class.h-full]': "layout() === 'rail'",
    // The toolbar's keys (from whichever control has focus); Esc's hidden tooltips come back
    // once focus moves or the pointer leaves.
    '(keydown)': 'onKeydown($event)',
    '(focusin)': 'tipsOff.set(false)',
    '(pointerleave)': 'tipsOff.set(false)',
  },
  template: `
    <div
      #toolbar
      role="toolbar"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-orientation]="layout() === 'rail' ? 'vertical' : 'horizontal'"
      [class]="toolbarClass()"
    >
      @for (box of boxes(); track box.key) {
        @if (box.key === 'settings') {
          <span aria-hidden="true" data-divider [class]="dividerClass()"></span>
        }
        <div
          [attr.role]="box.key === 'settings' ? 'group' : null"
          [attr.aria-label]="box.key === 'settings' ? settingsLabel() : null"
          [attr.data-box]="box.key"
          [class]="boxClass()"
        >
          @for (col of box.cols; track $index) {
            <div [class]="colClass()">
              @for (it of col; track it.key) {
                @if (it.kind === 'choice') {
                  <div class="relative flex flex-col items-center gap-1" data-item>
                    <div role="radiogroup" [attr.aria-label]="it.c.label" [class]="trackClass()">
                      @for (o of it.options; track o.key) {
                        <button
                          type="button"
                          role="radio"
                          [class]="segmentClass(o.checked)"
                          [attr.aria-checked]="o.checked"
                          [attr.aria-label]="o.o.ariaLabel || null"
                          [attr.data-stop]="o.key"
                          [attr.data-choice]="it.c.id"
                          [attr.data-value]="o.o.value"
                          [tabIndex]="o.key === activeStop() ? 0 : -1"
                          (click)="choose(it.c, o.o.value, o.key)"
                          (focus)="activeKey.set(o.key)"
                        >
                          {{ o.o.label }}
                        </button>
                      }
                    </div>
                    <span [class]="labelClass()" aria-hidden="true"
                      ><span class="whitespace-nowrap">{{ it.c.label }}</span></span
                    >
                  </div>
                } @else {
                  <div class="group/item relative flex flex-col items-center" data-item>
                    <button
                      type="button"
                      class="group peer flex min-w-11 flex-col items-center gap-1 rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
                      [class.cursor-not-allowed]="it.c.disabled"
                      [id]="buttonId(it.c.id)"
                      [attr.data-control]="it.c.id"
                      [attr.data-stop]="it.key"
                      [tabIndex]="it.key === activeStop() ? 0 : -1"
                      [attr.aria-label]="it.name"
                      [attr.aria-pressed]="isToggle(it.c) ? !!it.c.pressed : null"
                      [attr.aria-disabled]="it.c.disabled ? true : null"
                      [attr.aria-describedby]="it.reasonId"
                      (click)="press(it.c)"
                      (focus)="activeKey.set(it.key)"
                    >
                      <span
                        class="relative flex size-11 items-center justify-center rounded-full transition-colors motion-reduce:transition-none"
                        [class]="circleClass(it)"
                        aria-hidden="true"
                      >
                        <sd-icon [name]="it.c.icon" [size]="20" />
                        @if (it.badge > 0) {
                          <span
                            class="absolute -right-1 -top-1 min-w-5 rounded-pill bg-cerulean px-1 text-center font-sans text-caption font-semibold text-white"
                            >{{ badgeText(it.badge) }}</span
                          >
                        }
                      </span>
                      <!-- not-sr-only resets white-space, so the no-wrap lives on the inner span. -->
                      <span [class]="labelClass()" aria-hidden="true"
                        ><span class="whitespace-nowrap">{{ it.c.label }}</span></span
                      >
                    </button>
                    <!-- Icon only (a narrow bar, a rail): the label on hover / focus. Outside the
                         button, so pointing at it keeps it open without pressing anything. -->
                    <span aria-hidden="true" data-tip [class]="tipClass(it)"
                      ><span
                        class="block w-max max-w-[12rem] rounded-field border border-white/15 bg-abyss px-2.5 py-1 font-sans text-caption text-white shadow-overlay"
                        >{{ it.c.label }}</span
                      ></span
                    >
                    @if (it.reasonId) {
                      <span [id]="it.reasonId" class="sr-only">{{ it.c.reason }}</span>
                    }
                    <!-- Pressing a disabled control shows why: above it (beside a rail), moved
                         along that edge as far as it takes to stay on the screen. -->
                    <span
                      role="status"
                      [attr.data-reason]="it.c.id"
                      [class]="bubbleClass(it)"
                      [style.margin-left.px]="reasonShiftX(it.c.id)"
                      [style.margin-top.px]="reasonShiftY(it.c.id)"
                      >{{ reasonText(it.c.id) }}</span
                    >
                  </div>
                }
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class CallControlsComponent {
  /** The call's controls, in bar order (hidden ones are left out). */
  readonly controls = input.required<readonly CallControl[]>();
  /** The settings after them: toggles, actions and segmented choices (hidden ones are left out). */
  readonly settings = input<readonly CallSetting[]>([]);
  readonly ariaLabel = input('Call controls');
  /** The settings group's name. */
  readonly settingsLabel = input('Call settings');
  /** `bar` (horizontal, below the video) or `rail` (vertical, beside it: phone landscape). */
  readonly layout = input<'bar' | 'rail'>('bar');
  /** `auto`: labels visible once the `callbar` container is 34rem wide; `never`: always screen-reader only. */
  readonly showLabels = input<'auto' | 'never'>('auto');

  /** A button was pressed (a call control or a setting's toggle / action). Not for disabled ones. */
  readonly pressed = output<CallControlId>();
  /** A segmented choice changed. */
  readonly choiceChange = output<CallChoiceChange>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly toolbar = viewChild.required<ElementRef<HTMLElement>>('toolbar');

  private readonly uid = `sd-callbar-${++nextId}`;

  /** The bar's two groups don't fit one row: the settings sit under the controls. */
  private readonly stackedState = signal(false);
  readonly stacked = this.stackedState.asReadonly();
  /** A rail's height (its columns are packed to it); 0 before it is measured. */
  private readonly railHeightPx = signal(0);
  protected readonly activeKey = signal<string | null>(null);
  /** Esc hid the tooltips (until focus moves or the pointer leaves). */
  protected readonly tipsOff = signal(false);
  private readonly reason = signal<{ anchor: CallControlId; text: string } | null>(null);
  private reasonTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How far the shown reason is moved along its edge (px: across a bar, down a
   * rail) to stay on the screen, e.g. Captions near a phone's right edge.
   */
  private readonly reasonShift = signal(0);

  private readonly items = computed(() => {
    const controls = this.controls().filter((c) => !c.hidden);
    const settings = this.settings().filter((s) => !s.hidden);
    const buttons = controls.length + settings.filter((s) => !isChoice(s)).length;
    let at = 0;
    const button = (c: CallControl, setting: boolean): ButtonView => {
      const i = at++;
      const badge = c.badge ?? 0;
      return {
        kind: 'button',
        key: `c:${c.id}`,
        c,
        setting,
        badge,
        name: badgeName(c.ariaLabel || c.label, badge),
        reasonId: c.disabled && c.reason ? `${this.uid}-${c.id}-reason` : null,
        align: buttons > 1 && i === 0 ? 'start' : buttons > 1 && i === buttons - 1 ? 'end' : 'center',
      };
    };
    const primary: ItemView[] = controls.map((c) => button(c, false));
    const rest: ItemView[] = settings.map((s) =>
      isChoice(s)
        ? {
            kind: 'choice',
            key: `g:${s.id}`,
            c: s,
            options: s.options.map((o) => ({ o, key: `r:${s.id}:${o.value}`, checked: o.value === s.value })),
          }
        : button(s, true),
    );
    return { primary, settings: rest };
  });

  protected readonly boxes = computed<readonly BoxView[]>(() => {
    const { primary, settings } = this.items();
    const rail = this.layout() === 'rail';
    const height = rail ? this.railHeightPx() : 0;
    const cols = (list: readonly ItemView[]) => (rail ? pack(list, height) : [list]);
    const boxes: BoxView[] = [{ key: 'controls', cols: cols(primary) }];
    if (settings.length) boxes.push({ key: 'settings', cols: cols(settings) });
    return boxes;
  });

  /** Every focus stop, in order: each button, and each option of a choice. */
  private readonly stops = computed(() => {
    const { primary, settings } = this.items();
    return [...primary, ...settings].flatMap((it) => (it.kind === 'button' ? [it.key] : it.options.map((o) => o.key)));
  });

  /** The stop in the tab order: the last one focused, else the first. */
  protected readonly activeStop = computed(() => {
    const stops = this.stops();
    const active = this.activeKey();
    return active && stops.includes(active) ? active : (stops[0] ?? null);
  });

  protected readonly toolbarClass = computed(() => {
    if (this.layout() === 'rail') return 'flex h-full flex-row items-center justify-center gap-2 px-[9px]';
    return this.stacked()
      ? 'flex flex-col items-center gap-x-2.5 gap-y-2'
      : 'flex flex-row flex-nowrap items-start justify-center gap-x-2.5 gap-y-2';
  });
  protected readonly boxClass = computed(() =>
    this.layout() === 'rail'
      ? 'flex h-full flex-row items-center gap-2'
      : 'flex max-w-full flex-wrap items-start justify-center gap-x-1.5 gap-y-2 sm:gap-x-2',
  );
  protected readonly colClass = computed(() =>
    this.layout() === 'rail' ? 'flex flex-col items-center justify-center gap-2' : 'contents',
  );
  protected readonly dividerClass = computed(() => {
    if (this.layout() === 'rail') return 'my-2 w-px shrink-0 self-stretch bg-white/15';
    return this.stacked() ? 'h-px w-full shrink-0 bg-white/15' : 'h-11 w-px shrink-0 bg-white/15';
  });
  protected readonly labelClass = computed(() =>
    this.showLabels() === 'never' || this.layout() === 'rail'
      ? 'sr-only'
      : 'sr-only font-sans text-caption text-white/80 callbar:not-sr-only',
  );
  protected readonly trackClass = computed(() =>
    this.layout() === 'rail'
      ? 'flex min-w-11 flex-col items-stretch gap-0.5 rounded-[1.375rem] border border-white/15 p-[3px]'
      : 'flex h-11 items-center gap-0.5 rounded-pill border border-white/15 p-[3px]',
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      // Labels change width once the web fonts arrive (no resize tells us).
      const fonts = (this.host.nativeElement.ownerDocument as { fonts?: FontFaceSet }).fonts;
      void fonts?.ready.then(() => this.measure());
      if (typeof ResizeObserver === 'undefined') return;
      let cancel: (() => void) | null = null;
      const observer = new ResizeObserver((records) => {
        const rect = records[records.length - 1]?.contentRect;
        if (!rect) return;
        cancel?.();
        cancel = nextFrame(() => {
          cancel = null;
          if (this.layout() === 'rail' && rect.height > 0) this.railHeightPx.set(rect.height);
          this.measure();
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
    // The items or the layout changed: whether both groups still fit one row.
    afterRenderEffect(() => {
      this.boxes();
      this.measure();
    });
    // A reason was shown (or cleared): keep it on the screen.
    afterRenderEffect(() => {
      const anchor = this.reason()?.anchor ?? null;
      untracked(() => this.placeReason(anchor));
    });
  }

  protected buttonId(id: CallControlId): string {
    return `${this.uid}-${id}`;
  }

  protected isToggle(c: CallControl): boolean {
    return typeof c.pressed === 'boolean';
  }

  protected circleClass(v: ButtonView): string {
    const c = v.c;
    const tone = v.setting ? (c.pressed ? SETTING_CIRCLE_PRESSED : SETTING_CIRCLE) : TONES[c.tone ?? 'default'];
    return c.disabled ? `${tone} opacity-50` : tone;
  }

  protected segmentClass(checked: boolean): string {
    const base =
      'flex h-9 min-w-9 items-center justify-center rounded-pill px-1.5 font-sans text-caption font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost motion-reduce:transition-none';
    const tone = checked ? 'bg-white text-ink' : 'text-white/80 hover:bg-white/10 hover:text-white';
    return this.layout() === 'rail' ? `${base} w-full ${tone}` : `${base} ${tone}`;
  }

  protected badgeText(n: number): string {
    return n > 99 ? '99+' : String(n);
  }

  protected reasonText(id: CallControlId): string {
    const r = this.reason();
    return r && r.anchor === id ? r.text : '';
  }

  /** The label as a tooltip while labels are hidden: on hover or focus, not over a reason, not after Esc. */
  protected tipClass(v: ButtonView): string {
    if (this.tipsOff() || this.reasonText(v.c.id)) return 'hidden';
    const place =
      this.layout() === 'rail'
        ? `right-full top-1/2 -translate-y-1/2 ${RAIL_SIDE_PADDING}`
        : v.align === 'start'
          ? 'bottom-full left-0 pb-2'
          : v.align === 'end'
            ? 'bottom-full right-0 pb-2'
            : 'bottom-full left-1/2 -translate-x-1/2 pb-2';
    const shown = this.showLabels() === 'never' || this.layout() === 'rail' ? '' : ' callbar:hidden!';
    return `absolute z-40 hidden group-hover/item:block peer-focus-visible:block ${place}${shown}`;
  }

  /** The reason above its control (beside a rail), at most the screen's width less 1rem a side; see placeReason. */
  protected bubbleClass(v: ButtonView): string {
    if (!this.reasonText(v.c.id)) return 'sr-only';
    const place =
      this.layout() === 'rail'
        ? `right-full top-1/2 ${RAIL_SIDE_MARGIN} -translate-y-1/2`
        : v.align === 'start'
          ? 'bottom-full left-0 mb-2'
          : v.align === 'end'
            ? 'bottom-full right-0 mb-2'
            : 'bottom-full left-1/2 mb-2 -translate-x-1/2';
    return `absolute z-40 w-max max-w-[min(16rem,calc(100vw-2rem))] rounded-field border border-white/15 bg-ink px-3 py-2 text-left font-sans text-caption text-white shadow-overlay ${place}`;
  }

  /** The shown reason's move across a bar (px), or null. */
  protected reasonShiftX(id: CallControlId): number | null {
    return this.layout() !== 'rail' && this.reason()?.anchor === id ? this.reasonShift() || null : null;
  }

  /** The shown reason's move down a rail (px), or null. */
  protected reasonShiftY(id: CallControlId): number | null {
    return this.layout() === 'rail' && this.reason()?.anchor === id ? this.reasonShift() || null : null;
  }

  protected press(c: CallControl): void {
    if (c.disabled) {
      if (c.reason) this.showReason(c.id, c.reason);
      return;
    }
    this.pressed.emit(c.id);
  }

  protected choose(c: CallChoice, value: string, key: string): void {
    this.activeKey.set(key);
    if (value !== c.value) this.choiceChange.emit({ id: c.id, value });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.reason()) this.clearReason();
      else this.tipsOff.set(true);
      return;
    }
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-stop]');
    const key = target?.dataset['stop'];
    const stops = this.stops();
    const i = key ? stops.indexOf(key) : -1;
    if (!target || i < 0) return;
    const rail = this.layout() === 'rail';
    // On an option, the arrows across the toolbar choose the previous / next one (APG toolbar).
    const choiceId = target.dataset['choice'];
    const back = rail ? 'ArrowLeft' : 'ArrowUp';
    const ahead = rail ? 'ArrowRight' : 'ArrowDown';
    if (choiceId && (event.key === back || event.key === ahead)) {
      const choice = this.items().settings.find((it): it is ChoiceView => it.kind === 'choice' && it.c.id === choiceId);
      if (!choice) return;
      const at = choice.options.findIndex((o) => o.key === key);
      const n = choice.options.length;
      const next = choice.options[(at + (event.key === ahead ? 1 : -1) + n) % n];
      event.preventDefault();
      this.focusStop(next.key);
      this.choose(choice.c, next.o.value, next.key);
      return;
    }
    let next: number;
    switch (event.key) {
      case rail ? 'ArrowUp' : 'ArrowLeft':
        next = (i - 1 + stops.length) % stops.length;
        break;
      case rail ? 'ArrowDown' : 'ArrowRight':
        next = (i + 1) % stops.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = stops.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.focusStop(stops[next]);
  }

  /**
   * A bar: whether the controls, the divider and the settings fit one row
   * (from the items' own widths, which stacking doesn't change); otherwise
   * the settings stack under the controls. Unmeasurable (not laid out): one row.
   */
  private measure(): void {
    if (this.layout() === 'rail') return;
    const toolbar = this.toolbar().nativeElement;
    const boxes = [...toolbar.querySelectorAll<HTMLElement>(':scope > [data-box]')];
    if (boxes.length < 2) {
      this.stackedState.set(false);
      return;
    }
    const width = toolbar.clientWidth;
    if (!(width > 0)) return;
    const view = toolbar.ownerDocument.defaultView;
    const gapOf = (el: HTMLElement) => parseFloat(view?.getComputedStyle(el).columnGap ?? '') || 0;
    let need = 1 + 2 * gapOf(toolbar);
    for (const box of boxes) {
      const gap = gapOf(box);
      box.querySelectorAll<HTMLElement>('[data-item]').forEach((item, i) => {
        need += item.getBoundingClientRect().width + (i ? gap : 0);
      });
    }
    this.stackedState.set(need > width + 0.5);
  }

  /**
   * Moves the shown reason along its edge (across a bar, down a rail) just far
   * enough to keep it REASON_EDGE_PX inside the screen; its start edge wins
   * when it can't fit. Not laid out (no size): left where it is.
   */
  private placeReason(anchor: CallControlId | null): void {
    const shift = this.reasonShift();
    const bubble = anchor ? this.host.nativeElement.querySelector<HTMLElement>(`[data-reason="${anchor}"]`) : null;
    const rect = bubble?.getBoundingClientRect();
    const root = this.host.nativeElement.ownerDocument.documentElement;
    const rail = this.layout() === 'rail';
    const limit = rail ? root.clientHeight : root.clientWidth;
    if (!rect || !(rect.width > 0 && rect.height > 0) || !(limit > 0)) {
      if (shift) this.reasonShift.set(0);
      return;
    }
    // Where it would sit unmoved, and where it would end.
    const start = (rail ? rect.top : rect.left) - shift;
    const end = start + (rail ? rect.height : rect.width);
    let next = 0;
    if (end > limit - REASON_EDGE_PX) next = limit - REASON_EDGE_PX - end;
    if (start + next < REASON_EDGE_PX) next = REASON_EDGE_PX - start;
    next = Math.round(next);
    if (next !== shift) this.reasonShift.set(next);
  }

  private focusStop(key: string): void {
    this.activeKey.set(key);
    this.host.nativeElement.querySelector<HTMLElement>(`[data-stop="${key}"]`)?.focus();
  }

  private showReason(anchor: CallControlId, text: string): void {
    if (this.reasonTimer) clearTimeout(this.reasonTimer);
    // Shown unmoved first; placeReason measures it there.
    this.reasonShift.set(0);
    this.reason.set({ anchor, text });
    this.reasonTimer = setTimeout(() => this.clearReason(), CALL_CONTROL_REASON_MS);
  }

  private clearReason(): void {
    if (this.reasonTimer) clearTimeout(this.reasonTimer);
    this.reasonTimer = null;
    this.reasonShift.set(0);
    this.reason.set(null);
  }
}
