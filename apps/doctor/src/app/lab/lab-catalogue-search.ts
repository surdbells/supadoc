import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import type { LabCatalogueItem } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { searchCatalogue } from './lab-composer-state';

/**
 * Search the active tab's catalogue (APG combobox with a listbox popup, in the
 * shared dropdown panel style). Every term must match the label, name, short
 * or a synonym; at most 8 rows; no free text. Enter / click adds the test,
 * clears the box and keeps focus here.
 */
@Component({
  selector: 'doc-lab-catalogue-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  // `id` is an input (the box's id): never also on the host, or the page has it twice.
  host: { class: 'block', '[attr.id]': 'null', '(document:pointerdown)': 'onDocPointer($event)' },
  styles: `
    .cs-pill {
      box-shadow: 0 4px 4px rgba(33, 150, 243, 0.1);
    }
    .cs-row {
      min-height: 40px;
    }
  `,
  template: `
    <div #wrap class="relative">
      <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate" />
      <input
        #box
        type="text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        [id]="id()"
        [attr.aria-label]="label()"
        [attr.aria-controls]="id() + '-listbox'"
        [attr.aria-expanded]="open()"
        [attr.aria-activedescendant]="open() && active() >= 0 && results().length ? id() + '-opt-' + active() : null"
        [placeholder]="placeholder()"
        class="cs-pill h-12 w-full rounded-[24px] border-[0.5px] border-haze bg-white pl-10 pr-4 font-sans text-caption text-ink placeholder:text-slate focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
        [value]="query()"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)"
        (focus)="open.set(query().trim() !== '')"
      />
      <ul
        role="listbox"
        [id]="id() + '-listbox'"
        [attr.aria-label]="label()"
        class="absolute left-0 right-0 top-full z-30 mt-1 overflow-y-auto rounded-2xl border-[0.5px] border-haze bg-white py-2 shadow-overlay"
        [hidden]="!open() || !query().trim()"
      >
        @for (item of results(); track item.code; let i = $index) {
          <li
            role="option"
            [id]="id() + '-opt-' + i"
            [attr.aria-selected]="i === active()"
            class="cs-row flex cursor-pointer items-center px-4 py-2 font-sans text-body"
            [class]="i === active() ? 'bg-glacier text-cerulean-dark' : 'text-ink'"
            tabindex="-1"
            (pointerdown)="$event.preventDefault()"
            (pointermove)="active.set(i)"
            (click)="choose(i)"
            (keydown.enter)="choose(i)"
          >
            {{ item.label }}
          </li>
        } @empty {
          <li role="option" aria-disabled="true" aria-selected="false" class="cs-row flex items-center px-4 py-2 font-sans text-body-sm text-slate">
            No tests match “{{ query().trim() }}”.
          </li>
        }
      </ul>
    </div>
  `,
})
export class LabCatalogueSearch {
  readonly id = input.required<string>();
  readonly items = input<readonly LabCatalogueItem[]>([]);
  readonly placeholder = input('');
  readonly label = input('Search tests');

  readonly picked = output<LabCatalogueItem>();

  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');
  private readonly wrap = viewChild.required<ElementRef<HTMLElement>>('wrap');

  protected readonly query = signal('');
  protected readonly open = signal(false);
  protected readonly active = signal(0);
  protected readonly results = computed(() => searchCatalogue(this.items(), this.query(), 8));

  protected onInput(value: string): void {
    this.query.set(value);
    this.active.set(0);
    this.open.set(value.trim() !== '');
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open()) this.open.set(this.query().trim() !== '');
        else if (n) this.active.set((this.active() + 1) % n);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (n) this.active.set((this.active() - 1 + n) % n);
        return;
      case 'Home':
        if (this.open() && n) {
          event.preventDefault();
          this.active.set(0);
        }
        return;
      case 'End':
        if (this.open() && n) {
          event.preventDefault();
          this.active.set(n - 1);
        }
        return;
      case 'Enter':
        if (this.open() && n) {
          event.preventDefault();
          this.choose(this.active());
        }
        return;
      case 'Escape':
        if (this.open()) {
          event.preventDefault();
          event.stopPropagation();
          this.open.set(false);
        } else if (this.query()) {
          event.preventDefault();
          this.query.set('');
        }
        return;
    }
  }

  protected choose(i: number): void {
    const item = this.results()[i];
    if (!item) return;
    this.query.set('');
    this.open.set(false);
    this.active.set(0);
    this.box().nativeElement.value = '';
    this.box().nativeElement.focus();
    this.picked.emit(item);
  }

  protected onDocPointer(event: Event): void {
    if (!this.open()) return;
    const t = event.target as Node | null;
    if (t && this.wrap().nativeElement.contains(t)) return;
    this.open.set(false);
  }

  /** Focus the search box (the composer's Fix buttons). */
  focus(): void {
    this.box().nativeElement.focus();
  }
}
