import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type {
  FollowUpMode,
  PregnancyStatus,
  PrescriptionStatus,
  ReadingKey,
  ReadingSource,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/**
 * Shared bits for the doctor's e-prescribing screens (GVM-RX-02): status
 * badge, field classes, date helpers and fallback labels.
 */

/** Base field treatment (border colour comes from {@link RX_OK} / {@link RX_BAD}). */
export const RX_FIELD =
  'w-full rounded-field border bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-cloud/40 disabled:text-slate';
export const RX_OK = 'border-cloud focus:border-cerulean focus:ring-cerulean/20';
export const RX_BAD = 'border-alert ring-2 ring-alert/20 focus:border-alert focus:ring-alert/30';

/** Small bordered action button used in lists (View PDF, Download, …). */
export const RX_ACTION =
  'inline-flex items-center justify-center gap-1.5 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean disabled:cursor-not-allowed disabled:opacity-60';
export const RX_ACTION_DANGER =
  'inline-flex items-center justify-center gap-1.5 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-caption font-semibold text-alert transition-colors hover:border-alert disabled:cursor-not-allowed disabled:opacity-60';

export interface RxStatusMeta {
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
}

/** Every status has an icon AND text — never colour alone. */
export const RX_STATUS: Record<PrescriptionStatus, RxStatusMeta> = {
  draft: { label: 'Draft', icon: 'pen-line', cls: 'bg-frost/60 text-ocean' },
  active: { label: 'Active', icon: 'circle-check', cls: 'bg-sage/15 text-sage' },
  expired: { label: 'Expired', icon: 'hourglass', cls: 'bg-cloud text-slate' },
  cancelled: { label: 'Cancelled', icon: 'circle-x', cls: 'bg-alert/10 text-alert' },
};

/** Fallback labels (the API's option lists are preferred when loaded). */
export const RX_READING_LABELS: Record<ReadingKey, { label: string; unit: string }> = {
  temperature: { label: 'Temperature', unit: '°C' },
  heart_rate: { label: 'Heart rate', unit: 'beats/min' },
  blood_pressure: { label: 'Blood pressure', unit: 'mmHg' },
  respiratory_rate: { label: 'Breathing rate', unit: 'breaths/min' },
  oxygen_saturation: { label: 'Oxygen level', unit: '%' },
  blood_sugar: { label: 'Blood sugar', unit: 'mmol/L' },
  weight: { label: 'Weight', unit: 'kg' },
  height: { label: 'Height', unit: 'cm' },
  bmi: { label: 'BMI', unit: 'kg/m²' },
  pain_score: { label: 'Pain score', unit: '/10' },
};

export const RX_SOURCE_LABELS: Record<ReadingSource, string> = {
  patient_device: "Patient's own device",
  video: 'Seen on video',
  clinic: 'Clinic',
  lab: 'Lab',
};

export const RX_PREGNANCY_LABELS: Record<PregnancyStatus, string> = {
  no: 'No',
  pregnant: 'Pregnant',
  breastfeeding: 'Breastfeeding',
  unknown: 'Not sure',
  not_applicable: 'Not applicable',
};

export const RX_FOLLOW_UP_LABELS: Record<FollowUpMode, string> = {
  video: 'Video',
  in_person: 'In person',
};

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const SHORT_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Parse `YYYY-MM-DD` as a LOCAL date (no timezone shift) or any ISO string. */
function parseDate(value: string): Date | null {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** "3 Oct 2026" (or "—"). */
export function rxDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseDate(value);
  return d ? DATE_FMT.format(d) : '—';
}

/** "3 Oct 2026, 09:15" (or "—"). */
export function rxDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseDate(value);
  return d ? `${DATE_FMT.format(d)}, ${TIME_FMT.format(d)}` : '—';
}

/** "3 Oct, 09:15" (or ""). */
export function rxShortDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = parseDate(value);
  return d ? `${SHORT_FMT.format(d)}, ${TIME_FMT.format(d)}` : '';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Today as a local `YYYY-MM-DD` (for `min` on date inputs). */
export function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Now as a local `YYYY-MM-DDTHH:mm` (for `max` on datetime-local inputs). */
export function nowLocalInput(): string {
  const d = new Date();
  return `${todayYmd()}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO date-time → local `YYYY-MM-DDTHH:mm` for a datetime-local input. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local datetime-local value → ISO 8601 (UTC). */
export function localInputToIso(local: string): string {
  const d = new Date(local);
  return isNaN(d.getTime()) ? local : d.toISOString();
}

/** "1 medicine" / "3 medicines". */
export function medicinesLabel(n: number): string {
  return `${n} medicine${n === 1 ? '' : 's'}`;
}

/** Join a value and its unit: "37.2°C", "92 %"→"92%", "148/92 mmHg". */
export function withUnit(value: string, unit: string | null | undefined): string {
  if (!unit) return value;
  return /^[%/°]/.test(unit) ? `${value}${unit}` : `${value} ${unit}`;
}

/** Status badge — icon + text, e.g. ✓ Active. */
@Component({
  selector: 'doc-rx-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'inline-flex' },
  template: `
    <span
      class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold"
      [class]="meta().cls"
    >
      <sd-icon [name]="meta().icon" [size]="13" />
      {{ meta().label }}
    </span>
  `,
})
export class RxStatusBadge {
  readonly status = input.required<PrescriptionStatus>();
  /** Only a real draft says "Draft" — an unexpected status is shown as it is. */
  protected readonly meta = computed<RxStatusMeta>(() => {
    const status = this.status();
    // Own keys only, so an odd value never matches e.g. `constructor`.
    return Object.hasOwn(RX_STATUS, status)
      ? RX_STATUS[status]
      : { label: humanStatus(String(status ?? '')), icon: 'info', cls: 'bg-cloud text-slate' };
  });
}

/** "partially_filled" → "Partially filled" (fallback label for an unknown status). */
function humanStatus(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Unknown';
}
