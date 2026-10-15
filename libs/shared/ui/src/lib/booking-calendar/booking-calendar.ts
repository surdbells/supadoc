import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  NgZone,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { AvailabilityDayDto, DaySlotDto } from '@supadoc/models';
import { addMonths, monthGrid, timeZoneShortLabel, viewerTimeZone, ymdInZone } from '@supadoc/data-access';
import { IconComponent } from '../icon/icon';
import {
  BookingCalendarCell,
  clampYmd,
  dayAccessibleName,
  dayState,
  groupSlots,
  isOpenStatus,
  keyTarget,
  lastDayOfMonth,
  longDayLabel,
  monthTitle,
  msToNextDay,
  navigableBounds,
  shortDayLabel,
  timesCount,
  weekdayHeaders,
} from './booking-calendar.model';

let nextId = 0;

/**
 * Month calendar + time picker for booking a consultation. Presentational: it
 * fetches nothing — feed it a range's `days`, the chosen day's `slots`, and
 * follow its outputs (`AvailabilityCalendarStore` from @supadoc/data-access is
 * made for this). Every date is a 'YYYY-MM-DD' on the calendar of the zone the
 * availability was asked for (the viewer's by default); `value` is a slot's ISO
 * start.
 *
 * The grid is the WAI-ARIA APG date-picker grid: arrows move by day / week,
 * Home / End to the week's ends, PageUp / PageDown by month (Shift: year),
 * Enter / Space choose. Fully booked or closed days can still be chosen — the
 * times panel then shows "Next available" (a day after the chosen one; off
 * with `[nextOnEmptyDay]="false"` when the projected content offers its own)
 * and the projected `[calendarEmpty]` content (alternative doctors, say).
 * Past days and days beyond the booking window can't. Times are native radios
 * grouped Morning / Afternoon / Evening.
 *
 * Angular creates projected content whether or not the calendar shows it, so
 * wrap anything that loads data in an `@if` on the day having no times (a block
 * with one root element is still projected by that element's attribute).
 *
 * Usage:
 * `<sd-booking-calendar [days]="cal.days()" [month]="cal.month()" (monthChange)="cal.setMonth($event)"
 *    [selectedDate]="cal.selectedDate()" (selectedDateChange)="cal.selectDate($event)"
 *    [slots]="cal.slots()" [(value)]="slotIso" … >
 *    @if (cal.slots()?.length === 0) {
 *      <app-similar-doctors calendarEmpty … />
 *    }
 *  </sd-booking-calendar>`
 */
@Component({
  selector: 'sd-booking-calendar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, IconComponent],
  // A size container, so the two-column layout follows the room it is given,
  // not the viewport.
  host: { class: '@container block w-full min-w-0' },
  styles: [
    `
      .sd-cal-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background-color: var(--color-teal, #00796c);
      }
      .sd-cal-open {
        color: var(--color-teal, #00796c);
      }
      .sd-cal-few {
        color: #8a5a00;
      }
      .sd-cal-full {
        color: #c62828;
      }
      :host-context(html[data-theme='dark']) .sd-cal-dot {
        background-color: var(--color-teal-bright, #00b39a);
      }
      :host-context(html[data-theme='dark']) .sd-cal-open {
        color: var(--color-teal-bright, #00b39a);
      }
      :host-context(html[data-theme='dark']) .sd-cal-few {
        color: #f2c14e;
      }
      :host-context(html[data-theme='dark']) .sd-cal-full {
        color: #ff8a80;
      }
      /* On the chosen (cerulean) day every marker reads white. :host lifts these
         above the dark-mode rules (one more attribute than :host-context's). */
      :host .sd-cal-sel .sd-cal-dot {
        background-color: #ffffff;
      }
      :host .sd-cal-sel .sd-cal-open,
      :host .sd-cal-sel .sd-cal-few,
      :host .sd-cal-sel .sd-cal-full {
        color: rgba(255, 255, 255, 0.92);
      }
      /* Focus rings go on the inner tile / the time's label, offset so they
         show on the chosen (cerulean) one too. */
      .sd-cal-gridcell {
        outline: none;
      }
      .sd-cal-gridcell:focus-visible .sd-cal-cell,
      .sd-cal-time:has(:focus-visible) {
        outline: 2px solid var(--color-cerulean, #0b62e4);
        outline-offset: 2px;
      }
      @media (prefers-reduced-motion: no-preference) {
        .sd-cal-cell,
        .sd-cal-time {
          transition:
            background-color 0.15s ease-out,
            border-color 0.15s ease-out,
            color 0.15s ease-out;
        }
      }
    `,
  ],
  template: `
    <div class="grid gap-6 @2xl:grid-cols-[340px_minmax(0,1fr)] @2xl:gap-8">
      <!-- Month grid -->
      <div class="flex w-full min-w-0 max-w-[420px] flex-col gap-3 @2xl:max-w-none">
        <div class="flex items-center gap-1">
          <h3
            [id]="headingId"
            class="min-w-0 flex-1 truncate font-heading text-body-lg font-semibold text-ink"
            aria-live="polite"
          >
            {{ title() }}
          </h3>
          <button
            type="button"
            class="inline-flex min-h-11 items-center rounded-field px-3 font-sans text-body-sm font-semibold text-cerulean hover:bg-frost/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed disabled:text-slate/40 disabled:hover:bg-transparent"
            [disabled]="disabled() || visibleMonth() === todayMonth()"
            (click)="goToday()"
          >
            Today
          </button>
          <button
            type="button"
            class="inline-flex size-11 items-center justify-center rounded-full text-ink hover:bg-cloud focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed disabled:text-slate/40 disabled:hover:bg-transparent"
            aria-label="Previous month"
            [disabled]="!canPrev()"
            (click)="shiftMonth(-1, $event)"
          >
            <sd-icon name="chevron-left" [size]="20" />
          </button>
          <button
            type="button"
            class="inline-flex size-11 items-center justify-center rounded-full text-ink hover:bg-cloud focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed disabled:text-slate/40 disabled:hover:bg-transparent"
            aria-label="Next month"
            [disabled]="!canNext()"
            (click)="shiftMonth(1, $event)"
          >
            <sd-icon name="chevron-right" [size]="20" />
          </button>
        </div>

        <table
          role="grid"
          class="w-full table-fixed border-separate border-spacing-y-1"
          [attr.aria-labelledby]="headingId"
          [attr.aria-busy]="loading() || null"
          [attr.aria-disabled]="disabled() || null"
        >
          <thead>
            <tr>
              @for (w of weekdays(); track w.long) {
                <th
                  scope="col"
                  [attr.abbr]="w.long"
                  class="pb-1 text-center font-sans text-caption font-medium text-slate"
                >
                  {{ w.short }}
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr>
                @for (c of row; track c.date) {
                  @if (c.inMonth) {
                    <td
                      role="gridcell"
                      class="sd-cal-gridcell p-0"
                      [class.cursor-pointer]="!c.disabled"
                      [class.cursor-not-allowed]="c.disabled"
                      [attr.data-date]="c.date"
                      [tabIndex]="c.date === tabbable() ? 0 : -1"
                      [attr.aria-label]="c.label"
                      [attr.aria-selected]="c.selected"
                      [attr.aria-current]="c.today ? 'date' : null"
                      [attr.aria-disabled]="c.disabled || null"
                      (click)="pick(c)"
                      (keydown)="onCellKeydown($event, c)"
                      (focus)="focusDate.set(c.date)"
                    >
                      <div
                        class="sd-cal-cell mx-auto flex h-12 w-full max-w-12 flex-col items-center justify-center gap-0.5 rounded-[12px]"
                        [class]="cellClass(c)"
                      >
                        <span class="font-sans text-body-sm leading-none" [class.font-bold]="c.today || c.selected">
                          {{ c.day }}
                        </span>
                        <span class="flex h-3 items-center gap-0.5 font-sans text-[10px] font-semibold leading-none" aria-hidden="true">
                          @if (loading() && c.status === null) {
                            <span class="sd-shimmer h-1.5 w-5 rounded-full"></span>
                          } @else if (!c.disabled && c.status === 'available') {
                            <span class="sd-cal-dot"></span><span class="sd-cal-open">{{ c.open }}</span>
                          } @else if (!c.disabled && c.status === 'few') {
                            <span class="sd-cal-few">few left</span>
                          } @else if (!c.disabled && c.status === 'full') {
                            <span class="sd-cal-full">full</span>
                          }
                        </span>
                      </div>
                    </td>
                  } @else {
                    <td class="p-0"></td>
                  }
                }
              </tr>
            }
          </tbody>
        </table>

        <p class="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-caption text-slate" aria-hidden="true">
          <span class="inline-flex items-center gap-1"><span class="sd-cal-dot"></span>open times</span>
          <span class="sd-cal-few font-semibold">few left</span>
          <span class="sd-cal-full font-semibold">full</span>
        </p>
      </div>

      <!-- Times for the chosen day -->
      <div class="@container flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 class="font-heading text-body-lg font-semibold text-ink">
            {{ timesTitle() }}
          </h3>
          @if (tzLabel()) {
            <p class="inline-flex items-center gap-1 font-sans text-caption text-slate">
              <sd-icon name="globe" [size]="14" />
              Times in {{ tzLabel() }}
            </p>
          }
        </div>
        <p class="font-sans text-body-sm text-slate" aria-live="polite" aria-atomic="true">{{ summary() }}</p>

        @if (!selectedDateState()) {
          @if (monthEmpty()) {
            <div class="flex flex-col items-start gap-3 rounded-card border border-dashed border-cloud bg-white p-4">
              <p class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
                <sd-icon name="calendar-off" [size]="18" />
                No openings this month
              </p>
              @if (nextTarget(); as t) {
                <ng-container [ngTemplateOutlet]="jumpButton" [ngTemplateOutletContext]="{ $implicit: t }" />
              }
            </div>
          } @else {
            <p class="flex items-center gap-2 rounded-card border border-dashed border-cloud p-4 font-sans text-body-sm text-slate">
              <sd-icon name="calendar-days" [size]="18" />
              Choose a day to see its open times.
            </p>
          }
        } @else if (slotsLoading()) {
          <div class="grid grid-cols-3 gap-2 @sm:grid-cols-4" aria-hidden="true">
            @for (i of skeleton; track i) {
              <span class="sd-shimmer h-11 rounded-field"></span>
            }
          </div>
        } @else if (groups().length) {
          @for (g of groups(); track g.period) {
            <fieldset class="m-0 flex min-w-0 flex-col border-0 p-0" [disabled]="disabled()">
              <legend class="mb-2 flex items-center gap-1.5 font-sans text-body-sm font-semibold text-ink">
                <sd-icon [name]="g.icon" [size]="16" />
                {{ g.label }}
                <span class="font-normal text-slate">· {{ g.slots.length }}</span>
              </legend>
              <div class="grid grid-cols-3 gap-2 @sm:grid-cols-4 @lg:grid-cols-5">
                @for (s of g.slots; track s.iso) {
                  <label
                    class="sd-cal-time flex min-h-11 items-center justify-center gap-1 rounded-field border px-2 font-sans text-body-sm font-medium"
                    [class]="valueState() === s.iso ? 'border-cerulean bg-cerulean text-white' : 'border-cloud bg-white text-ink hover:border-cerulean/50'"
                    [class.cursor-pointer]="!disabled()"
                    [class.opacity-60]="disabled()"
                  >
                    <input
                      type="radio"
                      class="sr-only"
                      [name]="radioName"
                      [value]="s.iso"
                      [checked]="valueState() === s.iso"
                      (change)="pickSlot(s.iso)"
                    />
                    @if (valueState() === s.iso) {
                      <sd-icon name="check" [size]="14" />
                    }
                    <span class="whitespace-nowrap">{{ s.label }}</span>
                  </label>
                }
              </div>
            </fieldset>
          }
        } @else if (noTimes()) {
          <div class="flex flex-col items-start gap-3 rounded-card border border-cloud bg-white p-4">
            <p class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
              <sd-icon name="calendar-off" [size]="18" />
              {{ emptyMessage() }}
            </p>
            @if (emptyDayTarget(); as t) {
              <ng-container [ngTemplateOutlet]="jumpButton" [ngTemplateOutletContext]="{ $implicit: t }" />
            }
          </div>
          <ng-content select="[calendarEmpty]" />
        }
      </div>
    </div>

    <ng-template #jumpButton let-t>
      <button
        type="button"
        class="inline-flex min-h-11 items-center gap-2 rounded-field bg-frost/40 px-4 font-sans text-body-sm font-semibold text-cerulean hover:bg-frost/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed disabled:opacity-60"
        [disabled]="disabled()"
        (click)="jump()"
      >
        <sd-icon name="calendar-check" [size]="16" />
        Next available · {{ shortDay(t) }}
      </button>
    </ng-template>
  `,
})
export class BookingCalendarComponent {
  /** The range's days (AvailabilityRangeDto.days) — at least the visible 6-week grid. */
  readonly days = input<readonly AvailabilityDayDto[]>([]);
  /** The month on show, 'YYYY-MM' ('' = the chosen day's, else this month). */
  readonly month = input<string>('');
  /** The chosen day, 'YYYY-MM-DD'. */
  readonly selectedDate = input<string | null>(null);
  /** The chosen day's open times; null = not loaded. */
  readonly slots = input<readonly DaySlotDto[] | null>(null);
  /** The chosen time's ISO start. */
  readonly value = input<string | null>(null);
  readonly loading = input(false);
  readonly slotsLoading = input(false);
  /** First / last bookable day, 'YYYY-MM-DD' (bookable_from / bookable_until); also bound the month arrows. */
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  /** The first open time (AvailabilityRangeDto.next_available, ISO). */
  readonly nextAvailable = input<string | null>(null);
  /**
   * On a chosen day with no times, offer "Next available" (the first open day
   * after it). Set false when the projected `[calendarEmpty]` content offers
   * its own next opening, so the two never show together.
   */
  readonly nextOnEmptyDay = input(true);
  /** Shown as "Times in …"; defaults to the zone's short name. */
  readonly timeZoneLabel = input<string>('');
  /** The IANA zone the days and times are in (AvailabilityRangeDto.tz); defaults to the viewer's. */
  readonly timeZone = input<string>('');
  /** First column of the week, 0 = Sunday … 6 = Saturday. */
  readonly weekStartsOn = input<number>(1);
  readonly disabled = input(false);

  readonly monthChange = output<string>();
  readonly selectedDateChange = output<string>();
  /** A chosen time, or null when choosing another day drops it. */
  readonly valueChange = output<string | null>();
  /**
   * "Next available" was pressed; carries the day jumped to. The calendar has
   * already moved there (emitting monthChange + selectedDateChange), so this is
   * only a notification: don't select a day from it — re-selecting would
   * restart that day's times request, or snap the choice back when the parent
   * works the target out differently. Leave it unwired, or pass the day on
   * (`cal.jumpToNext($event)`, which does nothing for the day already chosen).
   */
  readonly jumpToNext = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly zone = inject(NgZone);

  protected readonly headingId = `sd-cal-${++nextId}-month`;
  protected readonly radioName = `sd-cal-${nextId}-time`;
  protected readonly skeleton = [0, 1, 2, 3, 4, 5, 6, 7];

  // Local copies of the two-way inputs, so the calendar also works uncontrolled;
  // a new input value always wins.
  private readonly monthState = linkedSignal(() => this.month());
  protected readonly selectedDateState = linkedSignal(() => this.selectedDate());
  protected readonly valueState = linkedSignal(() => this.value());

  /** The cell keyboard focus last sat on (drives the roving tabindex). */
  protected readonly focusDate = signal<string | null>(null);

  /** Ticks when the date may have changed (see the constructor), so a page left open moves "today" on past midnight. */
  private readonly clock = signal(0);

  private readonly tz = computed(() => this.timeZone() || viewerTimeZone());
  protected readonly today = computed(() => {
    this.clock();
    return ymdInZone(new Date(), this.tz());
  });
  protected readonly todayMonth = computed(() => this.today().slice(0, 7));
  protected readonly tzLabel = computed(() => this.timeZoneLabel() || timeZoneShortLabel(this.tz()));

  protected readonly visibleMonth = computed(() => {
    const m = this.monthState();
    if (/^\d{4}-\d{2}$/.test(m)) return m;
    const sel = this.selectedDateState();
    if (sel) return sel.slice(0, 7);
    const min = this.min();
    const today = this.today();
    return (min && min > today ? min : today).slice(0, 7);
  });

  protected readonly title = computed(() => monthTitle(this.visibleMonth()));
  protected readonly weekdays = computed(() => weekdayHeaders(this.weekStartsOn()));
  /**
   * Whole months from min's to max's. While a range is loading and the last
   * bookable day isn't known yet, paging forward waits for it (rather than
   * running past the booking window); a disabled calendar keeps to its month.
   */
  private readonly bounds = computed(() => {
    const ym = this.visibleMonth();
    if (this.disabled()) return { lo: `${ym}-01`, hi: lastDayOfMonth(ym) };
    const { lo, hi } = navigableBounds(this.min(), this.max());
    return { lo, hi: hi ?? (this.loading() ? lastDayOfMonth(ym) : null) };
  });

  protected readonly canPrev = computed(() => {
    const lo = this.bounds().lo;
    return !this.disabled() && (!lo || this.visibleMonth() > lo.slice(0, 7));
  });
  protected readonly canNext = computed(() => {
    const hi = this.bounds().hi;
    return !this.disabled() && (!hi || this.visibleMonth() < hi.slice(0, 7));
  });

  private readonly dayMap = computed(() => new Map(this.days().map((d) => [d.date, d])));

  protected readonly cells = computed<BookingCalendarCell[]>(() => {
    const ym = this.visibleMonth();
    const map = this.dayMap();
    const ctx = { today: this.today(), min: this.min(), max: this.max(), disabled: this.disabled() };
    const selected = this.selectedDateState();
    return monthGrid(ym, this.weekStartsOn()).map((date) => {
      const day = map.get(date);
      const state = dayState(date, day, ctx);
      const open = day?.open ?? 0;
      return {
        date,
        day: Number(date.slice(8, 10)),
        inMonth: date.startsWith(ym),
        ...state,
        open,
        today: date === ctx.today,
        selected: date === selected,
        label: dayAccessibleName(date, state.status, open),
      };
    });
  });

  protected readonly rows = computed(() => {
    const cells = this.cells();
    return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  });

  /** The one cell in the tab order: the focused day, else the chosen one, else the first open, else today, else the 1st. */
  protected readonly tabbable = computed(() => {
    const ym = this.visibleMonth();
    const shown = (d: string | null): d is string => !!d && d.startsWith(ym);
    const focus = this.focusDate();
    if (shown(focus)) return focus;
    const selected = this.selectedDateState();
    if (shown(selected)) return selected;
    const inMonth = this.cells().filter((c) => c.inMonth);
    const open = inMonth.find((c) => c.bookable);
    if (open) return open.date;
    const today = this.today();
    if (shown(today)) return today;
    return `${ym}-01`;
  });

  /** Nothing open all month (once its days have loaded). */
  protected readonly monthEmpty = computed(() => {
    if (this.loading()) return false;
    const map = this.dayMap();
    const inMonth = this.cells().filter((c) => c.inMonth);
    return inMonth.some((c) => map.has(c.date)) && !inMonth.some((c) => c.bookable);
  });

  /**
   * Where "Next available" goes. With no day chosen: the day of
   * `nextAvailable` (as the store's `jumpToNext()` does), else the next open
   * day loaded after today. For a chosen day with no times it is always a day
   * after it — never an earlier one: `nextAvailable`'s day when that is later
   * (the first opening at all, so the first after it too), else the first
   * open day loaded after it; null when none is known.
   */
  protected readonly nextTarget = computed<string | null>(() => {
    const selected = this.selectedDateState();
    const next = this.nextAvailable();
    const date = next ? ymdInZone(next, this.tz()) : '';
    if (date && (selected === null || date > selected)) return date;
    const from = selected ?? this.today();
    const min = this.min();
    const max = this.max();
    return (
      this.days()
        .filter((d) => isOpenStatus(d.status) && d.date > from && (!min || d.date >= min) && (!max || d.date <= max))
        .map((d) => d.date)
        .sort()[0] ?? null
    );
  });

  /** The chosen empty day's "Next available" — none when the projected content offers its own. */
  protected readonly emptyDayTarget = computed(() => (this.nextOnEmptyDay() ? this.nextTarget() : null));

  protected readonly groups = computed(() => groupSlots(this.slots() ?? [], this.tz()));

  private readonly selectedStatus = computed(() => {
    const sel = this.selectedDateState();
    return sel ? (this.dayMap().get(sel)?.status ?? null) : null;
  });

  /** The chosen day has no open times to list. */
  protected readonly noTimes = computed(() => {
    if (!this.selectedDateState() || this.slotsLoading()) return false;
    const slots = this.slots();
    if (slots) return slots.length === 0;
    const status = this.selectedStatus();
    return status === 'full' || status === 'closed' || status === 'blocked';
  });

  protected readonly emptyMessage = computed(() => {
    const day = shortDayLabel(this.selectedDateState() ?? '');
    switch (this.selectedStatus()) {
      case 'full':
        return `Fully booked on ${day}`;
      case 'closed':
        return `No hours on ${day}`;
      default:
        return `No open times on ${day}`;
    }
  });

  protected readonly timesTitle = computed(() => {
    const sel = this.selectedDateState();
    return sel ? longDayLabel(sel) : 'Available times';
  });

  /** Spoken (aria-live) and shown: "12 times on Thu 16 Oct". */
  protected readonly summary = computed(() => {
    const sel = this.selectedDateState();
    if (!sel) return '';
    const day = shortDayLabel(sel);
    if (this.slotsLoading()) return `Loading times for ${day}…`;
    const slots = this.slots();
    if (slots?.length) return `${timesCount(slots.length)} on ${day}`;
    return this.noTimes() ? `No times on ${day}` : '';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Re-read the date at the zone's next midnight (checked at least hourly) and
    // whenever the tab comes back into view — outside Angular, so a pending
    // timer never holds the app unstable; the signal schedules the render.
    afterNextRender(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(tick, msToNextDay(this.tz()));
      };
      const tick = () => {
        this.clock.update((n) => n + 1);
        schedule();
      };
      const onVisibility = () => {
        if (document.visibilityState !== 'hidden') tick();
      };
      this.zone.runOutsideAngular(() => {
        schedule();
        document.addEventListener('visibilitychange', onVisibility);
      });
      destroyRef.onDestroy(() => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
      });
    });
  }

  protected shortDay(date: string): string {
    return shortDayLabel(date);
  }

  protected cellClass(c: BookingCalendarCell): string {
    if (c.selected && !c.disabled) return 'sd-cal-sel bg-cerulean text-white shadow-[0_2px_10px_rgba(21,101,192,0.25)]';
    const today = c.today ? ' ring-1 ring-inset ring-cerulean' : '';
    // A chosen day that can't be chosen now (a past date a reschedule starts
    // from, or a locked calendar) still shows as chosen: a bold ring.
    if (c.disabled) return 'text-slate/40' + (c.selected ? ' ring-2 ring-inset ring-cerulean font-bold' : today);
    if (c.bookable) return 'bg-frost/40 text-ink hover:bg-frost/70' + today;
    if (c.status === null) return 'text-ink hover:bg-cloud' + today;
    // Full / closed / blocked: muted, but still choosable (to see alternatives).
    return 'text-slate hover:bg-cloud' + today;
  }

  protected pick(c: BookingCalendarCell): void {
    if (!c.inMonth || c.disabled) return;
    this.focusDate.set(c.date);
    this.select(c.date);
  }

  protected pickSlot(iso: string): void {
    if (this.disabled() || this.valueState() === iso) return;
    this.valueState.set(iso);
    this.valueChange.emit(iso);
  }

  protected onCellKeydown(e: KeyboardEvent, c: BookingCalendarCell): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.pick(c);
      return;
    }
    const target = keyTarget(c.date, e.key, e.shiftKey, this.weekStartsOn());
    if (!target) return;
    e.preventDefault();
    // Clamped to min..max — or, while disabled, to the month on show (no fetches).
    const { lo, hi } = this.bounds();
    this.moveFocus(clampYmd(target, lo, hi));
  }

  protected shiftMonth(n: number, e: Event): void {
    const button = e.currentTarget as HTMLButtonElement | null;
    this.focusDate.set(null);
    this.setMonth(addMonths(this.visibleMonth(), n));
    // Reaching the first / last month disables the button just pressed — hand
    // focus to the grid rather than drop it on the page.
    afterNextRender(
      () => {
        if (button?.disabled) this.focusCell(this.tabbable());
      },
      { injector: this.injector },
    );
  }

  protected goToday(): void {
    const { lo, hi } = this.bounds();
    this.moveFocus(clampYmd(this.today(), lo, hi));
  }

  protected jump(): void {
    const target = this.nextTarget();
    if (!target || this.disabled()) return;
    this.focusDate.set(target);
    this.setMonth(target.slice(0, 7));
    this.select(target);
    this.jumpToNext.emit(target);
    afterNextRender(() => this.focusCell(target), { injector: this.injector });
  }

  private select(date: string): void {
    if (this.selectedDateState() === date) return;
    this.selectedDateState.set(date);
    this.selectedDateChange.emit(date);
    // A time on another day would be booked unseen — drop it.
    const value = this.valueState();
    if (value && ymdInZone(value, this.tz()) !== date) {
      this.valueState.set(null);
      this.valueChange.emit(null);
    }
  }

  private setMonth(ym: string): void {
    if (ym === this.visibleMonth()) return;
    this.monthState.set(ym);
    this.monthChange.emit(ym);
  }

  private moveFocus(date: string): void {
    this.focusDate.set(date);
    if (date.startsWith(this.visibleMonth())) {
      this.focusCell(date);
      return;
    }
    this.setMonth(date.slice(0, 7));
    afterNextRender(() => this.focusCell(date), { injector: this.injector });
  }

  private focusCell(date: string): void {
    this.host.nativeElement.querySelector<HTMLElement>(`td[data-date="${date}"]`)?.focus();
  }
}
