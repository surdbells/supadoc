import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  forwardRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { IconComponent } from '@supadoc/ui';
import { onbControl } from './ui-classes';

/**
 * Languages (D24): a disclosure button showing the chosen values ("English,
 * Yoruba") or "Select", opening a panel with a fieldset of native checkboxes.
 * Up to `max` choices; then the unchecked boxes are disabled and a hint says
 * so. Esc (or a click outside) closes it and focus returns to the button;
 * tabbing out of it closes it too.
 * No listbox role: checkboxes inside a listbox are invalid ARIA.
 */
@Component({
  selector: 'onb-multi-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MultiSelectComponent), multi: true }],
  host: { class: 'relative block', '(document:click)': 'onDocClick($event)', '(focusout)': 'onFocusOut($event)' },
  template: `
    <button
      #trigger
      type="button"
      [id]="inputId()"
      [class]="triggerClass()"
      [disabled]="disabled()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId()"
      [attr.aria-describedby]="describedBy()"
      [attr.aria-invalid]="invalid() || null"
      (click)="toggle()"
      (keydown.escape)="close(true)"
    >
      <span class="min-w-0 flex-1 truncate text-left" [class]="selected().length ? 'text-ink' : 'text-slate'">
        {{ selected().length ? selected().join(', ') : placeholder() }}
      </span>
      <sd-icon
        name="chevron-down"
        [size]="20"
        [strokeWidth]="1.5"
        class="shrink-0 text-slate transition-transform"
        [class.rotate-180]="open()"
      />
    </button>
    @if (open()) {
      <!-- tabindex -1: a click on the legend or a label's text keeps focus inside (it does not count as leaving). -->
      <div
        [id]="panelId()"
        tabindex="-1"
        class="absolute left-0 right-0 z-30 mt-2 max-h-72 overflow-y-auto rounded-card border border-haze bg-white p-3 shadow-overlay focus:outline-none"
      >
        <fieldset>
          <legend class="mb-2 font-sans text-body-sm font-medium text-ink">{{ legend() }}</legend>
          <div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
            @for (option of options(); track option; let i = $index) {
              <label
                class="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 font-sans text-body-sm text-ink hover:bg-glacier has-[:disabled]:cursor-not-allowed has-[:disabled]:text-slate"
              >
                <input
                  type="checkbox"
                  class="size-[18px] shrink-0 accent-cerulean"
                  [checked]="isChecked(option)"
                  [disabled]="!isChecked(option) && full()"
                  (change)="toggleOption(option, $event)"
                  (keydown.escape)="close(true)"
                />
                {{ option }}
              </label>
            }
          </div>
          @if (full()) {
            <p class="mt-2 font-label text-caption text-slate" role="status">You can choose up to {{ max() }}.</p>
          }
        </fieldset>
      </div>
    }
  `,
})
export class MultiSelectComponent implements ControlValueAccessor {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly inputId = input.required<string>();
  readonly options = input<readonly string[]>([]);
  readonly max = input(5);
  readonly placeholder = input('Select');
  readonly legend = input('Languages, choose up to 5');
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);

  protected readonly open = signal(false);
  protected readonly disabled = signal(false);
  protected readonly selected = signal<string[]>([]);
  protected readonly full = computed(() => this.selected().length >= this.max());
  protected readonly panelId = computed(() => `${this.inputId()}-panel`);
  protected readonly triggerClass = computed(
    () => `${onbControl(this.invalid())} flex items-center gap-2 text-left disabled:cursor-not-allowed`,
  );

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  private onChange: (value: string[]) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  protected isChecked(option: string): boolean {
    return this.selected().includes(option);
  }

  protected toggle(): void {
    if (this.open()) this.close(false);
    else this.open.set(true);
  }

  close(refocus: boolean): void {
    if (!this.open()) return;
    this.open.set(false);
    this.onTouched();
    if (refocus) this.trigger().nativeElement.focus();
  }

  protected toggleOption(option: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.selected();
    const next = checked
      ? [...current, option].slice(0, this.max())
      : current.filter((o) => o !== option);
    // Keep the list order (English, Yoruba…), whatever order they were ticked in.
    const ordered = this.options().filter((o) => next.includes(o));
    this.selected.set(ordered);
    this.onChange(ordered);
  }

  protected onDocClick(event: MouseEvent): void {
    if (this.open() && event.target instanceof Node && !this.host.nativeElement.contains(event.target)) {
      this.close(false);
    }
  }

  /**
   * Tab (or Shift+Tab) out of the panel closes it, so it never covers the
   * control that now has focus (WCAG 2.4.11). Focus going nowhere (a click on
   * the page, the window losing focus) is left to the document click.
   */
  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (this.open() && next instanceof Node && !this.host.nativeElement.contains(next)) this.close(false);
  }

  writeValue(value: string[] | null): void {
    this.selected.set(Array.isArray(value) ? [...value] : []);
  }
  registerOnChange(fn: (value: string[]) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }
}
