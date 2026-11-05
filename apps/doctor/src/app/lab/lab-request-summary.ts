import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { LabItemKind, LabOptionsDto, LabRequestContextDto, LabRequestDto } from '@supadoc/models';
import { AlertComponent } from '@supadoc/ui';
import {
  catalogueItem,
  fastingShortfall,
  type LabFormState,
  safetyRequired,
  wholeIn,
} from './lab-composer-state';
import {
  ageSex,
  CONTRAST_WARNING,
  fastingWarning,
  LAB_PRIORITY_META,
  PREGNANCY_WARNING,
  specimenText,
  STAT_EMERGENCY,
} from './lab-ui';

/** One "Laboratory (2)" row of the summary. */
export interface LabSummaryGroup {
  readonly kind: LabItemKind;
  readonly title: string;
  readonly line: string;
  /** "Specimens: FBC: Whole blood (EDTA) · …" (Laboratory only). */
  readonly specimens: string | null;
}

/** What Preview, the detail page and the Sent dialog show — built from the form or from a request. */
export interface LabSummaryView {
  readonly patientLine: string;
  readonly patientMeta: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly meta: string;
  readonly groups: readonly LabSummaryGroup[];
  readonly safety: string | null;
  readonly warnings: readonly string[];
}

const KIND_TITLE: Record<LabItemKind, string> = { lab: 'Laboratory', imaging: 'Imaging', physiological: 'Physiological' };
const KINDS: readonly LabItemKind[] = ['lab', 'imaging', 'physiological'];

const yesNo = (v: boolean | null | undefined): string | null => (v === true ? 'Yes' : v === false ? 'No' : null);

interface SummaryInput {
  readonly patient: { name: string; reference: string; email: string; age: number | null; sex: string | null };
  readonly question: string;
  readonly history: string;
  readonly medication: string;
  readonly allergies: string;
  readonly priority: keyof typeof LAB_PRIORITY_META;
  readonly fasting: boolean | null;
  readonly fastingHours: number | null;
  readonly pregnancyAsked: boolean;
  readonly pregnant: boolean | null;
  readonly weeks: number | null;
  readonly alerts: readonly string[];
  readonly transfusion: boolean | null;
  readonly purpose: string | null;
  readonly items: readonly {
    kind: LabItemKind;
    short: string;
    specimen: string | null;
    preparation: string | null;
    contrast: boolean;
    ionising: boolean;
  }[];
  readonly safety: { contrast: string | null; mobility: string | null } | null;
  readonly shortfall: { short: string; hours: number } | null;
}

/** "Patient Details" lines, the clinical rows, the meta line, the investigations and the warnings. */
function build(x: SummaryInput): LabSummaryView {
  const rows = [
    { label: 'Provisional diagnosis / clinical question', value: x.question.trim() },
    { label: 'Relevant history / symptoms', value: x.history.trim() },
    { label: 'Current medication', value: x.medication.trim() },
    { label: 'Allergies', value: x.allergies.trim() },
  ].filter((r) => r.value !== '');

  const meta: string[] = [`Priority: ${LAB_PRIORITY_META[x.priority]?.label ?? x.priority}`];
  if (x.fasting === true) meta.push(`Fasting: Yes${x.fastingHours ? `, ${x.fastingHours} hours` : ''}`);
  else if (x.fasting === false) meta.push('Fasting: No');
  if (x.pregnancyAsked && x.pregnant === true) meta.push(`Pregnant: Yes${x.weeks ? `, ${x.weeks} weeks` : ''}`);
  else if (x.pregnancyAsked && x.pregnant === false) meta.push('Pregnant: No');
  if (x.alerts.length) meta.push(`Infection alert: ${x.alerts.join(', ')}`);
  const transfusion = yesNo(x.transfusion);
  if (transfusion) meta.push(`Transfusion: ${transfusion}`);
  if (x.purpose) meta.push(`Purpose: ${x.purpose}`);

  const groups: LabSummaryGroup[] = [];
  for (const kind of KINDS) {
    const list = x.items.filter((i) => i.kind === kind);
    if (!list.length) continue;
    const line = list
      .map((i) => (kind === 'imaging' && i.preparation ? `${i.short} (Preparation: ${i.preparation})` : i.short))
      .join(' · ');
    const specimens =
      kind === 'lab'
        ? 'Specimens: ' + list.map((i) => `${i.short}: ${i.specimen ? specimenText(i.specimen) : 'Not chosen'}`).join(' · ')
        : null;
    groups.push({ kind, title: `${KIND_TITLE[kind]} (${list.length})`, line, specimens });
  }

  const imaging = x.items.filter((i) => i.kind === 'imaging');
  let safety: string | null = null;
  if (imaging.length && x.safety) {
    const parts = ['Safety'];
    if (x.safety.contrast) parts.push(`Contrast allergy: ${x.safety.contrast}`);
    if (x.safety.mobility) parts.push(`Mobility: ${x.safety.mobility}`);
    if (x.pregnancyAsked && x.pregnant !== null) parts.push(`Pregnant: ${x.pregnant ? 'Yes' : 'No'}`);
    safety = parts.join(' · ');
  }

  const warnings: string[] = [];
  if (x.priority === 'stat') warnings.push(STAT_EMERGENCY);
  if (x.safety?.contrast === 'Yes' && imaging.some((i) => i.contrast)) warnings.push(CONTRAST_WARNING);
  if (x.pregnant === true && x.items.some((i) => i.ionising || i.contrast)) warnings.push(PREGNANCY_WARNING);
  if (x.shortfall) warnings.push(fastingWarning(x.shortfall.short, x.shortfall.hours));

  return {
    patientLine: [x.patient.name, x.patient.reference ? `Ref ${x.patient.reference}` : ''].filter(Boolean).join(' · '),
    patientMeta: [x.patient.email, ageSex(x.patient.age, x.patient.sex)].filter(Boolean).join(' · '),
    rows,
    meta: meta.join(' · '),
    groups,
    safety,
    warnings,
  };
}

function optionLabel<T extends string>(list: readonly { value: T; label: string }[] | undefined, v: T | null | undefined): string | null {
  if (!v) return null;
  return list?.find((o) => o.value === v)?.label ?? v;
}

/** The summary of the form being written (Preview). */
export function summaryFromForm(s: LabFormState, ctx: LabRequestContextDto, opts: LabOptionsDto): LabSummaryView {
  const specimenLabel = (code: string | null | undefined) => optionLabel(opts.specimens, code ?? null);
  return build({
    patient: ctx.patient,
    question: s.question,
    history: s.history,
    medication: s.medication,
    allergies: s.allergies,
    priority: s.priority,
    fasting: s.fasting,
    fastingHours: s.fasting === true ? wholeIn(s.fastingHours, 1, 99) : null,
    pregnancyAsked: ctx.ask_pregnancy,
    pregnant: ctx.ask_pregnancy ? s.pregnant : null,
    weeks: s.pregnant === true ? wholeIn(s.weeksPregnant, 1, 99) : null,
    alerts: s.infectionAlerts.map((a) => optionLabel(opts.infection_alerts, a) ?? a),
    transfusion: s.transfusion,
    purpose: optionLabel(opts.purposes, s.purpose),
    items: s.items.map((i) => {
      const cat = catalogueItem(opts, i.code);
      const prep = i.preparation && i.preparation !== 'none' ? optionLabel(opts.preparations, i.preparation) : null;
      const specimen =
        i.kind !== 'lab'
          ? null
          : i.specimenMode === 'manual' && cat?.category !== 'microbiology'
            ? specimenLabel(i.specimenCode)
            : specimenLabel(cat?.default_specimen);
      return {
        kind: i.kind,
        short: i.short,
        specimen,
        preparation: prep,
        contrast: !!cat?.contrast_possible,
        ionising: !!cat?.ionising,
      };
    }),
    safety: safetyRequired(s)
      ? {
          contrast: s.safety.contrastAllergy === 'yes' ? 'Yes' : s.safety.contrastAllergy === 'no' ? 'No' : null,
          mobility: optionLabel(opts.mobility, s.safety.mobility),
        }
      : null,
    shortfall: fastingShortfall(s, opts),
  });
}

const PURPOSES: Record<string, string> = {
  diagnosis: 'Diagnosis',
  monitoring: 'Monitoring',
  screening: 'Screening',
  pre_operative: 'Pre-operative',
};
const ALERTS: Record<string, string> = { hiv: 'HIV', hep_b: 'Hep B', hep_c: 'Hep C', tb: 'TB' };
const MOBILITY: Record<string, string> = { walking: 'Walking', chair: 'Chair', bed: 'Bed', portable: 'Portable' };

/** The summary of a sent request (detail page): its own snapshots, no catalogue needed. */
export function summaryFromRequest(dto: LabRequestDto): LabSummaryView {
  const snap = dto.patient_snapshot;
  const c = dto.clinical;
  const safetySrc = dto.imaging_safety;
  return build({
    patient: {
      name: snap?.name || dto.patient.name,
      reference: snap?.reference ?? '',
      email: snap?.email ?? '',
      age: snap?.age ?? dto.patient.age,
      sex: snap?.sex ?? dto.patient.sex,
    },
    question: dto.clinical_question ?? '',
    history: dto.history ?? '',
    medication: dto.medication ?? '',
    allergies: dto.allergies ?? '',
    priority: dto.priority,
    fasting: c?.fasting ?? null,
    fastingHours: c?.fasting_hours ?? null,
    pregnancyAsked: !!c?.pregnancy_asked,
    pregnant: c?.pregnancy_asked ? (c.pregnant ?? null) : null,
    weeks: c?.weeks_pregnant ?? null,
    alerts: (c?.infection_alerts ?? []).map((a) => ALERTS[a] ?? a),
    transfusion: c?.transfusion_3m ?? null,
    purpose: dto.purpose ? (PURPOSES[dto.purpose] ?? dto.purpose) : null,
    items: [...(dto.items ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        kind: i.kind,
        short: i.short,
        specimen: i.specimen_label,
        preparation: i.preparation_code && i.preparation_code !== 'none' ? i.preparation_label : null,
        contrast: !!i.contrast_possible,
        ionising: !!i.ionising,
      })),
    safety: safetySrc
      ? {
          contrast: safetySrc.contrast_allergy === 'yes' ? 'Yes' : safetySrc.contrast_allergy === 'no' ? 'No' : null,
          mobility: MOBILITY[safetySrc.mobility] ?? safetySrc.mobility ?? null,
        }
      : null,
    shortfall: null,
  });
}

/**
 * The request as Preview shows it (and the detail page, without the signing
 * footer): patient, clinical rows, the meta line, investigations per tab with
 * counts, the imaging safety line and the warnings.
 */
@Component({
  selector: 'doc-lab-request-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent],
  host: { class: 'flex flex-col' },
  styles: `
    .sum-sec {
      border-bottom: 1px solid var(--color-haze);
      padding: 16px 0;
    }
    .sum-sec:first-child {
      padding-top: 0;
    }
    /* What follows (warnings, the signing block, the signed line) brings its own divider. */
    .sum-sec:last-of-type {
      border-bottom: 0;
      padding-bottom: 0;
    }
  `,
  template: `
    @let v = view();
    <section class="sum-sec flex flex-col gap-1" aria-label="Patient Details">
      <p class="font-sans text-caption text-slate">Patient Details</p>
      <p class="font-sans text-body text-ink [overflow-wrap:anywhere]">{{ v.patientLine }}</p>
      @if (v.patientMeta) {
        <p class="font-sans text-body-sm text-slate [overflow-wrap:anywhere]">{{ v.patientMeta }}</p>
      }
    </section>

    <section class="sum-sec flex flex-col gap-3" aria-label="Clinical information">
      <dl class="flex flex-col gap-3">
        @for (r of v.rows; track r.label) {
          <div class="flex flex-col gap-0.5">
            <dt class="font-sans text-caption text-slate">{{ r.label }}</dt>
            <dd class="whitespace-pre-line font-sans text-body text-ink [overflow-wrap:anywhere]">{{ r.value }}</dd>
          </div>
        }
      </dl>
      <p class="font-sans text-caption text-slate">{{ v.meta }}</p>
    </section>

    <section class="sum-sec flex flex-col gap-3" aria-labelledby="lab-sum-inv">
      <h3 id="lab-sum-inv" class="font-sans text-body font-semibold text-ink">Investigations</h3>
      @if (v.groups.length) {
        <dl class="flex flex-col gap-3">
          @for (g of v.groups; track g.kind) {
            <div class="flex flex-col gap-0.5">
              <dt class="font-sans text-caption text-slate">{{ g.title }}</dt>
              <dd class="font-sans text-body text-ink [overflow-wrap:anywhere]">{{ g.line }}</dd>
              @if (g.specimens) {
                <dd class="font-sans text-caption text-slate [overflow-wrap:anywhere]">{{ g.specimens }}</dd>
              }
            </div>
          }
        </dl>
      } @else {
        <p class="font-sans text-body-sm text-slate">No tests added yet.</p>
      }
      @if (v.safety) {
        <p class="font-sans text-caption text-slate">{{ v.safety }}</p>
      }
    </section>

    @if (v.warnings.length) {
      <div class="flex flex-col gap-2 pt-4">
        @for (w of v.warnings; track w) {
          <sd-alert tone="warning">{{ w }}</sd-alert>
        }
      </div>
    }
  `,
})
export class LabRequestSummary {
  readonly view = input.required<LabSummaryView>();
}
