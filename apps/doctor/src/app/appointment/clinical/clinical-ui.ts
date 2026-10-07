import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';

/**
 * Shared look for the Schedule Details → Clinical tools sub-tabs, copied from
 * the screens already at Figma parity (Overview cards, Edit Profile fields,
 * the prescriptions panel's header / list rows / empty state).
 */

/** White surface card on the glacier page (Overview + Schedule card treatment). */
export const CLINICAL_CARD =
  'flex flex-col gap-5 rounded-card border border-cloud bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-6';

/** One item card in a sub-tab's list (the History / Past Visits card treatment). */
export const CLINICAL_LIST_ITEM =
  'rounded-card border border-cloud bg-white p-4 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-5';

/** Card sub-heading (e.g. "New lab order"). */
export const CLINICAL_H3 = 'flex items-center gap-2 font-heading text-body font-semibold text-ink';

/**
 * Small count pill next to a sub-heading — the same neutral pill as the
 * patient record's section counts (reads on both white cards and the page).
 */
export const CLINICAL_COUNT =
  'rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-semibold text-slate';

/** Field label above a control (the Edit Profile / sd-input label). */
export const CLINICAL_LABEL = 'font-sans text-body font-semibold text-ink';
/** Helper text under a field. */
export const CLINICAL_HINT = 'font-sans text-caption text-slate';
/** Metadata row under a list item title (date · author · …). */
export const CLINICAL_META =
  'flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-caption text-slate';

const FIELD_BASE =
  'w-full rounded-field border border-[#b8c6d4] bg-white font-sans text-body-sm text-ink ' +
  'shadow-[0_1px_2px_rgba(10,22,40,0.04)] transition-all duration-200 placeholder:text-slate/60 ' +
  'hover:border-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20 ' +
  'disabled:cursor-not-allowed disabled:bg-cloud/40 disabled:text-slate';

/** Single-line input (16px radius, light border, Cerulean focus ring). */
export const CLINICAL_INPUT = `${FIELD_BASE} px-4 py-3`;
/** Single-line input with a leading icon (place the icon with {@link CLINICAL_INPUT_ICON}). */
export const CLINICAL_INPUT_WITH_ICON = `${FIELD_BASE} py-3 pl-11 pr-4`;
/** The leading icon inside a `relative` wrapper. */
export const CLINICAL_INPUT_ICON =
  'pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate';
/** Multi-line field. */
export const CLINICAL_TEXTAREA = `${FIELD_BASE} min-h-24 resize-y px-4 py-3 leading-relaxed`;

/** Pill segmented control built from native radios (keyboard arrows work). */
export const CLINICAL_SEGMENTED =
  'flex w-full max-w-full gap-1 rounded-pill border border-cloud bg-white p-1 sm:w-fit';
export const CLINICAL_SEGMENT =
  'flex flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-pill px-4 py-2 ' +
  'font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink ' +
  'has-[:checked]:bg-frost has-[:checked]:text-cerulean ' +
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-cerulean/40';

/** Selectable option card built from a native radio. */
export const CLINICAL_RADIO_CARD =
  'flex cursor-pointer items-center gap-2.5 rounded-field border border-[#b8c6d4] bg-white px-4 py-3 ' +
  'font-sans text-body-sm text-ink transition-colors hover:border-slate/50 ' +
  'has-[:checked]:border-cerulean has-[:checked]:bg-frost/30 has-[:checked]:font-semibold ' +
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-cerulean/40';

/** A link styled as `<sd-button variant="outline" size="sm">` (for real `<a href>`s). */
export const CLINICAL_LINK_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-field bg-transparent px-3 py-2.5 font-sans text-[14px] ' +
  'font-semibold leading-[22px] tracking-[0.48px] text-cerulean ring-1 ring-inset ring-cerulean transition-all ' +
  'duration-200 hover:bg-frost/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/60';

export type ClinicalTone = 'neutral' | 'brand' | 'draft' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<ClinicalTone, string> = {
  neutral: 'bg-cloud text-slate',
  brand: 'bg-frost text-cerulean',
  draft: 'bg-frost/60 text-ocean',
  success: 'bg-sage/15 text-sage',
  // Ink on the amber tint: amber text on it is below AA contrast (as in the patient record badges).
  warning: 'bg-warning/15 text-ink',
  danger: 'bg-alert/10 text-alert',
};

/** Routine / Urgent — icon + text, never colour alone. */
export const PRIORITY_META: Record<
  'routine' | 'urgent',
  { readonly label: string; readonly icon: string; readonly tone: ClinicalTone }
> = {
  routine: { label: 'Routine', icon: 'clock', tone: 'neutral' },
  urgent: { label: 'Urgent', icon: 'zap', tone: 'danger' },
};

/**
 * Sub-tab header — the prescriptions panel's pattern: a Lexend title with a
 * Cerulean icon, one line of helper text, and projected trailing content
 * (a status badge or an action).
 *
 * Usage: `<doc-clinical-header icon="pill" heading="Lab orders" helper="…"><doc-clinical-badge … /></doc-clinical-header>`
 */
@Component({
  selector: 'doc-clinical-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between' },
  template: `
    <div class="flex min-w-0 flex-col gap-0.5">
      <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink">
        <sd-icon [name]="icon()" [size]="18" class="shrink-0 text-cerulean" />{{ heading() }}
      </h2>
      @if (helper()) {
        <p class="font-sans text-caption text-slate">{{ helper() }}</p>
      }
    </div>
    <ng-content />
  `,
})
export class ClinicalHeader {
  readonly icon = input.required<string>();
  readonly heading = input.required<string>();
  readonly helper = input('');
}

/**
 * Status badge — icon + text in a tinted pill (the prescription status badge's
 * shape). Usage: `<doc-clinical-badge tone="success" icon="circle-check" label="Finalized" />`.
 */
@Component({
  selector: 'doc-clinical-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'inline-flex shrink-0' },
  template: `
    <span
      class="inline-flex items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold"
      [class]="toneClass()"
    >
      <sd-icon [name]="icon()" [size]="13" [class]="pulse() ? 'motion-safe:animate-pulse' : ''" />
      {{ label() }}
    </span>
  `,
})
export class ClinicalBadge {
  readonly label = input.required<string>();
  readonly icon = input.required<string>();
  readonly tone = input<ClinicalTone>('neutral');
  /** Gently pulse the icon (e.g. a live recording). */
  readonly pulse = input(false);

  protected readonly toneClass = computed(() => TONE_CLASS[this.tone()]);
}

/**
 * Compact empty block for lists inside a sub-tab — the prescriptions panel's
 * dashed empty state, so every list in Clinical tools reads the same.
 */
@Component({
  selector: 'doc-clinical-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col items-center gap-3 rounded-card border border-dashed border-ash bg-white px-4 py-10 text-center">
      <span class="flex size-14 items-center justify-center rounded-full bg-glacier text-slate">
        <sd-icon [name]="icon()" [size]="26" />
      </span>
      <p class="max-w-sm font-sans text-body-sm text-slate">{{ message() }}</p>
      <ng-content />
    </div>
  `,
})
export class ClinicalEmpty {
  readonly icon = input.required<string>();
  readonly message = input.required<string>();
}
