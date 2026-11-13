import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  NgZone,
  OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, tap, throwError } from 'rxjs';
import {
  addDaysYmd,
  apiErrorFields,
  apiErrorMessage,
  DoctorApi,
  formatInZone,
  isValidTimeZone,
  zoneAbbr,
  zoneLongName,
} from '@supadoc/data-access';
import type {
  AddAvailabilityInput,
  AddAvailabilityResultDto,
  AvailabilityRepeat,
  AvailabilitySlotDto,
  WeeklyHours,
} from '@supadoc/models';
import { ButtonComponent, DialogComponent, DialogService, IconComponent } from '@supadoc/ui';
import { DoctorClock } from '../doctor-clock';
import { focusAfterDialogs } from '../focus-after-dialog';
import { DoctorTimeZoneDialog } from '../time-zone/time-zone-dialog';

interface DayCell {
  readonly date: string; // YYYY-MM-DD on the doctor's calendar
  readonly day: number;
  readonly inMonth: boolean;
}

const TIME_INPUT =
  'rounded-field border border-[#b8c6d4] bg-white px-3 py-2.5 font-sans text-body-sm text-ink shadow-control focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20 disabled:bg-glacier disabled:text-slate';

/** The Repeats option cards (12px radius, not pills: tailwind/pills.css draws the pills). */
const PILL_ON = 'bg-frost text-cerulean-dark shadow-control';
const PILL_OFF = 'text-slate';

const DURATIONS = [15, 30, 45, 60];

/** Recurring publishes: 1–26 weeks (the API's limit), 8 by default. */
export const MIN_WEEKS = 1;
export const MAX_WEEKS = 26;
/** Nothing beyond this many days from today (the API's horizon). */
export const HORIZON_DAYS = 365;

/** Weekday chips, Monday first; `value` is 0 = Sunday … 6 = Saturday (the API's numbering). */
export const WEEKDAY_CHIPS: readonly { readonly value: number; readonly short: string; readonly name: string }[] = [
  { value: 1, short: 'M', name: 'Monday' },
  { value: 2, short: 'T', name: 'Tuesday' },
  { value: 3, short: 'W', name: 'Wednesday' },
  { value: 4, short: 'T', name: 'Thursday' },
  { value: 5, short: 'F', name: 'Friday' },
  { value: 6, short: 'S', name: 'Saturday' },
  { value: 0, short: 'S', name: 'Sunday' },
];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Your time zone was changed…" (409 `timezone_changed` from another window). */
export const ZONE_CHANGED_TEXT = (long: string, abbr: string) =>
  `Your time zone is now ${long} (${abbr}), changed in another window. Check your times and try again.`;
export const ZONE_FAILED_TEXT = "We couldn't load your time zone, so times can't be changed right now.";
export const API_UPDATING_TEXT = 'VideoMed is being updated. Adding and blocking times will be back in a few minutes.';
export const OLD_API_ADD_TEXT =
  'Your times may have been added at the wrong time or for the first day only. Check the list, remove any that are wrong, and try again in a few minutes.';

/** Minutes since midnight -> 'HH:MM'. */
const hm = (mins: number): string => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
/** 'HH:MM' (or "24:00") -> minutes since midnight. */
const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** The day's last bookable minute when no "until midnight" is chosen. */
const LAST_MINUTE = 23 * 60 + 59;

/** The weekday (0 = Sunday) of a calendar date string — never from an instant. */
export function weekdayOfYmd(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

/** "Mon 9 Nov" for a calendar date string. */
export function shortDay(ymd: string): string {
  return formatInZone(`${ymd}T12:00:00Z`, 'UTC', 'date').replace(/ \d{4}$/, '');
}

/** "9:00 AM" for a wall-clock "HH:MM"; "midnight" for "24:00". */
export function hmLabel(t: string): string {
  if (t === '24:00') return 'midnight';
  return formatInZone(`2026-01-01T${t}:00Z`, 'UTC', 'time');
}

/** The weekdays a publish repeats on (0 = Sunday … 6 = Saturday). */
export function repeatWeekdays(repeat: AvailabilityRepeat, firstYmd: string, days: readonly number[]): number[] {
  if (repeat === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (repeat === 'days') return [...new Set(days)].sort((a, b) => a - b);
  return [weekdayOfYmd(firstYmd)];
}

/** Every date a publish covers: [first, last occurrence], only the chosen weekdays. */
export function occurrenceDates(
  repeat: AvailabilityRepeat,
  firstYmd: string,
  weeks: number,
  days: readonly number[],
): string[] {
  if (repeat === 'none') return [firstYmd];
  const wanted = new Set(repeatWeekdays(repeat, firstYmd, days));
  const span = Math.max(1, weeks) * 7;
  const out: string[] = [];
  for (let i = 0; i < span; i++) {
    const ymd = addDaysYmd(firstYmd, i);
    if (wanted.has(weekdayOfYmd(ymd))) out.push(ymd);
  }
  return out;
}

/** "Every day", "Every Monday", "Weekdays", "Mon, Wed, Fri". */
function repeatPhrase(repeat: AvailabilityRepeat, firstYmd: string, days: readonly number[]): string {
  if (repeat === 'daily') return 'Every day';
  if (repeat === 'weekly') return `Every ${WEEKDAY_NAMES[weekdayOfYmd(firstYmd)]}`;
  const set = repeatWeekdays('days', firstYmd, days);
  if (set.length === 7) return 'Every day';
  if (set.length === 5 && [1, 2, 3, 4, 5].every((d) => set.includes(d))) return 'Weekdays';
  // Monday first, like the chips.
  return WEEKDAY_CHIPS.filter((c) => set.includes(c.value))
    .map((c) => WEEKDAY_SHORT[c.value])
    .join(', ');
}

/**
 * The Add dialog's live summary: "Every day, 9:00 AM – 12:00 PM, Mon 9 Nov →
 * Sun 3 Jan · about 336 times"; one date: "Wed 4 Nov, 9:00 AM – 12:00 PM · 6
 * times". Empty while the form can't make any.
 */
export function addSummary(input: {
  repeat: AvailabilityRepeat;
  date: string;
  start: string;
  end: string;
  duration: number;
  weeks: number;
  days: readonly number[];
}): string {
  const { repeat, date, start, end, duration, weeks, days } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return '';
  const perDay = duration > 0 ? Math.floor((toMinutes(end) - toMinutes(start)) / duration) : 0;
  if (perDay <= 0) return '';
  const range = `${hmLabel(start)} – ${hmLabel(end)}`;
  if (repeat === 'none') return `${shortDay(date)}, ${range} · ${perDay} time${perDay === 1 ? '' : 's'}`;
  if (weeks < MIN_WEEKS || weeks > MAX_WEEKS) return '';
  const dates = occurrenceDates(repeat, date, weeks, days);
  if (!dates.length) return '';
  const total = perDay * dates.length;
  return `${repeatPhrase(repeat, date, days)}, ${range}, ${shortDay(dates[0])} → ${shortDay(dates[dates.length - 1])} · about ${total} times`;
}

/** An API error that is the 409 `timezone_changed`, with the profile's current zone. */
function zoneChanged(err: unknown): string | null {
  const f = apiErrorFields(err);
  return f['code'] === 'timezone_changed' && isValidTimeZone(f['timezone']) ? f['timezone'] : null;
}

/**
 * Date-specific availability (route `/availability`) — calendar + list, with
 * Add Availability (one date, or repeating every day / weekly / on chosen
 * days) and Block modals. Every date and time is on the doctor's PROFILE time
 * zone (`DoctorClock`), sent as `tz` with each request: the page waits for the
 * profile, never writes with the device's zone, and keeps adding and blocking
 * off until the API echoes `tz` (an older API works in UTC).
 */
@Component({
  selector: 'doc-availability',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, ButtonComponent, DialogComponent, IconComponent, DoctorTimeZoneDialog],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Availability</h1>
          <p class="font-sans text-body text-slate">Manage your consultation hour and availability.</p>
          <ng-container [ngTemplateOutlet]="zoneCaption" />
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="flex items-center gap-2 rounded-field border border-haze bg-white px-5 py-3 font-sans text-body-sm font-semibold text-slate shadow-control transition hover:border-alert hover:text-alert active:shadow-none disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none" [disabled]="isPast(selectedDate()) || !canAddBlock()" (click)="openBlock(selectedDate())">
            <sd-icon name="ban" [size]="18" />Block this day
          </button>
          <sd-button [disabled]="isPast(selectedDate()) || !canAddBlock()" (click)="openAdd(selectedDate())">
            <sd-icon name="plus" [size]="18" />Add Availability
          </sd-button>
        </div>
      </header>

      @if (zoneFailed()) {
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink" role="alert">
          <sd-icon name="triangle-alert" [size]="18" class="shrink-0" />
          <span class="min-w-0 flex-1 basis-56">{{ zoneFailedText }}</span>
          <button type="button" class="min-h-11 rounded-field border border-alert/30 bg-white px-4 font-semibold text-alert-ink transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="retrying()" (click)="retryZone()">
            {{ retrying() ? 'Trying…' : 'Try again' }}
          </button>
        </div>
      } @else if (apiOutdated()) {
        <div class="flex items-center gap-2 rounded-card bg-warning/10 px-4 py-2.5 font-sans text-caption text-ink" role="status">
          <sd-icon name="info" [size]="16" class="shrink-0 text-warning" />{{ apiUpdatingText }}
        </div>
      }

      <!-- View toggle -->
      <div class="sd-track sd-track-l w-fit" role="group" aria-label="View">
        <button type="button" class="sd-pill sd-pill-l sd-seg" [attr.aria-pressed]="mode() === 'calendar'" (click)="mode.set('calendar')">Calendar view</button>
        <button type="button" class="sd-pill sd-pill-l sd-seg" [attr.aria-pressed]="mode() === 'list'" (click)="mode.set('list')">List view</button>
      </div>

      <!-- What just happened (an add's counts, a time zone changed elsewhere). -->
      <p class="sr-only" role="status">{{ statusLine() }}</p>
      @if (result(); as r) {
        <div class="flex items-start gap-2 rounded-card bg-sage/10 px-4 py-2.5 font-sans text-caption text-ink" aria-hidden="true">
          <sd-icon name="circle-check" [size]="16" class="mt-px shrink-0 text-sage" />{{ r }}
        </div>
      }
      @if (zoneNotice(); as z) {
        <div class="flex items-start gap-2 rounded-card bg-warning/10 px-4 py-2.5 font-sans text-caption text-ink" aria-hidden="true">
          <sd-icon name="globe" [size]="16" class="mt-px shrink-0 text-warning" />{{ z }}
        </div>
      }
      @if (notice()) {
        <div class="flex items-center gap-2 rounded-card bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert" role="status">
          <sd-icon name="triangle-alert" [size]="16" />{{ notice() }}
        </div>
      }

      @if (mode() === 'calendar') {
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <!-- Month calendar -->
          <section class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card">
            <div class="flex items-center justify-between">
              <h2 class="font-heading text-h5 text-ink">{{ monthLabel() }}</h2>
              <div class="flex items-center gap-1">
                <button type="button" class="flex size-11 items-center justify-center rounded-field text-slate transition-colors hover:bg-glacier" aria-label="Previous month" (click)="shiftMonth(-1)"><sd-icon name="chevron-right" [size]="18" class="rotate-180" /></button>
                <button type="button" class="flex size-11 items-center justify-center rounded-field text-slate transition-colors hover:bg-glacier" aria-label="Next month" (click)="shiftMonth(1)"><sd-icon name="chevron-right" [size]="18" /></button>
              </div>
            </div>
            <div class="grid grid-cols-7 gap-1 text-center">
              @for (w of weekdayLabels; track w) { <span class="py-1 font-sans text-caption font-semibold text-slate">{{ w }}</span> }
              @for (cell of calendar(); track cell.date) {
                <button type="button"
                  class="relative flex h-10 items-center justify-center rounded-field font-sans text-body-sm transition-colors"
                  [class]="cellClass(cell)"
                  [attr.aria-label]="isPast(cell.date) ? cell.day + ' (past)' : null"
                  (click)="selectedDate.set(cell.date)">
                  {{ cell.day }}
                  @if (dayState(cell.date) !== 'none' && selectedDate() !== cell.date) {
                    <span class="absolute bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full" [class]="underlineColor(cell.date)"></span>
                  }
                </button>
              }
            </div>
            <p class="text-center font-sans text-caption text-slate">
              Days with <span class="text-sage">green underline</span> have open slots.
              Day with <span class="text-alert">red underline</span> are blocked.
              Day with <span class="text-warning">Yellow Underline</span> are Unavailable.
            </p>
          </section>

          <ng-container [ngTemplateOutlet]="dayDetail" />
        </div>
      } @else {
        <!-- List view: week days (left) + selected day detail (right) -->
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card">
            <h2 class="font-heading text-h5 text-ink">{{ weekLabel() }}</h2>
            @if (loading()) {
              <div class="sd-shimmer h-48 rounded-field"></div>
            } @else {
              <ul class="flex flex-col gap-3">
                @for (d of weekDays(); track d.date) {
                  <li>
                    <button type="button"
                      class="flex w-full flex-col gap-0.5 rounded-card border border-l-4 px-4 py-3 text-left transition-colors"
                      [class]="(selectedDate() === d.date ? 'border-cerulean/30 bg-frost/40 ' : 'border-cloud bg-white hover:bg-glacier ') + weekBorderColor(d)"
                      (click)="selectedDate.set(d.date)">
                      <span class="font-heading text-body font-semibold text-ink">{{ d.label }}</span>
                      <span class="font-sans text-caption text-slate">
                        {{ d.blocked ? 'Blocked' : (d.open > 0 || d.booked > 0 ? d.open + ' open · ' + d.booked + ' Booked' : (regularFor(d.date) ? 'Regular hours' : 'No availability')) }}
                      </span>
                    </button>
                  </li>
                }
              </ul>
            }
          </section>

          <ng-container [ngTemplateOutlet]="dayDetail" />
        </div>
      }
    </div>

    <!-- "All times are in your time zone…" (page header and the Add dialog). -->
    <ng-template #zoneCaption>
      <p class="flex flex-wrap items-center gap-x-2 font-sans text-caption text-slate">
        <span class="flex items-center gap-1.5"><sd-icon name="globe" [size]="14" class="shrink-0" />All times are in your time zone: {{ clock.longName() }} ({{ clock.abbr() }}).</span>
        @if (clock.supported()) {
          <button type="button" class="min-h-11 rounded-field px-1 font-semibold text-cerulean underline-offset-2 transition-colors hover:text-ocean hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" aria-label="Change time zone" (click)="tzOpen.set(true)">Change</button>
        }
      </p>
    </ng-template>

    <!-- Shared day-detail panel (both views) -->
    <ng-template #dayDetail>
      <section class="flex h-fit flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card">
        <h2 class="font-heading text-h5 text-ink">{{ selectedLabel() }}</h2>
        <!-- Removed here: said, and focused (the Remove button that asked went away with the time). -->
        @if (removed(); as r) {
          @if (r.date === selectedDate()) {
            <p #removedNote tabindex="-1" role="status" class="flex items-center gap-2 rounded-field bg-sage/10 px-4 py-2.5 font-sans text-caption font-semibold text-sage-ink outline-none">
              <sd-icon name="circle-check" [size]="16" class="shrink-0" />{{ r.text }}
            </p>
          }
        }
        @if (loading()) {
          <div class="sd-shimmer h-40 rounded-field"></div>
        } @else if (selectedBlock(); as blk) {
          <div class="flex items-center gap-2 rounded-card bg-alert/10 px-4 py-3.5 font-sans text-body-sm font-medium text-alert">
            <sd-icon name="ban" [size]="18" class="shrink-0" />Blocked - {{ blk.reason || 'No reason given' }}
          </div>
          @if (!isSynthetic(blk)) {
            <button type="button" class="min-h-11 w-fit font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean disabled:opacity-50" [disabled]="busyId() === blk.id || !canRemove()" (click)="removeSlot(blk)">Remove block</button>
          }
        } @else {
          @if (selectedSlots().length === 0) {
            @if (regularFor(selectedDate()); as reg) {
              <!-- No published times: the regular weekly hours patients can book (not removable here). -->
              <ul class="flex flex-col divide-y divide-cloud" aria-label="Regular hours">
                @for (w of reg.windows; track $index) {
                  <li class="flex items-center gap-2 py-3 font-sans text-body-sm text-slate">
                    <sd-icon name="repeat" [size]="15" class="shrink-0" />Regular hours · {{ w }}
                  </li>
                }
              </ul>
              <p class="flex items-start gap-2 font-sans text-caption text-slate">
                <sd-icon name="info" [size]="14" class="mt-px shrink-0" />{{ reg.hint }}
              </p>
            } @else {
              <div class="flex flex-col items-center gap-2 py-10 text-center">
                <sd-icon name="calendar-off" [size]="28" class="text-slate" />
                <p class="font-sans text-body-sm text-slate">No availability set for this day.</p>
              </div>
            }
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (s of selectedSlots(); track s.id) {
                <li class="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div class="flex min-w-0 flex-col wrap-anywhere">
                    <span class="font-sans text-body-sm font-medium text-ink">{{ slotRange(s) }}</span>
                    @if (s.status === 'booked' && s.patient_name) {
                      <span class="flex items-center gap-1 font-sans text-caption text-sage"><sd-icon name="user" [size]="13" />{{ s.patient_name }}</span>
                    }
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    @if (s.series_id) {
                      <span class="sd-chip bg-glacier text-slate"><sd-icon name="repeat" [size]="14" />Repeats</span>
                    }
                    <span class="sd-chip" [class]="statusClass(s.status)">{{ statusLabel(s.status) }}</span>
                    @if (s.status !== 'booked' && !isSynthetic(s)) {
                      <button type="button" class="flex min-h-11 min-w-11 items-center justify-center rounded-field text-slate transition-colors hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-50" [attr.aria-label]="'Remove ' + slotRange(s)" [disabled]="busyId() === s.id || !canRemove()" (click)="removeSlot(s)"><sd-icon name="trash-2" [size]="16" /></button>
                    }
                  </div>
                </li>
              }
            </ul>
          }
          @if (isPast(selectedDate())) {
            <p class="mt-2 flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate">
              <sd-icon name="info" [size]="16" class="mt-px shrink-0" />This day has passed. Pick today or a later day to add or block time.
            </p>
          } @else {
            <div class="mt-2 flex flex-col gap-3 sm:flex-row">
              <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border border-haze bg-white px-4 py-2.5 font-sans text-body-sm font-semibold text-slate shadow-control transition hover:border-alert hover:text-alert active:shadow-none disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none" [disabled]="!canAddBlock()" (click)="openBlock(selectedDate())">
                <sd-icon name="ban" [size]="18" />Block this day
              </button>
              <sd-button [full]="true" [disabled]="!canAddBlock()" (click)="openAdd(selectedDate())"><sd-icon name="plus" [size]="18" />Add Availability</sd-button>
            </div>
          }
        }
      </section>
    </ng-template>

    <!-- Add Availability (the design-system dialog: bottom sheet on phones, focus kept inside, Esc closes). -->
    <sd-dialog [open]="addOpen()" title="Add Availability" size="sm" [busy]="busy()" (closed)="addOpen.set(false)">
        <div class="flex flex-col gap-5">
          <ng-container [ngTemplateOutlet]="zoneCaption" />

          <div class="flex flex-col gap-2">
            <span id="add-often-label" class="font-sans text-body font-semibold text-ink">How often</span>
            <div class="sd-track" role="group" aria-labelledby="add-often-label">
              <button type="button" class="sd-pill sd-pill-s sd-seg flex-1" [attr.aria-pressed]="!addRecurring()" (click)="setRecurring(false)">One-time</button>
              <button type="button" class="sd-pill sd-pill-s sd-seg flex-1" [attr.aria-pressed]="addRecurring()" (click)="setRecurring(true)">Recurring</button>
            </div>
          </div>

          @if (addRecurring()) {
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body font-semibold text-ink" aria-hidden="true">Repeats</span>
              <div class="grid grid-cols-3 gap-1 rounded-card border border-haze bg-glacier p-1" role="group" aria-label="Repeats">
                @for (r of repeatOptions(); track r.value) {
                  <button type="button" class="flex min-h-11 flex-col items-center justify-center rounded-[12px] px-2 py-1.5 text-center font-sans transition" [class]="addRepeat() === r.value ? '${PILL_ON}' : '${PILL_OFF}'" [attr.aria-pressed]="addRepeat() === r.value" (click)="addRepeat.set(r.value)">
                    <span class="text-body-sm font-semibold">{{ r.label }}</span>
                    @if (r.sub) { <span class="text-caption">{{ r.sub }}</span> }
                  </button>
                }
              </div>
              @if (addRepeat() === 'days') {
                <div class="flex flex-col gap-2" role="group" aria-label="Days">
                  <div class="flex gap-2">
                    <button type="button" class="sd-pill sd-pill-s sd-filter" [attr.aria-pressed]="daysAre([1, 2, 3, 4, 5])" (click)="setDays([1, 2, 3, 4, 5])">Weekdays</button>
                    <button type="button" class="sd-pill sd-pill-s sd-filter" [attr.aria-pressed]="daysAre([0, 1, 2, 3, 4, 5, 6])" (click)="setDays([0, 1, 2, 3, 4, 5, 6])">Every day</button>
                  </div>
                  <div class="grid grid-cols-7 gap-1">
                    @for (c of weekdayChips; track c.value) {
                      <button type="button" class="flex min-h-11 items-center justify-center rounded-field border font-sans text-body-sm font-semibold transition" [class]="addDays().includes(c.value) ? 'border-cerulean bg-cerulean text-white' : 'border-haze bg-white text-slate hover:bg-glacier'" [attr.aria-label]="c.name" [attr.aria-pressed]="addDays().includes(c.value)" (click)="toggleDay(c.value)">{{ c.short }}</button>
                    }
                  </div>
                  @if (addDays().length === 0) {
                    <p class="flex items-center gap-1.5 font-sans text-caption text-alert-ink" role="alert"><sd-icon name="circle-alert" [size]="14" class="shrink-0" />Choose at least one day</p>
                  }
                </div>
              }
            </div>
          }

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">{{ addRecurring() ? 'Starts on' : 'Date' }}</span>
            <input type="date" class="${TIME_INPUT}" [min]="today()" [max]="maxDate()" [value]="addDate()" (input)="addDate.set($any($event.target).value)" />
          </label>

          @if (addRecurring()) {
            <div class="flex flex-col gap-2">
              <label for="add-weeks" class="font-sans text-body font-semibold text-ink">For</label>
              <div class="flex items-center gap-2">
                <input id="add-weeks" type="number" inputmode="numeric" min="1" max="26" class="${TIME_INPUT} w-20" [attr.aria-invalid]="weeksError() ? true : null" [attr.aria-describedby]="weeksError() ? 'add-weeks-error' : null" [value]="addWeeksText()" (input)="addWeeksText.set($any($event.target).value)" />
                <span class="font-sans text-body-sm text-slate">weeks</span>
              </div>
              @if (weeksError()) {
                <p id="add-weeks-error" class="flex items-center gap-1.5 font-sans text-caption text-alert-ink"><sd-icon name="circle-alert" [size]="14" class="shrink-0" />{{ weeksError() }}</p>
              }
            </div>
          }

          <div class="flex flex-col gap-2">
            <span id="add-duration-label" class="font-sans text-body font-semibold text-ink">Consultation duration</span>
            <div class="sd-track" role="group" aria-labelledby="add-duration-label">
              @for (d of durations; track d) {
                <button type="button" class="sd-pill sd-pill-s sd-seg flex-1" [attr.aria-pressed]="addDuration() === d" (click)="addDuration.set(d)">{{ d }} mins</button>
              }
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <span id="add-range-label" class="font-sans text-body font-semibold text-ink">Time Range</span>
            <div class="flex flex-wrap items-center gap-2" role="group" aria-labelledby="add-range-label">
              <input type="time" aria-label="Start time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="addDate() === today() && !addRecurring() ? nowTime() : null" [value]="addStart()" (input)="addStart.set($any($event.target).value)" />
              <span class="font-sans text-caption text-slate">to</span>
              <input type="time" aria-label="End time" class="${TIME_INPUT} min-w-0 flex-1" [disabled]="addMidnight()" [attr.min]="addStart() || null" [value]="addMidnight() ? '' : addEnd()" (input)="addEnd.set($any($event.target).value)" />
              <button type="button" class="sd-pill sd-pill-s sd-filter" [attr.aria-pressed]="addMidnight()" (click)="addMidnight.set(!addMidnight())">Until midnight</button>
            </div>
            <p class="font-sans text-caption text-slate">Working overnight? Add two times: until midnight on the first day, then from midnight on the next.</p>
          </div>

          <p class="font-sans text-caption text-slate" aria-live="polite">{{ summary() }}</p>

          @if (addError()) { <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert" role="alert">{{ addError() }}</p> }
        </div>
        <div dialogFooter class="flex shrink-0 border-t border-cloud px-5 py-4 sm:px-6">
          <sd-button class="w-full" [full]="true" [disabled]="busy()" (click)="submitAdd()">{{ busy() ? 'Saving…' : 'Save Availability' }}</sd-button>
        </div>
    </sd-dialog>

    <!-- Block Availability -->
    <sd-dialog [open]="blockOpen()" title="Block Availability" subtitle="Patients can't book blocked times." size="sm" [busy]="busy()" (closed)="blockOpen.set(false)">
        <div class="flex flex-col gap-5">
          <ng-container [ngTemplateOutlet]="zoneCaption" />

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Date</span>
            <input type="date" class="${TIME_INPUT}" [min]="today()" [max]="maxDate()" [value]="blockDate()" (input)="blockDate.set($any($event.target).value)" />
          </label>

          <div class="sd-track" role="group" aria-label="What to block">
            <button type="button" class="sd-pill sd-pill-s sd-seg flex-1" [attr.aria-pressed]="blockEntire()" (click)="blockEntire.set(true)">Entire day</button>
            <button type="button" class="sd-pill sd-pill-s sd-seg flex-1" [attr.aria-pressed]="!blockEntire()" (click)="blockEntire.set(false)">Specific time</button>
          </div>

          @if (!blockEntire()) {
            <div class="flex flex-col gap-2">
              <span id="block-range-label" class="font-sans text-body font-semibold text-ink">Time Range</span>
              <div class="flex items-center gap-2" role="group" aria-labelledby="block-range-label">
                <input type="time" aria-label="Start time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="blockDate() === today() ? nowTime() : null" [value]="blockStart()" (input)="blockStart.set($any($event.target).value)" />
                <span class="font-sans text-caption text-slate">to</span>
                <input type="time" aria-label="End time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="blockStart() || null" [value]="blockEnd()" (input)="blockEnd.set($any($event.target).value)" />
              </div>
            </div>
          }

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Reason (optional)</span>
            <input type="text" class="${TIME_INPUT}" placeholder="e.g. Vacation, personal leave" [value]="blockReason()" (input)="blockReason.set($any($event.target).value)" />
          </label>

          @if (blockError()) { <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert" role="alert">{{ blockError() }}</p> }
        </div>
        <div dialogFooter class="flex shrink-0 border-t border-cloud px-5 py-4 sm:px-6">
          <button type="button" class="flex min-h-11 w-full items-center justify-center gap-2 rounded-field bg-alert px-5 py-3 font-sans text-body font-semibold text-white inset-shadow-rim transition-colors hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40 focus-visible:ring-offset-2 disabled:opacity-60" [disabled]="busy()" (click)="submitBlock()">
            <sd-icon name="ban" [size]="18" />{{ busy() ? 'Blocking…' : blockEntire() ? 'Block this day' : 'Block these times' }}
          </button>
        </div>
    </sd-dialog>

    <doc-time-zone-dialog [open]="tzOpen()" (closed)="tzOpen.set(false)" (saved)="load()" />
  `,
})
export class DoctorAvailability implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogs = inject(DialogService);
  private readonly injector = inject(Injector);
  private readonly zone = inject(NgZone);
  protected readonly clock = inject(DoctorClock);

  protected readonly weekdayLabels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  protected readonly weekdayChips = WEEKDAY_CHIPS;
  protected readonly durations = DURATIONS;
  protected readonly zoneFailedText = ZONE_FAILED_TEXT;
  protected readonly apiUpdatingText = API_UPDATING_TEXT;
  /** Ticks so "today" and "now" stay current while the page is open. */
  private readonly tick = signal(Date.now());
  /** Today on the doctor's calendar. Earlier days are read-only. */
  protected readonly today = computed(() => {
    this.tick();
    return this.clock.today();
  });
  /** Now on the doctor's clock, 'HH:MM' — the earliest start allowed on today's date. */
  protected readonly nowTime = computed(() => {
    this.tick();
    return this.clock.nowHm();
  });
  /** The furthest date a time can be added or blocked on (12 months ahead). */
  protected readonly maxDate = computed(() => addDaysYmd(this.today(), HORIZON_DAYS));

  protected readonly mode = signal<'calendar' | 'list'>('calendar');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly notice = signal('');
  /** The counts of the last add ("Added 336 times (Mon 9 Nov – Sun 3 Jan)…"). */
  protected readonly result = signal('');
  /** "Your time zone is now …, changed in another window…". */
  protected readonly zoneNotice = signal('');
  /** One polite announcement for both lines above. */
  protected readonly statusLine = computed(() => [this.result(), this.zoneNotice()].filter(Boolean).join(' '));
  /** What Remove just took off, on which day (shown on that day's panel). */
  protected readonly removed = signal<{ date: string; text: string } | null>(null);
  private readonly removedNote = viewChild<ElementRef<HTMLElement>>('removedNote');
  protected readonly slots = signal<AvailabilitySlotDto[]>([]);
  protected readonly slotMinutes = signal(30);
  /** The zone the last list was read in (`tz` echoed); null from an older (UTC) API. */
  private readonly listTz = signal<string | null>(null);
  /** The last list has been answered (with or without `tz`). */
  private readonly listed = signal(false);
  /** The zone the last list was asked for in (a zone change elsewhere reads again). */
  private lastLoadTz: string | null = null;
  private readonly regularHours = signal<WeeklyHours | null>(null);
  private readonly regularSource = signal<'own' | 'default' | null>(null);
  protected readonly retrying = signal(false);
  protected readonly tzOpen = signal(false);

  /** The profile (and its zone) failed to load: nothing can be changed. */
  protected readonly zoneFailed = computed(() => this.clock.status() === 'failed');
  /** The API answered without `tz` (still the UTC one): adding and blocking wait. */
  protected readonly apiOutdated = computed(() => this.listed() && this.listTz() === null && !this.zoneFailed());
  /** The zone every write carries: the loaded profile's, never the device's. */
  private readonly writeTz = computed(() => (this.clock.status() === 'ready' ? this.clock.zone() : null));
  /** Add and Block: the zone is loaded and the API reads it. */
  protected readonly canAddBlock = computed(() => this.writeTz() !== null && this.listTz() !== null);
  /** Remove: the zone is loaded (an older API ignores it). */
  protected readonly canRemove = computed(() => this.writeTz() !== null);

  /** First day of the visible month, as a calendar date (UTC midnight). */
  protected readonly monthCursor = signal(this.firstOfMonth(this.clock.today()));
  protected readonly selectedDate = signal(this.clock.today());

  // Add modal
  protected readonly addOpen = signal(false);
  protected readonly addRecurring = signal(false);
  protected readonly addRepeat = signal<Exclude<AvailabilityRepeat, 'none'>>('daily');
  protected readonly addDays = signal<number[]>([1, 2, 3, 4, 5]);
  protected readonly addDate = signal(this.clock.today());
  protected readonly addDuration = signal(30);
  protected readonly addStart = signal('09:00');
  protected readonly addEnd = signal('12:00');
  protected readonly addMidnight = signal(false);
  /** The weeks box as typed (an empty box is an error, never 0). */
  protected readonly addWeeksText = signal('8');
  protected readonly addError = signal('');

  // Block modal
  protected readonly blockOpen = signal(false);
  protected readonly blockDate = signal(this.clock.today());
  protected readonly blockEntire = signal(true);
  protected readonly blockStart = signal('09:00');
  protected readonly blockEnd = signal('12:00');
  protected readonly blockReason = signal('');
  protected readonly blockError = signal('');

  protected readonly repeatOptions = computed(() => [
    { value: 'daily' as const, label: 'Every day', sub: 'Monday to Sunday' },
    { value: 'weekly' as const, label: 'Weekly', sub: `Every ${WEEKDAY_NAMES[weekdayOfYmd(this.validDate(this.addDate()))]}` },
    { value: 'days' as const, label: 'Choose days', sub: null },
  ]);

  /** The weeks as a number, or null when empty / not 1–26. */
  private readonly addWeeks = computed(() => {
    const raw = this.addWeeksText().trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= MIN_WEEKS && n <= MAX_WEEKS ? n : null;
  });
  protected readonly weeksError = computed(() => (this.addRecurring() && this.addWeeks() === null ? 'Choose 1 to 26 weeks' : ''));
  private readonly repeat = computed<AvailabilityRepeat>(() => (this.addRecurring() ? this.addRepeat() : 'none'));
  private readonly endValue = computed(() => (this.addMidnight() ? '24:00' : this.addEnd()));

  protected readonly summary = computed(() =>
    addSummary({
      repeat: this.repeat(),
      date: this.addDate(),
      start: this.addStart(),
      end: this.endValue(),
      duration: this.addDuration(),
      weeks: this.addWeeks() ?? 0,
      days: this.addDays(),
    }),
  );

  protected readonly monthLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(this.monthCursor()),
  );

  protected readonly selectedLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${this.selectedDate()}T00:00:00Z`)) + '.',
  );

  /** 42-cell (6-week) grid starting on the Monday on/before the 1st (calendar dates). */
  protected readonly calendar = computed<DayCell[]>(() => {
    const cursor = this.monthCursor();
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1));
    // Monday-first offset (getUTCDay: 0=Sun..6=Sat).
    const offset = (first.getUTCDay() + 6) % 7;
    const start = new Date(Date.UTC(year, month, 1 - offset));
    const cells: DayCell[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      cells.push({
        date: d.toISOString().slice(0, 10),
        day: d.getUTCDate(),
        inMonth: d.getUTCMonth() === month,
      });
    }
    return cells;
  });

  /** Per-day counts, keyed by the doctor's YYYY-MM-DD — drives underlines, borders and labels. */
  private readonly dayInfo = computed(() => {
    const map = new Map<string, { open: number; booked: number; blocked: boolean }>();
    for (const s of this.slots()) {
      const key = this.dayKey(s);
      const info = map.get(key) ?? { open: 0, booked: 0, blocked: false };
      if (s.status === 'open') info.open++;
      else if (s.status === 'booked') info.booked++;
      else if (s.status === 'blocked') info.blocked = true;
      map.set(key, info);
    }
    return map;
  });

  /** One of 'open' (green) | 'blocked' (red) | 'booked' (yellow/unavailable) | 'none'. */
  protected dayState(date: string): 'open' | 'blocked' | 'booked' | 'none' {
    const i = this.dayInfo().get(date);
    if (!i) return 'none';
    if (i.open > 0) return 'open';
    if (i.blocked) return 'blocked';
    if (i.booked > 0) return 'booked';
    return 'none';
  }

  protected readonly selectedSlots = computed(() =>
    this.slots()
      .filter((s) => this.dayKey(s) === this.selectedDate())
      // Keep open/booked slots and specific-time block rows (so they stay
      // visible and removable); drop the full-day block (handled by
      // selectedBlock) and overlapped-open rows re-tagged blocked.
      .filter((s) => (s.kind === 'block' ? !this.isFullDayBlock(s) : s.status !== 'blocked'))
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)),
  );

  /**
   * Only an ENTIRE-day block short-circuits the day panel. A specific-time block
   * must not hide the day's still-open slots or the Add/Block controls, and must
   * be matched by kind so "Remove block" never deletes an overlapped open slot.
   */
  protected readonly selectedBlock = computed(() => {
    const day = this.selectedDate();
    return this.slots().find((s) => this.dayKey(s) === day && s.kind === 'block' && this.isFullDayBlock(s)) ?? null;
  });

  /**
   * An entire-day block: the API's `entire_day` (the local day's bounds in
   * `tz`); from an older API, one from the doctor's midnight lasting a day.
   */
  private isFullDayBlock(s: AvailabilitySlotDto): boolean {
    if (s.kind !== 'block') return false;
    if (typeof s.entire_day === 'boolean') return s.entire_day;
    return this.clock.format(s.starts_at, 'hm') === '00:00' && Date.parse(s.ends_at) - Date.parse(s.starts_at) >= 23 * 3_600_000;
  }

  /** A row's day on the doctor's calendar. */
  private dayKey(s: AvailabilitySlotDto): string {
    return this.clock.ymd(s.starts_at);
  }

  /** The seven days (Mon–Sun) of the week containing the selected date — the list view. */
  protected readonly weekDays = computed(() => {
    const sel = this.selectedDate();
    const offset = (weekdayOfYmd(sel) + 6) % 7; // Monday-first
    const monday = addDaysYmd(sel, -offset);
    const out: { date: string; label: string; open: number; booked: number; blocked: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDaysYmd(monday, i);
      const info = this.dayInfo().get(date) ?? { open: 0, booked: 0, blocked: false };
      out.push({
        date,
        label: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)),
        ...info,
      });
    }
    return out;
  });

  protected readonly weekLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${this.selectedDate()}T00:00:00Z`)),
  );

  constructor() {
    // The zone changed elsewhere (the shell banner's "Use …", possibly moving the
    // times too; another window): read the list again in it, so no row from before
    // the move is shown, grouped in the new zone. The dialog here and a 409 reload by
    // themselves (`load()` records the zone it read in), so they aren't read twice.
    effect(() => {
      const z = this.clock.profileZone();
      untracked(() => {
        if (this.listed() && z && z !== this.lastLoadTz) this.load();
      });
    });
  }

  ngOnInit(): void {
    // Outside the zone: a forever-ticking timer would keep the page from ever being stable.
    const tick = this.zone.runOutsideAngular(() => setInterval(() => this.tick.set(Date.now()), 30_000));
    this.destroyRef.onDestroy(() => clearInterval(tick));
    void this.start();
  }

  /** Wait for the doctor's zone (the profile), then show their calendar in it. */
  private async start(): Promise<void> {
    await this.clock.ensureLoaded();
    this.resetToToday();
    this.load();
  }

  /** "Try again" after the profile failed to load. */
  protected async retryZone(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    try {
      await this.clock.retry();
    } finally {
      this.retrying.set(false);
    }
    this.resetToToday();
    this.load();
  }

  private resetToToday(): void {
    const today = this.clock.today();
    this.selectedDate.set(today);
    this.monthCursor.set(this.firstOfMonth(today));
  }

  /** The visible grid's rows, read in the doctor's zone (nothing without it). */
  protected load(): void {
    const tz = this.writeTz();
    if (!tz) {
      this.loading.set(false);
      return;
    }
    this.lastLoadTz = tz;
    this.loading.set(true);
    this.notice.set('');
    // Fetch every day the 42-cell grid actually renders (a month can trail up to
    // ~14 days into the next one), so no visible cell is missing its slot data.
    const cells = this.calendar();
    const from = cells[0].date;
    const to = cells[cells.length - 1].date;
    this.api
      .availability(from, to, tz)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const d = res.data;
          this.slots.set(d.slots);
          this.slotMinutes.set(d.slot_minutes);
          this.addDuration.set(d.slot_minutes);
          this.listTz.set(typeof d.tz === 'string' && d.tz !== '' ? d.tz : null);
          this.regularHours.set(d.regular_hours ?? null);
          this.regularSource.set(d.regular_hours_source ?? null);
          this.listed.set(true);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          if (this.onZoneChanged(err)) return;
          this.notice.set(apiErrorMessage(err, 'Could not load your availability.'));
        },
      });
  }

  /**
   * A 409 `timezone_changed` (the zone was changed in another window): take
   * the profile's zone, reload, and say so. True when it was one.
   */
  private onZoneChanged(err: unknown): boolean {
    const tz = zoneChanged(err);
    if (!tz) return false;
    this.clock.apply({ timezone: tz });
    this.zoneNotice.set(ZONE_CHANGED_TEXT(zoneLongName(tz), zoneAbbr(tz)));
    this.load();
    return true;
  }

  protected shiftMonth(delta: number): void {
    const c = this.monthCursor();
    this.monthCursor.set(new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + delta, 1)));
    this.load();
  }

  protected cellClass(cell: DayCell): string {
    if (this.selectedDate() === cell.date) return 'bg-cerulean font-semibold text-white';
    const base = !cell.inMonth ? 'text-slate/40 hover:bg-glacier' : this.isPast(cell.date) ? 'text-slate/60 hover:bg-glacier' : 'text-ink hover:bg-glacier';
    return cell.date === this.today() ? `${base} ring-1 ring-inset ring-cerulean/40` : base;
  }

  /** A day before today: viewable, but nothing can be added or blocked on it. */
  protected isPast(date: string): boolean {
    return date < this.today();
  }

  /** Underline colour for a calendar day by its state. */
  protected underlineColor(date: string): string {
    return { open: 'bg-sage', blocked: 'bg-alert', booked: 'bg-warning', none: '' }[this.dayState(date)];
  }

  /**
   * Left-border colour for a list-view day card. Precedence matches the calendar
   * underline / legend (open > blocked > booked): green only when there are open
   * slots, so a fully-booked day reads yellow ("Unavailable"), never green.
   */
  protected weekBorderColor(d: { open: number; booked: number; blocked: boolean }): string {
    if (d.open > 0) return 'border-l-sage';
    if (d.blocked) return 'border-l-alert';
    if (d.booked > 0) return 'border-l-warning';
    return 'border-l-cloud';
  }

  /**
   * The regular weekly hours patients can book on a day with no published
   * times (the doctor's own, or the weekday default) — null when none apply.
   */
  protected regularFor(date: string): { windows: string[]; hint: string } | null {
    const hours = this.regularHours();
    const source = this.regularSource();
    if (!hours || !source) return null;
    if ((this.dayInfo().get(date)?.blocked ?? false) || this.slots().some((s) => this.dayKey(s) === date)) return null;
    const windows = (hours[String(weekdayOfYmd(date))] ?? []).filter(
      (w): w is [string, string] => Array.isArray(w) && typeof w[0] === 'string' && typeof w[1] === 'string',
    );
    if (!windows.length) return null;
    return {
      windows: windows.map(([a, b]) => `${hmLabel(a)} – ${hmLabel(b)}`),
      hint:
        source === 'own'
          ? 'Patients can book these unless you publish times for this day.'
          : 'Your default weekday hours. Publishing any times replaces them.',
    };
  }

  protected isSynthetic(s: AvailabilitySlotDto): boolean {
    return s.id.startsWith('appt-');
  }

  protected slotRange(s: AvailabilitySlotDto): string {
    return `${this.clock.time(s.starts_at)} - ${this.clock.time(s.ends_at)}`;
  }

  protected statusClass(status: string): string {
    return status === 'booked'
      ? 'bg-sage/15 text-sage-ink'
      : status === 'blocked'
        ? 'bg-alert/10 text-alert-ink'
        : 'bg-frost text-cerulean-dark';
  }
  protected statusLabel(status: string): string {
    return status === 'booked' ? 'Booked' : status === 'blocked' ? 'Blocked' : 'Open';
  }

  // ----- Add: repeat choices -----
  protected setRecurring(on: boolean): void {
    if (on && !this.addRecurring()) this.addRepeat.set('daily');
    this.addRecurring.set(on);
  }

  protected toggleDay(day: number): void {
    this.addDays.update((list) => (list.includes(day) ? list.filter((d) => d !== day) : [...list, day]));
  }

  protected setDays(days: number[]): void {
    this.addDays.set([...days]);
  }

  protected daysAre(days: number[]): boolean {
    const set = this.addDays();
    return set.length === days.length && days.every((d) => set.includes(d));
  }

  // ----- Modals -----
  protected openAdd(date: string): void {
    this.tick.set(Date.now());
    // A disabled <sd-button> still lets a click reach its host, so these are refused here too.
    if (this.isPast(date) || !this.canAddBlock()) return;
    const [day, start, end] = this.defaultAddRange(this.notBeforeToday(date));
    this.addDate.set(day);
    this.addRecurring.set(false);
    this.addRepeat.set('daily');
    this.addDays.set([1, 2, 3, 4, 5]);
    this.addDuration.set(this.slotMinutes());
    this.addStart.set(start);
    this.addEnd.set(end);
    this.addMidnight.set(false);
    this.addWeeksText.set('8');
    this.addError.set('');
    this.removed.set(null);
    this.addOpen.set(true);
  }

  protected openBlock(date: string): void {
    this.tick.set(Date.now());
    if (this.isPast(date) || !this.canAddBlock()) return;
    const day = this.notBeforeToday(date);
    const [start, end] = this.defaultBlockRange(day);
    this.blockDate.set(day);
    this.blockEntire.set(true);
    this.blockStart.set(start);
    this.blockEnd.set(end);
    this.blockReason.set('');
    this.blockError.set('');
    this.removed.set(null);
    this.blockOpen.set(true);
  }

  /** A pre-filled date is clamped to today — a picker's `min` doesn't reject a value already set. */
  private notBeforeToday(date: string): string {
    return date && !this.isPast(date) ? date : this.today();
  }

  /** Today's next half hour (minutes; up to 24:00), or null when 09:00 is still ahead / it isn't today. */
  private nextHalfHour(date: string): number | null {
    if (date !== this.today()) return null;
    const from = Math.ceil(toMinutes(this.nowTime()) / 30) * 30;
    return from <= 9 * 60 ? null : from;
  }

  /**
   * The Add pre-fill [date, start, end]: 09:00–12:00, or from the next half hour
   * once 09:00 has gone today, always long enough for one slot. When not even one
   * slot fits before 23:59 any more, it moves to tomorrow, 09:00–12:00.
   */
  private defaultAddRange(date: string): [string, string, string] {
    const from = this.nextHalfHour(date);
    if (from === null) return [date, '09:00', '12:00'];
    const slot = this.slotMinutes();
    if (from + slot > LAST_MINUTE) return [addDaysYmd(date, 1), '09:00', '12:00'];
    return [date, hm(from), hm(Math.max(Math.min(from + 180, LAST_MINUTE), from + slot))];
  }

  /**
   * The Block pre-fill for a specific time: 09:00–12:00, or the next half hour
   * onward today; in the day's last half hour, now to 23:59. The date stays put:
   * the default "entire day" block of today is always allowed.
   */
  private defaultBlockRange(date: string): [string, string] {
    const from = this.nextHalfHour(date);
    if (from === null) return ['09:00', '12:00'];
    if (from >= LAST_MINUTE) return [this.nowTime(), hm(LAST_MINUTE)];
    return [hm(from), hm(Math.min(from + 180, LAST_MINUTE))];
  }

  /** Why a start on `date` at `start` can't be used (it has gone by), or '' when it can. */
  private pastStartError(date: string, start: string | null): string {
    this.tick.set(Date.now());
    if (date === '') return 'Choose a date.';
    if (this.isPast(date)) return 'Choose today or a later date.';
    if (start !== null && date === this.today() && start < this.nowTime()) {
      return `That start time has passed. Choose ${hmLabel(this.nowTime())} or later.`;
    }
    return '';
  }

  /** The Add form's first problem, or '' when it can be sent. */
  private addProblem(): string {
    const repeat = this.repeat();
    // A series skips today's earlier times itself; a single time can't start in the past.
    const past = this.pastStartError(this.addDate(), repeat === 'none' ? this.addStart() : null);
    if (past) return past;
    if (repeat === 'days' && this.addDays().length === 0) return 'Choose at least one day';
    const weeks = this.addWeeks();
    if (repeat !== 'none' && weeks === null) return 'Choose 1 to 26 weeks';
    const dates = occurrenceDates(repeat, this.addDate(), weeks ?? 1, this.addDays());
    if (!dates.length) return 'None of the chosen days fall in this period';
    if (this.addDate() > this.maxDate() || dates[dates.length - 1] > this.maxDate()) return 'Choose a date within the next 12 months';
    if (!/^\d{2}:\d{2}$/.test(this.addStart()) || !/^\d{2}:\d{2}$/.test(this.endValue())) return 'Choose a start and an end time.';
    const start = toMinutes(this.addStart());
    const end = toMinutes(this.endValue());
    if (end <= start) return 'End time must be after the start time.';
    if (end - start < this.addDuration()) return `The time range must fit at least one ${this.addDuration()}-minute slot.`;
    return '';
  }

  protected async submitAdd(): Promise<void> {
    if (this.busy()) return;
    const tz = this.writeTz();
    if (!tz || !this.canAddBlock()) return;
    const problem = this.addProblem();
    if (problem) {
      this.addError.set(problem);
      return;
    }
    const repeat = this.repeat();
    const body: AddAvailabilityInput = {
      date: this.addDate(),
      start: this.addStart(),
      end: this.endValue(),
      duration: this.addDuration(),
      tz,
      repeat,
      ...(repeat === 'days' ? { days: [...this.addDays()].sort((a, b) => a - b) } : {}),
      ...(repeat !== 'none' ? { weeks: this.addWeeks() ?? 8 } : {}),
    };
    this.busy.set(true);
    this.addError.set('');
    try {
      const res = await firstValueFrom(this.api.addAvailability(body));
      this.addOpen.set(false);
      this.selectedDate.set(this.addDate());
      this.notice.set('');
      this.zoneNotice.set('');
      this.result.set(this.resultText(res.data));
      this.load();
    } catch (err) {
      if (this.onZoneChanged(err)) {
        this.addError.set(this.zoneNotice());
      } else {
        this.addError.set(apiErrorMessage(err, 'Could not add availability.'));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** "Added 336 times (Mon 9 Nov – Sun 3 Jan). 6 fall on blocked times…" */
  private resultText(r: Partial<AddAvailabilityResultDto> & { created: number }): string {
    // An older API (no `tz` in the answer) read the times as UTC, and only the first day.
    if (typeof r.tz !== 'string') return OLD_API_ADD_TEXT;
    const parts: string[] = [];
    if (r.created === 0) {
      parts.push('Those slots already exist for that time.');
    } else {
      const first = r.first_at ? shortDay(this.clock.ymd(r.first_at)) : '';
      const last = r.last_at ? shortDay(this.clock.ymd(r.last_at)) : '';
      const span = first && last ? (first === last ? ` (${first})` : ` (${first} – ${last})`) : '';
      parts.push(`Added ${r.created} time${r.created === 1 ? '' : 's'}${span}.`);
      if (r.existing) parts.push(`${r.existing} already existed.`);
    }
    if (r.overlapping) parts.push(`${r.overlapping} overlapped other times and were skipped.`);
    if (r.blocked) parts.push(`${r.blocked} fall on blocked times (they'll open if you remove the block).`);
    if (r.past) parts.push(`${r.past} earlier times today were skipped.`);
    return parts.join(' ');
  }

  protected async submitBlock(): Promise<void> {
    if (this.busy()) return;
    const tz = this.writeTz();
    if (!tz || !this.canAddBlock()) return;
    const past = this.pastStartError(this.blockDate(), this.blockEntire() ? null : this.blockStart());
    if (past) {
      this.blockError.set(past);
      return;
    }
    if (this.blockDate() > this.maxDate()) {
      this.blockError.set('Choose a date within the next 12 months');
      return;
    }
    if (!this.blockEntire() && this.blockEnd() <= this.blockStart()) {
      this.blockError.set('End time must be after the start time.');
      return;
    }
    this.busy.set(true);
    this.blockError.set('');
    try {
      await firstValueFrom(
        this.api.blockAvailability({
          date: this.blockDate(),
          entire_day: this.blockEntire(),
          start: this.blockStart(),
          end: this.blockEnd(),
          reason: this.blockReason(),
          tz,
        }),
      );
      this.blockOpen.set(false);
      this.selectedDate.set(this.blockDate());
      this.result.set('');
      this.load();
    } catch (err) {
      if (this.onZoneChanged(err)) {
        this.blockError.set(this.zoneNotice());
      } else {
        this.blockError.set(apiErrorMessage(err, 'Could not block the day.'));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Remove an open time or a block — asked first; the request runs in the
   * dialog (inline error). A repeating time offers "Only this time" or "This
   * and later times" (booked consultations are never removed).
   */
  protected async removeSlot(s: AvailabilitySlotDto): Promise<void> {
    if (this.busyId() || !this.writeTz()) return;
    this.notice.set('');
    this.removed.set(null);
    const block = s.kind === 'block' || s.status === 'blocked';
    const series = !block && !!s.series_id;
    const date = this.selectedDate();
    const day = this.dayName(s.starts_at);
    // The zone is read on each press: after a 409 `timezone_changed` the dialog stays
    // open, and pressing again must send the zone just taken, never the first one.
    const remove = (scope: 'one' | 'following') => {
      const zone = this.writeTz();
      if (!zone) return throwError(() => new Error(ZONE_FAILED_TEXT));
      return this.api.deleteAvailability(s.id, scope, zone).pipe(
        tap({
          error: (err: unknown) => {
            const changed = zoneChanged(err);
            if (changed) {
              this.clock.apply({ timezone: changed });
              this.load();
            }
          },
        }),
      );
    };
    const errorMessage = (err: unknown) => {
      if (err instanceof Error && err.message === ZONE_FAILED_TEXT) return ZONE_FAILED_TEXT;
      const changed = zoneChanged(err);
      if (changed) return ZONE_CHANGED_TEXT(zoneLongName(changed), zoneAbbr(changed));
      return apiErrorMessage(err, block ? 'Could not remove the block.' : 'Could not remove that time.');
    };
    let removedCount = 1;
    this.busyId.set(s.id);
    try {
      const { confirmed, choice } = series
        ? await this.dialogs.confirm({
            tone: 'warning',
            icon: 'trash-2',
            title: `Remove ${this.clock.time(s.starts_at)}?`,
            message: 'This time repeats. Booked consultations are never removed.',
            confirmLabel: 'Only this time',
            cancelLabel: 'Keep it',
            action: () => remove('one'),
            secondary: {
              label: 'This and later times',
              value: 'following',
              action: () =>
                remove('following').pipe(
                  tap((res) => {
                    removedCount = res?.data?.deleted ?? 1;
                  }),
                ),
            },
            errorMessage,
          })
        : await this.dialogs.confirm({
            tone: 'warning',
            icon: block ? 'calendar-check' : 'trash-2',
            title: block
              ? this.isFullDayBlock(s) ? `Remove the block on ${day}?` : `Remove the ${this.slotRange(s)} block on ${day}?`
              : `Remove ${this.slotRange(s)}?`,
            message: block
              ? 'Patients can book your open times on this day again.'
              : `It comes off your availability on ${day}, and patients can no longer book it.`,
            confirmLabel: block ? 'Remove block' : 'Remove time',
            cancelLabel: 'Keep it',
            action: () => remove('one'),
            errorMessage,
          });
      if (choice === 'following') {
        this.removed.set({
          date,
          text: `${removedCount} time${removedCount === 1 ? '' : 's'} removed. Booked consultations were kept.`,
        });
        this.load();
        focusAfterDialogs(this.injector, () => this.removedNote()?.nativeElement);
      } else if (confirmed) {
        this.slots.update((list) => list.filter((x) => x.id !== s.id));
        this.removed.set({
          date,
          text: block ? 'Block removed — patients can book this day again.' : `${this.slotRange(s)} removed from your availability.`,
        });
        // Its Remove button (the dialog's opener) went with it: focus what happened instead.
        focusAfterDialogs(this.injector, () => this.removedNote()?.nativeElement);
      }
    } finally {
      this.busyId.set(null);
    }
  }

  /** "Thu 16 Oct" for a row's start, on the doctor's clock. */
  private dayName(iso: string): string {
    return shortDay(this.clock.ymd(iso));
  }

  /** A date string that parses (the Weekly caption while the date box is being edited). */
  private validDate(ymd: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : this.today();
  }

  private firstOfMonth(ymd: string): Date {
    const [y, m] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, 1));
  }
}
