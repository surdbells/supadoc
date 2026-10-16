import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  viewChild,
} from '@angular/core';
import { todayLocal } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';
import {
  ANY_WHEN,
  lastSearchDay,
  type TimeOfDay,
  type WhenChoice,
  type WhenFilter,
} from './booking-helpers';

let nextId = 0;

const WHEN_OPTIONS: readonly { value: WhenChoice; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'This week' },
  { value: 'date', label: 'Pick a date' },
];

const TIME_OPTIONS: readonly {
  value: TimeOfDay;
  label: string;
  icon: string;
}[] = [
  { value: 'any', label: 'Any time', icon: 'clock' },
  { value: 'morning', label: 'Morning', icon: 'sunrise' },
  { value: 'afternoon', label: 'Afternoon', icon: 'sun' },
  { value: 'evening', label: 'Evening', icon: 'moon' },
];

/**
 * The directory's "When" (Any · Today · Tomorrow · This week · Pick a date)
 * and "Time of day" chips, two-way bound as one {@link WhenFilter}. Each group
 * is a set of toggle buttons (aria-pressed); "Pick a date" reveals a native
 * date input limited to the booking window. `compact` uses the sidebar's
 * smaller labels.
 */
@Component({
  selector: 'pat-when-filter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-4">
      <div
        class="flex flex-col gap-2"
        role="group"
        [attr.aria-labelledby]="whenId"
      >
        <span [id]="whenId" [class]="labelClass()">When</span>
        <div class="flex flex-wrap gap-2">
          @for (o of whenOptions; track o.value) {
            <button
              type="button"
              [class]="chipClass(value().when === o.value)"
              [attr.aria-pressed]="value().when === o.value"
              (click)="setWhen(o.value)"
            >
              @if (value().when === o.value) {
                <sd-icon name="check" [size]="14" />
              }
              {{ o.label }}
            </button>
          }
        </div>
        @if (value().when === 'date') {
          <label class="mt-1 flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate"
              >Date</span
            >
            <input
              #dateInput
              type="date"
              class="min-h-11 w-full max-w-[240px] rounded-field border border-cloud bg-white px-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
              [min]="today"
              [max]="maxDate()"
              [value]="value().date"
              (change)="setDate($any($event.target).value)"
            />
          </label>
        }
      </div>

      <div
        class="flex flex-col gap-2"
        role="group"
        [attr.aria-labelledby]="timeId"
      >
        <span [id]="timeId" [class]="labelClass()">Time of day</span>
        <div class="flex flex-wrap gap-2">
          @for (o of timeOptions; track o.value) {
            <button
              type="button"
              [class]="chipClass(value().time === o.value)"
              [attr.aria-pressed]="value().time === o.value"
              (click)="setTime(o.value)"
            >
              <sd-icon
                [name]="value().time === o.value ? 'check' : o.icon"
                [size]="14"
              />
              {{ o.label }}
            </button>
          }
        </div>
      </div>
    </div>
  `,
})
export class WhenFilterChips {
  private readonly injector = inject(Injector);
  private readonly dateInput =
    viewChild<ElementRef<HTMLInputElement>>('dateInput');

  readonly value = model<WhenFilter>(ANY_WHEN);
  /** The last day "Pick a date" offers (default: today + the default booking horizon). */
  readonly maxDate = input<string>(lastSearchDay());
  /** Smaller, muted group labels (the public directory's sidebar). */
  readonly compact = input(false);

  protected readonly whenId = `pat-when-${++nextId}`;
  protected readonly timeId = `pat-when-${nextId}-time`;
  protected readonly whenOptions = WHEN_OPTIONS;
  protected readonly timeOptions = TIME_OPTIONS;
  protected readonly today = todayLocal();

  protected readonly labelClass = computed(() =>
    this.compact()
      ? 'font-sans text-caption font-semibold text-slate'
      : 'font-sans text-body-sm font-semibold text-ink',
  );

  protected chipClass(active: boolean): string {
    const base =
      'inline-flex min-h-11 items-center gap-1.5 rounded-pill border px-4 font-sans text-body-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';
    return active
      ? `${base} border-cerulean bg-frost font-medium text-cerulean-dark shadow-control`
      : `${base} border-haze bg-white text-slate shadow-control hover:text-ink`;
  }

  protected setWhen(when: WhenChoice): void {
    const current = this.value();
    if (current.when === when) return;
    this.value.set({
      ...current,
      when,
      date: when === 'date' ? current.date : '',
    });
    // "Pick a date" opens its input: take the patient straight to it.
    if (when === 'date') {
      afterNextRender(() => this.dateInput()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
  }

  protected setDate(date: string): void {
    const valid =
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      date >= this.today &&
      date <= this.maxDate();
    this.value.set({ ...this.value(), when: 'date', date: valid ? date : '' });
  }

  protected setTime(time: TimeOfDay): void {
    if (this.value().time !== time) this.value.set({ ...this.value(), time });
  }
}
