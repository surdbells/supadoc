import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { AvailabilitySlotDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

interface DayCell {
  readonly date: string; // YYYY-MM-DD (UTC)
  readonly day: number;
  readonly inMonth: boolean;
}

const TIME_INPUT =
  'rounded-field border border-[#b8c6d4] bg-white px-3 py-2.5 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

const DURATIONS = [15, 30, 45, 60];

/** Date-specific availability (route `/availability`) — calendar + list, with
 *  Add Availability and Block day modals. Times are UTC wall-clock end-to-end. */
@Component({
  selector: 'doc-availability',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Availability</h1>
          <p class="font-sans text-body text-slate">Manage your consultation hours and availability.</p>
        </div>
        <sd-button (click)="openAdd(selectedDate())">
          <sd-icon name="plus" [size]="18" />Add Availability
        </sd-button>
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
                  (click)="selectedDate.set(cell.date)">
                  {{ cell.day }}
                  @if (hasOpen(cell.date) && selectedDate() !== cell.date) {
                    <span class="absolute bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-sage"></span>
                  }
                </button>
              }
            </div>
            <p class="text-center font-sans text-caption text-slate">Days with a <span class="text-sage">green underline</span> have open slots.</p>
          </section>

          <!-- Day detail -->
          <section class="flex h-fit flex-col gap-4 rounded-card border border-cloud bg-white p-6">
            <h2 class="font-heading text-h5 text-ink">{{ selectedLabel() }}</h2>
            @if (loading()) {
              <div class="sd-shimmer h-40 rounded-field"></div>
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
                        } @else if (s.status === 'blocked' && s.reason) {
                          <span class="font-sans text-caption text-slate">{{ s.reason }}</span>
                        }
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(s.status)">{{ statusLabel(s.status) }}</span>
                        @if (s.status !== 'booked' && !isSynthetic(s)) {
                          <button type="button" class="text-slate transition-colors hover:text-alert disabled:opacity-50" aria-label="Remove" [disabled]="busyId() === s.id" (click)="removeSlot(s)"><sd-icon name="trash-2" [size]="16" /></button>
                        }
                      </div>
                    </li>
                  }
                </ul>
              }
              <div class="mt-2 flex flex-col gap-3 sm:flex-row">
                <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:border-alert hover:text-alert" (click)="openBlock(selectedDate())">
                  <sd-icon name="ban" [size]="18" />Block this day
                </button>
                <sd-button [full]="true" (click)="openAdd(selectedDate())"><sd-icon name="plus" [size]="18" />Add Availability</sd-button>
              </div>
            }
          </section>
        </div>
      } @else {
        <!-- List view -->
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          @if (loading()) {
            <div class="sd-shimmer h-48 rounded-field"></div>
          } @else if (listGroups().length === 0) {
            <div class="flex flex-col items-center gap-2 py-12 text-center">
              <sd-icon name="calendar-off" [size]="28" class="text-slate" />
              <p class="font-sans text-body-sm text-slate">No availability in this range.</p>
            </div>
          } @else {
            @for (g of listGroups(); track g.date) {
              <div class="flex flex-col gap-2">
                <h3 class="font-heading text-body font-semibold text-ink">{{ g.label }}</h3>
                <ul class="flex flex-col divide-y divide-cloud rounded-card border border-cloud">
                  @for (s of g.slots; track s.id) {
                    <li class="flex items-center justify-between gap-3 px-4 py-3">
                      <div class="flex flex-col">
                        <span class="font-sans text-body-sm font-medium text-ink">{{ slotRange(s) }}</span>
                        @if (s.status === 'booked' && s.patient_name) {
                          <span class="flex items-center gap-1 font-sans text-caption text-sage"><sd-icon name="user" [size]="13" />{{ s.patient_name }}</span>
                        } @else if (s.status === 'blocked' && s.reason) {
                          <span class="font-sans text-caption text-slate">{{ s.reason }}</span>
                        }
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(s.status)">{{ statusLabel(s.status) }}</span>
                        @if (s.status !== 'booked' && !isSynthetic(s)) {
                          <button type="button" class="text-slate transition-colors hover:text-alert disabled:opacity-50" aria-label="Remove" [disabled]="busyId() === s.id" (click)="removeSlot(s)"><sd-icon name="trash-2" [size]="16" /></button>
                        }
                      </div>
                    </li>
                  }
                </ul>
              </div>
            }
          }
        </section>
      }
    </div>

    <!-- Add Availability modal -->
    @if (addOpen()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="addOpen.set(false)"></button>
        <div class="relative z-10 flex w-full max-w-sm flex-col gap-5 rounded-[16px] bg-white p-6 shadow-[0_8px_40px_rgba(10,22,40,0.2)]">
          <div class="flex items-center justify-between">
            <h3 class="font-heading text-h5 text-ink">Add Availability</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="addOpen.set(false)"><sd-icon name="x" [size]="22" /></button>
          </div>

          <div class="flex rounded-pill border border-cloud bg-white p-1">
            <button type="button" class="flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="addRecurring() ? 'text-slate' : 'bg-frost text-cerulean'" (click)="addRecurring.set(false)">One-time</button>
            <button type="button" class="flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="addRecurring() ? 'bg-frost text-cerulean' : 'text-slate'" (click)="addRecurring.set(true)">Recurring</button>
          </div>

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Date</span>
            <input type="date" class="${TIME_INPUT}" [min]="today" [value]="addDate()" (input)="addDate.set($any($event.target).value)" />
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
              <input type="time" class="${TIME_INPUT} flex-1" [value]="addStart()" (input)="addStart.set($any($event.target).value)" />
              <span class="font-sans text-caption text-slate">to</span>
              <input type="time" class="${TIME_INPUT} flex-1" [value]="addEnd()" (input)="addEnd.set($any($event.target).value)" />
            </div>
          </div>

          @if (addError()) { <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ addError() }}</p> }
          <sd-button [full]="true" [disabled]="busy()" (click)="submitAdd()">{{ busy() ? 'Saving…' : 'Save Availability' }}</sd-button>
        </div>
      </div>
    }

    <!-- Block Availability modal -->
    @if (blockOpen()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="blockOpen.set(false)"></button>
        <div class="relative z-10 flex w-full max-w-sm flex-col gap-5 rounded-[16px] bg-white p-6 shadow-[0_8px_40px_rgba(10,22,40,0.2)]">
          <div class="flex items-center justify-between">
            <h3 class="font-heading text-h5 text-ink">Block Availability</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="blockOpen.set(false)"><sd-icon name="x" [size]="22" /></button>
          </div>

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Date</span>
            <input type="date" class="${TIME_INPUT}" [min]="today" [value]="blockDate()" (input)="blockDate.set($any($event.target).value)" />
          </label>

          <div class="flex rounded-pill border border-cloud bg-white p-1">
            <button type="button" class="flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="blockEntire() ? 'bg-frost text-cerulean' : 'text-slate'" (click)="blockEntire.set(true)">Entire day</button>
            <button type="button" class="flex-1 rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors" [class]="blockEntire() ? 'text-slate' : 'bg-frost text-cerulean'" (click)="blockEntire.set(false)">Specific time</button>
          </div>

          @if (!blockEntire()) {
            <div class="flex flex-col gap-2">
              <span class="font-sans text-body font-semibold text-ink">Time Range</span>
              <div class="flex items-center gap-2">
                <input type="time" class="${TIME_INPUT} flex-1" [value]="blockStart()" (input)="blockStart.set($any($event.target).value)" />
                <span class="font-sans text-caption text-slate">to</span>
                <input type="time" class="${TIME_INPUT} flex-1" [value]="blockEnd()" (input)="blockEnd.set($any($event.target).value)" />
              </div>
            </div>
          }

          <label class="flex flex-col gap-2">
            <span class="font-sans text-body font-semibold text-ink">Reason (optional)</span>
            <input type="text" class="${TIME_INPUT}" placeholder="e.g. Vacation, personal leave" [value]="blockReason()" (input)="blockReason.set($any($event.target).value)" />
          </label>

          @if (blockError()) { <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ blockError() }}</p> }
          <button type="button" class="flex items-center justify-center gap-2 rounded-field bg-alert px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60" [disabled]="busy()" (click)="submitBlock()">
            <sd-icon name="ban" [size]="18" />{{ busy() ? 'Blocking…' : 'Block this day' }}
          </button>
        </div>
      </div>
    }
  `,
})
export class DoctorAvailability implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly weekdayLabels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  protected readonly durations = DURATIONS;
  protected readonly today = new Date().toISOString().slice(0, 10);

  protected readonly mode = signal<'calendar' | 'list'>('calendar');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly notice = signal('');
  protected readonly slots = signal<AvailabilitySlotDto[]>([]);
  protected readonly slotMinutes = signal(30);

  /** First day of the visible month, as a UTC date. */
  protected readonly monthCursor = signal(this.firstOfMonth(new Date()));
  protected readonly selectedDate = signal(this.today);

  // Add modal
  protected readonly addOpen = signal(false);
  protected readonly addRecurring = signal(false);
  protected readonly addDate = signal(this.today);
  protected readonly addDuration = signal(30);
  protected readonly addStart = signal('09:00');
  protected readonly addEnd = signal('12:00');
  protected readonly addWeeks = signal(8);
  protected readonly addError = signal('');

  // Block modal
  protected readonly blockOpen = signal(false);
  protected readonly blockDate = signal(this.today);
  protected readonly blockEntire = signal(true);
  protected readonly blockStart = signal('09:00');
  protected readonly blockEnd = signal('12:00');
  protected readonly blockReason = signal('');
  protected readonly blockError = signal('');

  protected readonly monthLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(this.monthCursor()),
  );

  protected readonly selectedLabel = computed(() =>
    new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${this.selectedDate()}T00:00:00Z`)),
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

  /** Dates (YYYY-MM-DD) that have at least one open slot. */
  private readonly openDays = computed(() => {
    const set = new Set<string>();
    for (const s of this.slots()) {
      if (s.status === 'open') set.add(s.starts_at.slice(0, 10));
    }
    return set;
  });

  protected readonly selectedSlots = computed(() =>
    this.slots()
      .filter((s) => s.starts_at.slice(0, 10) === this.selectedDate())
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  );

  protected readonly listGroups = computed(() => {
    const byDate = new Map<string, AvailabilitySlotDto[]>();
    for (const s of [...this.slots()].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
      const key = s.starts_at.slice(0, 10);
      (byDate.get(key) ?? byDate.set(key, []).get(key)!).push(s);
    }
    return [...byDate.entries()].map(([date, slots]) => ({
      date,
      label: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)),
      slots,
    }));
  });

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    const cursor = this.monthCursor();
    const from = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1 - 7)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 7)).toISOString().slice(0, 10);
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
        error: () => {
          this.notice.set('Could not load your availability.');
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
    const base = cell.inMonth ? 'text-ink hover:bg-glacier' : 'text-slate/40 hover:bg-glacier';
    return cell.date === this.today ? `${base} ring-1 ring-inset ring-cerulean/40` : base;
  }

  protected hasOpen(date: string): boolean {
    return this.openDays().has(date);
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
    this.addDate.set(date);
    this.addRecurring.set(false);
    this.addDuration.set(this.slotMinutes());
    this.addStart.set('09:00');
    this.addEnd.set('12:00');
    this.addWeeks.set(8);
    this.addError.set('');
    this.addOpen.set(true);
  }

  protected openBlock(date: string): void {
    this.blockDate.set(date);
    this.blockEntire.set(true);
    this.blockStart.set('09:00');
    this.blockEnd.set('12:00');
    this.blockReason.set('');
    this.blockError.set('');
    this.blockOpen.set(true);
  }

  protected async submitAdd(): Promise<void> {
    if (this.addEnd() <= this.addStart()) {
      this.addError.set('End time must be after the start time.');
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

  protected async removeSlot(s: AvailabilitySlotDto): Promise<void> {
    this.busyId.set(s.id);
    this.notice.set('');
    try {
      await firstValueFrom(this.api.deleteAvailability(s.id));
      this.slots.update((list) => list.filter((x) => x.id !== s.id));
    } catch (err) {
      this.notice.set(apiErrorMessage(err, 'Could not remove that slot.'));
    } finally {
      this.busyId.set(null);
    }
  }

  private firstOfMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
}
