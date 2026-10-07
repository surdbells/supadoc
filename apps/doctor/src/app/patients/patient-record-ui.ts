import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type {
  AllergyRow,
  AllergySeverity,
  AppointmentDto,
  ConditionRow,
  MedicationRow,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/**
 * Presentational building blocks for the doctor's patient record
 * (`/patients/:id`): badge metadata (always icon + text, never colour alone),
 * formatting helpers and a few tiny display components shared by the
 * Overview / Medical history / Visits tabs.
 */

/** An icon + label + colour treatment for a pill badge. */
export interface BadgeMeta {
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
}

/** Shared pill-badge base (matches `doc-rx-status-badge`). */
const BADGE =
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold';

// ----- Allergies -----

interface SeverityMeta extends BadgeMeta {
  /** 0 = most serious — used to list the riskiest allergies first. */
  readonly rank: number;
  /** Severe or life-threatening: drives the alert-coloured banner. */
  readonly serious: boolean;
}

const SEVERITY: Record<AllergySeverity, SeverityMeta> = {
  'life-threatening': { label: 'Life-threatening', icon: 'shield-alert', cls: 'bg-alert text-white', rank: 0, serious: true },
  severe: { label: 'Severe', icon: 'circle-alert', cls: 'bg-alert/10 text-alert', rank: 1, serious: true },
  moderate: { label: 'Moderate', icon: 'triangle-alert', cls: 'bg-warning/15 text-ink', rank: 2, serious: false },
  mild: { label: 'Mild', icon: 'info', cls: 'bg-cloud text-slate', rank: 3, serious: false },
  unknown: { label: 'Severity not known', icon: 'circle-help', cls: 'bg-cloud text-slate', rank: 4, serious: false },
};

/** Free-text severities from older saves (Low / Medium / High …) → the fixed list. */
const SEVERITY_ALIASES: Record<string, AllergySeverity> = {
  mild: 'mild',
  low: 'mild',
  minor: 'mild',
  moderate: 'moderate',
  medium: 'moderate',
  severe: 'severe',
  high: 'severe',
  serious: 'severe',
  'life-threatening': 'life-threatening',
  'life threatening': 'life-threatening',
  lifethreatening: 'life-threatening',
  unknown: 'unknown',
  'not sure': 'unknown',
};

/** Badge for a stored allergy severity (unrecognised text is shown as typed). */
export function allergySeverity(raw: string | null | undefined): SeverityMeta {
  const text = (raw ?? '').trim();
  if (text === '') return { ...SEVERITY.unknown, label: 'Severity not recorded', rank: 5 };
  const key = text.toLowerCase().replace(/[\s_]+/g, ' ');
  const known = SEVERITY_ALIASES[key] ?? SEVERITY_ALIASES[key.replace(/ /g, '-')];
  return known ? SEVERITY[known] : { ...SEVERITY.unknown, label: text };
}

/** Allergies, most serious first (stable for equal severities). */
export function sortAllergies(rows: readonly AllergyRow[]): AllergyRow[] {
  return [...rows].sort((a, b) => allergySeverity(a.severity).rank - allergySeverity(b.severity).rank);
}

// ----- Conditions -----

const CONDITION_STATUS: Record<string, BadgeMeta> = {
  active: { label: 'Active', icon: 'activity', cls: 'bg-frost text-cerulean' },
  managed: { label: 'Managed', icon: 'shield-check', cls: 'bg-sage/15 text-sage' },
  resolved: { label: 'Resolved', icon: 'circle-check', cls: 'bg-cloud text-slate' },
};

/** Badge for a condition's status, or null when none was recorded. */
export function conditionStatus(raw: string | null | undefined): BadgeMeta | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  return CONDITION_STATUS[text.toLowerCase()] ?? { label: text, icon: 'info', cls: 'bg-cloud text-slate' };
}

/** A condition counts as current unless it is marked resolved. */
export function isCurrentCondition(c: ConditionRow): boolean {
  return (c.status ?? '').trim().toLowerCase() !== 'resolved';
}

// ----- Appointments -----

const VISIT_STATUS: Record<string, BadgeMeta> = {
  pending: { label: 'Pending', icon: 'hourglass', cls: 'bg-warning/15 text-ink' },
  confirmed: { label: 'Confirmed', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  rescheduled: { label: 'Rescheduled', icon: 'refresh-cw', cls: 'bg-cloud text-slate' },
  completed: { label: 'Completed', icon: 'calendar-check', cls: 'bg-frost text-cerulean' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
};

/** Parse an ISO date-time (or local `YYYY-MM-DD`) to epoch ms; NaN-safe (0). */
export function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const d = parseDate(value);
  return d ? d.getTime() : 0;
}

/** Visits newest first. */
export function sortVisits(rows: readonly AppointmentDto[]): AppointmentDto[] {
  return [...rows].sort((a, b) => timeOf(b.scheduled_at) - timeOf(a.scheduled_at));
}

/** A visit that is still ahead (not cancelled / completed, scheduled in the future). */
export function isUpcomingVisit(a: AppointmentDto, now: number): boolean {
  return a.status !== 'cancelled' && a.status !== 'completed' && timeOf(a.scheduled_at) > now;
}

// ----- Medications -----

/** The API stores herbal as a string flag ('1' when herbal / traditional). */
export function isHerbal(flag: string | boolean | null | undefined): boolean {
  if (typeof flag === 'boolean') return flag;
  return /^(1|yes|true)$/i.test((flag ?? '').trim());
}

// ----- Formatting -----

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' });

/** Parse `YYYY-MM-DD` as a LOCAL date (no timezone shift) or any ISO string. */
function parseDate(value: string): Date | null {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** "3 Mar 1991" (or ""). */
export function formatDate(value: string | null | undefined): string {
  const d = value ? parseDate(value) : null;
  return d ? DATE_FMT.format(d) : '';
}

/** "Tue, 3 Oct 2026" (or ""). */
export function formatDay(value: string | null | undefined): string {
  const d = value ? parseDate(value) : null;
  return d ? DAY_FMT.format(d) : '';
}

/** "09:15" (or ""). */
export function formatTime(value: string | null | undefined): string {
  const d = value ? parseDate(value) : null;
  return d ? TIME_FMT.format(d) : '';
}

/** Whole years since a date of birth, or null when missing / implausible. */
export function ageFrom(dob: string | null | undefined): number | null {
  const d = dob ? parseDate(dob) : null;
  if (!d) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Up to two initials, e.g. "Amaka Obi" → "AO". */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** "Female" from "female" (or ""). */
export function capitalise(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
}

// ----- Components -----

/** Appointment status pill — icon + text, e.g. ✓ Confirmed. */
@Component({
  selector: 'doc-visit-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'inline-flex' },
  template: `
    <span class="${BADGE}" [class]="meta().cls">
      <sd-icon [name]="meta().icon" [size]="13" />{{ meta().label }}
    </span>
  `,
})
export class VisitStatusBadge {
  readonly status = input.required<string>();
  /** The API's own label (preferred when present). */
  readonly label = input<string>('');
  protected readonly meta = computed<BadgeMeta>(() => {
    const known = VISIT_STATUS[this.status()];
    const base = known ?? { label: this.status(), icon: 'info', cls: 'bg-cloud text-slate' };
    return this.label() ? { ...base, label: this.label() } : base;
  });
}

/** Allergy severity pill — icon + text; serious levels in the alert colour. */
@Component({
  selector: 'doc-allergy-severity-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'inline-flex' },
  template: `
    <span class="${BADGE}" [class]="meta().cls">
      <sd-icon [name]="meta().icon" [size]="13" />{{ meta().label }}
    </span>
  `,
})
export class AllergySeverityBadge {
  readonly severity = input<string>('');
  protected readonly meta = computed(() => allergySeverity(this.severity()));
}

/** Condition status pill (renders nothing when no status was recorded). */
@Component({
  selector: 'doc-condition-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'inline-flex empty:hidden' },
  template: `
    @if (meta(); as m) {
      <span class="${BADGE}" [class]="m.cls">
        <sd-icon [name]="m.icon" [size]="13" />{{ m.label }}
      </span>
    }
  `,
})
export class ConditionStatusBadge {
  readonly status = input<string>('');
  protected readonly meta = computed(() => conditionStatus(this.status()));
}

/** One medication: name, dose · frequency, "for <reason>" and a Herbal chip. */
@Component({
  selector: 'doc-medication-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex items-start gap-3' },
  template: `
    <span class="flex size-9 shrink-0 items-center justify-center rounded-full" [class]="herbal() ? 'bg-sage/15 text-sage' : 'bg-frost text-cerulean'" aria-hidden="true">
      <sd-icon [name]="herbal() ? 'leaf' : 'pill'" [size]="16" />
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="break-words font-sans text-body-sm font-semibold text-ink">{{ med().name }}</span>
        @if (herbal()) {
          <span class="${BADGE} bg-sage/15 text-sage"><sd-icon name="leaf" [size]="12" />Herbal</span>
        }
      </div>
      @if (doseLine()) {
        <span class="font-sans text-caption text-slate">{{ doseLine() }}</span>
      }
      @if (med().reason) {
        <span class="font-sans text-caption text-slate">for {{ med().reason }}</span>
      }
    </div>
  `,
})
export class MedicationItem {
  readonly med = input.required<MedicationRow>();
  protected readonly herbal = computed(() => isHerbal(this.med().herbal));
  protected readonly doseLine = computed(() =>
    [this.med().dosage, this.med().frequency].filter((p) => !!p && p.trim() !== '').join(' · '),
  );
}

/**
 * A design-system record card: an icon + title header bar (with an optional
 * count), the projected body, a small empty state, and an optional projected
 * `[sectionFooter]` (the dashboard's "View all" bar).
 *
 * Usage: `<doc-record-section icon="pill" heading="Medications" [count]="n" [empty]="n === 0" emptyText="…">…</doc-record-section>`
 */
@Component({
  selector: 'doc-record-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex min-w-0 flex-col overflow-hidden rounded-card border border-cloud bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)]' },
  template: `
    <div class="flex items-center justify-between gap-3 border-b border-cloud px-5 py-4">
      <h3 class="flex min-w-0 items-center gap-2 font-heading text-body-lg text-ink">
        <sd-icon [name]="icon()" [size]="20" class="shrink-0" [class]="iconClass()" />
        <span class="min-w-0 break-words">{{ heading() }}</span>
      </h3>
      @if (count() && !empty()) {
        <span class="shrink-0 rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-semibold text-slate">
          <span class="sr-only">{{ heading() }}: </span>{{ count() }}
        </span>
      }
    </div>
    @if (empty()) {
      <div class="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center">
        <span class="flex size-12 items-center justify-center rounded-full bg-glacier text-slate">
          <sd-icon [name]="emptyIcon() || icon()" [size]="22" />
        </span>
        <p class="font-sans text-body-sm text-slate">{{ emptyText() }}</p>
        @if (emptyHint()) {
          <p class="max-w-xs font-sans text-caption text-slate">{{ emptyHint() }}</p>
        }
      </div>
    } @else {
      <ng-content />
    }
    <ng-content select="[sectionFooter]" />
  `,
})
export class RecordSection {
  readonly icon = input.required<string>();
  readonly heading = input.required<string>();
  readonly iconClass = input('text-cerulean');
  readonly count = input<number | null>(null);
  readonly empty = input(false);
  readonly emptyText = input('None recorded');
  readonly emptyHint = input('');
  readonly emptyIcon = input('');
}
