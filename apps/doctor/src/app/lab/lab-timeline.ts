import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { LabRequestDto, LabRequestStatus } from '@supadoc/models';
import { DoctorClock } from '../doctor-clock';
import { calendarDate, LAB_STATUS_META } from './lab-ui';

export interface LabTimelineStep {
  readonly key: string;
  readonly label: string;
  readonly done: boolean;
  /** ISO instant (done steps). */
  readonly at: string | null;
  readonly actor: string | null;
  /** "Patient reported". */
  readonly tag: string | null;
  /** Extra lines (lab and planned date, reasons, a reported sample date). */
  readonly notes: readonly string[];
}

const TERMINAL: readonly LabRequestStatus[] = ['declined', 'cancelled', 'expired'];

/** The steps still ahead of a request in this status (none once it ended). */
function pending(dto: LabRequestDto): { key: string; label: string; tag: string | null }[] {
  const ahead: { key: string; label: string; tag: string | null; from: LabRequestStatus[] }[] = [
    { key: 'p-accepted', label: 'Accepted by patient', tag: 'Patient reported', from: ['awaiting_consent'] },
    { key: 'p-sample', label: 'Sample given', tag: 'Patient reported', from: ['awaiting_consent', 'booked'] },
    { key: 'p-result', label: 'Result added', tag: null, from: ['awaiting_consent', 'booked', 'in_lab'] },
    { key: 'p-reviewed', label: 'Reviewed', tag: null, from: ['awaiting_consent', 'booked', 'in_lab', 'result_ready'] },
  ];
  if (TERMINAL.includes(dto.status)) return [];
  return ahead
    .filter((s) => s.from.includes(dto.status))
    .filter((s) => s.key !== 'p-reviewed' || dto.status !== 'result_ready' || (dto.unreviewed_count ?? 0) > 0 || !dto.reviewed_at);
}

const statusLabel = (s: LabRequestStatus | null): string => (s ? (LAB_STATUS_META[s]?.label ?? s) : '');

/**
 * The status timeline, oldest first: what happened (who and when), then what
 * is still ahead. Declined / Cancelled / Expired end it. Staff corrections read
 * "Updated by VideoMed support: {from} → {to}".
 */
export function timelineSteps(dto: LabRequestDto): LabTimelineStep[] {
  const steps: LabTimelineStep[] = [];
  const events = [...(dto.timeline ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  events.forEach((e, i) => {
    const base = { key: `${e.event}-${i}`, done: true, at: e.at, actor: e.actor_name ?? null };
    switch (e.event) {
      case 'sent':
        steps.push({ ...base, label: 'Sent', tag: null, notes: [] });
        break;
      case 'accepted': {
        const parts = [
          dto.lab_name ? `Lab: ${dto.lab_name}` : '',
          dto.lab_date ? `Planned for ${calendarDate(dto.lab_date)}` : '',
        ].filter(Boolean);
        steps.push({ ...base, label: 'Accepted by patient', tag: 'Patient reported', notes: parts.length ? [parts.join(' · ')] : [] });
        break;
      }
      case 'sample_given':
        steps.push({ ...base, label: 'Sample given', tag: 'Patient reported', notes: [] });
        break;
      case 'result_added':
        steps.push({ ...base, label: 'Result added', tag: null, notes: [] });
        break;
      case 'result_reviewed':
        steps.push({ ...base, label: 'Reviewed', tag: null, notes: [] });
        break;
      case 'declined':
        steps.push({ ...base, label: 'Declined by patient', tag: null, notes: dto.decline_reason ? [`Reason: ${dto.decline_reason}`] : [] });
        break;
      case 'cancelled':
        steps.push({ ...base, label: 'Cancelled', tag: null, notes: dto.cancel_reason ? [`Reason: ${dto.cancel_reason}`] : [] });
        break;
      case 'expired':
        steps.push({ ...base, label: 'Expired', tag: null, notes: [] });
        break;
      case 'status_corrected': {
        const sample = e.sample_date ? calendarDate(e.sample_date) : '';
        steps.push({
          ...base,
          label: `Updated by VideoMed support: ${statusLabel(e.from_status)} → ${statusLabel(e.to_status)}`,
          tag: null,
          notes: sample ? [`Sample date reported: ${sample}`] : [],
        });
        break;
      }
      // 'reminded': not shown.
    }
  });
  // Expiry is computed on read: with no sweeper run (no cron) there is no stored
  // `expired` event, yet the request has expired — end the timeline the same way.
  if (dto.status === 'expired' && !events.some((e) => e.event === 'expired')) {
    const at = dto.expired_at ?? dto.expires_at ?? null;
    steps.push({ key: 'expired-computed', label: 'Expired', done: true, at, actor: null, tag: null, notes: [] });
  }
  for (const p of pending(dto)) steps.push({ key: p.key, label: p.label, done: false, at: null, actor: null, tag: p.tag, notes: [] });
  return steps;
}

/** The request's status timeline (`<ol>`): a filled dot for what happened, an outline for what is ahead. */
@Component({
  selector: 'doc-lab-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3' },
  styles: `
    .tl-dot {
      width: 20px;
      height: 20px;
      border-radius: 9999px;
      border: 2px solid var(--color-cerulean);
      flex: none;
    }
    .tl-dot.done {
      background: var(--color-cerulean);
    }
    .tl-dot.todo {
      border-color: var(--color-ash);
      background: #fff;
    }
    .tl-line {
      width: 2px;
      flex: 1;
      background: var(--color-haze);
      margin: 4px 0;
    }
  `,
  template: `
    <ol class="flex flex-col">
      @for (s of steps(); track s.key; let last = $last) {
        <li class="flex gap-3">
          <div class="flex flex-col items-center">
            <span class="tl-dot" [class.done]="s.done" [class.todo]="!s.done" aria-hidden="true"></span>
            @if (!last) {
              <span class="tl-line" aria-hidden="true"></span>
            }
          </div>
          <div class="flex min-w-0 flex-col gap-0.5 pb-4">
            <p class="flex flex-wrap items-center gap-2 font-sans text-body-sm" [class]="s.done ? 'font-medium text-ink' : 'text-slate'">
              @if (!s.done) {
                <span class="sr-only">Not yet:</span>
              }
              {{ s.label }}
              @if (s.tag) {
                <span class="rounded-xl bg-cloud px-2 font-sans text-caption font-medium text-slate">{{ s.tag }}</span>
              }
            </p>
            @if (s.done && s.at) {
              <p class="font-sans text-caption text-slate">
                {{ clock.dateTime(s.at) }}{{ s.actor ? ' · ' + s.actor : '' }}
              </p>
            }
            @for (n of s.notes; track n) {
              <p class="font-sans text-caption text-slate [overflow-wrap:anywhere]">{{ n }}</p>
            }
          </div>
        </li>
      }
    </ol>
    <p class="font-sans text-caption text-slate">Booked and In Lab are reported by the patient.</p>
  `,
})
export class LabTimeline {
  protected readonly clock = inject(DoctorClock);
  readonly request = input.required<LabRequestDto>();
  protected readonly steps = computed(() => timelineSteps(this.request()));
}
