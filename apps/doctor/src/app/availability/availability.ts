import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { WeeklyHours } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Day {
  readonly key: string;
  readonly label: string;
}

// Display Monday-first; keys are weekday numbers ("0"=Sun … "6"=Sat).
const DAYS: Day[] = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
];

const TIME =
  'rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none';

/** Weekly availability editor (route `/availability`). Persists Specialist.weekly_hours. */
@Component({
  selector: 'doc-availability',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-2xl flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Availability</h1>
        <p class="font-sans text-body text-slate">Set the weekly hours patients can book you for.</p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-64 rounded-card"></div>
      } @else {
        <section class="flex flex-col divide-y divide-cloud rounded-card border border-cloud bg-white">
          @for (d of days; track d.key) {
            <div class="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
              <label class="flex w-40 shrink-0 cursor-pointer items-center gap-2">
                <input type="checkbox" class="size-4 accent-cerulean" [checked]="isOpen(d.key)" (change)="toggleDay(d.key, $any($event.target).checked)" />
                <span class="font-sans text-body font-semibold text-ink">{{ d.label }}</span>
              </label>
              <div class="flex flex-1 flex-col gap-2">
                @if (isOpen(d.key)) {
                  @for (w of windows(d.key); track $index) {
                    <div class="flex items-center gap-2">
                      <input type="time" class="${TIME}" [value]="w[0]" (input)="setStart(d.key, $index, $any($event.target).value)" />
                      <span class="font-sans text-caption text-slate">to</span>
                      <input type="time" class="${TIME}" [value]="w[1]" (input)="setEnd(d.key, $index, $any($event.target).value)" />
                      <button type="button" class="text-slate transition-colors hover:text-alert" aria-label="Remove" (click)="removeWindow(d.key, $index)"><sd-icon name="x" [size]="18" /></button>
                    </div>
                  }
                  <button type="button" class="w-fit font-sans text-caption font-semibold text-cerulean hover:underline" (click)="addWindow(d.key)">+ Add hours</button>
                } @else {
                  <span class="font-sans text-body-sm text-slate">Unavailable</span>
                }
              </div>
            </div>
          }
        </section>

        @if (notice()) {
          <p class="rounded-field px-4 py-2 font-label text-caption" [class]="ok() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'">{{ notice() }}</p>
        }
        <div class="flex items-center gap-3">
          <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-6 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="saving()" (click)="save()">
            <sd-icon name="check" [size]="18" />{{ saving() ? 'Saving…' : 'Save availability' }}
          </button>
          <p class="font-sans text-caption text-slate">Times are in your local timezone.</p>
        </div>
      }
    </div>
  `,
})
export class DoctorAvailability implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly days = DAYS;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly ok = signal(false);
  private readonly hours = signal<WeeklyHours>({});

  ngOnInit(): void {
    this.api
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.hours.set(this.normalise(res.data.weekly_hours ?? {}));
          this.loading.set(false);
        },
        error: () => {
          this.hours.set({});
          this.loading.set(false);
        },
      });
  }

  protected isOpen(key: string): boolean {
    return (this.hours()[key]?.length ?? 0) > 0;
  }
  protected windows(key: string): [string, string][] {
    return this.hours()[key] ?? [];
  }

  protected toggleDay(key: string, open: boolean): void {
    this.hours.update((h) => {
      const next = { ...h };
      if (open) next[key] = next[key]?.length ? next[key] : [['09:00', '17:00']];
      else delete next[key];
      return next;
    });
  }
  protected addWindow(key: string): void {
    this.hours.update((h) => ({ ...h, [key]: [...(h[key] ?? []), ['09:00', '17:00'] as [string, string]] }));
  }
  protected removeWindow(key: string, i: number): void {
    this.hours.update((h) => {
      const list = (h[key] ?? []).filter((_, idx) => idx !== i);
      const next = { ...h };
      if (list.length) next[key] = list;
      else delete next[key];
      return next;
    });
  }
  protected setStart(key: string, i: number, value: string): void {
    this.editWindow(key, i, 0, value);
  }
  protected setEnd(key: string, i: number, value: string): void {
    this.editWindow(key, i, 1, value);
  }
  private editWindow(key: string, i: number, pos: 0 | 1, value: string): void {
    this.hours.update((h) => ({
      ...h,
      [key]: (h[key] ?? []).map((w, idx) => (idx === i ? (pos === 0 ? [value, w[1]] : [w[0], value]) : w)),
    }));
  }

  protected save(): void {
    this.saving.set(true);
    this.notice.set('');
    // Drop empty/invalid windows; a day with no windows means unavailable.
    const clean: WeeklyHours = {};
    for (const [key, list] of Object.entries(this.hours())) {
      const valid = list.filter((w) => w[0] && w[1] && w[0] < w[1]);
      if (valid.length) clean[key] = valid;
    }
    this.api
      .updateProfile({ weekly_hours: clean })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.hours.set(this.normalise(res.data.weekly_hours ?? clean));
          this.ok.set(true);
          this.notice.set('Availability saved.');
          this.saving.set(false);
        },
        error: (err) => {
          this.ok.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not save availability.'));
          this.saving.set(false);
        },
      });
  }

  /** Coerce server data into [start,end] string tuples. */
  private normalise(raw: WeeklyHours): WeeklyHours {
    const out: WeeklyHours = {};
    for (const [key, list] of Object.entries(raw ?? {})) {
      if (Array.isArray(list)) {
        out[key] = list
          .filter((w) => Array.isArray(w) && w.length >= 2)
          .map((w) => [String(w[0]), String(w[1])] as [string, string]);
      }
    }
    return out;
  }
}
