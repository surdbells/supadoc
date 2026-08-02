import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

type Status = 'completed' | 'cancelled' | 'followup';
type Tab = 'all' | 'completed' | 'cancelled' | 'followup';

interface Consultation {
  readonly id: string;
  readonly photo: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly status: Status;
}

const STATUS: Record<Status, { label: string; class: string }> = {
  completed: { label: 'Completed', class: 'bg-sage/15 text-sage' },
  cancelled: { label: 'Cancelled', class: 'bg-alert/10 text-alert' },
  followup: {
    label: 'Follow-up Required',
    class: 'bg-warning/15 text-warning',
  },
};

/** Consultation History (Figma 497:7880) + inline empty state (808:13294). */
@Component({
  selector: 'pat-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Consultation History</h1>
        <p class="font-sans text-body text-slate">
          View your consultation in one place.
        </p>
      </div>

      <!-- Tabs -->
      <div
        class="flex items-center gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-2"
      >
        @for (t of tabs; track t.key) {
          <button
            type="button"
            class="shrink-0 rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
            [class]="
              activeTab() === t.key
                ? 'bg-frost font-medium text-cerulean'
                : 'text-slate hover:text-ink'
            "
            (click)="activeTab.set(t.key)"
          >
            {{ t.label }}
          </button>
        }
        <button
          type="button"
          class="ml-auto shrink-0 px-3 font-sans text-body-sm text-cerulean hover:underline"
          (click)="activeTab.set('all')"
        >
          Clear all
        </button>
      </div>

      @if (viewState() === 'empty') {
        <div class="flex flex-col items-center gap-5 py-24 text-center">
          <span
            class="flex size-20 items-center justify-center rounded-full bg-cloud text-slate"
          >
            <sd-icon name="calendar-off" [size]="36" />
          </span>
          <div class="flex max-w-sm flex-col gap-2">
            <h2 class="font-heading text-h5 text-ink">
              No consultation history yet
            </h2>
            <p class="font-sans text-body-sm text-slate">
              You haven't completed any consultations yet. Once you do, they'll
              show up here.
            </p>
          </div>
          <sd-button>
            <sd-icon name="calendar-days" [size]="18" />
            Book a Consultation
          </sd-button>
        </div>
      } @else {
        <div class="flex flex-col gap-4">
          @for (c of filtered(); track c.id) {
            <button
              type="button"
              class="flex items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/50"
              (click)="open(c)"
            >
              <img
                [src]="c.photo"
                alt=""
                width="56"
                height="56"
                class="size-14 shrink-0 rounded-full object-cover"
              />
              <div class="flex min-w-0 flex-1 flex-col">
                <p class="truncate font-sans text-body font-semibold text-ink">
                  {{ c.name }}
                </p>
                <p class="truncate font-sans text-caption text-slate">
                  {{ c.specialty }}
                </p>
              </div>
              <div
                class="hidden flex-col gap-1 font-sans text-caption text-slate sm:flex"
              >
                <span class="flex items-center gap-2">
                  <sd-icon name="calendar-days" [size]="16" />{{ c.date }}
                </span>
                <span class="flex items-center gap-2">
                  <sd-icon name="clock" [size]="16" />{{ c.time }}
                </span>
              </div>
              <div class="hidden flex-col items-start gap-2 md:flex">
                <span
                  class="flex items-center gap-2 font-sans text-caption text-slate"
                >
                  <sd-icon name="video" [size]="16" />Video Consultation
                </span>
                <span
                  class="rounded-lg px-4 py-1 font-sans text-caption font-medium"
                  [class]="status(c).class"
                  >{{ status(c).label }}</span
                >
              </div>
              <sd-icon
                name="chevron-right"
                [size]="20"
                class="shrink-0 text-cerulean"
              />
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class History {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly activeTab = signal<Tab>('all');
  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'followup', label: 'Follow - up Required' },
  ];

  private readonly view = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('view'))),
    { initialValue: null },
  );

  protected status(c: Consultation) {
    return STATUS[c.status];
  }

  protected open(c: Consultation): void {
    void this.router.navigate(['/dashboard/history', c.id]);
  }

  // TODO: source from the consultation history API once available.
  private readonly all: Consultation[] = [
    this.make('h1', '/dashboard/avatar-james.png', 'completed'),
    this.make('h2', '/dashboard/avatar-james.png', 'cancelled'),
    this.make('h3', '/dashboard/avatar-james.png', 'followup'),
    this.make('h4', '/dashboard/avatar-james.png', 'completed'),
  ];

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    if (tab === 'all') return this.all;
    return this.all.filter((c) => c.status === tab);
  });

  protected readonly viewState = computed<'list' | 'empty'>(() =>
    this.view() === 'empty' || this.filtered().length === 0 ? 'empty' : 'list',
  );

  private make(id: string, photo: string, status: Status): Consultation {
    return {
      id,
      photo,
      name: 'Dr. Ibrahim Musa',
      specialty: 'Cardiologist',
      date: 'Tue, 21 July 2026',
      time: '10:00 AM',
      status,
    };
  }
}
