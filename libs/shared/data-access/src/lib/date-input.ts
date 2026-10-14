import type { DayAvailability } from '@supadoc/models';

/**
 * Local-time values for native date / time pickers and slot labels.
 *
 * `<input type="date">` and `datetime-local` speak the viewer's wall clock, so
 * their `min` must too — `toISOString().slice(…)` is UTC and is hours (or a
 * whole day) off for most viewers. Slot labels are likewise built here from each
 * slot's ISO instant rather than shown as the server's UTC text, so the earliest
 * slots never read as times that have already gone by.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** A Date as local 'YYYY-MM-DD'. */
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TIME_LABEL = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

/**
 * Today on the viewer's calendar, 'YYYY-MM-DD' — for a date input's `[min]`.
 * `offsetDays` shifts it, e.g. `todayLocal(-7)` for a one-week backdate limit.
 */
export function todayLocal(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return localYmd(d);
}

/**
 * Now on the viewer's clock, 'YYYY-MM-DDTHH:mm' — for a datetime-local input's
 * `[min]`. Pass `roundUpMinutes` (e.g. 30) to round up to the next boundary:
 * the browser counts `step` from `min`, so a 30-minute step needs a :00/:30 min.
 */
export function nowLocalInput(roundUpMinutes = 1): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const step = Math.max(1, Math.floor(roundUpMinutes));
  const over = d.getMinutes() % step;
  if (over !== 0) d.setMinutes(d.getMinutes() + step - over);
  return `${localYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A slot's start in the viewer's local time, e.g. "9:30 AM". */
export function slotLabel(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : TIME_LABEL.format(d);
}

/**
 * The slots endpoint's days (grouped by UTC date, with UTC labels) regrouped by
 * the viewer's LOCAL date, with local labels — and without any slot that has
 * started since the list was fetched. Same `DayAvailability` shape, so a
 * template that renders the server days renders these unchanged.
 */
export function localSlotDays(days: readonly DayAvailability[]): DayAvailability[] {
  const now = Date.now();
  const byDate = new Map<string, DayAvailability>();
  for (const day of days) {
    for (const slot of day.slots) {
      const at = new Date(slot.iso);
      if (isNaN(at.getTime()) || at.getTime() <= now) continue;
      const date = localYmd(at);
      let bucket = byDate.get(date);
      if (!bucket) {
        bucket = { date, weekday: WEEKDAY_LABEL.format(at), day: String(at.getDate()), slots: [] };
        byDate.set(date, bucket);
      }
      bucket.slots.push({ iso: slot.iso, label: TIME_LABEL.format(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}` });
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, slots: d.slots.sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime()) }));
}
