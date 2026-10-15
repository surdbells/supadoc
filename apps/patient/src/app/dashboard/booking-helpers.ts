import type { ParamMap } from '@angular/router';
import {
  addDaysYmd,
  todayLocal,
  viewerTimeZone,
  type ListSpecialistsQuery,
} from '@supadoc/data-access';
import type { PartOfDay } from '@supadoc/models';
import { shortDayLabel } from '@supadoc/ui';

/**
 * Availability helpers shared by the patient's booking, appointment and
 * directory screens: the directory's "when" filters (deep-linkable as
 * `?when=today|tomorrow|week|YYYY-MM-DD&time=morning|afternoon|evening`), and
 * how a doctor who can no longer be booked is worded. Every date is a day on
 * the viewer's own calendar, and the API is always told the viewer's zone.
 */

export type WhenChoice = 'any' | 'today' | 'tomorrow' | 'week' | 'date';
export type TimeOfDay = PartOfDay | 'any';

/** The directory's "when" filters: a day (or today / tomorrow / this week) and a part of the day. */
export interface WhenFilter {
  readonly when: WhenChoice;
  /** 'YYYY-MM-DD' on the viewer's calendar while `when` is 'date' ('' until one is picked). */
  readonly date: string;
  readonly time: TimeOfDay;
}

export const ANY_WHEN: WhenFilter = { when: 'any', date: '', time: 'any' };

/**
 * How far ahead patients can book unless the clinic changed it (BookingSettings
 * `horizon_days`). Only bounds the "Pick a date" input; the API says when a
 * date is out of range (422 `available_on`).
 */
export const DEFAULT_HORIZON_DAYS = 60;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PARTS: readonly PartOfDay[] = ['morning', 'afternoon', 'evening'];
const PART_TEXT: Record<PartOfDay, string> = {
  morning: 'in the morning',
  afternoon: 'in the afternoon',
  evening: 'in the evening',
};

/** The last day the "Pick a date" input offers. */
export function lastSearchDay(): string {
  return addDaysYmd(todayLocal(), DEFAULT_HORIZON_DAYS - 1);
}

/** `?when=…&time=…` → a filter (anything unknown, or a past date, reads as "any"). */
export function whenFromQuery(q: ParamMap): WhenFilter {
  const w = (q.get('when') ?? '').toLowerCase();
  const t = (q.get('time') ?? '').toLowerCase();
  const time: TimeOfDay = (PARTS as readonly string[]).includes(t)
    ? (t as PartOfDay)
    : 'any';
  if (w === 'today' || w === 'tomorrow' || w === 'week')
    return { when: w, date: '', time };
  if (YMD.test(w) && w >= todayLocal()) return { when: 'date', date: w, time };
  return { ...ANY_WHEN, time };
}

/** The filter as deep-link query params (each absent while "any"). */
export function whenQuery(f: WhenFilter): { when?: string; time?: string } {
  return {
    when:
      f.when === 'any'
        ? undefined
        : f.when === 'date'
          ? f.date || undefined
          : f.when,
    time: f.time === 'any' ? undefined : f.time,
  };
}

/** A day is filtered on (a picked date, or today / tomorrow / this week). */
export function hasDateFilter(f: WhenFilter): boolean {
  return f.when === 'date' ? f.date !== '' : f.when !== 'any';
}

/** Any "when" filter is on (a day or a part of the day). */
export function hasWhenFilter(f: WhenFilter): boolean {
  return hasDateFilter(f) || f.time !== 'any';
}

/** The filter as directory API params — `tz` always, so the days are the viewer's. */
export function whenParams(
  f: WhenFilter,
): Pick<
  ListSpecialistsQuery,
  'available_on' | 'available_within' | 'part_of_day' | 'tz'
> {
  return {
    available_on: f.when === 'date' && f.date ? f.date : undefined,
    available_within:
      f.when === 'today' || f.when === 'tomorrow' || f.when === 'week'
        ? f.when
        : undefined,
    part_of_day: f.time === 'any' ? undefined : f.time,
    tz: viewerTimeZone(),
  };
}

/** The single day the filter is about ('YYYY-MM-DD'), or null for "any" / "this week". */
export function whenDay(f: WhenFilter): string | null {
  switch (f.when) {
    case 'today':
      return todayLocal();
    case 'tomorrow':
      return todayLocal(1);
    case 'date':
      return f.date || null;
    default:
      return null;
  }
}

/** The last day the filter covers (this week: today + 6), or null without a date filter. */
export function whenLastDay(f: WhenFilter): string | null {
  return f.when === 'week' ? todayLocal(6) : whenDay(f);
}

/** "today", "tomorrow", "this week", "on Thu 16 Oct" — and "… in the evening". */
export function whenText(f: WhenFilter): string {
  const day =
    f.when === 'today'
      ? 'today'
      : f.when === 'tomorrow'
        ? 'tomorrow'
        : f.when === 'week'
          ? 'this week'
          : f.when === 'date' && f.date
            ? `on ${shortDayLabel(f.date)}`
            : '';
  const part = f.time === 'any' ? '' : PART_TEXT[f.time];
  return [day, part].filter(Boolean).join(' ');
}

/** The HTTP status of a failed request, from either error shape (normalised or raw). */
export function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : undefined;
}

/** What a patient reads about a doctor who can't be booked (suspended, no longer listed, switched off). */
export function notBookableText(name: string | null | undefined): string {
  return `${name || 'This doctor'} isn't taking bookings at the moment.`;
}

/**
 * The calendar store's error, worded for a patient: its 404 (a doctor who is
 * no longer listed) reads as "isn't taking bookings", not "… not found".
 */
export function calendarErrorText(
  error: string | null,
  name: string | null | undefined,
): string {
  if (!error) return '';
  return /not found/i.test(error) ? notBookableText(name) : error;
}
