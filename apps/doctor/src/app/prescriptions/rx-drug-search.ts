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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DrugDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { catchError, debounceTime, EMPTY, map, of, Subject, switchMap } from 'rxjs';
import { RX_BAD, RX_FIELD, RX_OK } from './rx-shared';

/** The medicine currently chosen on a row. */
export interface RxChosenDrug {
  name: string;
  branded: boolean;
  dose_form: string | null;
  generic_name?: string | null;
}

/**
 * RxNorm medicine typeahead (an ARIA combobox + listbox). Typing never sets a
 * medicine — only choosing an entry from the list emits `picked`.
 */
@Component({
  selector: 'doc-rx-drug-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    @if (chosen(); as c) {
      <div
        class="flex items-start justify-between gap-3 rounded-field border bg-glacier/60 px-4 py-3"
        [class]="invalid() ? 'border-alert' : 'border-cloud'"
      >
        <div class="flex min-w-0 flex-col gap-1">
          <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ c.name }}</span>
          <span class="flex flex-wrap items-center gap-1.5 font-sans text-caption text-slate">
            @if (c.branded) {
              <span class="rounded-pill bg-warning/20 px-2 py-0.5 font-semibold text-ink">Brand</span>
            }
            @if (c.dose_form) {
              <span>{{ c.dose_form }}</span>
            }
            @if (c.branded && c.generic_name) {
              <span>· {{ c.generic_name }}</span>
            }
          </span>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-field px-2 py-1 font-sans text-caption font-semibold text-cerulean transition-colors hover:bg-frost/40 disabled:opacity-50"
          [disabled]="disabled()"
          [attr.aria-label]="'Change medicine: ' + c.name"
          (click)="change()"
        >
          Change
        </button>
      </div>
    } @else {
      <div class="relative">
        <sd-icon
          name="search"
          [size]="16"
          class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate"
        />
        <input
          #box
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-autocomplete="list"
          class="${RX_FIELD} pl-10"
          [class]="invalid() ? '${RX_BAD}' : '${RX_OK}'"
          [id]="inputId()"
          [attr.aria-expanded]="showList()"
          [attr.aria-controls]="listId()"
          [attr.aria-activedescendant]="activeId()"
          [attr.aria-invalid]="invalid() ? 'true' : null"
          [attr.aria-describedby]="describedBy()"
          [disabled]="disabled()"
          placeholder="Search by medicine name…"
          [value]="query()"
          (input)="onInput($any($event.target).value)"
          (keydown)="onKeydown($event)"
          (focus)="onFocus()"
          (blur)="open.set(false)"
        />
        @if (showList()) {
          <div
            class="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-card border border-cloud bg-white shadow-[0_12px_32px_rgba(10,22,40,0.12)]"
            (mousedown)="$event.preventDefault()"
          >
            @if (error()) {
              <p class="flex items-center gap-2 px-3 py-3 font-sans text-body-sm text-alert">
                <sd-icon name="circle-alert" [size]="16" class="shrink-0" /> {{ error() }}
              </p>
            } @else if (results().length === 0) {
              <p class="flex items-center gap-2 px-3 py-3 font-sans text-body-sm text-slate">
                @if (searching()) {
                  <sd-icon name="loader-circle" [size]="16" class="shrink-0 animate-spin" /> Searching…
                } @else {
                  No medicines match “{{ query().trim() }}”. Try the generic name.
                }
              </p>
            }
            <ul
              role="listbox"
              aria-label="Matching medicines"
              class="max-h-72 overflow-y-auto py-1"
              [id]="listId()"
              [class.hidden]="results().length === 0 || !!error()"
              [attr.aria-busy]="stale() ? 'true' : null"
            >
              @for (d of results(); track d.rxcui; let i = $index) {
                <!-- Focus stays on the text box (aria-activedescendant); tabindex -1 keeps options out of the tab order.
                     Results for an older search are greyed out and cannot be chosen until the new ones arrive. -->
                <li
                  role="option"
                  tabindex="-1"
                  class="px-3 py-2 transition-colors"
                  [class]="stale() ? 'cursor-wait opacity-50' : i === active() ? 'cursor-pointer bg-frost/50' : 'cursor-pointer hover:bg-glacier'"
                  [id]="optionId(i)"
                  [attr.aria-selected]="!stale() && i === active()"
                  [attr.aria-disabled]="stale() ? 'true' : null"
                  (mouseenter)="!stale() && active.set(i)"
                  (click)="pickAt(i)"
                  (keydown.enter)="pickAt(i)"
                >
                  <span class="block font-sans text-body-sm text-ink">{{ d.name }}</span>
                  <span class="mt-0.5 flex flex-wrap items-center gap-1.5 font-sans text-caption text-slate">
                    @if (d.branded) {
                      <span class="rounded-pill bg-warning/20 px-2 py-0.5 font-semibold text-ink">Brand</span>
                    }
                    @if (d.dose_form) {
                      <span>{{ d.dose_form }}</span>
                    }
                    @if (d.branded && d.generic_name) {
                      <span>· {{ d.generic_name }}</span>
                    }
                  </span>
                </li>
              }
            </ul>
            @if (searching() && results().length > 0) {
              <p class="border-t border-cloud px-3 py-1.5 font-sans text-caption text-slate">Updating…</p>
            }
          </div>
        }
      </div>
      @if (query().trim() !== '' && !showList()) {
        <p class="mt-1 flex items-center gap-1.5 font-sans text-caption text-ink">
          <sd-icon name="triangle-alert" [size]="13" class="shrink-0 text-warning" /> Choose the medicine from the list
        </p>
      }
      <span class="sr-only" aria-live="polite">{{ liveMessage() }}</span>
    }
  `,
})
export class RxDrugSearch {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  /** id for the text box (so a <label for> can point at it). */
  readonly inputId = input.required<string>();
  /** The medicine chosen on this row, or null to show the search box. */
  readonly chosen = input<RxChosenDrug | null>(null);
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);
  readonly disabled = input(false);

  /** A medicine was chosen from the list. */
  readonly picked = output<DrugDto>();
  /** "Change" was pressed on the chosen medicine. */
  readonly cleared = output<void>();
  /** The typed search text (never a chosen medicine). */
  readonly queryChange = output<string>();

  protected readonly query = signal('');
  protected readonly results = signal<DrugDto[]>([]);
  /** The (trimmed) search text `results` belong to. */
  private readonly resultsFor = signal('');
  protected readonly open = signal(false);
  protected readonly searching = signal(false);
  protected readonly error = signal('');
  protected readonly active = signal(-1);

  protected readonly listId = computed(() => `${this.inputId()}-list`);
  protected readonly showList = computed(
    () => this.open() && this.query().trim().length >= 2,
  );
  /**
   * The list on screen is for an older search (the doctor kept typing): it
   * stays visible but cannot be chosen from, so Enter never picks e.g. a
   * 125 mg product while "amoxicillin 500" is still being looked up.
   */
  protected readonly stale = computed(
    () => this.searching() || this.resultsFor() !== this.query().trim(),
  );
  protected readonly activeId = computed(() =>
    this.showList() && !this.stale() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );
  protected readonly liveMessage = computed(() => {
    if (!this.showList() || this.stale()) return '';
    const n = this.results().length;
    return n === 0 ? 'No matching medicines' : `${n} matching medicine${n === 1 ? '' : 's'}. Use the arrow keys to choose.`;
  });

  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');
  private readonly terms$ = new Subject<string>();

  constructor() {
    this.terms$
      .pipe(
        debounceTime(250),
        map((q) => q.trim()),
        switchMap((q) => {
          if (q.length < 2) return EMPTY;
          this.searching.set(true);
          return this.api.searchDrugs(q, 20).pipe(
            map((res) => ({ q, items: res.data, err: '' })),
            catchError((err: unknown) =>
              of({
                q,
                items: [] as DrugDto[],
                err: apiErrorMessage(err, 'Could not search medicines. Please try again.'),
              }),
            ),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ q, items, err }) => {
        const current = q === this.query().trim();
        // A newer search is still queued (debounce) when the text moved on.
        this.searching.set(!current);
        this.error.set(current ? err : '');
        this.results.set(items);
        this.resultsFor.set(q);
        // Only highlight the first entry for results that match what is typed.
        if (current) this.active.set(items.length > 0 ? 0 : -1);
      });
  }

  protected optionId(i: number): string {
    return `${this.inputId()}-opt-${i}`;
  }

  protected onInput(value: string): void {
    this.query.set(value);
    this.queryChange.emit(value);
    this.open.set(true);
    this.error.set('');
    if (value.trim().length < 2) {
      this.results.set([]);
      this.resultsFor.set('');
      this.searching.set(false);
      this.active.set(-1);
    } else {
      this.searching.set(true);
      // The highlighted entry belonged to the previous search.
      if (value.trim() !== this.resultsFor()) this.active.set(-1);
    }
    this.terms$.next(value);
  }

  protected onFocus(): void {
    if (this.query().trim().length >= 2) this.open.set(true);
  }

  protected onKeydown(e: KeyboardEvent): void {
    // Results for an older search can be seen but not chosen.
    const n = this.stale() ? 0 : this.results().length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!this.open()) {
          this.open.set(true);
          return;
        }
        if (n > 0) this.setActive(Math.min(this.active() + 1, n - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n > 0) this.setActive(Math.max(this.active() - 1, 0));
        break;
      case 'Enter':
        // Never submit the surrounding form from here; only a current result is picked.
        if (this.showList()) {
          e.preventDefault();
          this.pickAt(this.active());
        }
        break;
      case 'Escape':
        if (this.open()) {
          e.preventDefault();
          e.stopPropagation();
          this.open.set(false);
        }
        break;
      case 'Tab':
        this.open.set(false);
        break;
    }
  }

  /** Choose the i-th result — only when the list matches what is typed now. */
  protected pickAt(i: number): void {
    if (this.stale()) return;
    const d = this.results()[i];
    if (d) this.pick(d);
  }

  protected pick(d: DrugDto): void {
    this.picked.emit(d);
    this.query.set('');
    this.queryChange.emit('');
    this.results.set([]);
    this.resultsFor.set('');
    this.open.set(false);
    this.active.set(-1);
  }

  protected change(): void {
    this.cleared.emit();
    // The text box only exists once the parent has cleared the choice and re-rendered.
    afterNextRender(() => this.box()?.nativeElement.focus(), { injector: this.injector });
  }

  private setActive(i: number): void {
    this.active.set(i);
    const el = document.getElementById(this.optionId(i));
    el?.scrollIntoView({ block: 'nearest' });
  }
}
