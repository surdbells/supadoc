import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';

type Category =
  'appointment' | 'consultation' | 'payment' | 'account' | 'announcement';
type Tab = 'all' | 'unread' | Category;

interface Notice {
  readonly category: Category;
  readonly icon: string;
  readonly tint: string;
  readonly chip: string;
  readonly title: string;
  readonly meta?: string;
  readonly time: string;
  readonly unread: boolean;
}

const CHIP: Record<Category, { label: string; tint: string; chip: string }> = {
  appointment: {
    label: 'Appointment',
    tint: 'bg-frost text-cerulean',
    chip: 'bg-frost text-cerulean',
  },
  consultation: {
    label: 'Consultation',
    tint: 'bg-teal/10 text-teal',
    chip: 'bg-teal/10 text-teal',
  },
  payment: {
    label: 'Payment',
    tint: 'bg-sage/15 text-sage',
    chip: 'bg-sage/15 text-sage',
  },
  account: {
    label: 'Account',
    tint: 'bg-cloud text-slate',
    chip: 'bg-cloud text-slate',
  },
  announcement: {
    label: 'Announcement',
    tint: 'bg-sky/10 text-sky',
    chip: 'bg-sky/10 text-sky',
  },
};

/** Notification (Figma 824:14190) + inline empty state (497:8141). */
@Component({
  selector: 'pat-notification',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Title + search -->
      <div
        class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Notification</h1>
          <p class="font-sans text-body text-slate">
            Check all notifications here.
          </p>
        </div>
        <span
          class="flex items-center gap-2 rounded-field border border-cloud bg-white px-4 py-3 lg:w-[440px]"
        >
          <sd-icon name="search" [size]="20" class="text-slate" />
          <input
            type="search"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
            placeholder="Search notifications"
            class="w-full bg-transparent font-sans text-body text-ink placeholder:text-slate/70 focus:outline-none"
          />
        </span>
      </div>

      <!-- Tabs -->
      <div
        class="flex items-center gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-2"
      >
        @for (t of tabs; track t.key) {
          <button
            type="button"
            class="flex shrink-0 items-center gap-2 rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
            [class]="
              activeTab() === t.key
                ? 'bg-frost font-medium text-cerulean'
                : 'text-slate hover:text-ink'
            "
            (click)="activeTab.set(t.key)"
          >
            {{ t.label }}
            @if (t.key === 'unread' && unreadCount() > 0) {
              <span
                class="flex size-4 items-center justify-center rounded-full bg-cerulean text-[10px] font-semibold text-white"
                >{{ unreadCount() }}</span
              >
            }
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

      @if (filtered().length === 0) {
        <div class="flex flex-col items-center gap-5 py-24 text-center">
          <span
            class="flex size-20 items-center justify-center rounded-full bg-cloud text-slate"
          >
            <sd-icon name="bell-off" [size]="36" />
          </span>
          <div class="flex max-w-md flex-col gap-2">
            <h2 class="font-heading text-h5 text-ink">No Notification yet</h2>
            <p class="font-sans text-body-sm text-slate">
              When you have new appointments, consultation updates, or account
              activities, they'll appear here.
            </p>
          </div>
        </div>
      } @else {
        <div class="flex flex-col gap-4">
          <h2 class="font-sans text-body font-semibold text-ink">Today</h2>
          @for (n of filtered(); track $index) {
            <div
              class="flex gap-3 rounded-card border border-cloud bg-white p-4"
              [class.border-l-4]="n.unread"
              [class.!border-l-cerulean]="n.unread"
            >
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-lg"
                [class]="n.tint"
              >
                <sd-icon [name]="n.icon" [size]="20" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <div class="flex items-start justify-between gap-2">
                  <span
                    class="rounded-pill px-2.5 py-0.5 font-sans text-[10px] font-medium"
                    [class]="n.chip"
                    >{{ chip(n).label }}</span
                  >
                  <span class="shrink-0 font-sans text-caption text-slate">{{
                    n.time
                  }}</span>
                </div>
                <p class="font-sans text-body font-semibold text-ink">
                  {{ n.title }}
                </p>
                @if (n.meta) {
                  <p class="font-sans text-caption text-slate">{{ n.meta }}</p>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class Notification {
  protected readonly query = signal('');
  protected readonly activeTab = signal<Tab>('all');

  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'appointment', label: 'Appointments' },
    { key: 'consultation', label: 'Consultation' },
    { key: 'payment', label: 'Payments' },
    { key: 'account', label: 'Account' },
    { key: 'announcement', label: 'Announcement' },
  ];

  protected chip(n: Notice) {
    return CHIP[n.category];
  }

  // TODO: source from the notifications API once available.
  private readonly all: Notice[] = [
    {
      category: 'appointment',
      icon: 'calendar-clock',
      tint: CHIP.appointment.tint,
      chip: CHIP.appointment.chip,
      title: 'Appointment confirmed with Dr. Alina Okafor',
      meta: 'Tue, 21 July 2026  •  10:00 AM  •  Video Consultation',
      time: '20 mins ago',
      unread: true,
    },
    {
      category: 'consultation',
      icon: 'stethoscope',
      tint: CHIP.consultation.tint,
      chip: CHIP.consultation.chip,
      title: 'Consultation notes are ready to review',
      meta: 'Dr. Mehta shared a summary and next steps from July 22 consultation.',
      time: '53 mins ago',
      unread: true,
    },
    {
      category: 'payment',
      icon: 'credit-card',
      tint: CHIP.payment.tint,
      chip: CHIP.payment.chip,
      title: 'Payment received - $84.00',
      meta: 'Invoice #INV-20481 was paid via Visa *******4242',
      time: '1 hr ago',
      unread: false,
    },
    {
      category: 'appointment',
      icon: 'calendar-clock',
      tint: CHIP.appointment.tint,
      chip: CHIP.appointment.chip,
      title: 'Reminder: Dermatology follow-up tomorrow',
      meta: 'Tue, 27 July 2026  •  10:00 AM  •  Tap to add to calender',
      time: '3 hrs ago',
      unread: true,
    },
  ];

  protected readonly unreadCount = computed(
    () => this.all.filter((n) => n.unread).length,
  );

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const q = this.query().trim().toLowerCase();
    return this.all.filter((n) => {
      const byTab =
        tab === 'all' ? true : tab === 'unread' ? n.unread : n.category === tab;
      const byQuery =
        !q ||
        n.title.toLowerCase().includes(q) ||
        (n.meta?.toLowerCase().includes(q) ?? false);
      return byTab && byQuery;
    });
  });
}
