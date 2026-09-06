import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MonitoringApi } from '@supadoc/data-access';
import type { AuditEventDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Audit trail (route `/audit`) — every recorded staff/patient action. */
@Component({
  selector: 'bo-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Audit log</h1>
        <p class="font-sans text-body text-slate">A record of actions across the platform.</p>
      </header>

      <div class="flex items-center gap-2">
        <div class="relative flex-1 sm:max-w-xs">
          <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
          <input
            class="w-full rounded-field border border-cloud bg-white py-2 pl-9 pr-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none"
            placeholder="Filter by action (e.g. wallet.topup)"
            [value]="actionFilter()"
            (input)="actionFilter.set($any($event.target).value)"
            (keydown.enter)="apply()"
          />
        </div>
        <button type="button" class="rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean" (click)="apply()">Filter</button>
      </div>

      <div class="overflow-x-auto rounded-card border border-cloud bg-white">
        <table class="w-full min-w-[640px] text-left">
          <thead class="border-b border-cloud font-sans text-caption text-slate">
            <tr>
              <th class="px-4 py-3">Action</th>
              <th class="px-4 py-3">Actor</th>
              <th class="px-4 py-3">Role</th>
              <th class="px-4 py-3">Resource</th>
              <th class="px-4 py-3">When</th>
            </tr>
          </thead>
          <tbody>
            @for (a of events(); track a.id) {
              <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                <td class="px-4 py-3 font-mono text-caption">{{ a.action }}</td>
                <td class="px-4 py-3">{{ a.actor_name }}</td>
                <td class="px-4 py-3 text-slate capitalize">{{ a.actor_role }}</td>
                <td class="px-4 py-3 text-slate">{{ a.resource_type || '—' }}</td>
                <td class="px-4 py-3 text-slate">{{ when(a.created_at) }}</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No audit events.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>

      @if (hasMore()) {
        <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">
          {{ loading() ? 'Loading…' : 'Load more' }}
        </button>
      }
    </div>
  `,
})
export class AdminAudit implements OnInit {
  private readonly api = inject(MonitoringApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly events = signal<AuditEventDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly actionFilter = signal('');
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected apply(): void {
    this.page = 1;
    this.events.set([]);
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    const action = this.actionFilter().trim() || undefined;
    this.api
      .audit({ page: this.page, per_page: 40, action })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.events.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
}
