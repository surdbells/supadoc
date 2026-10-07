import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import type { Subscription } from 'rxjs';
import {
  apiErrorMessage,
  type ListNotificationsQuery,
  NotificationsApi,
} from '@supadoc/data-access';
import type {
  NotificationDto,
  NotificationsResponse,
  NotificationType,
  NotificationTypeCount,
} from '@supadoc/models';
import { ButtonComponent, EmptyStateComponent, IconComponent } from '@supadoc/ui';

type Type = NotificationType;
type Tab = 'all' | 'unread' | Type;
type Count = NotificationTypeCount;

const TYPES: readonly Type[] = ['appointment', 'prescription', 'payment', 'message', 'system'];

/** Notifications fetched per page ("Load more" fetches the next). */
const PAGE_SIZE = 50;

interface Notice {
  id: string;
  type: Type;
  title: string;
  body: string;
  time: string;
  /** The API's created_at, kept for paging ("load more" continues from here). */
  createdAt: string;
  read: boolean;
  /** Safe in-app deep link (e.g. /dashboard/prescriptions/{id}), or null. */
  link: string | null;
}

/**
 * Only in-app paths are followed ("/dashboard/…"): never absolute, external or
 * protocol-relative ("//host") URLs.
 */
function safeAppLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') return null;
  const l = link.trim();
  return /^\/(?![/\\])/.test(l) ? l : null;
}

const TYPE: Record<Type, { label: string; icon: string; tint: string }> = {
  appointment: { label: 'Appointment', icon: 'calendar-clock', tint: 'bg-frost text-cerulean' },
  prescription: { label: 'Prescription', icon: 'pill', tint: 'bg-teal/10 text-teal' },
  payment: { label: 'Payment', icon: 'credit-card', tint: 'bg-sage/15 text-sage' },
  message: { label: 'Message', icon: 'message-square', tint: 'bg-frost text-cerulean' },
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
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    time: relativeTime(n.created_at),
    createdAt: n.created_at,
    read: n.read,
    link: safeAppLink(n.link),
  };
}

/** The server-side filter for a tab. */
function filterFor(tab: Tab): ListNotificationsQuery {
  if (tab === 'all') return {};
  if (tab === 'unread') return { unread: true };
  return { type: tab };
}

function countsFromMeta(meta: Partial<Record<Type, Partial<Count>>>): Record<Type, Count> {
  return Object.fromEntries(
    TYPES.map((t) => [
      t,
      {
        total: Math.max(0, Number(meta[t]?.total) || 0),
        unread: Math.max(0, Number(meta[t]?.unread) || 0),
      },
    ]),
  ) as Record<Type, Count>;
}

function tally(notices: readonly Notice[]): Record<Type, Count> {
  const counts = countsFromMeta({});
  for (const n of notices) {
    const c = counts[n.type];
    if (!c) continue;
    c.total++;
    if (!n.read) c.unread++;
  }
  return counts;
}

/**
 * Notification (Figma 824:14190) — wired to GET /api/portal/notifications. Each
 * tab lists its own notifications from the server (newest first, "Load more"
 * for older), and every tab's badge counts what it holds.
 */
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

      <!-- Tabs (they scroll sideways when they don't fit; "Mark all read" stays put) -->
      <div class="flex items-center gap-2 rounded-pill border border-cloud bg-white p-2">
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          @for (t of tabs; track t.key) {
            @let c = tabCounts()[t.key];
            <button
              type="button"
              class="flex shrink-0 items-center gap-2 rounded-pill px-4 py-1.5 font-sans text-body-sm transition-colors"
              [class]="
                activeTab() === t.key
                  ? 'bg-frost font-medium text-cerulean'
                  : 'text-slate hover:text-ink'
              "
              [attr.aria-pressed]="activeTab() === t.key"
              [attr.aria-label]="tabAria(t.label, t.key, c)"
              (click)="selectTab(t.key)"
            >
              {{ t.label }}
              @if (c && c.total > 0) {
                <span
                  class="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums"
                  [class]="c.unread > 0 ? 'bg-cerulean text-white' : 'bg-cloud text-slate'"
                  aria-hidden="true"
                  >{{ c.total > 99 ? '99+' : c.total }}</span
                >
              }
            </button>
          }
        </div>
        @if (unread() > 0) {
          <!-- Icon-only on phones, leaving the tabs room to scroll. -->
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 px-2 font-sans text-body-sm text-cerulean hover:underline sm:px-3"
            aria-label="Mark all read"
            title="Mark all read"
            (click)="markAll()"
          >
            <sd-icon name="check" [size]="18" class="sm:hidden" />
            <span class="hidden sm:inline">Mark all read</span>
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
            [message]="loadError() || 'Check your connection and try again.'"
          >
            <sd-button variant="outline" (click)="reload()">Try Again</sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            [icon]="emptyState().icon"
            [title]="emptyState().title"
            [message]="emptyState().message"
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
                  @if (n.link) {
                    <span class="flex items-center gap-1 font-sans text-caption font-semibold text-cerulean">
                      Open
                      <sd-icon name="chevron-right" [size]="14" />
                    </span>
                  }
                </div>
                @if (!n.read) {
                  <span class="mt-1 size-2 shrink-0 rounded-full bg-cerulean" aria-label="Unread"></span>
                }
              </button>
            }
            @if (hasMore()) {
              <div class="flex flex-col items-center gap-2 pt-2">
                @if (moreError()) {
                  <p class="font-sans text-caption text-alert" role="alert">{{ moreError() }}</p>
                }
                <sd-button variant="outline" [disabled]="loadingMore()" (click)="loadMore()">
                  {{ loadingMore() ? 'Loading…' : moreError() ? 'Try again' : 'Load more' }}
                </sd-button>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class Notification {
  private readonly api = inject(NotificationsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;

  protected readonly query = signal('');
  protected readonly activeTab = signal<Tab>('all');

  // Account-wide numbers (whatever tab is showing), kept in step as items are read.
  protected readonly unread = signal(0);
  private readonly total = signal(0);
  /** Total / unread per type; null while unknown (an older API, part-loaded). */
  private readonly counts = signal<Record<Type, Count> | null>(null);

  /**
   * Each tab's badge: how many notifications it holds and how many of those are
   * unread (the badge is highlighted while any are). null = no badge.
   */
  protected readonly tabCounts = computed<Record<Tab, Count | null>>(() => {
    const counts = this.counts();
    const unread = this.unread();
    const byTab = {
      all: { total: this.total(), unread },
      unread: { total: unread, unread },
    } as Record<Tab, Count | null>;
    for (const t of TYPES) byTab[t] = counts?.[t] ?? null;
    return byTab;
  });

  /** The active tab's notifications, newest first, as far as they've loaded. */
  private readonly items = signal<Notice[]>([]);
  protected readonly hasMore = signal(false);
  private readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  /** The API's reason the list failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');
  /** Why "Load more" failed ('' when it hasn't); what's loaded stays. */
  protected readonly moreError = signal('');
  /**
   * An API that predates per-type counts also ignores `type` / `before` and
   * pages by an offset that shifts as items are read — so with one, the page
   * takes the newest 100 once and filters them here, as it always did.
   */
  private legacy = false;
  private request: Subscription | null = null;

  // What was read on this page. Reading is one-way, so a response that was
  // already on its way can't make these unread again.
  private readonly readHere = new Set<string>();
  /**
   * "Mark all read" covered everything created up to this moment (ms, by the
   * server's clock: the newest notification the page had seen), or null.
   */
  private allReadUpTo: number | null = null;
  /** The newest created_at (ms) any response has shown, by the server's clock. */
  private newestSeen = 0;
  /** Bumped on every read here, so an older response won't overwrite the numbers. */
  private readEpoch = 0;
  /** Mark-read calls not yet answered; until they are, responses may predate them. */
  private pendingWrites = 0;
  /** A response's numbers were skipped as possibly stale; refresh once writes settle. */
  private numbersStale = false;

  protected readonly tabs: { key: Tab; label: string; noun: string }[] = [
    { key: 'all', label: 'All', noun: 'notifications' },
    { key: 'unread', label: 'Unread', noun: 'unread notifications' },
    { key: 'appointment', label: 'Appointments', noun: 'appointment notifications' },
    { key: 'prescription', label: 'Prescriptions', noun: 'prescription notifications' },
    { key: 'payment', label: 'Payments', noun: 'payment notifications' },
    { key: 'message', label: 'Messages', noun: 'messages' },
    { key: 'system', label: 'System', noun: 'system notifications' },
  ];

  constructor() {
    this.destroyRef.onDestroy(() => (this.destroyed = true));
    this.load();
  }

  protected type(n: Notice) {
    return TYPE[n.type] ?? TYPE.system;
  }

  /** Screen-reader name for a tab, e.g. "Prescriptions, 3, 1 unread". */
  protected tabAria(label: string, key: Tab, c: Count | null): string {
    if (!c || c.total === 0) return label;
    return c.unread > 0 && key !== 'unread'
      ? `${label}, ${c.total}, ${c.unread} unread`
      : `${label}, ${c.total}`;
  }

  protected selectTab(tab: Tab): void {
    if (tab === this.activeTab()) return;
    this.activeTab.set(tab);
    this.load();
  }

  protected reload(): void {
    this.load();
  }

  protected loadMore(): void {
    if (this.loadingMore() || !this.hasMore()) return;
    this.load(true);
  }

  // The server filters by tab; filtering again here covers an older API that
  // ignores `type`, and items read on the Unread tab.
  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const q = this.query().trim().toLowerCase();
    return this.items().filter((n) => {
      const byTab = tab === 'all' ? true : tab === 'unread' ? !n.read : n.type === tab;
      const byQuery =
        !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
      return byTab && byQuery;
    });
  });

  protected readonly viewState = computed<'loading' | 'list' | 'empty' | 'error'>(() => {
    if (this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    return this.filtered().length === 0 && !this.hasMore() ? 'empty' : 'list';
  });

  protected readonly emptyState = computed(() => {
    const tab = this.activeTab();
    if (this.query().trim()) {
      return { icon: 'search', title: 'No matching notifications', message: 'Try a different search.' };
    }
    if (tab === 'unread') {
      return { icon: 'bell', title: "You're all caught up", message: 'You have no unread notifications.' };
    }
    if (tab !== 'all') {
      const noun = this.tabs.find((t) => t.key === tab)?.noun ?? 'notifications';
      return { icon: 'bell-off', title: `No ${noun} yet`, message: `When you have ${noun}, they'll appear here.` };
    }
    return {
      icon: 'bell-off',
      title: 'No notifications yet',
      message: "When you have new appointments, prescriptions, or account activity, they'll appear here.",
    };
  });

  /** Tap: mark it read, then follow its in-app deep link (if any). */
  protected open(n: Notice): void {
    if (!n.read) {
      this.writeStarted();
      this.readHere.add(n.id);
      this.items.update((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      this.unread.update((u) => Math.max(0, u - 1));
      this.counts.update((c) =>
        c?.[n.type]
          ? { ...c, [n.type]: { ...c[n.type], unread: Math.max(0, c[n.type].unread - 1) } }
          : c,
      );
      if (this.activeTab() === 'unread' && this.unread() === 0) this.hasMore.set(false);
      // Not tied to this page's lifetime: navigating away must not cancel the
      // mark-read request.
      this.api.markRead(n.id).subscribe({
        next: () => this.writeSettled(),
        error: () => {
          this.readHere.delete(n.id);
          this.writeSettled(false);
          if (!this.destroyed) this.load(); // resync on failure
        },
      });
    }
    const link = safeAppLink(n.link);
    if (link) void this.router.navigateByUrl(link);
  }

  protected markAll(): void {
    this.writeStarted();
    this.allReadUpTo = this.newestSeen || null;
    this.items.update((list) => list.map((x) => ({ ...x, read: true })));
    this.unread.set(0);
    this.counts.update((c) =>
      c ? countsFromMeta(Object.fromEntries(TYPES.map((t) => [t, { total: c[t].total, unread: 0 }]))) : c,
    );
    // Nothing older is unread any more.
    if (this.activeTab() === 'unread') this.hasMore.set(false);
    this.api.markAllRead().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.writeSettled(),
      error: () => {
        this.allReadUpTo = null;
        this.writeSettled(false);
        this.load();
      },
    });
  }

  private writeStarted(): void {
    this.readEpoch++;
    this.pendingWrites++;
  }

  /** A mark-read call was answered; once none are left, refresh skipped numbers. */
  private writeSettled(refresh = true): void {
    this.pendingWrites = Math.max(0, this.pendingWrites - 1);
    if (refresh && this.pendingWrites === 0 && this.numbersStale) this.refreshNumbers();
  }

  /** Re-read just the account-wide numbers (one tiny request). */
  private refreshNumbers(): void {
    this.numbersStale = false;
    const epoch = this.readEpoch;
    this.api
      .list({ per_page: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (this.readEpoch !== epoch || this.pendingWrites > 0) {
            this.numbersStale = true;
            if (this.pendingWrites === 0) this.refreshNumbers();
            return;
          }
          this.applyMeta(res.meta, null);
          if (this.activeTab() === 'unread' && this.unread() === 0) this.hasMore.set(false);
        },
        error: () => {
          /* the next load resyncs */
        },
      });
  }

  /** What was read on this page wins over what a response says. */
  private withReadsHere(n: Notice): Notice {
    if (n.read) return n;
    const readAll = this.allReadUpTo !== null && new Date(n.createdAt).getTime() <= this.allReadUpTo;
    return readAll || this.readHere.has(n.id) ? { ...n, read: true } : n;
  }

  /** First page of the active tab, or (`more`) the next one after what's shown. */
  private load(more = false): void {
    const last = this.items()[this.items().length - 1];
    if (more && (this.legacy || !last)) return;
    this.request?.unsubscribe();
    const tab = this.activeTab();
    const legacy = this.legacy;
    const epoch = this.readEpoch;
    // A request sent while a mark-read is unanswered may be served before it.
    const clean = this.pendingWrites === 0;
    const query: ListNotificationsQuery = legacy
      ? { per_page: 100 }
      : { per_page: PAGE_SIZE, ...filterFor(tab) };
    if (more) {
      query.before = new Date(last.createdAt).toISOString();
      this.loadingMore.set(true);
      this.moreError.set('');
    } else {
      this.items.set([]);
      this.hasMore.set(false);
      this.loading.set(true);
      this.loadingMore.set(false);
      this.loadError.set('');
      this.moreError.set('');
    }

    this.request = this.api
      .list(query)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // The API changed under the page (deployed, or rolled back): start the
          // tab again the way this API works rather than mix the two.
          if (!res.meta.counts !== legacy) {
            this.legacy = !res.meta.counts;
            this.load();
            return;
          }
          for (const d of res.data) {
            this.newestSeen = Math.max(this.newestSeen, new Date(d.created_at).getTime() || 0);
          }
          // Merge into the list as it is now (reads made meanwhile included).
          const current = more ? this.items() : [];
          const known = new Set(current.map((n) => n.id));
          const fresh = res.data
            .map((d) => this.withReadsHere(toNotice(d)))
            .filter((n) => !known.has(n.id));
          const items = [...current, ...fresh];
          this.items.set(items);
          // Numbers from a response the server may have answered before a read
          // here was saved are skipped, then refreshed once the saves are done.
          if (clean && this.readEpoch === epoch && this.pendingWrites === 0) {
            this.applyMeta(res.meta, items);
            this.numbersStale = false;
          } else {
            this.numbersStale = true;
            // Totals don't change when things are read, and an older API's
            // per-type tally comes from the (read-adjusted) list itself.
            if (!res.meta.counts) {
              this.total.set(res.meta.total);
              this.counts.set(items.length >= res.meta.total ? tally(items) : null);
            }
            if (this.pendingWrites === 0) this.refreshNumbers();
          }
          this.hasMore.set(
            !legacy &&
              !(more && fresh.length === 0) &&
              !(tab === 'unread' && this.unread() === 0) &&
              res.meta.total > res.data.length,
          );
          this.loading.set(false);
          this.loadingMore.set(false);
        },
        error: (err: unknown) => {
          const message = apiErrorMessage(err, 'Check your connection and try again.');
          if (more) this.moreError.set(message);
          else this.loadError.set(message);
          this.loading.set(false);
          this.loadingMore.set(false);
        },
      });
  }

  /** Account-wide numbers from a response; `items` = the older API's one page (null: numbers only). */
  private applyMeta(meta: NotificationsResponse['meta'], items: readonly Notice[] | null): void {
    this.unread.set(Math.max(0, Number(meta.unread) || 0));
    if (meta.counts) {
      const counts = countsFromMeta(meta.counts);
      this.counts.set(counts);
      this.total.set(TYPES.reduce((sum, t) => sum + counts[t].total, 0));
      return;
    }
    // An older API: the one unfiltered page covers the whole account, and the
    // per-type numbers are only certain when nothing lies beyond it.
    this.total.set(meta.total);
    if (items) this.counts.set(items.length >= meta.total ? tally(items) : null);
  }
}
