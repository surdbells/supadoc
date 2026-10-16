import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { tap, type Subscription } from 'rxjs';
import { StaffAuthService, type HasUnsavedChanges } from '@supadoc/auth';
import { apiErrorFields, apiErrorMessage, ReferenceApi } from '@supadoc/data-access';
import type { ReferenceItemDto } from '@supadoc/models';
import type { LeaveCopy } from '@supadoc/ui';
import { AlertComponent, DialogService, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { afterDialogCloses, focusIfLost } from '../shared/after-dialog';
import {
  BTN_BESIDE_FIELD,
  BTN_ICON,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD_ITEM,
  CHIP,
  COUNT_BADGE,
  EMPTY_FRAME,
  FIELD,
  FIELD_ERROR,
  FIELD_INVALID,
  FIELD_STACK,
  FILTER_CHIP,
  FILTER_CHIP_OFF,
  FILTER_CHIP_ON,
  FILTER_CHIPS,
  FOCUS_RING,
  LABEL,
  LIST_BODY,
  LIST_FRAME,
  LIST_HEAD,
  PAGE_HEADER_TEXT,
  PAGE_NARROW,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PAGE_TITLE_ROW,
  PILL,
  SEARCH_BOX,
  SEARCH_CLEAR,
  SEARCH_ICON,
  SEARCH_INPUT,
  SEARCH_WRAP,
  SECTION,
  SECTION_SUBTITLE,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED,
} from '../shared/layout';
import {
  capitalise,
  countOf,
  duplicateOf,
  filterItems,
  moveItem,
  REFERENCE_LABEL_MAX,
  REFERENCE_LISTS,
  type ReferenceListDef,
  type ReferenceShow,
  tidyLabel,
} from './reference-list';

/**
 * Desktop (md+) columns, shared by the header row and every item row:
 * Order | Name | Status (on / off + use) | Actions. Sized for the narrow
 * settings column (`PAGE_NARROW`: 680–728px inside a row).
 */
const COLUMNS = 'md:grid-cols-[6.5rem_minmax(0,1fr)_9rem_8rem]';

/** Below md each row is its own card; on md+ it is a divided row of the list frame. */
const ROW = CARD_ITEM + ' md:grid md:items-center md:gap-4 md:rounded-none md:border-0 md:px-5 md:py-4 md:shadow-none';

/** Up / down: 44px to touch, 36px in the desktop list. */
const MOVE_BTN = BTN_ICON + ' md:size-9 disabled:hover:border-cloud disabled:hover:text-slate';

/** Row actions: words on phones, icon-only (named for screen readers, with a tooltip) from md. */
const ACTION_BTN =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-field border bg-white px-3 py-2 font-sans text-caption font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 md:size-9 md:min-h-0 md:p-0 ' +
  FOCUS_RING;
const ACTION_LABEL = 'md:sr-only';

/** The rename form's compact buttons (36px in the desktop list). */
const SAVE_BTN =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60 md:min-h-9 ' +
  FOCUS_RING;
const CANCEL_BTN =
  'inline-flex min-h-11 items-center justify-center rounded-field px-3 py-2 font-sans text-caption font-semibold text-slate transition-colors hover:bg-glacier hover:text-ink disabled:opacity-60 md:min-h-9 ' +
  FOCUS_RING;

const SHOWS: readonly { value: ReferenceShow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Switched off' },
];

function byOrder(list: readonly ReferenceItemDto[]): ReferenceItemDto[] {
  return [...list].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
}

/**
 * Reference data (route `/reference-data`, needs `settings.manage`) — the
 * back-office-managed pick lists, one tab each (Specialties for now). For the
 * open list: add an item, search, rename in place (a rename relabels every
 * doctor who has it — confirmed first when any do), move up / down (buttons,
 * so it works from the keyboard), switch on / off (a switched-off item is no
 * longer offered but stays on the records that have it) and delete an unused
 * one. Each item shows how many doctors use it. Every change is audited by
 * the API; confirmations go through DialogService, and outcomes are read out
 * from one permanent live region.
 */
@Component({
  selector: 'bo-reference-data',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, EmptyStateComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE_NARROW}">
      <header class="${PAGE_HEADER_TEXT}">
        <div class="${PAGE_TITLE_ROW}">
          <h1 class="${PAGE_TITLE}">Reference data</h1>
          @if (!loading() && !loadError()) {
            <span class="${COUNT_BADGE}">
              <sd-icon [name]="list().icon" [size]="14" />{{ countOf(items().length, list().one, list().many) }}
            </span>
          }
        </div>
        <p class="${PAGE_SUBTITLE}">The pick lists people choose from across VideoMed. Switch an item off to stop it being offered without changing the records that already have it.</p>
      </header>

      <!-- One tab per list. -->
      <div class="${SEGMENTED}" role="tablist" aria-label="Pick lists">
        @for (l of lists; track l.category; let i = $index) {
          <button
            #tabButton
            type="button"
            role="tab"
            [id]="'bo-ref-tab-' + l.category"
            [attr.aria-selected]="list().category === l.category"
            [attr.aria-controls]="list().category === l.category ? 'bo-ref-panel' : null"
            [tabIndex]="list().category === l.category ? 0 : -1"
            class="${SEGMENT}"
            [class]="list().category === l.category ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'"
            (click)="selectList(l)"
            (keydown)="onTabKeydown($event, i)"
          >
            <sd-icon [name]="l.icon" [size]="16" />{{ l.tab }}
          </button>
        }
      </div>

      <section id="bo-ref-panel" role="tabpanel" [attr.aria-labelledby]="'bo-ref-tab-' + list().category" class="flex flex-col gap-6">
        <p class="${SECTION_SUBTITLE}">{{ list().about }}</p>

        <!-- Add -->
        <form class="${SECTION}" novalidate (submit)="$event.preventDefault(); add()" aria-labelledby="bo-ref-add-label">
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label class="${FIELD_STACK} flex-1">
                <span id="bo-ref-add-label" class="${LABEL}">Add a {{ list().one }}</span>
                <input
                  #addInput
                  type="text"
                  autocomplete="off"
                  class="${FIELD}"
                  [class]="addError() ? '${FIELD_INVALID}' : ''"
                  [attr.maxlength]="max"
                  [placeholder]="list().example"
                  [value]="newLabel()"
                  (input)="setNewLabel($any($event.target).value)"
                  [attr.aria-invalid]="addError() ? 'true' : null"
                  [attr.aria-describedby]="addError() ? 'bo-ref-add-err' : null"
                />
              </label>
              <button type="submit" class="${BTN_PRIMARY} ${BTN_BESIDE_FIELD}" [disabled]="adding() || loading() || !!loadError()">
                <sd-icon [name]="adding() ? 'loader-circle' : 'plus'" [size]="18" [class.animate-spin]="adding()" />{{ adding() ? 'Adding…' : 'Add ' + list().one }}
              </button>
            </div>
            @if (addError(); as e) {
              <span id="bo-ref-add-err" class="${FIELD_ERROR}">{{ e }}</span>
            }
          </div>
          @if (offerSwitchOn(); as off) {
            <button type="button" class="${BTN_SECONDARY} w-full sm:w-fit" [disabled]="isBusy(off.id)" (click)="switchOn(off, true)">
              <sd-icon name="eye" [size]="16" />Switch “{{ off.label }}” back on
            </button>
          }
        </form>

        <!-- Search + show, then the outcome of the last action. -->
        <div class="flex flex-col">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div role="search" class="${SEARCH_WRAP} min-w-0">
              <label for="bo-ref-search" class="sr-only">Search {{ list().many }}</label>
              <div class="${SEARCH_BOX}">
                <sd-icon name="search" [size]="20" class="${SEARCH_ICON}" />
                <input
                  id="bo-ref-search"
                  type="search"
                  autocomplete="off"
                  spellcheck="false"
                  class="${SEARCH_INPUT}"
                  [placeholder]="'Search ' + list().many + '…'"
                  [value]="search()"
                  (input)="search.set($any($event.target).value)"
                  (keydown.escape)="search.set('')"
                />
                @if (search()) {
                  <button type="button" class="${SEARCH_CLEAR}" aria-label="Clear search" (click)="clearSearch()">
                    <sd-icon name="x" [size]="16" />
                  </button>
                }
              </div>
            </div>
            <div class="${FILTER_CHIPS} md:shrink-0" role="group" aria-label="Show">
              @for (s of shows(); track s.value) {
                <button
                  type="button"
                  [attr.aria-pressed]="show() === s.value"
                  class="${FILTER_CHIP}"
                  [class]="show() === s.value ? '${FILTER_CHIP_ON}' : '${FILTER_CHIP_OFF}'"
                  (click)="show.set(s.value)"
                >
                  {{ s.label }}
                  <span class="rounded-pill px-1.5 text-caption font-semibold" [class]="show() === s.value ? 'bg-white/20' : 'bg-glacier'">{{ s.count }}</span>
                </button>
              }
            </div>
          </div>

          <!--
            One permanent live region, so what an action did is read out: moves
            in the visually hidden line, other outcomes in the alerts (inserted
            into a region that is already on the page). Block layout with
            margins on the alerts: no empty gap when there is nothing to say.
          -->
          <div aria-live="polite">
            <p class="sr-only">{{ announcement() }}</p>
            @if (notice(); as n) {
              <sd-alert class="mt-4" tone="success">{{ n }}</sd-alert>
            }
            @if (info(); as m) {
              <sd-alert class="mt-4" tone="info">{{ m }}</sd-alert>
            }
            @if (actionError(); as e) {
              <sd-alert class="mt-4" tone="error">{{ e }}</sd-alert>
            }
          </div>
        </div>

        @if (loading() && items().length === 0) {
          <div class="${LIST_FRAME}" aria-busy="true">
            <span class="sr-only" role="status">Loading {{ list().many }}…</span>
            <ul class="${LIST_BODY}" aria-hidden="true">
              @for (i of skeleton; track i) {
                <li class="${ROW} ${COLUMNS}">
                  <div class="sd-shimmer h-9 w-24 rounded-field"></div>
                  <div class="flex flex-col gap-2">
                    <div class="sd-shimmer h-4 w-40 max-w-full rounded-pill"></div>
                    <div class="sd-shimmer h-3 w-24 rounded-pill"></div>
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <div class="sd-shimmer h-6 w-20 rounded-pill"></div>
                    <div class="sd-shimmer h-6 w-24 rounded-pill"></div>
                  </div>
                  <div class="sd-shimmer h-9 w-28 rounded-field"></div>
                </li>
              }
            </ul>
          </div>
        } @else if (loadError()) {
          <div class="${EMPTY_FRAME}" role="alert">
            <sd-empty-state icon="wifi-off" tone="error" [title]="'Could not load the ' + list().many" [message]="loadError()">
              <button type="button" class="${BTN_SECONDARY}" (click)="load()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
            </sd-empty-state>
          </div>
        } @else if (items().length === 0) {
          <div class="${EMPTY_FRAME}">
            <sd-empty-state [icon]="list().icon" tone="brand" [title]="'No ' + list().many + ' yet'" [message]="'Add the first one above. Until the list has items, the forms accept any ' + list().one + '.'" />
          </div>
        } @else {
          <div class="flex flex-col gap-4">
            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <p #summary tabindex="-1" class="font-sans text-body-sm text-slate focus:outline-none">{{ summaryText() }}</p>
              @if (!canReorder()) {
                <p class="flex items-center gap-1.5 font-sans text-caption text-slate"><sd-icon name="info" [size]="14" />Clear the search and show all to change the order.</p>
              }
            </div>

            @if (visible().length === 0) {
              <div class="${EMPTY_FRAME}">
                <sd-empty-state icon="search" [title]="emptyTitle()" message="Check the spelling, or show all items.">
                  <button type="button" class="${BTN_SECONDARY}" (click)="clearSearch(); show.set('all')"><sd-icon name="x" [size]="16" />Clear search and filter</button>
                </sd-empty-state>
              </div>
            } @else {
              <section class="${LIST_FRAME}" [attr.aria-label]="list().tab" [attr.aria-busy]="loading() || null">
                <div class="${LIST_HEAD} ${COLUMNS}" aria-hidden="true">
                  <span>Order</span>
                  <span>Name</span>
                  <span>Status</span>
                  <span class="text-right">Actions</span>
                </div>
                <ul class="${LIST_BODY}">
                  @for (it of visible(); track it.id) {
                    <li class="${ROW} ${COLUMNS}">
                      <!-- Order -->
                      <div class="flex items-center justify-between gap-2 md:justify-start">
                        <span class="font-sans text-caption font-semibold tabular-nums text-slate">
                          <span class="md:sr-only">Position </span>{{ position(it) }}<span class="sr-only"> of {{ items().length }}</span>
                        </span>
                        <span class="flex items-center gap-1">
                          <button
                            type="button"
                            [id]="'bo-ref-up-' + it.id"
                            class="${MOVE_BTN}"
                            [disabled]="!canReorder() || position(it) === 1"
                            [attr.aria-label]="'Move ' + it.label + ' up'"
                            title="Move up"
                            (click)="move(it, -1)"
                          >
                            <sd-icon name="arrow-up" [size]="16" />
                          </button>
                          <button
                            type="button"
                            [id]="'bo-ref-down-' + it.id"
                            class="${MOVE_BTN}"
                            [disabled]="!canReorder() || position(it) === items().length"
                            [attr.aria-label]="'Move ' + it.label + ' down'"
                            title="Move down"
                            (click)="move(it, 1)"
                          >
                            <sd-icon name="arrow-down" [size]="16" />
                          </button>
                        </span>
                      </div>

                      <!-- Name (or the rename field) -->
                      <div class="min-w-0">
                        @if (editingId() === it.id) {
                          <form class="flex flex-col gap-2" novalidate (submit)="$event.preventDefault(); saveRename(it)">
                            <label class="sr-only" [for]="'bo-ref-edit-' + it.id">New name for {{ it.label }}</label>
                            <input
                              [id]="'bo-ref-edit-' + it.id"
                              type="text"
                              autocomplete="off"
                              class="${FIELD}"
                              [class]="editError() ? '${FIELD_INVALID}' : ''"
                              [attr.maxlength]="max"
                              [value]="editLabel()"
                              (input)="setEditLabel($any($event.target).value)"
                              (keydown.escape)="$event.preventDefault(); cancelRename(it)"
                              [attr.aria-invalid]="editError() ? 'true' : null"
                              [attr.aria-describedby]="editError() ? 'bo-ref-edit-err' : null"
                            />
                            @if (editError(); as e) {
                              <span id="bo-ref-edit-err" class="${FIELD_ERROR}">{{ e }}</span>
                            }
                            <span class="flex flex-wrap gap-2">
                              <button type="submit" class="${SAVE_BTN}" [disabled]="isBusy(it.id)">
                                <sd-icon [name]="isBusy(it.id) ? 'loader-circle' : 'check'" [size]="14" [class.animate-spin]="isBusy(it.id)" />{{ isBusy(it.id) ? 'Saving…' : 'Save name' }}
                              </button>
                              <button type="button" class="${CANCEL_BTN}" [disabled]="isBusy(it.id)" (click)="cancelRename(it)">Cancel</button>
                            </span>
                          </form>
                        } @else {
                          <span class="flex min-w-0 flex-col">
                            <span class="break-words font-heading text-body-lg" [class]="it.active ? 'text-ink' : 'text-slate'">{{ it.label }}</span>
                            <span class="truncate font-mono text-caption text-slate" [attr.title]="'Code: ' + it.code"><span class="sr-only">Code </span>{{ it.code }}</span>
                          </span>
                        }
                      </div>

                      <!-- Status: whether it is offered, and who uses it -->
                      <div class="flex flex-wrap items-center gap-2 md:flex-col md:items-start md:gap-1.5">
                        <span class="${PILL}" [class]="it.active ? 'bg-sage/15 text-sage' : 'bg-cloud text-slate'">
                          <sd-icon [name]="it.active ? 'circle-check' : 'eye-off'" [size]="13" />{{ it.active ? 'Active' : 'Switched off' }}
                        </span>
                        @if (it.usage_count > 0) {
                          <span class="${CHIP} bg-frost text-cerulean">
                            <sd-icon name="users" [size]="14" /><span class="sr-only">Used by </span>{{ countOf(it.usage_count, list().usedBy) }}
                          </span>
                        } @else {
                          <span class="${CHIP} bg-glacier text-slate">Not used</span>
                        }
                      </div>

                      <!-- Actions -->
                      <div class="flex flex-wrap items-center gap-2 border-t border-cloud pt-3 md:flex-nowrap md:justify-end md:border-0 md:pt-0">
                        <button
                          type="button"
                          [id]="'bo-ref-rename-' + it.id"
                          class="${ACTION_BTN} border-cloud text-cerulean hover:border-cerulean"
                          [disabled]="isBusy(it.id) || editingId() === it.id"
                          title="Rename"
                          (click)="startRename(it)"
                        >
                          <sd-icon name="pencil" [size]="16" /><span class="${ACTION_LABEL}">Rename<span class="sr-only"> {{ it.label }}</span></span>
                        </button>
                        <button
                          type="button"
                          [id]="'bo-ref-toggle-' + it.id"
                          class="${ACTION_BTN} border-cloud text-ink hover:border-cerulean"
                          [disabled]="isBusy(it.id)"
                          [attr.title]="it.active ? 'Switch off' : 'Switch on'"
                          (click)="it.active ? switchOff(it) : switchOn(it)"
                        >
                          <sd-icon [name]="isBusy(it.id) && editingId() !== it.id ? 'loader-circle' : (it.active ? 'eye-off' : 'eye')" [size]="16" [class.animate-spin]="isBusy(it.id) && editingId() !== it.id" />
                          <span class="${ACTION_LABEL}">{{ it.active ? 'Switch off' : 'Switch on' }}<span class="sr-only"> {{ it.label }}</span></span>
                        </button>
                        <button
                          type="button"
                          [id]="'bo-ref-delete-' + it.id"
                          class="${ACTION_BTN} border-alert/30 text-alert hover:bg-alert/5"
                          [disabled]="isBusy(it.id)"
                          title="Delete"
                          (click)="askDelete(it)"
                        >
                          <sd-icon name="trash-2" [size]="16" /><span class="${ACTION_LABEL}">Delete<span class="sr-only"> {{ it.label }}</span></span>
                        </button>
                      </div>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class AdminReferenceData implements OnInit, HasUnsavedChanges {
  private readonly api = inject(ReferenceApi);
  private readonly auth = inject(StaffAuthService);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);

  protected readonly lists = REFERENCE_LISTS;
  protected readonly max = REFERENCE_LABEL_MAX;
  protected readonly skeleton = [1, 2, 3, 4, 5];
  protected readonly countOf = countOf;

  /** The open list. */
  protected readonly list = signal<ReferenceListDef>(REFERENCE_LISTS[0]);
  /** Its items, in list order. */
  protected readonly items = signal<ReferenceItemDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');

  protected readonly search = signal('');
  protected readonly show = signal<ReferenceShow>('all');

  protected readonly newLabel = signal('');
  protected readonly adding = signal(false);
  protected readonly addError = signal('');
  /** A switched-off item the person tried to add again — offer to switch it back on. */
  protected readonly offerSwitchOn = signal<ReferenceItemDto | null>(null);

  protected readonly editingId = signal<string | null>(null);
  protected readonly editLabel = signal('');
  protected readonly editError = signal('');

  /** Items with a request in flight. */
  private readonly busyIds = signal<ReadonlySet<string>>(new Set());

  protected readonly notice = signal('');
  /** An explanation that is neither a success nor a failure (why an item can't be deleted). */
  protected readonly info = signal('');
  protected readonly actionError = signal('');
  protected readonly announcement = signal('');

  private loadSub?: Subscription;
  private reorderInFlight = false;
  private reorderQueued = false;

  private readonly addInput = viewChild<ElementRef<HTMLInputElement>>('addInput');
  private readonly summary = viewChild<ElementRef<HTMLElement>>('summary');
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  protected readonly visible = computed(() => filterItems(this.items(), this.search(), this.show()));

  /** Moving needs the whole list in view. */
  protected readonly canReorder = computed(() => this.search().trim() === '' && this.show() === 'all');

  protected readonly shows = computed(() => {
    const all = this.items();
    const active = all.filter((i) => i.active).length;
    const counts: Record<ReferenceShow, number> = { all: all.length, active, inactive: all.length - active };
    return SHOWS.map((s) => ({ ...s, count: counts[s.value] }));
  });

  protected readonly summaryText = computed(() => {
    const l = this.list();
    const all = this.items();
    const active = all.filter((i) => i.active).length;
    const off = all.length - active;
    const shown = this.visible().length;
    const base = `${countOf(all.length, l.one, l.many)} · ${active.toLocaleString('en-GB')} active` + (off > 0 ? ` · ${off.toLocaleString('en-GB')} switched off` : '');
    return shown === all.length ? base : `Showing ${shown.toLocaleString('en-GB')} of ${base}`;
  });

  protected readonly emptyTitle = computed(() => {
    const q = this.search().trim();
    const l = this.list();
    if (q) return `No ${l.many} match “${q}”`;
    return this.show() === 'inactive' ? `No switched-off ${l.many}` : `No active ${l.many}`;
  });

  ngOnInit(): void {
    this.load();
  }

  // ----- Loading -----

  protected load(): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    this.loadSub = this.api
      .list(this.list().category)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.set(byOrder(res.data ?? []));
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, `Could not load the ${this.list().many}.`));
          this.loading.set(false);
        },
      });
  }

  protected async selectList(l: ReferenceListDef): Promise<void> {
    if (l.category === this.list().category) return;
    if (this.hasUnsavedChanges() && !(await this.dialogs.confirmLeave(this.leaveCopy))) return;
    this.list.set(l);
    this.items.set([]);
    this.resetForms();
    this.search.set('');
    this.show.set('all');
    this.load();
  }

  protected onTabKeydown(event: KeyboardEvent, index: number): void {
    const last = this.lists.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    void this.selectList(this.lists[next]).then(() => this.tabButtons()[next]?.nativeElement.focus());
  }

  // ----- Add -----

  protected setNewLabel(value: string): void {
    this.newLabel.set(value);
    this.addError.set('');
    this.offerSwitchOn.set(null);
  }

  protected add(): void {
    if (this.adding()) return;
    const l = this.list();
    const label = tidyLabel(this.newLabel());
    this.clearMessages();
    this.offerSwitchOn.set(null);
    if (label === '') return this.refuseAdd(`Enter the ${l.one} to add.`);
    if (label.length > this.max) return this.refuseAdd(`Keep it to ${this.max} characters or fewer.`);
    const dup = duplicateOf(this.items(), label);
    if (dup) {
      if (!dup.active) this.offerSwitchOn.set(dup);
      return this.refuseAdd(
        dup.active
          ? `“${dup.label}” is already in the list.`
          : `“${dup.label}” is already in the list but switched off — switch it back on instead.`,
      );
    }
    this.adding.set(true);
    this.api
      .create(l.category, { label })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.adding.set(false);
          // New items go to the end (the API numbers them last + 10). Not
          // re-sorted by number: moves still being saved stay as shown.
          this.items.update((list) => [...list.filter((i) => i.id !== res.data.id), res.data]);
          this.newLabel.set('');
          this.notice.set(`Added “${res.data.label}” to the end of the list.`);
          // Ready for the next one.
          this.addInput()?.nativeElement.focus();
        },
        error: (err: unknown) => {
          this.adding.set(false);
          this.refuseAdd(apiErrorFields(err)['label'] ?? apiErrorMessage(err, `Could not add the ${l.one}.`));
        },
      });
  }

  private refuseAdd(message: string): void {
    this.addError.set(message);
    this.addInput()?.nativeElement.focus();
  }

  // ----- Rename -----

  protected startRename(it: ReferenceItemDto): void {
    this.clearMessages();
    this.editingId.set(it.id);
    this.editLabel.set(it.label);
    this.editError.set('');
    this.focusById(`bo-ref-edit-${it.id}`, true);
  }

  protected setEditLabel(value: string): void {
    this.editLabel.set(value);
    this.editError.set('');
  }

  protected cancelRename(it: ReferenceItemDto): void {
    if (this.isBusy(it.id)) return;
    this.editingId.set(null);
    this.editError.set('');
    this.focusById(`bo-ref-rename-${it.id}`);
  }

  protected async saveRename(it: ReferenceItemDto): Promise<void> {
    if (this.isBusy(it.id)) return;
    const l = this.list();
    const label = tidyLabel(this.editLabel());
    if (label === '') return this.refuseRename(it, 'Enter a name.');
    if (label === it.label) return this.cancelRename(it);
    if (label.length > this.max) return this.refuseRename(it, `Keep it to ${this.max} characters or fewer.`);
    const dup = duplicateOf(this.items(), label, it.id);
    if (dup) {
      return this.refuseRename(it, `“${dup.label}” is already in the list${dup.active ? '' : ' (switched off)'}.`);
    }
    const n = it.usage_count;
    if (n > 0) {
      const { confirmed } = await this.dialogs.confirm({
        tone: 'warning',
        icon: 'pencil',
        title: `Rename “${it.label}” to “${label}”?`,
        message: `The ${countOf(n, l.usedBy)} who ${n === 1 ? 'has' : 'have'} “${it.label}” will show “${label}” instead, and change requests waiting for review are updated too. Every change is recorded in the audit log.`,
        details: [
          { label: 'Now', value: it.label },
          { label: 'New name', value: label },
          { label: capitalise(l.usedBy) + 's updated', value: n.toLocaleString('en-GB') },
        ],
        confirmLabel: 'Rename',
        cancelLabel: 'Keep editing',
      });
      if (!confirmed) {
        afterDialogCloses(() => this.focusById(`bo-ref-edit-${it.id}`), this.doc);
        return;
      }
    }
    this.setBusy(it.id, true);
    this.api
      .update(l.category, it.id, { label })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.setBusy(it.id, false);
          this.replace(res.data);
          this.editingId.set(null);
          const moved = res.data.specialists_updated ?? 0;
          this.notice.set(
            `Renamed “${it.label}” to “${res.data.label}”.` + (moved > 0 ? ` ${countOf(moved, l.usedBy)} updated.` : ''),
          );
          this.focusById(`bo-ref-rename-${it.id}`);
        },
        error: (err: unknown) => {
          this.setBusy(it.id, false);
          this.refuseRename(it, apiErrorFields(err)['label'] ?? apiErrorMessage(err, 'Could not rename it.'));
        },
      });
  }

  private refuseRename(it: ReferenceItemDto, message: string): void {
    this.editError.set(message);
    this.focusById(`bo-ref-edit-${it.id}`);
  }

  // ----- Order -----

  /** Position in the whole list (1-based). */
  protected position(it: ReferenceItemDto): number {
    return this.items().findIndex((i) => i.id === it.id) + 1;
  }

  /**
   * Move an item one place, at once on screen; the new order is then saved
   * (POST …/reorder with every id). Moves made while a save is in flight are
   * sent together once it returns, so saves never cross.
   */
  protected move(it: ReferenceItemDto, delta: -1 | 1): void {
    if (!this.canReorder()) return;
    const list = this.items();
    const index = list.findIndex((i) => i.id === it.id);
    const next = moveItem(list, index, delta);
    if (next === list || next.every((x, i) => x === list[i])) return;
    this.clearMessages();
    this.items.set(next);
    const pos = index + delta + 1;
    this.announcement.set(`${it.label} moved ${delta < 0 ? 'up' : 'down'} to position ${pos} of ${next.length}.`);
    // The row moved in the DOM, which drops focus: put it back on the same arrow
    // — or the other one, once it reached the top / bottom (that one is disabled).
    let arrow: 'up' | 'down' = delta < 0 ? 'up' : 'down';
    if (arrow === 'up' && pos === 1) arrow = 'down';
    else if (arrow === 'down' && pos === next.length) arrow = 'up';
    this.focusById(`bo-ref-${arrow}-${it.id}`);
    this.saveOrder();
  }

  private saveOrder(): void {
    if (this.reorderInFlight) {
      this.reorderQueued = true;
      return;
    }
    this.reorderInFlight = true;
    const l = this.list();
    this.api
      .reorder(
        l.category,
        this.items().map((i) => i.id),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.reorderInFlight = false;
          if (this.reorderQueued) {
            this.reorderQueued = false;
            this.saveOrder();
            return;
          }
          // The screen already shows this order: take only the server's
          // numbers. The rest of the snapshot may predate a rename or a
          // switch on / off sent while it was in flight, so it is not used.
          if (this.list().category === l.category) {
            const order = new Map((res.data ?? []).map((i) => [i.id, i.sort_order]));
            this.items.update((list) =>
              list.map((i) => {
                const n = order.get(i.id);
                return n === undefined || n === i.sort_order ? i : { ...i, sort_order: n };
              }),
            );
          }
        },
        error: (err: unknown) => {
          this.reorderInFlight = false;
          this.reorderQueued = false;
          this.actionError.set(apiErrorMessage(err, 'Could not save the new order.') + ' The list has been reloaded.');
          this.load();
        },
      });
  }

  // ----- Switch on / off -----

  protected async switchOff(it: ReferenceItemDto): Promise<void> {
    if (this.isBusy(it.id)) return;
    const l = this.list();
    this.clearMessages();
    const n = it.usage_count;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'eye-off',
      title: `Switch off “${it.label}”?`,
      message:
        `It won't be offered when a ${l.one} is chosen. ` +
        (n > 0
          ? `The ${countOf(n, l.usedBy)} who ${n === 1 ? 'has' : 'have'} it keep${n === 1 ? 's' : ''} it until it is changed. You can switch it back on at any time.`
          : 'You can switch it back on at any time.'),
      confirmLabel: 'Switch off',
      cancelLabel: 'Keep it on',
      action: () => this.setActive(it, false),
      errorMessage: (err) => apiErrorMessage(err, 'Could not switch it off.'),
    });
    if (confirmed) this.notice.set(`“${it.label}” is switched off. It is no longer offered.`);
  }

  protected switchOn(it: ReferenceItemDto, fromAdd = false): void {
    if (this.isBusy(it.id)) return;
    this.clearMessages();
    this.setBusy(it.id, true);
    this.setActive(it, true).subscribe({
      next: () => {
        this.setBusy(it.id, false);
        this.notice.set(`“${it.label}” is switched on and offered again.`);
        if (fromAdd) {
          this.newLabel.set('');
          this.addError.set('');
          this.offerSwitchOn.set(null);
          this.addInput()?.nativeElement.focus();
        }
      },
      error: (err: unknown) => {
        this.setBusy(it.id, false);
        this.actionError.set(apiErrorMessage(err, 'Could not switch it on.'));
      },
    });
  }

  private setActive(it: ReferenceItemDto, active: boolean) {
    return this.api
      .update(this.list().category, it.id, { active })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        tap((res) => this.replace(res.data)),
      );
  }

  // ----- Delete -----

  protected async askDelete(it: ReferenceItemDto): Promise<void> {
    if (this.isBusy(it.id)) return;
    const l = this.list();
    this.clearMessages();
    const n = it.usage_count;
    if (n > 0) {
      // In use: it can't go (the API refuses too).
      const have = `${countOf(n, l.usedBy)} ${n === 1 ? 'has' : 'have'} it`;
      if (it.active) {
        // …so offer to switch it off.
        const { confirmed } = await this.dialogs.confirm({
          tone: 'warning',
          icon: 'circle-alert',
          title: `“${it.label}” is in use`,
          message: `${capitalise(have)}, so it can't be deleted. Switch it off instead: it stays on their profiles but is no longer offered.`,
          confirmLabel: 'Switch it off',
          cancelLabel: 'Cancel',
          action: () => this.setActive(it, false),
          errorMessage: (err) => apiErrorMessage(err, 'Could not switch it off.'),
        });
        if (confirmed) this.notice.set(`“${it.label}” is switched off. It is no longer offered.`);
        return;
      }
      // Already switched off: nothing to decide — except, for someone who may
      // open that page, to see who still has it.
      const why = `It is already switched off, so nobody can choose it; it stays on their profiles until their ${l.one} is changed.`;
      const page = l.usedByPage;
      if (page && this.auth.hasPermission(page.permission)) {
        const { confirmed } = await this.dialogs.confirm({
          tone: 'info',
          icon: 'info',
          title: `“${it.label}” can't be deleted`,
          message: `${capitalise(have)}. ${why}`,
          confirmLabel: n === 1 ? `Show this ${l.usedBy}` : `Show these ${l.usedBy}s`,
          cancelLabel: 'Close',
        });
        if (confirmed) void this.router.navigate([page.path], { queryParams: { [page.searchParam]: it.label } });
      } else {
        this.info.set(`“${it.label}” can't be deleted: ${have}. ${why}`);
      }
      return;
    }
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'trash-2',
      title: `Delete “${it.label}”?`,
      message: `It is removed from the list for good. No ${l.usedBy}s have it. To stop offering it but keep it, switch it off instead.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep it',
      action: () =>
        this.api.remove(l.category, it.id).pipe(
          takeUntilDestroyed(this.destroyRef),
          tap(() => this.items.update((list) => list.filter((i) => i.id !== it.id))),
        ),
      errorMessage: (err) => apiErrorMessage(err, 'Could not delete it.'),
    });
    if (confirmed) {
      this.notice.set(`Deleted “${it.label}”.`);
      // Its row (and the button that opened the dialog) is gone.
      afterDialogCloses(() => focusIfLost(this.summary()?.nativeElement ?? this.addInput()?.nativeElement, this.doc), this.doc);
    } else {
      // It may have come into use meanwhile (the dialog said so): show the latest counts.
      this.refreshCounts();
    }
  }

  // ----- Leaving -----

  hasUnsavedChanges(): boolean {
    if (tidyLabel(this.newLabel()) !== '') return true;
    const id = this.editingId();
    if (id === null) return false;
    const it = this.items().find((i) => i.id === id);
    return !!it && tidyLabel(this.editLabel()) !== it.label;
  }

  readonly leaveCopy: LeaveCopy = {
    title: 'Leave without saving?',
    message: "The name you were typing hasn't been saved. If you leave now, it will be lost.",
  };

  // ----- Helpers -----

  protected clearSearch(): void {
    this.search.set('');
    this.focusById('bo-ref-search');
  }

  protected isBusy(id: string): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private replace(item: ReferenceItemDto): void {
    this.items.update((list) => list.map((i) => (i.id === item.id ? { ...i, ...item } : i)));
  }

  /**
   * Re-read the usage counts without the loading state (a failure keeps what
   * is shown). Only the counts are taken: labels, states and order on screen
   * may be newer than this snapshot.
   */
  private refreshCounts(): void {
    const category = this.list().category;
    this.api
      .list(category)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (this.list().category !== category) return;
          const counts = new Map((res.data ?? []).map((i) => [i.id, i.usage_count]));
          this.items.update((list) =>
            list.map((i) => {
              const n = counts.get(i.id);
              return n === undefined || n === i.usage_count ? i : { ...i, usage_count: n };
            }),
          );
        },
        error: () => undefined,
      });
  }

  private clearMessages(): void {
    this.notice.set('');
    this.info.set('');
    this.actionError.set('');
  }

  private resetForms(): void {
    this.newLabel.set('');
    this.addError.set('');
    this.offerSwitchOn.set(null);
    this.editingId.set(null);
    this.editLabel.set('');
    this.editError.set('');
    this.clearMessages();
  }

  /** Focus an element by id once the view has caught up (optionally selecting its text). */
  private focusById(id: string, select = false): void {
    afterNextRender(
      () => {
        const el = this.doc.getElementById(id);
        if (!el) return;
        el.focus();
        if (select && el instanceof HTMLInputElement) el.select();
      },
      { injector: this.injector },
    );
  }
}
