import type {
  CreateLabRequestInput,
  LabCatalogueItem,
  LabInfectionAlert,
  LabItemKind,
  LabMobility,
  LabModality,
  LabOptionsDto,
  LabPreparation,
  LabPriority,
  LabPurpose,
  LabRequestContextDto,
  LabRequestDto,
  LabRequestItemInput,
  LabSite,
  LabSpecimenMode,
  LabYesNo,
} from '@supadoc/models';

/*
 * The lab request form, as pure functions over one immutable state object
 * (spec §3.5). The composer keeps a single signal of `LabFormState` and only
 * ever replaces it with what these return, so every rule here is unit-tested
 * without a component.
 */

/** One investigation on the form. `label` / `short` are the catalogue's, kept for display. */
export interface LabFormItem {
  readonly code: string;
  readonly kind: LabItemKind;
  readonly label: string;
  readonly short: string;
  /** Lab items only (microbiology: always 'auto', fixed by the site). */
  readonly specimenMode: LabSpecimenMode | null;
  /** Lab items with a manual specimen. */
  readonly specimenCode: string | null;
  /** Imaging items only. */
  readonly preparation: LabPreparation | null;
}

/** Which add-select picked an item (each shows its last pick with a ✕). */
export type LabPickSource = 'quick' | 'panel' | 'single' | 'micro' | 'study' | 'physio';

export type LabCategoryTab = 'routine_panel' | 'single_test' | 'microbiology';

export interface LabFormState {
  /** crypto.randomUUID(): new per patient (emptyForm), and again after any 409 from create. */
  readonly clientKey: string;
  readonly priority: LabPriority;
  readonly question: string;
  readonly history: string;
  readonly medication: string;
  readonly allergies: string;
  /** True until edited (the "From the patient's record" caption). */
  readonly prefilled: { readonly medication: boolean; readonly allergies: boolean };
  readonly fasting: boolean | null;
  readonly fastingHours: string;
  /** The short of the item that set the fasting answer while auto-filled; null once the doctor edits it. */
  readonly fastingSource: string | null;
  readonly pregnant: boolean | null;
  readonly weeksPregnant: string;
  readonly infectionAlerts: readonly LabInfectionAlert[];
  readonly transfusion: boolean | null;
  readonly purpose: LabPurpose | null;
  /** Unique by code, in the order added. */
  readonly items: readonly LabFormItem[];
  /** The lab item the "Specimen type" row edits. */
  readonly activeLabCode: string | null;
  /** The study "Preparation instruction" edits. */
  readonly activeImagingCode: string | null;
  readonly category: LabCategoryTab;
  readonly site: LabSite | null;
  readonly modality: LabModality;
  readonly safety: { readonly contrastAllergy: LabYesNo | null; readonly mobility: LabMobility | null };
  readonly tab: LabItemKind;
  readonly lastPick: Readonly<Record<LabPickSource, string | null>>;
}

/** Quick add, in the designed order (the options response has no quick_add list: a UI constant). */
export const QUICK_ADD_CODES: readonly string[] = ['FBC', 'MP', 'RBS', 'HIV', 'WIDAL', 'UA', 'HBSAG'];

const EMPTY_PICKS: Readonly<Record<LabPickSource, string | null>> = {
  quick: null,
  panel: null,
  single: null,
  micro: null,
  study: null,
  physio: null,
};

/** A uuid v4 (the form's idempotency key). */
export function newClientKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A fresh form for this patient (fresh `clientKey`; medication and allergies from their record). */
export function emptyForm(ctx: LabRequestContextDto): LabFormState {
  const medication = (ctx.prefill?.medication ?? '').trim();
  const allergies = (ctx.prefill?.allergies ?? '').trim();
  return {
    clientKey: newClientKey(),
    priority: 'routine',
    question: '',
    history: '',
    medication,
    allergies,
    prefilled: { medication: medication !== '', allergies: allergies !== '' },
    fasting: null,
    fastingHours: '',
    fastingSource: null,
    pregnant: null,
    weeksPregnant: '',
    infectionAlerts: [],
    transfusion: null,
    purpose: null,
    items: [],
    activeLabCode: null,
    activeImagingCode: null,
    category: 'routine_panel',
    site: null,
    modality: 'x_ray',
    safety: { contrastAllergy: null, mobility: null },
    tab: 'lab',
    lastPick: EMPTY_PICKS,
  };
}

/** A whole number in [min, max] from a text field, else null. */
export function wholeIn(value: string | number | null | undefined, min: number, max: number): number | null {
  const s = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/**
 * Add an investigation. Deduplicated by code (re-adding only makes it active and
 * updates the select's last pick). Imaging gets its default preparation. While
 * Fasting? is unanswered or still auto-filled, an item with `fasting_hours`
 * answers it with the longest fasting time among the added items.
 */
export function addItem(s: LabFormState, item: LabCatalogueItem, source?: LabPickSource): LabFormState {
  const lastPick = source ? { ...s.lastPick, [source]: item.code } : s.lastPick;
  const active = {
    activeLabCode: item.kind === 'lab' ? item.code : s.activeLabCode,
    activeImagingCode: item.kind === 'imaging' ? item.code : s.activeImagingCode,
  };
  if (s.items.some((i) => i.code === item.code)) return { ...s, ...active, lastPick };

  const added: LabFormItem = {
    code: item.code,
    kind: item.kind,
    label: item.label,
    short: item.short,
    specimenMode: item.kind === 'lab' ? 'auto' : null,
    specimenCode: null,
    preparation: item.kind === 'imaging' ? (item.default_preparation ?? 'none') : null,
  };
  let next: LabFormState = { ...s, ...active, lastPick, items: [...s.items, added] };

  const hours = item.fasting_hours;
  if (typeof hours === 'number' && hours > 0 && (s.fasting === null || s.fastingSource !== null)) {
    const current = s.fasting === true && s.fastingSource !== null ? (wholeIn(s.fastingHours, 1, 99) ?? 0) : 0;
    if (hours > current) {
      next = { ...next, fasting: true, fastingHours: String(hours), fastingSource: item.short };
    } else if (s.fasting !== true) {
      next = { ...next, fasting: true };
    }
  }
  return next;
}

/** Remove an investigation: every select showing it forgets it; the fasting answer stays. */
export function removeItem(s: LabFormState, code: string): LabFormState {
  const items = s.items.filter((i) => i.code !== code);
  if (items.length === s.items.length) return s;
  const lastPick = { ...s.lastPick };
  for (const key of Object.keys(lastPick) as LabPickSource[]) if (lastPick[key] === code) lastPick[key] = null;
  const lastOf = (kind: LabItemKind) => [...items].reverse().find((i) => i.kind === kind)?.code ?? null;
  return {
    ...s,
    items,
    lastPick,
    activeLabCode: s.activeLabCode === code ? lastOf('lab') : s.activeLabCode,
    activeImagingCode: s.activeImagingCode === code ? lastOf('imaging') : s.activeImagingCode,
  };
}

/** The catalogue entry of a code (active items only). */
export function catalogueItem(opts: LabOptionsDto, code: string | null | undefined): LabCatalogueItem | null {
  if (!code) return null;
  return opts.items.find((i) => i.code === code) ?? null;
}

/**
 * The added item with the longest fasting time when Fasting? = No, or when the
 * hours given are shorter than it; null otherwise (a warning, never a blocker).
 */
export function fastingShortfall(s: LabFormState, opts: LabOptionsDto): { short: string; hours: number } | null {
  let worst: { short: string; hours: number } | null = null;
  for (const i of s.items) {
    const h = catalogueItem(opts, i.code)?.fasting_hours;
    if (typeof h === 'number' && h > 0 && (!worst || h > worst.hours)) worst = { short: i.short, hours: h };
  }
  if (!worst) return null;
  if (s.fasting === false) return worst;
  if (s.fasting === true) {
    const given = wholeIn(s.fastingHours, 1, 99);
    if (given !== null && given < worst.hours) return worst;
  }
  return null;
}

export function tabCount(s: LabFormState, kind: LabItemKind): number {
  return s.items.filter((i) => i.kind === kind).length;
}

/** The imaging safety screen is required once a study is added. */
export function safetyRequired(s: LabFormState): boolean {
  return s.items.some((i) => i.kind === 'imaging');
}

export function safetyComplete(s: LabFormState, askPregnancy: boolean): boolean {
  return s.safety.contrastAllergy !== null && s.safety.mobility !== null && (!askPregnancy || s.pregnant !== null);
}

/** Pregnant? is asked once: the clinical radio and the safety screen's select are the same answer. */
export function setPregnant(s: LabFormState, pregnant: boolean | null): LabFormState {
  return { ...s, pregnant };
}

/** The doctor answers Fasting? (or types the hours): no longer auto-filled. */
export function setFasting(s: LabFormState, fasting: boolean): LabFormState {
  return { ...s, fasting, fastingSource: null };
}

export function setFastingHours(s: LabFormState, hours: string): LabFormState {
  return { ...s, fastingHours: hours, fastingSource: null };
}

export function setText(s: LabFormState, field: 'question' | 'history' | 'medication' | 'allergies', value: string): LabFormState {
  if (field === 'medication' || field === 'allergies') {
    return { ...s, [field]: value, prefilled: { ...s.prefilled, [field]: false } };
  }
  return { ...s, [field]: value };
}

export function toggleInfectionAlert(s: LabFormState, alert: LabInfectionAlert, order: readonly LabInfectionAlert[]): LabFormState {
  const on = s.infectionAlerts.includes(alert);
  const set = new Set(on ? s.infectionAlerts.filter((a) => a !== alert) : [...s.infectionAlerts, alert]);
  return { ...s, infectionAlerts: order.filter((a) => set.has(a)) };
}

export function setSpecimenMode(s: LabFormState, code: string, mode: LabSpecimenMode): LabFormState {
  return {
    ...s,
    items: s.items.map((i) =>
      i.code === code && i.kind === 'lab' ? { ...i, specimenMode: mode, specimenCode: mode === 'auto' ? null : i.specimenCode } : i,
    ),
  };
}

export function setSpecimen(s: LabFormState, code: string, specimenCode: string | null): LabFormState {
  return { ...s, items: s.items.map((i) => (i.code === code && i.kind === 'lab' ? { ...i, specimenCode } : i)) };
}

export function setPreparation(s: LabFormState, code: string, preparation: LabPreparation): LabFormState {
  return { ...s, items: s.items.map((i) => (i.code === code && i.kind === 'imaging' ? { ...i, preparation } : i)) };
}

/** A microbiology item: its specimen is fixed by the site. */
export function isMicro(opts: LabOptionsDto, code: string | null | undefined): boolean {
  return catalogueItem(opts, code)?.category === 'microbiology';
}

export type PreflightKey = 'tests' | 'indication' | 'safety' | 'fasting_hours' | 'weeks' | 'specimen';

export interface PreflightIssue {
  readonly key: PreflightKey;
  readonly label: string;
  /** The item a `specimen` row is about. */
  readonly code?: string;
}

/** What is still missing before Preview, in the validation modal's order. */
export function preflight(s: LabFormState, ctx: LabRequestContextDto, opts: LabOptionsDto): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  const min = opts.limits?.question_min ?? 3;
  const max = opts.limits?.question_max ?? 200;
  const [fMin, fMax] = opts.limits?.fasting_hours ?? [1, 24];
  const [wMin, wMax] = opts.limits?.weeks_pregnant ?? [1, 42];
  if (s.items.length === 0) out.push({ key: 'tests', label: 'Add at least one test' });
  const q = s.question.trim().length;
  if (q < min || q > max) out.push({ key: 'indication', label: 'Confirm indication' });
  if (safetyRequired(s) && !safetyComplete(s, ctx.ask_pregnancy)) {
    out.push({ key: 'safety', label: 'Complete the imaging safety screen' });
  }
  if (s.fasting === true && wholeIn(s.fastingHours, fMin, fMax) === null) {
    out.push({ key: 'fasting_hours', label: 'Add the fasting hours' });
  }
  if (ctx.ask_pregnancy && s.pregnant === true && wholeIn(s.weeksPregnant, wMin, wMax) === null) {
    out.push({ key: 'weeks', label: 'Add how many weeks pregnant' });
  }
  for (const i of s.items) {
    if (i.kind === 'lab' && i.specimenMode === 'manual' && !i.specimenCode && !isMicro(opts, i.code)) {
      out.push({ key: 'specimen', label: `Choose a specimen for ${i.short}`, code: i.code });
    }
  }
  return out;
}

/** The create body (spec §2.2). Pregnant? / weeks are left out when Pregnant? isn't asked. */
export function toCreateBody(
  s: LabFormState,
  ctx: LabRequestContextDto,
  appointmentId: string | null,
  duplicatedFrom: string | null,
  signature: CreateLabRequestInput['signature'],
  catalogueVersion: string,
): CreateLabRequestInput {
  const fastingHours = s.fasting === true ? wholeIn(s.fastingHours, 1, 99) : null;
  const items: LabRequestItemInput[] = s.items.map((i) => {
    if (i.kind === 'lab') {
      if (i.specimenMode === 'manual') return { code: i.code, specimen_mode: 'manual', specimen_code: i.specimenCode };
      return { code: i.code, specimen_mode: 'auto' };
    }
    if (i.kind === 'imaging') return { code: i.code, preparation_code: i.preparation ?? 'none' };
    return { code: i.code };
  });
  const clinical: CreateLabRequestInput['clinical'] = {
    fasting: s.fasting,
    fasting_hours: fastingHours,
    infection_alerts: [...s.infectionAlerts],
    transfusion_3m: s.transfusion,
    ...(ctx.ask_pregnancy
      ? { pregnant: s.pregnant, weeks_pregnant: s.pregnant === true ? wholeIn(s.weeksPregnant, 1, 99) : null }
      : {}),
  };
  const imaging =
    safetyRequired(s) && s.safety.contrastAllergy && s.safety.mobility
      ? { contrast_allergy: s.safety.contrastAllergy, mobility: s.safety.mobility }
      : null;
  return {
    client_key: s.clientKey,
    catalogue_version: catalogueVersion,
    patient_id: ctx.patient.id,
    appointment_id: appointmentId,
    duplicated_from: duplicatedFrom,
    priority: s.priority,
    purpose: s.purpose,
    clinical_question: s.question.trim(),
    history: s.history.trim(),
    medication: s.medication.trim(),
    allergies: s.allergies.trim(),
    clinical,
    items,
    imaging_safety: imaging,
    attest: true,
    signature,
  };
}

/** The tab to open on: the first that holds an item. */
function firstTab(s: LabFormState): LabItemKind {
  return (['lab', 'imaging', 'physiological'] as const).find((k) => tabCount(s, k) > 0) ?? 'lab';
}

/**
 * Duplicate: a new form for the same patient that copies priority, purpose,
 * question, history, items (specimens, preparations), infection alerts and
 * mobility. Medication / allergies come from the record (as a new form);
 * pregnancy, fasting (re-derived from the items), transfusion and contrast
 * allergy describe the patient now and are asked again. Codes no longer in the
 * catalogue are dropped and reported by label.
 */
export function fromRequest(
  dto: LabRequestDto,
  opts: LabOptionsDto,
  ctx: LabRequestContextDto,
): { state: LabFormState; dropped: string[] } {
  let s: LabFormState = {
    ...emptyForm(ctx),
    priority: dto.priority,
    purpose: dto.purpose ?? null,
    question: dto.clinical_question ?? '',
    history: dto.history ?? '',
  };
  const dropped: string[] = [];
  const items = [...(dto.items ?? [])].sort((a, b) => a.position - b.position);
  for (const it of items) {
    const cat = catalogueItem(opts, it.code);
    if (!cat) {
      dropped.push(it.label || it.code);
      continue;
    }
    s = addItem(s, cat);
    if (cat.kind === 'lab' && cat.category !== 'microbiology' && it.specimen_mode === 'manual' && it.specimen_code) {
      s = setSpecimen(setSpecimenMode(s, cat.code, 'manual'), cat.code, it.specimen_code);
    }
    if (cat.kind === 'imaging' && it.preparation_code) s = setPreparation(s, cat.code, it.preparation_code);
  }
  const alerts = new Set(dto.clinical?.infection_alerts ?? []);
  const order = (opts.infection_alerts ?? []).map((a) => a.value);
  s = {
    ...s,
    infectionAlerts: order.filter((a) => alerts.has(a)),
    safety: { contrastAllergy: null, mobility: dto.imaging_safety?.mobility ?? null },
  };
  return { state: { ...s, tab: firstTab(s) }, dropped };
}

/** After `catalogue_changed`: drop the codes no longer in the list (reported by label). */
export function revalidate(s: LabFormState, opts: LabOptionsDto): { state: LabFormState; dropped: string[] } {
  let next = s;
  const dropped: string[] = [];
  for (const i of s.items) {
    if (!catalogueItem(opts, i.code)) {
      dropped.push(i.label || i.code);
      next = removeItem(next, i.code);
    }
  }
  return { state: next, dropped };
}

/** What the doctor entered (UI-only choices — tab, category, site, modality, active item, picks — don't count). */
function answers(s: LabFormState): unknown {
  return [
    s.priority,
    s.question.trim(),
    s.history.trim(),
    s.medication.trim(),
    s.allergies.trim(),
    s.fasting,
    s.fasting === true ? s.fastingHours.trim() : '',
    s.pregnant,
    s.pregnant === true ? s.weeksPregnant.trim() : '',
    [...s.infectionAlerts].sort(),
    s.transfusion,
    s.purpose,
    s.items.map((i) => [i.code, i.specimenMode, i.specimenCode, i.preparation]),
    s.safety.contrastAllergy,
    s.safety.mobility,
  ];
}

/** Leaving would lose something the doctor entered. */
export function isDirty(s: LabFormState, initial: LabFormState): boolean {
  return JSON.stringify(answers(s)) !== JSON.stringify(answers(initial));
}

/**
 * Catalogue search (the active tab's items only): every whitespace-separated
 * term must appear in the label, name, short or a synonym (case-insensitive);
 * short / label prefix matches rank first; at most `limit` rows.
 */
export function searchCatalogue(items: readonly LabCatalogueItem[], query: string, limit = 8): LabCatalogueItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const q = query.trim().toLowerCase();
  const scored: { item: LabCatalogueItem; rank: number; at: number }[] = [];
  items.forEach((item, at) => {
    const hay = [item.label, item.name, item.short, ...(item.synonyms ?? [])].join(' \u0001 ').toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return;
    const short = item.short.toLowerCase();
    const label = item.label.toLowerCase();
    const rank = short === q || label === q ? 0 : short.startsWith(q) || label.startsWith(q) ? 1 : 2;
    scored.push({ item, rank, at });
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, limit)
    .map((x) => x.item);
}
