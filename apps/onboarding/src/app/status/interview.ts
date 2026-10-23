import { timeZoneShortLabel, viewerTimeZone } from '@supadoc/data-access';
import { CLINIC_TZ } from '../core/format';

function wall(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

function time(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/**
 * "Wednesday 14 October, 10:00 WAT · video call" in clinic time; when the
 * viewer's clock differs, " · 09:00 your time (BST)" is added.
 */
export function interviewLabel(startsAt: string, viewerTz: string = viewerTimeZone()): string {
  const at = new Date(startsAt);
  if (Number.isNaN(at.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLINIC_TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(at);
  let label = `${day}, ${time(at, CLINIC_TZ)} WAT · video call`;
  if (wall(at, viewerTz) !== wall(at, CLINIC_TZ)) {
    label += ` · ${time(at, viewerTz)} your time (${timeZoneShortLabel(viewerTz, at)})`;
  }
  return label;
}
