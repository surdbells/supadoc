import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NotificationsApi } from '@supadoc/data-access';
import type { NotificationDto } from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';

type Type = 'appointment' | 'prescription' | 'payment' | 'system';
type Tab = 'all' | 'unread' | Type;

interface Notice {
  id: string;
  type: Type;
  title: string;
  body: string;
  time: string;
  read: boolean;
}

const TYPE: Record<Type, { label: string; icon: string; tint: string }> = {
  appointment: { label: 'Appointment', icon: 'calendar-clock', tint: 'bg-frost text-cerulean' },
  prescription: { label: 'Prescription', icon: 'pill', tint: 'bg-teal/10 text-teal' },
  payment: { label: 'Payment', icon: 'credit-card', tint: 'bg-sage/15 text-sage' },
  system: { label: 'System', icon: 'bell', tint: 'bg-sky/10 text-sky' },
};

function relativeTime(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

function toNotice(n: NotificationDto): Notice {
  return { id: n.id, type: n.type, title: n.title, body: n.body, time: relativeTime(n.created_at), read: n.read };
}

/** Notification (Figma 824:14190) — wired to GET /api/portal/notifications. */
@Component({
  selector: 'pat-notification',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, EmptyStateComponent, IconComponent],
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
            @if (t.key === 'unread' && unread() > 0) {
              <span
                class="flex size-4 items-center justify-center rounded-full bg-cerulean text-[10px] font-semibold text-white"
                >{{ unread() }}</span
              >
            }
          </button>
        }
        @if (unread() > 0) {
          <button
            type="button"
            class="ml-auto shrink-0 px-3 font-sans text-body-sm text-cerulean hover:underline"
            (click)="markAll()"
          >
            Mark all read
          </button>
        }
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-4">
            @for (n of [1, 2, 3, 4]; track n) {
              <div class="h-20 animate-pulse rounded-card border border-cloud bg-cloud/40"></div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Couldn't load notifications"
            message="Check your connection and try again."
          >
            <sd-button variant="outline" (click)="reload()">Try Again</sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            icon="bell-off"
            title="No notifications yet"
            message="When you have new appointments, prescriptions, or account activity, they'll appear here."
          />
        }
        @default {
          <div class="flex flex-col gap-4">
            @for (n of filtered(); track n.id) {
              <button
                type="button"
                class="sd-card-hover flex gap-3 rounded-card border border-cloud bg-white p-4 text-left hover:border-cerulean/40"
                [class.border-l-4]="!n.read"
                [class.!border-l-cerulean]="!n.read"
                (click)="open(n)"
              >
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-lg"
                  [class]="type(n).tint"
                >
                  <sd-icon [name]="type(n).icon" [size]="20" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div class="flex items-start justify-between gap-2">
                    <span
                      class="rounded-pill px-2.5 py-0.5 font-sans text-[10px] font-medium"
                      [class]="type(n).tint"
                      >{{ type(n).label }}</span
                    >
                    <span class="shrink-0 font-sans text-caption text-slate">{{ n.time }}</span>
                  </div>
                  <p class="font-sans text-body font-semibold text-ink">{{ n.title }}</p>
                  <p class="font-sans text-caption text-slate">{{ n.body }}</p>
                </div>
                @if (!n.read) {
                  <span class="mt-1 size-2 shrink-0 rounded-full bg-cerulean" aria-label="Unread"></span>
                }
              </button>
            }
          </div>
        }
      }
    </div>
  `,
})
export class Notification {
  private readonly api = inject(NotificationsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal('');
  protected readonly activeTab = signal<Tab>('all');
  protected readonly unread = signal(0);

  private readonly all = signal<Notice[]>([]);
  private readonly loading = signal(true);
  private readonly loadError = signal(false);

  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'appointment', label: 'Appointments' },
    { key: 'prescription', label: 'Prescriptions' },
    { key: 'payment', label: 'Payments' },
    { key: 'system', label: 'System' },
  ];

  constructor() {
    this.load();
  }

  protected type(n: Notice) {
    return TYPE[n.type];
  }

  protected reload(): void {
    this.load();
  }

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const q = this.query().trim().toLowerCase();
    return this.all().filter((n) => {
      const byTab = tab === 'all' ? true : tab === 'unread' ? !n.read : n.type === tab;
      const byQuery =
        !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
      return byTab && byQuery;
    });
  });

  protected readonly viewState = computed<'loading' | 'list' | 'empty' | 'error'>(() => {
    if (this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    return this.filtered().length === 0 ? 'empty' : 'list';
  });

  protected open(n: Notice): void {
    if (n.read) return;
    this.all.update((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    this.unread.update((u) => Math.max(0, u - 1));
    this.api.markRead(n.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => this.load(), // resync on failure
    });
  }

  protected markAll(): void {
    this.all.update((list) => list.map((x) => ({ ...x, read: true })));
    this.unread.set(0);
    this.api.markAllRead().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => this.load(),
    });
  }

  private load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.api
      .list({ per_page: 100 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.all.set(res.data.map(toNotice));
          this.unread.set(res.meta.unread);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
  }
}
