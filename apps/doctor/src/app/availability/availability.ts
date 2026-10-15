import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { AvailabilitySlotDto } from '@supadoc/models';
import { ButtonComponent, DialogComponent, DialogService, IconComponent } from '@supadoc/ui';
import { focusAfterDialogs } from '../focus-after-dialog';

interface DayCell {
  readonly date: string; // YYYY-MM-DD (UTC)
  readonly day: number;
  readonly inMonth: boolean;
}

const TIME_INPUT =
  'rounded-field border border-[#b8c6d4] bg-white px-3 py-2.5 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

const DURATIONS = [15, 30, 45, 60];

/** Minutes since midnight -> 'HH:MM'. */
const hm = (mins: number): string => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
/** 'HH:MM' -> minutes since midnight. */
const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** The day's last bookable minute: an end time can't go past 23:59. */
const LAST_MINUTE = 23 * 60 + 59;

/** Date-specific availability (route `/availability`) — calendar + list, with
 *  Add Availability and Block day modals. Times are UTC wall-clock end-to-end. */
@Component({
  selector: 'doc-availability',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, ButtonComponent, DialogComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Availability</h1>
          <p class="font-sans text-body text-slate">Manage your consultation hour and availability.</p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="flex items-center gap-2 rounded-field border border-cloud bg-white px-5 py-3 font-sans text-body-sm font-semibold text-slate transition-colors hover:border-alert hover:text-alert disabled:pointer-events-none disabled:opacity-50" [disabled]="isPast(selectedDate())" (click)="openBlock(selectedDate())">
            <sd-icon name="ban" [size]="18" />Block this day
          </button>
          <sd-button [disabled]="isPast(selectedDate())" (click)="openAdd(selectedDate())">
            <sd-icon name="plus" [size]="18" />Add Availability
          </sd-button>
        </div>
      </header>

      <!-- View toggle -->
      <div class="flex w-fit rounded-pill border border-cloud bg-white p-1">
        <button type="button" class="rounded-pill px-5 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="mode() === 'calendar' ? 'bg-frost text-cerulean' : 'text-slate'" (click)="mode.set('calendar')">Calendar view</button>
        <button type="button" class="rounded-pill px-5 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="mode() === 'list' ? 'bg-frost text-cerulean' : 'text-slate'" (click)="mode.set('list')">List view</button>
      </div>

      @if (notice()) {
        <div class="flex items-center gap-2 rounded-card bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert" role="status">
          <sd-icon name="triangle-alert" [size]="16" />{{ notice() }}
        </div>
      }

      @if (mode() === 'calendar') {
        <div class="grid gap-6 lg:grid-cols-2">
          <!-- Month calendar -->
          <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
            <div class="flex items-center justify-between">
              <h2 class="font-heading text-h5 text-ink">{{ monthLabel() }}</h2>
              <div class="flex items-center gap-1">
                <button type="button" class="flex size-8 items-center justify-center rounded-field text-slate transition-colors hover:bg-glacier" aria-label="Previous month" (click)="shiftMonth(-1)"><sd-icon name="chevron-right" [size]="18" class="rotate-180" /></button>
                <button type="button" class="flex size-8 items-center justify-center rounded-field text-slate transition-colors hover:bg-glacier" aria-label="Next month" (click)="shiftMonth(1)"><sd-icon name="chevron-right" [size]="18" /></button>
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
        <div class="grid gap-6 lg:grid-cols-2">
          <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
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
                        {{ d.blocked ? 'Blocked' : (d.open > 0 || d.booked > 0 ? d.open + ' open · ' + d.booked + ' Booked' : 'No availability') }}
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

    <!-- Shared day-detail panel (both views) -->
    <ng-template #dayDetail>
      <section class="flex h-fit flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="font-heading text-h5 text-ink">{{ selectedLabel() }}</h2>
        <!-- Removed here: said, and focused (the Remove button that asked went away with the time). -->
        @if (removed(); as r) {
          @if (r.date === selectedDate()) {
            <p #removedNote tabindex="-1" role="status" class="flex items-center gap-2 rounded-field bg-sage/10 px-4 py-2.5 font-sans text-caption font-semibold text-sage outline-none">
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
            <button type="button" class="w-fit font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean disabled:opacity-50" [disabled]="busyId() === blk.id" (click)="removeSlot(blk)">Remove block</button>
          }
        } @else {
          @if (selectedSlots().length === 0) {
            <div class="flex flex-col items-center gap-2 py-10 text-center">
              <sd-icon name="calendar-off" [size]="28" class="text-slate" />
              <p class="font-sans text-body-sm text-slate">No availability set for this day.</p>
            </div>
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (s of selectedSlots(); track s.id) {
                <li class="flex items-center justify-between gap-3 py-3">
                  <div class="flex flex-col">
                    <span class="font-sans text-body-sm font-medium text-ink">{{ slotRange(s) }}</span>
                    @if (s.status === 'booked' && s.patient_name) {
                      <span class="flex items-center gap-1 font-sans text-caption text-sage"><sd-icon name="user" [size]="13" />{{ s.patient_name }}</span>
                    }
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(s.status)">{{ statusLabel(s.status) }}</span>
                    @if (s.status !== 'booked' && !isSynthetic(s)) {
                      <button type="button" class="flex min-h-11 min-w-11 items-center justify-center rounded-field text-slate transition-colors hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:opacity-50" [attr.aria-label]="'Remove ' + slotRange(s)" [disabled]="busyId() === s.id" (click)="removeSlot(s)"><sd-icon name="trash-2" [size]="16" /></button>
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
              <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:border-alert hover:text-alert" (click)="openBlock(selectedDate())">
                <sd-icon name="ban" [size]="18" />Block this day
              </button>
              <sd-button [full]="true" (click)="openAdd(selectedDate())"><sd-icon name="plus" [size]="18" />Add Availability</sd-button>
            </div>
          }
        }
      </section>
    </ng-template>

    <!-- Add Availability (the design-system dialog: bottom sheet on phones, focus kept inside, Esc closes). -->
    <sd-dialog [open]="addOpen()" title="Add Availability" size="sm" [busy]="busy()" (closed)="addOpen.set(false)">
        <div class="flex flex-col gap-5">
          <div class="flex rounded-pill border border-cloud bg-white p-1" role="group" aria-label="How often">
            <button type="button" class="min-h-11 flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="addRecurring() ? 'text-slate' : 'bg-frost text-cerulean'" [attr.aria-pressed]="!addRecurring()" (click)="addRecurring.set(false)">One-time</button>
            <button type="button" class="min-h-11 flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="addRecurring() ? 'bg-frost text-cerulean' : 'text-slate'" [attr.aria-pressed]="addRecurring()" (click)="addRecurring.set(true)">Recurring</button>
          </div>

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Date</span>
            <input type="date" class="${TIME_INPUT}" [min]="today()" [value]="addDate()" (input)="addDate.set($any($event.target).value)" />
          </label>

          @if (addRecurring()) {
            <label class="flex flex-col gap-2">
              <span class="font-sans text-body font-semibold text-ink">Repeat weekly for</span>
              <div class="flex items-center gap-2">
                <input type="number" min="1" max="26" class="${TIME_INPUT} w-20" [value]="addWeeks()" (input)="addWeeks.set(+$any($event.target).value)" />
                <span class="font-sans text-body-sm text-slate">weeks</span>
              </div>
            </label>
          }

          <div class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Consultation duration</span>
            <div class="flex rounded-pill border border-cloud bg-white p-1">
              @for (d of durations; track d) {
                <button type="button" class="flex-1 rounded-pill px-2 py-1.5 font-sans text-caption font-semibold transition-colors" [class]="addDuration() === d ? 'bg-frost text-cerulean' : 'text-slate'" (click)="addDuration.set(d)">{{ d }} mins</button>
              }
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Time Range</span>
            <div class="flex items-center gap-2">
              <input type="time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="addDate() === today() ? nowTime() : null" [value]="addStart()" (input)="addStart.set($any($event.target).value)" />
              <span class="font-sans text-caption text-slate">to</span>
              <input type="time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="addStart() || null" [value]="addEnd()" (input)="addEnd.set($any($event.target).value)" />
            </div>
          </div>

          @if (addError()) { <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert" role="alert">{{ addError() }}</p> }
        </div>
        <div dialogFooter class="flex shrink-0 border-t border-cloud px-5 py-4 sm:px-6">
          <sd-button class="w-full" [full]="true" [disabled]="busy()" (click)="submitAdd()">{{ busy() ? 'Saving…' : 'Save Availability' }}</sd-button>
        </div>
    </sd-dialog>

    <!-- Block Availability -->
    <sd-dialog [open]="blockOpen()" title="Block Availability" subtitle="Patients can't book blocked times." size="sm" [busy]="busy()" (closed)="blockOpen.set(false)">
        <div class="flex flex-col gap-5">

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Date</span>
            <input type="date" class="${TIME_INPUT}" [min]="today()" [value]="blockDate()" (input)="blockDate.set($any($event.target).value)" />
          </label>

          <div class="flex rounded-pill border border-cloud bg-white p-1" role="group" aria-label="What to block">
            <button type="button" class="min-h-11 flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="blockEntire() ? 'bg-frost text-cerulean' : 'text-slate'" [attr.aria-pressed]="blockEntire()" (click)="blockEntire.set(true)">Entire day</button>
            <button type="button" class="min-h-11 flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="blockEntire() ? 'text-slate' : 'bg-frost text-cerulean'" [attr.aria-pressed]="!blockEntire()" (click)="blockEntire.set(false)">Specific time</button>
          </div>

          @if (!blockEntire()) {
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body font-semibold text-ink">Time Range</span>
              <div class="flex items-center gap-2">
                <input type="time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="blockDate() === today() ? nowTime() : null" [value]="blockStart()" (input)="blockStart.set($any($event.target).value)" />
                <span class="font-sans text-caption text-slate">to</span>
                <input type="time" class="${TIME_INPUT} min-w-0 flex-1" [attr.min]="blockStart() || null" [value]="blockEnd()" (input)="blockEnd.set($any($event.target).value)" />
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
          <button type="button" class="flex min-h-11 w-full items-center justify-center gap-2 rounded-field bg-alert px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40 focus-visible:ring-offset-2 disabled:opacity-60" [disabled]="busy()" (click)="submitBlock()">
            <sd-icon name="ban" [size]="18" />{{ busy() ? 'Blocking…' : blockEntire() ? 'Block this day' : 'Block these times' }}
          </button>
        </div>
    </sd-dialog>
  `,
})
export class DoctorAvailability implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogs = inject(DialogService);
  private readonly injector = inject(Injector);

  protected readonly weekdayLabels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  protected readonly durations = DURATIONS;
  /** Ticks so "today" and "now" stay current while the page is open. */
  private readonly clock = signal(Date.now());
  /** Today's date in UTC — this editor's calendar. Earlier days are read-only. */
  protected readonly today = computed(() => new Date(this.clock()).toISOString().slice(0, 10));
  /** The current UTC time, 'HH:MM' — the earliest start allowed on today's date. */
  protected readonly nowTime = computed(() => new Date(this.clock()).toISOString().slice(11, 16));

  protected readonly mode = signal<'calendar' | 'list'>('calendar');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly notice = signal('');
  /** What Remove just took off, on which day (shown on that day's panel). */
  protected readonly removed = signal<{ date: string; text: string } | null>(null);
  private readonly removedNote = viewChild<ElementRef<HTMLElement>>('removedNote');
  protected readonly slots = signal<AvailabilitySlotDto[]>([]);
  protected readonly slotMinutes = signal(30);

  /** First day of the visible month, as a UTC date. */
  protected readonly monthCursor = signal(this.firstOfMonth(new Date()));
  protected readonly selectedDate = signal(this.today());

  // Add modal
  protected readonly addOpen = signal(false);
  protected readonly addRecurring = signal(false);
  protected readonly addDate = signal(this.today());
  protected readonly addDuration = signal(30);
  protected readonly addStart = signal('09:00');
  protected readonly addEnd = signal('12:00');
  protected readonly addWeeks = signal(8);
  protected readonly addError = signal('');

  // Block modal
  protected readonly blockOpen = signal(false);
  protected readonly blockDate = signal(this.today());
  protected readonly blockEntire = signal(true);
  protected readonly blockStart = signal('09:00');
  protected readonly blockEnd = signal('12:00');
  protected readonly blockReason = signal('');
  protected readonly blockError = signal('');

  protected readonly monthLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(this.monthCursor()),
  );

  protected readonly selectedLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${this.selectedDate()}T00:00:00Z`)) + '.',
  );

  /** 42-cell (6-week) grid starting on the Monday on/before the 1st. */
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

  /** Per-day counts, keyed by YYYY-MM-DD — drives underlines, borders and labels. */
  private readonly dayInfo = computed(() => {
    const map = new Map<string, { open: number; booked: number; blocked: boolean }>();
    for (const s of this.slots()) {
      const key = s.starts_at.slice(0, 10);
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
      .filter((s) => s.starts_at.slice(0, 10) === this.selectedDate())
      // Keep open/booked slots and specific-time block rows (so they stay
      // visible and removable); drop the full-day block (handled by
      // selectedBlock) and overlapped-open rows re-tagged blocked.
      .filter((s) => (s.kind === 'block' ? !this.isFullDayBlock(s) : s.status !== 'blocked'))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  );

  /**
   * Only an ENTIRE-day block short-circuits the day panel. A specific-time block
   * must not hide the day's still-open slots or the Add/Block controls, and must
   * be matched by kind so "Remove block" never deletes an overlapped open slot.
   */
  protected readonly selectedBlock = computed(() => {
    const day = this.selectedDate();
    return (
      this.slots().find(
        (s) => s.starts_at.slice(0, 10) === day && s.kind === 'block' && this.isFullDayBlock(s),
      ) ?? null
    );
  });

  /** True for an entire-day block (00:00 → next-day 00:00), vs a specific-time one. */
  private isFullDayBlock(s: AvailabilitySlotDto): boolean {
    return (
      s.kind === 'block' &&
      s.starts_at.slice(11, 16) === '00:00' &&
      new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime() >= 86_400_000
    );
  }

  /** The seven days (Mon–Sun) of the week containing the selected date — the list view. */
  protected readonly weekDays = computed(() => {
    const sel = new Date(`${this.selectedDate()}T00:00:00Z`);
    const offset = (sel.getUTCDay() + 6) % 7; // Monday-first
    const monday = new Date(sel.getTime() - offset * 86400000);
    const out: { date: string; label: string; open: number; booked: number; blocked: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getTime() + i * 86400000);
      const date = d.toISOString().slice(0, 10);
      const info = this.dayInfo().get(date) ?? { open: 0, booked: 0, blocked: false };
      out.push({
        date,
        label: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d),
        ...info,
      });
    }
    return out;
  });

  protected readonly weekLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${this.selectedDate()}T00:00:00Z`)),
  );

  ngOnInit(): void {
    const tick = setInterval(() => this.clock.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(tick));
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.notice.set('');
    // Fetch every day the 42-cell grid actually renders (a month can trail up to
    // ~14 days into the next one), so no visible cell is missing its slot data.
    const cells = this.calendar();
    const from = cells[0].date;
    const to = cells[cells.length - 1].date;
    this.api
      .availability(from, to)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.slots.set(res.data.slots);
          this.slotMinutes.set(res.data.slot_minutes);
          this.addDuration.set(res.data.slot_minutes);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.notice.set(apiErrorMessage(err, 'Could not load your availability.'));
          this.loading.set(false);
        },
      });
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

  protected isSynthetic(s: AvailabilitySlotDto): boolean {
    return s.id.startsWith('appt-');
  }

  protected slotRange(s: AvailabilitySlotDto): string {
    return `${this.fmt(s.starts_at)} - ${this.fmt(s.ends_at)}`;
  }
  private fmt(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(iso));
  }

  protected statusClass(status: string): string {
    return status === 'booked'
      ? 'bg-sage/15 text-sage'
      : status === 'blocked'
        ? 'bg-alert/10 text-alert'
        : 'bg-frost text-cerulean';
  }
  protected statusLabel(status: string): string {
    return status === 'booked' ? 'Booked' : status === 'blocked' ? 'Blocked' : 'Open';
  }

  // ----- Modals -----
  protected openAdd(date: string): void {
    this.clock.set(Date.now());
    // A disabled <sd-button> still lets a click reach its host, so past days are refused here too.
    if (this.isPast(date)) return;
    const [day, start, end] = this.defaultAddRange(this.notBeforeToday(date));
    this.addDate.set(day);
    this.addRecurring.set(false);
    this.addDuration.set(this.slotMinutes());
    this.addStart.set(start);
    this.addEnd.set(end);
    this.addWeeks.set(8);
    this.addError.set('');
    this.removed.set(null);
    this.addOpen.set(true);
  }

  protected openBlock(date: string): void {
    this.clock.set(Date.now());
    if (this.isPast(date)) return;
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
    const now = new Date(this.clock());
    const from = Math.ceil((now.getUTCHours() * 60 + now.getUTCMinutes()) / 30) * 30;
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
    if (from + slot > LAST_MINUTE) return [this.nextDay(date), '09:00', '12:00'];
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

  /** The UTC day after `date` (YYYY-MM-DD). */
  private nextDay(date: string): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }

  /** Why a start on `date` at `start` can't be used (it has gone by), or '' when it can. */
  private pastStartError(date: string, start: string | null): string {
    this.clock.set(Date.now());
    if (date === '') return 'Choose a date.';
    if (this.isPast(date)) return 'Choose today or a later date.';
    if (start !== null && date === this.today() && start < this.nowTime()) {
      return `That start time has passed. Choose ${this.nowTime()} or later.`;
    }
    return '';
  }

  protected async submitAdd(): Promise<void> {
    const past = this.pastStartError(this.addDate(), this.addStart());
    if (past) {
      this.addError.set(past);
      return;
    }
    if (this.addEnd() <= this.addStart()) {
      this.addError.set('End time must be after the start time.');
      return;
    }
    if (toMinutes(this.addEnd()) - toMinutes(this.addStart()) < this.addDuration()) {
      this.addError.set(`The time range must fit at least one ${this.addDuration()}-minute slot.`);
      return;
    }
    this.busy.set(true);
    this.addError.set('');
    try {
      const res = await firstValueFrom(
        this.api.addAvailability({
          date: this.addDate(),
          start: this.addStart(),
          end: this.addEnd(),
          duration: this.addDuration(),
          recurring: this.addRecurring(),
          weeks: this.addWeeks(),
        }),
      );
      this.addOpen.set(false);
      this.selectedDate.set(this.addDate());
      this.load();
      this.notice.set('');
      if (res.data.created === 0) {
        this.notice.set('Those slots already exist for that time.');
      }
    } catch (err) {
      this.addError.set(apiErrorMessage(err, 'Could not add availability.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async submitBlock(): Promise<void> {
    const past = this.pastStartError(this.blockDate(), this.blockEntire() ? null : this.blockStart());
    if (past) {
      this.blockError.set(past);
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
        }),
      );
      this.blockOpen.set(false);
      this.selectedDate.set(this.blockDate());
      this.load();
    } catch (err) {
      this.blockError.set(apiErrorMessage(err, 'Could not block the day.'));
    } finally {
      this.busy.set(false);
    }
  }

  /** Remove an open time or a block — asked first; the request runs in the dialog (inline error). */
  protected async removeSlot(s: AvailabilitySlotDto): Promise<void> {
    if (this.busyId()) return;
    this.notice.set('');
    this.removed.set(null);
    const block = s.kind === 'block' || s.status === 'blocked';
    const date = this.selectedDate();
    const day = this.dayName(s.starts_at);
    this.busyId.set(s.id);
    try {
      const { confirmed } = await this.dialogs.confirm({
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
        action: () => this.api.deleteAvailability(s.id),
        errorMessage: (err) => apiErrorMessage(err, block ? 'Could not remove the block.' : 'Could not remove that time.'),
      });
      if (confirmed) {
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

  /** "Thu 16 Oct" for a slot's start (UTC wall-clock, like the rest of this editor). */
  private dayName(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(iso));
  }

  private firstOfMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
}
