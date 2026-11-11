import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';

export interface LabSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** Type-ahead buffer lifetime (ms). */
const TYPE_AHEAD_MS = 500;

/**
 * The lab form's "Select field" with the shared dropdown panel (LD §2.0), as an
 * APG select-only combobox: Enter / Space / Alt+↓ open; ↑ ↓ Home End move;
 * Enter selects; Esc closes and keeps focus; letters jump (type-ahead);
 * `aria-activedescendant` tracks the active row; a click outside closes.
 *
 * `removable` shows a ✕ for the current value. It is a DOM **sibling** of the
 * combobox (placed to look inside the box), never inside it, so no control is
 * nested in another. `variant="pill"` is the list page's status filter
 * (no visible label: `ariaLabel`, optional count `badge`).
 */
@Component({
  selector: 'doc-lab-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'flex min-w-0 flex-col gap-2',
    // `id` is an input (the combobox's id): never also on the host, or the page has it twice.
    '[attr.id]': 'null',
    '(document:pointerdown)': 'onDocPointer($event)',
  },
  styles: `
    .ls-box {
      height: 38px;
    }
    .ls-pill {
      height: 48px;
    }
    .ls-panel {
      max-height: 18rem;
    }
    .ls-row {
      min-height: 40px;
    }
    .ls-x {
      right: 2rem;
    }
    .ls-pr {
      padding-right: 1.5rem;
    }
    .ls-disabled {
      cursor: not-allowed;
      background: var(--color-cloud);
    }
  `,
  template: `
    @if (label() && variant() === 'field') {
      <span [id]="id() + '-label'" class="font-sans text-caption text-ink">{{ label() }}</span>
    }
    <div #wrap class="relative">
      <div
        #trigger
        role="combobox"
        tabindex="0"
        [id]="id()"
        [attr.aria-controls]="id() + '-listbox'"
        aria-haspopup="listbox"
        [attr.aria-expanded]="open()"
        [attr.aria-labelledby]="ariaLabel() ? null : id() + '-label ' + id()"
        [attr.aria-label]="ariaLabel() || null"
        [attr.aria-activedescendant]="open() && activeIndex() >= 0 ? optionId(activeIndex()) : null"
        [attr.aria-disabled]="disabled() || null"
        [attr.aria-invalid]="invalid() ? true : null"
        [attr.aria-describedby]="describedBy()"
        [class]="triggerClass()"
        (click)="toggle()"
        (keydown)="onKey($event)"
      >
        <span class="min-w-0 flex-1 truncate" [class.ls-pr]="showRemove()">{{ display() }}</span>
        @if (variant() === 'pill' && badge() !== null) {
          <span class="sd-count" aria-hidden="true">{{ badge() }}</span>
        }
        <sd-icon name="chevron-down" [size]="20" class="shrink-0 text-slate transition-transform" [class.rotate-180]="open()" />
      </div>
      @if (showRemove()) {
        <button
          type="button"
          class="ls-x absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-slate transition-colors hover:text-alert focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [attr.aria-label]="'Remove ' + display()"
          (click)="remove()"
        >
          <sd-icon name="x" [size]="14" />
        </button>
      }
      <ul
        role="listbox"
        [id]="id() + '-listbox'"
        [attr.aria-labelledby]="ariaLabel() ? null : id() + '-label'"
        [attr.aria-label]="ariaLabel() || null"
        tabindex="-1"
        class="ls-panel absolute left-0 right-0 top-full z-30 mt-1 overflow-y-auto rounded-2xl border-[0.5px] border-haze bg-white py-2 shadow-overlay"
        [hidden]="!open()"
      >
        @for (o of rows(); track $index; let i = $index) {
          <li
            role="option"
            [id]="optionId(i)"
            [attr.aria-selected]="isSelected(o)"
            [attr.aria-disabled]="o.disabled || o.placeholder || null"
            class="ls-row flex items-center gap-2 px-4 py-2 font-sans text-body"
            [class]="rowClass(o, i)"
            tabindex="-1"
            (pointerdown)="$event.preventDefault()"
            (click)="pick(i)"
            (keydown.enter)="pick(i)"
            (pointermove)="hover(i)"
          >
            <span class="min-w-0 flex-1">{{ o.label }}</span>
            @if (isSelected(o)) {
              <sd-icon name="check" [size]="16" class="shrink-0 text-cerulean-dark" />
            }
          </li>
        }
      </ul>
    </div>
    @if (invalid(); as msg) {
      <p [id]="id() + '-error'" class="font-sans text-caption text-alert-ink">{{ msg }}</p>
    } @else if (helper()) {
      <p [id]="id() + '-helper'" class="font-sans text-caption text-slate">{{ helper() }}</p>
    }
  `,
})
export class LabSelect {
  readonly id = input.required<string>();
  readonly label = input('');
  readonly options = input<readonly LabSelectOption[]>([]);
  readonly value = input<string | null>(null);
  readonly placeholder = input('Select');
  /** Shows a ✕ for the current value. */
  readonly removable = input(false);
  readonly disabled = input(false);
  readonly helper = input<string | undefined>(undefined);
  /** An error message under the field (and `aria-invalid`). */
  readonly invalid = input<string | null>(null);
  /** The full-width (517) panel; the panel always matches the field's width. */
  readonly wide = input(false);
  /** The non-selectable "Select" row at the top of the list. */
  readonly placeholderRow = input(true);
  /** `pill`: the list page's status filter. */
  readonly variant = input<'field' | 'pill'>('field');
  /** Accessible name when there is no visible label (`pill`). */
  readonly ariaLabel = input<string | null>(null);
  /** A count in a small Cerulean badge (`pill` only; null hides it). */
  readonly badge = input<number | null>(null);

  readonly valueChange = output<string>();
  readonly removed = output<void>();

  private readonly trigger = viewChild.required<ElementRef<HTMLElement>>('trigger');
  private readonly wrap = viewChild.required<ElementRef<HTMLElement>>('wrap');

  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);
  private typed = '';
  private typedAt = 0;

  protected readonly rows = computed(() => {
    const opts = this.options().map((o) => ({ ...o, placeholder: false }));
    return this.placeholderRow() ? [{ value: '', label: this.placeholder(), placeholder: true, disabled: true }, ...opts] : opts;
  });

  protected readonly chosen = computed(() => this.options().find((o) => o.value === this.value()) ?? null);
  protected readonly display = computed(() => this.chosen()?.label ?? this.placeholder());
  protected readonly showRemove = computed(() => this.removable() && !!this.chosen() && !this.disabled());

  protected readonly describedBy = computed(() => {
    if (this.invalid()) return this.id() + '-error';
    return this.helper() ? this.id() + '-helper' : null;
  });

  protected readonly triggerClass = computed(() => {
    const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';
    if (this.variant() === 'pill') {
      return `ls-pill flex cursor-pointer items-center gap-2 rounded-[32px] border border-haze bg-snow px-4 font-sans text-body-sm text-ink shadow-bar ${focus}`;
    }
    const border = this.invalid() ? 'border-alert' : 'border-ash';
    const state = this.disabled() ? 'ls-disabled' : 'cursor-pointer bg-white';
    return `ls-box flex items-center gap-2 rounded-lg border ${border} ${state} px-2 font-sans text-body-sm text-slate ${focus}`;
  });

  protected optionId(i: number): string {
    return `${this.id()}-opt-${i}`;
  }

  protected isSelected(o: { value: string; placeholder: boolean }): boolean {
    return !o.placeholder && o.value === this.value();
  }

  protected rowClass(o: { disabled?: boolean; placeholder: boolean }, i: number): string {
    if (o.placeholder || o.disabled) return 'cursor-default text-slate';
    return i === this.activeIndex() ? 'cursor-pointer bg-glacier text-cerulean-dark' : 'cursor-pointer text-ink';
  }

  /** Open (or close) from a click on the box. */
  protected toggle(): void {
    if (this.disabled()) return;
    if (this.open()) this.close();
    else this.show();
  }

  private selectable(i: number): boolean {
    const r = this.rows()[i];
    return !!r && !r.placeholder && !r.disabled;
  }

  private firstSelectable(from: number, step: 1 | -1): number {
    const n = this.rows().length;
    for (let i = from; i >= 0 && i < n; i += step) if (this.selectable(i)) return i;
    return -1;
  }

  private show(at?: number): void {
    this.open.set(true);
    const current = this.rows().findIndex((r) => !r.placeholder && r.value === this.value());
    const start = at ?? (current >= 0 ? current : this.firstSelectable(0, 1));
    this.setActive(start);
  }

  private close(): void {
    this.open.set(false);
    this.activeIndex.set(-1);
  }

  private setActive(i: number): void {
    this.activeIndex.set(i);
    if (i < 0) return;
    // Keep the active row in view (no-op where layout isn't available).
    queueMicrotask(() => {
      const el = this.wrap().nativeElement.ownerDocument.getElementById(this.optionId(i));
      el?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  protected hover(i: number): void {
    if (this.selectable(i) && this.activeIndex() !== i) this.activeIndex.set(i);
  }

  protected pick(i: number): void {
    if (!this.selectable(i)) return;
    const value = this.rows()[i].value;
    this.close();
    this.trigger().nativeElement.focus();
    this.valueChange.emit(value);
  }

  protected remove(): void {
    this.removed.emit();
    this.trigger().nativeElement.focus();
  }

  protected onDocPointer(event: Event): void {
    if (!this.open()) return;
    const target = event.target as Node | null;
    if (target && this.wrap().nativeElement.contains(target)) return;
    this.close();
  }

  protected onKey(event: KeyboardEvent): void {
    if (this.disabled()) return;
    const key = event.key;
    const open = this.open();
    const n = this.rows().length;
    if (!open) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        this.show();
        return;
      }
      if (key === 'Home') {
        event.preventDefault();
        this.show(this.firstSelectable(0, 1));
        return;
      }
      if (key === 'End') {
        event.preventDefault();
        this.show(this.firstSelectable(n - 1, -1));
        return;
      }
      if (this.isPrintable(event)) {
        event.preventDefault();
        this.show();
        this.typeAhead(key);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = this.firstSelectable(this.activeIndex() + 1, 1);
        if (next >= 0) this.setActive(next);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (event.altKey) {
          if (this.activeIndex() >= 0) this.pick(this.activeIndex());
          else this.close();
          return;
        }
        const prev = this.firstSelectable(this.activeIndex() - 1, -1);
        if (prev >= 0) this.setActive(prev);
        return;
      }
      case 'Home':
        event.preventDefault();
        this.setActive(this.firstSelectable(0, 1));
        return;
      case 'End':
        event.preventDefault();
        this.setActive(this.firstSelectable(n - 1, -1));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (key === ' ' && this.typed && Date.now() - this.typedAt < TYPE_AHEAD_MS) {
          this.typeAhead(key);
          return;
        }
        if (this.activeIndex() >= 0) this.pick(this.activeIndex());
        else this.close();
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      case 'Tab':
        this.close();
        return;
      default:
        if (this.isPrintable(event)) {
          event.preventDefault();
          this.typeAhead(key);
        }
    }
  }

  private isPrintable(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ';
  }

  /** Jump to the next row starting with the letters typed (within half a second). */
  private typeAhead(char: string): void {
    const now = Date.now();
    this.typed = now - this.typedAt < TYPE_AHEAD_MS ? this.typed + char.toLowerCase() : char.toLowerCase();
    this.typedAt = now;
    const rows = this.rows();
    const n = rows.length;
    const start = this.activeIndex();
    const same = this.typed.split('').every((c) => c === this.typed[0]);
    const needle = same ? this.typed[0] : this.typed;
    // Repeating one letter cycles through the rows starting with it.
    const from = same || this.typed.length === 1 ? start + 1 : Math.max(start, 0);
    for (let k = 0; k < n; k++) {
      const i = (from + k + n) % n;
      if (this.selectable(i) && rows[i].label.toLowerCase().startsWith(needle)) {
        this.setActive(i);
        return;
      }
    }
  }

  /** Focus the combobox (the composer's Fix buttons). */
  focus(): void {
    this.trigger().nativeElement.focus();
  }
}
