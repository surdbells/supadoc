import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  NgZone,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import { StaffAuthService } from '@supadoc/auth';
import {
  apiErrorMessage,
  formatInZone,
  StaffNotificationsApi,
  viewerTimeZone,
  zoneAbbr,
} from '@supadoc/data-access';
import type { StaffNotificationDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import {
  BTN_ROW,
  BTN_SECONDARY,
  CARD_LIST,
  COUNT_BADGE,
  EMPTY_FRAME,
  INLINE_ERROR,
  LOAD_MORE,
  PAGE_HEADER,
  PAGE_HEADER_TEXT,
  PAGE_NARROW,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PAGE_TITLE_ROW,
  PILL,
} from '../shared/layout';
import {
  notificationIcon,
  notificationTarget,
  type NotificationTarget,
  revealOnArrival,
} from './notification-target';
import { UnreadNotifications } from './unread-notifications';

/** Notifications per page (the API paginates, newest first). */
export const NOTIFICATIONS_PER_PAGE = 20;

const COPY = {
  loadError: 'Could not load your notifications. Please try again.',
  markAllError: 'Could not mark your notifications as read. Please try again.',
  markReadError: 'Could not mark this notification as read. Please try again.',
  markedRead: 'Marked as read.',
} as const;

/**
 * Appended to an announcement that repeats the last one word for word: a live
 * region only speaks when its text changes. (A no-break space, so it is silent.)
 */
const REPEAT = String.fromCharCode(0xa0);

interface Row {
  readonly n: StaffNotificationDto;
  readonly target: NotificationTarget | null;
  /** Card tone: unread ones stand out (and say "New"); only a linked card lifts on hover. */
  readonly tone: string;
}

function rowTone(read: boolean, linked: boolean): string {
  const base = read ? 'border-haze bg-white' : 'border-cerulean/30 bg-frost/20';
  return linked ? `${base} hover:shadow-card-hover` : base;
}

/**
 * The signed-in staff user's notifications (route `/notifications`): newest
 * first, unread ones marked "New". Opening one marks it read; one that points
 * at a record links to it (only where the user's role opens that page).
 */
@Component({
  selector: 'bo-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, EmptyStateComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE_NARROW}">
      <header class="${PAGE_HEADER}">
        <div class="${PAGE_HEADER_TEXT}">
          <div class="${PAGE_TITLE_ROW}">
            <h1
              #heading
              tabindex="-1"
              class="${PAGE_TITLE} rounded-sm focus:outline-none"
            >
              Notifications
            </h1>
            @if (unreadCount() > 0) {
              <span class="${COUNT_BADGE}">{{ unreadCount() }} unread</span>
            }
          </div>
          <p class="${PAGE_SUBTITLE}">
            Updates for you and the work your role covers.
          </p>
        </div>
        @if (anyUnread() && items().length > 0) {
          <button
            type="button"
            class="${BTN_SECONDARY}"
            [disabled]="markingAll()"
            (click)="markAllRead()"
          >
            <sd-icon name="check-check" [size]="16" />{{
              markingAll() ? 'Marking…' : 'Mark all as read'
            }}
          </button>
        }
      </header>

      @if (markAllError()) {
        <p class="${INLINE_ERROR}" role="alert">
          <sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{
            markAllError()
          }}
        </p>
      }

      @if (items().length === 0) {
        @if (loading()) {
          <div class="${CARD_LIST}" aria-busy="true">
            <span class="sr-only">Loading notifications…</span>
            @for (i of [1, 2, 3]; track i) {
              <div
                class="sd-shimmer h-24 rounded-card"
                aria-hidden="true"
              ></div>
            }
          </div>
        } @else if (error()) {
          <div class="${EMPTY_FRAME}" role="alert">
            <sd-empty-state
              icon="wifi-off"
              tone="error"
              title="Couldn't load notifications"
              [message]="error()"
            >
              <button type="button" class="${BTN_SECONDARY}" (click)="reload()">
                <sd-icon name="refresh-cw" [size]="16" />Try again
              </button>
            </sd-empty-state>
          </div>
        } @else {
          <div class="${EMPTY_FRAME}">
            <sd-empty-state
              icon="bell"
              tone="brand"
              title="You're all caught up"
              message="Notifications for you and your role show up here."
            />
          </div>
        }
      } @else {
        <ul
          class="flex flex-col gap-3"
          aria-label="Notifications, newest first"
        >
          @for (row of rows(); track row.n.id) {
            @let n = row.n;
            <li
              class="group relative flex items-start gap-3 rounded-card border p-4 shadow-card transition sm:gap-4 sm:p-5"
              [class]="row.tone"
            >
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full"
                [class]="
                  n.read
                    ? 'bg-cloud text-slate'
                    : 'bg-cerulean/10 text-cerulean-dark'
                "
                aria-hidden="true"
              >
                <sd-icon [name]="icon(n.type)" [size]="18" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  @if (row.target; as t) {
                    <a
                      [id]="'bo-note-' + n.id"
                      [routerLink]="t.path"
                      [fragment]="t.fragment"
                      class="break-words font-sans text-body-sm font-semibold text-ink transition-colors group-hover:text-cerulean after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-cerulean"
                      (click)="follow(n, t, $event)"
                      >{{ n.title }}</a
                    >
                  } @else {
                    <p
                      [id]="'bo-note-' + n.id"
                      tabindex="-1"
                      class="break-words rounded-sm font-sans text-body-sm font-semibold text-ink focus:outline-none"
                    >
                      {{ n.title }}
                    </p>
                  }
                  @if (!n.read) {
                    <span class="${PILL} bg-cerulean/10 text-cerulean-dark"
                      >New</span
                    >
                  }
                </div>
                @if (n.body) {
                  <p class="break-words font-sans text-body-sm text-slate">
                    {{ n.body }}
                  </p>
                }
                <p class="font-sans text-caption text-slate">
                  <time [attr.datetime]="n.created_at">{{
                    when(n.created_at)
                  }}</time>
                </p>
                @if (readError(); as re) {
                  @if (re.id === n.id) {
                    <p class="${INLINE_ERROR} mt-1" role="alert">
                      <sd-icon
                        name="circle-alert"
                        [size]="16"
                        class="shrink-0"
                      />{{ re.message }}
                    </p>
                  }
                }
                @if (!row.target && !n.read) {
                  <!-- Under the text, so a narrow phone keeps the words wide. -->
                  <button
                    type="button"
                    class="${BTN_ROW} mt-1 self-start"
                    (click)="markRead(n)"
                  >
                    Mark as read<span class="sr-only">: {{ n.title }}</span>
                  </button>
                }
              </div>
              @if (row.target) {
                <sd-icon
                  name="chevron-right"
                  [size]="20"
                  class="mt-2.5 shrink-0 text-slate transition-colors group-hover:text-cerulean"
                  aria-hidden="true"
                />
              }
            </li>
          }
        </ul>

        @if (error() || hasMore()) {
          <div class="${LOAD_MORE}">
            @if (error()) {
              <p class="${INLINE_ERROR}" role="alert">
                <sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{
                  error()
                }}
              </p>
            }
            @if (hasMore()) {
              <button
                type="button"
                class="${BTN_SECONDARY}"
                [disabled]="loading()"
                (click)="loadMore()"
              >
                <sd-icon name="chevron-down" [size]="16" />{{
                  loading() ? 'Loading…' : 'Load more'
                }}
              </button>
            }
          </div>
        }
      }

      <p class="sr-only" role="status" aria-live="polite">
        {{ announcement() }}
      </p>
    </div>
  `,
})
export class AdminNotifications {
  private readonly api = inject(StaffNotificationsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly unread = inject(UnreadNotifications);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly ngZone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  /** Times are shown on this browser's clock. */
  private readonly zone = viewerTimeZone();
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly items = signal<StaffNotificationDto[]>([]);
  protected readonly rows = computed<Row[]>(() =>
    this.items().map((n) => {
      const target = notificationTarget(n, (p) => this.auth.hasPermission(p));
      return { n, target, tone: rowTone(n.read, !!target) };
    }),
  );
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly hasMore = signal(false);
  protected readonly markingAll = signal(false);
  protected readonly markAllError = signal('');
  /** The one notification whose read the API just refused, and why (shown on its card). */
  protected readonly readError = signal<{ id: string; message: string } | null>(
    null,
  );
  protected readonly announcement = signal('');
  /** The server's unread count (the bell's), which also covers pages not loaded yet. */
  protected readonly unreadCount = this.unread.count;
  protected readonly anyUnread = computed(
    () => this.unreadCount() > 0 || this.items().some((n) => !n.read),
  );

  private page = 1;
  private loadSub?: Subscription;

  constructor() {
    this.fetch(1);
    // The badge may be stale (another tab, or a while since the last poll).
    this.unread.refresh();
  }

  protected reload(): void {
    this.fetch(1);
  }

  protected loadMore(): void {
    if (!this.loading()) this.fetch(this.page + 1);
  }

  private fetch(page: number): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.loadSub = this.api
      .list({ page, per_page: NOTIFICATIONS_PER_PAGE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.page = page;
          const fresh = res.data ?? [];
          // Something new arriving between pages shifts them: never list one twice.
          this.items.update((list) =>
            page === 1
              ? fresh
              : [
                  ...list,
                  ...fresh.filter((n) => !list.some((x) => x.id === n.id)),
                ],
          );
          this.hasMore.set(
            (res.meta?.page ?? page) < (res.meta?.total_pages ?? 0),
          );
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, COPY.loadError));
          this.loading.set(false);
        },
      });
  }

  /** Following a notification's link: it is read now (the link itself navigates). */
  protected follow(
    n: StaffNotificationDto,
    t: NotificationTarget,
    e: MouseEvent,
  ): void {
    this.markRead(n, false);
    const sameTab =
      e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
    if (t.fragment && sameTab) {
      revealOnArrival(this.router, this.doc, t.fragment, (fn) =>
        this.ngZone.runOutsideAngular(fn),
      );
    }
  }

  /**
   * Mark one read: at once on screen, announced once the API agrees, and put
   * back with a message on its card if the API refuses.
   */
  protected markRead(n: StaffNotificationDto, announce = true): void {
    if (n.read) return;
    this.setRead(n.id, true);
    this.unread.markedRead();
    this.readError.set(null);
    // Not tied to this page: following a link leaves it at once, and the read must still land.
    this.api.markRead(n.id).subscribe({
      next: () => {
        if (announce) this.announce(COPY.markedRead);
      },
      error: (err: unknown) => {
        this.setRead(n.id, false);
        this.unread.refresh();
        // Never leave a success the screen reader heard standing; the alert says what happened.
        this.announcement.set('');
        this.readError.set({
          id: n.id,
          message: apiErrorMessage(err, COPY.markReadError),
        });
      },
    });
    if (announce) {
      // The button is gone: keep the user's place on the notification itself.
      afterNextRender(
        () => this.doc.getElementById('bo-note-' + n.id)?.focus(),
        { injector: this.injector },
      );
    }
  }

  /** Say `text` in the status region, even when it repeats the last announcement. */
  private announce(text: string): void {
    this.announcement.set(this.announcement() === text ? text + REPEAT : text);
  }

  protected markAllRead(): void {
    if (this.markingAll()) return;
    this.markingAll.set(true);
    this.markAllError.set('');
    this.api
      .markAllRead()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.items.update((list) =>
            list.map((x) => (x.read ? x : { ...x, read: true })),
          );
          this.unread.markedAllRead();
          this.markingAll.set(false);
          this.readError.set(null);
          this.announce('All notifications marked as read.');
          // The button is gone: focus the page heading rather than the void.
          afterNextRender(() => this.heading().nativeElement.focus(), {
            injector: this.injector,
          });
        },
        error: (err: unknown) => {
          this.markingAll.set(false);
          this.markAllError.set(apiErrorMessage(err, COPY.markAllError));
        },
      });
  }

  protected icon(type: string): string {
    return notificationIcon(type);
  }

  /** "Wed 4 Nov 2026, 9:00 AM WAT" on this browser's clock. */
  protected when(iso: string): string {
    const text = formatInZone(iso, this.zone, 'dateTime');
    return text && `${text} ${zoneAbbr(this.zone, iso)}`;
  }

  private setRead(id: string, read: boolean): void {
    this.items.update((list) =>
      list.map((x) => (x.id === id ? { ...x, read } : x)),
    );
  }
}
