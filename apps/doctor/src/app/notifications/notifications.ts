import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { StaffNotificationsApi } from '@supadoc/data-access';
import type { StaffNotificationDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

const ICON: Record<string, string> = {
  appointment: 'calendar-days',
  review: 'star',
  payout: 'banknote',
  message: 'message-square',
};

/** Doctor notifications (route `/notifications`). */
@Component({
  selector: 'doc-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Notifications</h1>
          <p class="font-sans text-body text-slate">Bookings, reviews and payout updates.</p>
        </div>
        <button type="button" class="font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean" (click)="markAllRead()">Mark all read</button>
      </header>

      <ul class="flex flex-col gap-2">
        @for (n of items(); track n.id) {
          <li>
            <button
              type="button"
              class="flex w-full items-start gap-3 rounded-card border p-4 text-left transition-colors"
              [class]="n.read ? 'border-cloud bg-white hover:bg-glacier' : 'border-cerulean/30 bg-frost/20 hover:bg-frost/30'"
              (click)="open(n)"
            >
              <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-cerulean/10 text-cerulean">
                <sd-icon [name]="icon(n.type)" [size]="18" />
              </span>
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="font-sans text-body-sm font-semibold text-ink">{{ n.title }}</span>
                @if (n.body) { <span class="font-sans text-body-sm text-slate">{{ n.body }}</span> }
                <span class="font-sans text-caption text-slate">{{ when(n.created_at) }}</span>
              </span>
              @if (!n.read) { <span class="mt-1.5 size-2 shrink-0 rounded-full bg-cerulean"></span> }
            </button>
          </li>
        } @empty {
          <li class="rounded-card border border-cloud bg-white px-5 py-16 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : "You're all caught up." }}</li>
        }
      </ul>

      @if (hasMore()) {
        <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Load more' }}</button>
      }
    </div>
  `,
})
export class DoctorNotifications implements OnInit {
  private readonly api = inject(StaffNotificationsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = signal<StaffNotificationDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.api
      .list({ page: this.page, per_page: 20 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected open(n: StaffNotificationDto): void {
    if (!n.read) {
      this.api.markRead(n.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => undefined, error: () => undefined });
      this.items.update((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    if (n.link) void this.router.navigateByUrl(n.link);
  }

  protected markAllRead(): void {
    this.api.markAllRead().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => undefined, error: () => undefined });
    this.items.update((list) => list.map((x) => ({ ...x, read: true })));
  }

  protected icon(type: string): string {
    return ICON[type] ?? 'bell';
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
