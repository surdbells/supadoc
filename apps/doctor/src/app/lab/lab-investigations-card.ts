import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, viewChildren } from '@angular/core';
import type {
  LabCatalogueItem,
  LabItemKind,
  LabModality,
  LabOptionsDto,
  LabPreparation,
  LabPurpose,
  LabSite,
  LabSpecimenMode,
} from '@supadoc/models';
import { LabCatalogueSearch } from './lab-catalogue-search';
import {
  catalogueItem,
  type LabCategoryTab,
  type LabFormItem,
  type LabFormState,
  type LabPickSource,
  QUICK_ADD_CODES,
  tabCount,
} from './lab-composer-state';
import { type LabSafetyEdit, LabSafetyScreen } from './lab-safety-screen';
import { LabSelect, type LabSelectOption } from './lab-select';
import { LabSelectedList } from './lab-selected-list';

/** One change the investigations card asks the composer to apply. */
export type LabInvestigationsEdit =
  | { readonly kind: 'tab'; readonly value: LabItemKind }
  | { readonly kind: 'category'; readonly value: LabCategoryTab }
  | { readonly kind: 'site'; readonly value: LabSite }
  | { readonly kind: 'modality'; readonly value: LabModality }
  | { readonly kind: 'purpose'; readonly value: LabPurpose | null }
  | { readonly kind: 'specimenMode'; readonly code: string; readonly value: LabSpecimenMode }
  | { readonly kind: 'specimen'; readonly code: string; readonly value: string }
  | { readonly kind: 'preparation'; readonly code: string; readonly value: LabPreparation }
  | { readonly kind: 'activate'; readonly code: string }
  | { readonly kind: 'safety'; readonly edit: LabSafetyEdit };

/** An add-select or the search picked a test. */
export interface LabAddEvent {
  readonly item: LabCatalogueItem;
  readonly source?: LabPickSource;
}

const TABS: readonly { readonly kind: LabItemKind; readonly label: string }[] = [
  { kind: 'lab', label: 'Laboratory' },
  { kind: 'imaging', label: 'Imaging' },
  { kind: 'physiological', label: 'Physiological' },
];

const SPECIMEN_MODES: readonly LabSelectOption[] = [
  { value: 'auto', label: 'Automatic (recommended)' },
  { value: 'manual', label: 'Choose manually' },
];

const toOptions = (items: readonly LabCatalogueItem[], text: (i: LabCatalogueItem) => string = (i) => i.label): LabSelectOption[] =>
  items.map((i) => ({ value: i.code, label: text(i) }));

/**
 * "Select investigations": Laboratory / Imaging / Physiological tabs (APG,
 * automatic activation, count badges), the catalogue search, the "Selected
 * (n)" chips and each tab's add-selects. Presentational: the composer owns
 * the state; `add`, `remove` and `edit` ask it to change.
 */
@Component({
  selector: 'doc-lab-investigations-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LabCatalogueSearch, LabSafetyScreen, LabSelect, LabSelectedList],
  host: { class: 'flex min-w-0 flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card' },
  styles: `
    .ic-tabs-wrap {
      container-type: inline-size;
    }
    /* Never wider than the pill: on a narrow card the tabs tighten, and as a last resort (320 px) the row scrolls inside it. */
    .ic-tabs {
      height: 48px;
      overflow-x: auto;
    }
    @container (max-width: 22rem) {
      .ic-tab {
        padding-inline: 4px;
        gap: 4px;
        font-size: 12px;
        letter-spacing: 0.36px;
      }
    }
  `,
  template: `
    @let s = state();
    <div class="flex flex-col gap-1">
      <h2 class="font-sans text-body-lg font-semibold text-ink">Select investigations</h2>
      <p class="font-sans text-caption text-slate">Search first. Quick chips and panels add a test in one tap.</p>
    </div>

    <div class="ic-tabs-wrap">
      <div role="tablist" aria-label="Investigation type" class="ic-tabs flex gap-1 rounded-[32px] border border-haze bg-snow p-1 shadow-bar">
      @for (t of tabs; track t.kind) {
        @let n = count(t.kind);
        <button
          #tabBtn
          type="button"
          role="tab"
          [id]="'lab-tab-' + t.kind"
          [attr.aria-controls]="'lab-panel-' + t.kind"
          [attr.aria-selected]="s.tab === t.kind"
          [attr.aria-label]="n ? t.label + ', ' + n + (n === 1 ? ' test' : ' tests') : null"
          [tabIndex]="s.tab === t.kind ? 0 : -1"
          class="ic-tab flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[24px] px-2 font-sans text-body-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [class]="s.tab === t.kind ? 'bg-cerulean/10 text-cerulean-dark' : 'text-slate hover:text-ink'"
          (click)="setTab(t.kind)"
          (keydown)="onTabKey($event)"
        >
          {{ t.label }}
          @if (n) {
            <span class="flex size-4 items-center justify-center rounded-full bg-cerulean font-sans text-[10px] font-semibold text-white" aria-hidden="true">{{ n }}</span>
          }
        </button>
      }
    </div>
    </div>

    @if (errors()['tests']) {
      <p class="font-sans text-caption text-alert-ink">{{ errors()['tests'] }}</p>
    }

    <!-- Laboratory -->
    <div role="tabpanel" id="lab-panel-lab" aria-labelledby="lab-tab-lab" class="flex flex-col gap-4" [hidden]="s.tab !== 'lab'">
      <doc-lab-catalogue-search
        id="lab-search-lab"
        label="Search laboratory tests"
        placeholder="Search tests, e.g. “FBC”, “malaria”, “culture”..."
        [items]="labItems()"
        (picked)="add.emit({ item: $event })"
      />
      <doc-lab-selected-list [items]="tabItems('lab')" [active]="s.activeLabCode" (activate)="edit.emit({ kind: 'activate', code: $event })" (remove)="remove.emit($event)" />
      <div class="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <doc-lab-select id="lab-quick" label="Quick add: common tests" [options]="quickOptions()" [value]="s.lastPick.quick" [removable]="true" (valueChange)="addCode($event, 'quick')" (removed)="removePick('quick')" />
        <doc-lab-select id="lab-category" label="Test category" [placeholderRow]="false" [options]="categoryOptions()" [value]="s.category" (valueChange)="edit.emit({ kind: 'category', value: $any($event) })" />
        @switch (s.category) {
          @case ('routine_panel') {
            <doc-lab-select class="sm:col-span-2" id="lab-panel-select" label="Routine panel" [wide]="true" [options]="panelOptions()" [value]="s.lastPick.panel" [removable]="true" (valueChange)="addCode($event, 'panel')" (removed)="removePick('panel')" />
          }
          @case ('single_test') {
            <doc-lab-select class="sm:col-span-2" id="lab-single-select" label="Single tests" [wide]="true" [options]="singleOptions()" [value]="s.lastPick.single" [removable]="true" (valueChange)="addCode($event, 'single')" (removed)="removePick('single')" />
          }
          @case ('microbiology') {
            <doc-lab-select id="lab-site" label="Specimen site" [options]="siteOptions()" [value]="s.site" (valueChange)="edit.emit({ kind: 'site', value: $any($event) })" />
            <doc-lab-select
              id="lab-micro-select"
              label="Microbiology test"
              [options]="microOptions()"
              [value]="s.lastPick.micro"
              [removable]="true"
              [disabled]="!s.site"
              [helper]="s.site ? undefined : 'Choose a specimen site first'"
              (valueChange)="addCode($event, 'micro')"
              (removed)="removePick('micro')"
            />
          }
        }
        <doc-lab-select
          id="lab-purpose"
          label="Purpose"
          [options]="purposeOptions()"
          [value]="s.purpose"
          [removable]="true"
          (valueChange)="edit.emit({ kind: 'purpose', value: $any($event) })"
          (removed)="edit.emit({ kind: 'purpose', value: null })"
        />
        <doc-lab-select
          id="lab-specimen-type"
          label="Specimen type"
          [placeholderRow]="false"
          [options]="specimenModes"
          [value]="activeLab() ? (activeIsMicro() ? 'auto' : (activeLab()?.specimenMode ?? 'auto')) : null"
          [disabled]="!activeLab() || activeIsMicro()"
          [helper]="specimenHelper()"
          (valueChange)="setMode($any($event))"
        />
        @if (activeLab(); as a) {
          @if (a.specimenMode === 'manual' && !activeIsMicro()) {
            <doc-lab-select
              class="sm:col-span-2"
              id="lab-specimen-manual"
              [label]="'Specimen for ' + a.short"
              [wide]="true"
              [options]="manualSpecimens()"
              [value]="a.specimenCode"
              [invalid]="errors()['specimen:' + a.code]"
              (valueChange)="edit.emit({ kind: 'specimen', code: a.code, value: $event })"
            />
          }
        }
      </div>
    </div>

    <!-- Imaging -->
    <div role="tabpanel" id="lab-panel-imaging" aria-labelledby="lab-tab-imaging" class="flex flex-col gap-4" [hidden]="s.tab !== 'imaging'">
      <doc-lab-catalogue-search
        id="lab-search-imaging"
        label="Search imaging"
        placeholder="Search Imaging, e.g. “Chest X-Ray”..."
        [items]="imagingItems()"
        (picked)="add.emit({ item: $event })"
      />
      <doc-lab-selected-list [items]="tabItems('imaging')" [active]="s.activeImagingCode" (activate)="edit.emit({ kind: 'activate', code: $event })" (remove)="remove.emit($event)" />
      <doc-lab-safety-screen
        [askPregnancy]="askPregnancy()"
        [pregnant]="s.pregnant"
        [contrastAllergy]="s.safety.contrastAllergy"
        [mobility]="s.safety.mobility"
        [mobilityList]="options().mobility"
        [complete]="safetyComplete()"
        (edit)="edit.emit({ kind: 'safety', edit: $event })"
      />
      @if (errors()['safety']) {
        <p class="font-sans text-caption text-alert-ink">{{ errors()['safety'] }}</p>
      }
      <div class="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <doc-lab-select id="lab-modality" label="Modality" [placeholderRow]="false" [options]="modalityOptions()" [value]="s.modality" (valueChange)="edit.emit({ kind: 'modality', value: $any($event) })" />
        <doc-lab-select id="lab-study" label="Study" [options]="studyOptions()" [value]="s.lastPick.study" [removable]="true" (valueChange)="addCode($event, 'study')" (removed)="removePick('study')" />
        <doc-lab-select
          class="sm:col-span-2"
          id="lab-preparation"
          label="Preparation instruction"
          [wide]="true"
          [placeholderRow]="false"
          [options]="preparationOptions()"
          [value]="activeStudy()?.preparation ?? null"
          [disabled]="!activeStudy()"
          [helper]="activeStudy() ? 'For ' + activeStudy()!.label : 'Add a study first'"
          (valueChange)="setPreparation($any($event))"
        />
      </div>
    </div>

    <!-- Physiological -->
    <div role="tabpanel" id="lab-panel-physiological" aria-labelledby="lab-tab-physiological" class="flex flex-col gap-4" [hidden]="s.tab !== 'physiological'">
      <doc-lab-selected-list [items]="tabItems('physiological')" [toggles]="false" (remove)="remove.emit($event)" />
      <doc-lab-select id="lab-physio-select" label="Physiological test" [wide]="true" [options]="physioOptions()" [value]="s.lastPick.physio" [removable]="true" (valueChange)="addCode($event, 'physio')" (removed)="removePick('physio')" />
    </div>
  `,
})
export class LabInvestigationsCard {
  readonly state = input.required<LabFormState>();
  readonly options = input.required<LabOptionsDto>();
  readonly askPregnancy = input(false);
  readonly safetyComplete = input(false);
  /** Inline messages: `safety`, and `specimen:{code}` per item (after the first failed Preview). */
  readonly errors = input<Readonly<Record<string, string>>>({});

  readonly add = output<LabAddEvent>();
  readonly remove = output<string>();
  readonly edit = output<LabInvestigationsEdit>();

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  protected readonly tabs = TABS;
  protected readonly specimenModes = SPECIMEN_MODES;

  private readonly byCategory = (c: LabCatalogueItem['category']) => this.options().items.filter((i) => i.category === c);
  protected readonly labItems = computed(() => this.options().items.filter((i) => i.kind === 'lab'));
  protected readonly imagingItems = computed(() => this.options().items.filter((i) => i.kind === 'imaging'));

  protected readonly quickOptions = computed(() => {
    const items = this.options().items;
    const ordered = QUICK_ADD_CODES.map((c) => items.find((i) => i.code === c)).filter((i): i is LabCatalogueItem => !!i);
    return toOptions(ordered, (i) => i.short);
  });
  protected readonly categoryOptions = computed(() => this.options().categories.map((c) => ({ value: c.value, label: c.label })));
  protected readonly panelOptions = computed(() => toOptions(this.byCategory('routine_panel')));
  protected readonly singleOptions = computed(() => toOptions(this.byCategory('single_test')));
  protected readonly siteOptions = computed(() => this.options().sites.map((s) => ({ value: s.value, label: s.label })));
  protected readonly microOptions = computed(() => {
    const site = this.state().site;
    return site ? toOptions(this.byCategory('microbiology').filter((i) => i.site === site)) : [];
  });
  protected readonly purposeOptions = computed(() => this.options().purposes.map((p) => ({ value: p.value, label: p.label })));
  protected readonly manualSpecimens = computed(() =>
    this.options().specimens.filter((sp) => sp.manual).map((sp) => ({ value: sp.value, label: sp.label })),
  );
  protected readonly modalityOptions = computed(() => this.options().modalities.map((m) => ({ value: m.value, label: m.label })));
  protected readonly studyOptions = computed(() => {
    const modality = this.state().modality;
    return toOptions(this.imagingItems().filter((i) => i.modality === modality));
  });
  protected readonly preparationOptions = computed(() => this.options().preparations.map((p) => ({ value: p.value, label: p.label })));
  protected readonly physioOptions = computed(() => toOptions(this.byCategory('physiological')));

  protected readonly activeLab = computed<LabFormItem | null>(() => {
    const s = this.state();
    return s.items.find((i) => i.code === s.activeLabCode && i.kind === 'lab') ?? null;
  });
  protected readonly activeIsMicro = computed(() => catalogueItem(this.options(), this.activeLab()?.code)?.category === 'microbiology');
  protected readonly activeStudy = computed<LabFormItem | null>(() => {
    const s = this.state();
    return s.items.find((i) => i.code === s.activeImagingCode && i.kind === 'imaging') ?? null;
  });
  protected readonly specimenHelper = computed(() => {
    const a = this.activeLab();
    if (!a) return 'Add a test first';
    return this.activeIsMicro() ? 'Set by the specimen site' : `For ${a.short}`;
  });

  protected count(kind: LabItemKind): number {
    return tabCount(this.state(), kind);
  }

  protected tabItems(kind: LabItemKind): LabFormItem[] {
    return this.state().items.filter((i) => i.kind === kind);
  }

  protected setTab(kind: LabItemKind): void {
    if (kind !== this.state().tab) this.edit.emit({ kind: 'tab', value: kind });
  }

  /** Arrow keys move between tabs and activate them (automatic activation); Home / End jump. */
  protected onTabKey(event: KeyboardEvent): void {
    const order = TABS.map((t) => t.kind);
    const at = order.indexOf(this.state().tab);
    let next = -1;
    if (event.key === 'ArrowRight') next = (at + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    if (next < 0) return;
    event.preventDefault();
    this.setTab(order[next]);
    this.tabButtons()[next]?.nativeElement.focus();
  }

  protected addCode(code: string, source: LabPickSource): void {
    const item = catalogueItem(this.options(), code);
    if (item) this.add.emit({ item, source });
  }

  /** A select's ✕: its last pick leaves the request. */
  protected removePick(source: LabPickSource): void {
    const code = this.state().lastPick[source];
    if (code) this.remove.emit(code);
  }

  protected setMode(mode: LabSpecimenMode): void {
    const a = this.activeLab();
    if (a) this.edit.emit({ kind: 'specimenMode', code: a.code, value: mode });
  }

  protected setPreparation(prep: LabPreparation): void {
    const a = this.activeStudy();
    if (a) this.edit.emit({ kind: 'preparation', code: a.code, value: prep });
  }
}
