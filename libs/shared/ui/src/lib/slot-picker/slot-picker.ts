import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';
import type { DayAvailability } from '@supadoc/models';

const DAY_NAME = new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * Day + time pills for choosing an open consultation slot. Feed it days already
 * in the viewer's local time (`localSlotDays()` from @supadoc/data-access), so
 * every pill is a time that is still ahead. Tapping a day shows its times; a
 * time must be tapped to be chosen. Two-way bindable on the slot's ISO start:
 * `<sd-slot-picker [days]="days()" [(value)]="slotIso" />`.
 */
@Component({
  selector: 'sd-slot-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    <div class="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Day">
      @for (d of days(); track d.date) {
        <button
          type="button"
          class="flex shrink-0 flex-col items-center rounded-field border px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [class]="activeDate() === d.date ? 'border-cerulean bg-cerulean text-white' : 'border-cloud bg-white text-slate hover:border-cerulean/50'"
          [attr.aria-pressed]="activeDate() === d.date"
          [attr.aria-label]="dayName(d.date)"
          (click)="pickDay(d)"
        >
          <span class="font-sans text-[10px] uppercase">{{ d.weekday }}</span>
          <span class="font-sans text-body-sm font-semibold">{{ d.day }}</span>
        </button>
      }
    </div>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Time">
      @for (t of activeSlots(); track t.iso) {
        <button
          type="button"
          class="rounded-field border px-3 py-1 font-sans text-caption transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          [class]="value() === t.iso ? 'border-cerulean bg-cerulean text-white' : 'border-cloud bg-white text-slate hover:border-cerulean/50'"
          [attr.aria-pressed]="value() === t.iso"
          (click)="value.set(t.iso)"
        >
          {{ t.label }}
        </button>
      }
    </div>
  `,
})
export class SlotPickerComponent {
  readonly days = input<readonly DayAvailability[]>([]);
  /** The chosen slot's ISO start ('' = none chosen). */
  readonly value = model('');

  /** The day last tapped — its times show even before one is chosen. */
  private readonly tapped = signal('');

  /** The day whose times are showing: the tapped one, else the chosen slot's, else the first. */
  protected readonly activeDate = computed(() => {
    const days = this.days();
    const tapped = this.tapped();
    if (tapped && days.some((d) => d.date === tapped)) return tapped;
    const chosen = this.value();
    return days.find((d) => d.slots.some((s) => s.iso === chosen))?.date ?? days[0]?.date ?? '';
  });

  protected readonly activeSlots = computed(
    () => this.days().find((d) => d.date === this.activeDate())?.slots ?? [],
  );

  protected pickDay(d: DayAvailability): void {
    this.tapped.set(d.date);
    // A time chosen on another day would be saved unseen — drop it.
    if (!d.slots.some((s) => s.iso === this.value())) this.value.set('');
  }

  /** "Monday, October 14" for a local YYYY-MM-DD (formatted as-is, not shifted). */
  protected dayName(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    return isNaN(d.getTime()) ? date : DAY_NAME.format(d);
  }
}
