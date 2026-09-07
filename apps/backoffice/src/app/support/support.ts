import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminSupportApi, apiErrorMessage } from '@supadoc/data-access';
import type {
  SupportMessageDto,
  SupportStatus,
  SupportTicketDto,
} from '@supadoc/models';
import type { ThreadMessage } from '@supadoc/ui';
import { IconComponent, MessageThreadComponent } from '@supadoc/ui';

const STATUS_CLASS: Record<string, string> = {
  open: 'bg-warning/15 text-warning',
  pending: 'bg-frost text-cerulean',
  resolved: 'bg-sage/15 text-sage',
  closed: 'bg-cloud text-slate',
};
const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  pending: 'Awaiting patient',
  resolved: 'Resolved',
  closed: 'Closed',
};

type Filter = 'all' | SupportStatus;

/** Back-office support desk (route `/support`) — queue + threaded replies. */
@Component({
  selector: 'bo-support',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, MessageThreadComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Support</h1>
          <p class="font-sans text-body text-slate">Patient tickets and conversations.</p>
        </div>
        @if (view() === 'thread') {
          <button type="button" class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean" (click)="showList()">
            <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Queue
          </button>
        }
      </div>

      @if (error()) {
        <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert">{{ error() }}</p>
      }

      @if (view() === 'list') {
        <div class="flex flex-wrap gap-2">
          @for (f of filters; track f.key) {
            <button type="button" class="rounded-field px-3 py-1.5 font-sans text-body-sm font-semibold transition-colors" [class]="filter() === f.key ? 'bg-cerulean text-white' : 'border border-cloud bg-white text-slate hover:text-ink'" (click)="setFilter(f.key)">{{ f.label }}</button>
          }
        </div>

        @if (loading()) {
          @for (i of [1,2,3,4]; track i) { <div class="sd-shimmer h-20 rounded-card"></div> }
        } @else {
          <ul class="flex flex-col gap-3">
            @for (t of tickets(); track t.id) {
              <li>
                <button type="button" class="flex w-full items-start gap-3 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/50" (click)="openTicket(t)">
                  <span class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="flex items-center gap-2">
                      <span class="truncate font-sans text-body font-semibold text-ink">{{ t.subject }}</span>
                      <span class="shrink-0 rounded-pill px-2 py-0.5 font-sans text-[10px] font-semibold" [class]="statusClass(t.status)">{{ statusLabel(t.status) }}</span>
                    </span>
                    <span class="font-sans text-caption text-slate">{{ t.patient_name }} • {{ t.category }}</span>
                    <span class="truncate font-sans text-caption text-slate">{{ t.last_message_role === 'staff' ? 'You: ' : t.patient_name + ': ' }}{{ t.last_message_preview }}</span>
                  </span>
                  <span class="flex shrink-0 flex-col items-end gap-1">
                    <span class="font-sans text-caption text-slate">{{ when(t.last_message_at) }}</span>
                    <sd-icon name="chevron-right" [size]="18" class="text-slate" />
                  </span>
                </button>
              </li>
            } @empty {
              <li class="rounded-card border border-cloud bg-white px-5 py-16 text-center font-sans text-body-sm text-slate">No tickets{{ filter() === 'all' ? '' : ' in this state' }}.</li>
            }
          </ul>
          @if (hasMore()) {
            <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">Load more</button>
          }
        }
      } @else {
        @if (current(); as t) {
          <div class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="font-heading text-body-lg text-ink">{{ t.subject }}</h2>
              <span class="shrink-0 rounded-pill px-2 py-0.5 font-sans text-[10px] font-semibold" [class]="statusClass(t.status)">{{ statusLabel(t.status) }}</span>
            </div>
            <p class="font-sans text-caption text-slate">{{ t.patient_name }} &lt;{{ t.patient_email }}&gt; • {{ t.category }} • opened {{ when(t.created_at) }}</p>
            <div class="flex flex-wrap gap-2">
              @if (t.status !== 'resolved') {
                <button type="button" class="rounded-field border border-sage px-3 py-1.5 font-sans text-caption font-semibold text-sage transition-colors hover:bg-sage/10 disabled:opacity-60" [disabled]="updating()" (click)="setStatus('resolved')">Mark resolved</button>
              }
              @if (t.status !== 'closed') {
                <button type="button" class="rounded-field border border-cloud px-3 py-1.5 font-sans text-caption font-semibold text-slate transition-colors hover:border-slate disabled:opacity-60" [disabled]="updating()" (click)="setStatus('closed')">Close</button>
              } @else {
                <button type="button" class="rounded-field border border-cerulean px-3 py-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:bg-frost/40 disabled:opacity-60" [disabled]="updating()" (click)="setStatus('open')">Reopen</button>
              }
            </div>
          </div>
          <div class="h-[54vh] rounded-card border border-cloud bg-white p-4">
            <sd-message-thread
              viewerRole="doctor"
              [messages]="threadMessages()"
              [loading]="threadLoading()"
              [sending]="sending()"
              [readOnly]="t.status === 'closed'"
              placeholder="Reply to the patient…"
              emptyText="No messages yet."
              (send)="reply($event)"
            />
          </div>
          @if (t.status === 'closed') {
            <p class="text-center font-sans text-caption text-slate">This ticket is closed. Reopen it to reply.</p>
          }
        }
      }
    </div>
  `,
})
export class AdminSupport implements OnInit {
  private readonly api = inject(AdminSupportApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'pending', label: 'Awaiting patient' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'closed', label: 'Closed' },
  ];

  protected readonly view = signal<'list' | 'thread'>('list');
  protected readonly filter = signal<Filter>('all');
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly sending = signal(false);
  protected readonly updating = signal(false);
  protected readonly hasMore = signal(false);
  private page = 1;

  protected readonly tickets = signal<SupportTicketDto[]>([]);
  protected readonly current = signal<SupportTicketDto | null>(null);
  protected readonly threadLoading = signal(false);
  private readonly messages = signal<SupportMessageDto[]>([]);

  protected readonly threadMessages = computed<ThreadMessage[]>(() =>
    this.messages().map((m) => ({
      id: m.id,
      sender_role: m.author_role === 'staff' ? 'doctor' : 'patient',
      sender_name: m.author_name,
      body: m.body,
      created_at: m.created_at,
    })),
  );

  ngOnInit(): void {
    this.loadList();
  }

  protected setFilter(f: Filter): void {
    if (f === this.filter()) return;
    this.filter.set(f);
    this.page = 1;
    this.loadList();
  }

  protected loadMore(): void {
    this.page += 1;
    this.loadList(true);
  }

  private loadList(append = false): void {
    this.loading.set(true);
    const status = this.filter() === 'all' ? undefined : (this.filter() as SupportStatus);
    this.api
      .list({ page: this.page, per_page: 20, status })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.tickets.update((list) => (append ? [...list, ...res.data] : res.data));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load the support queue.');
          this.loading.set(false);
        },
      });
  }

  protected showList(): void {
    this.view.set('list');
    this.error.set('');
    this.loadList();
  }

  protected openTicket(t: SupportTicketDto): void {
    this.current.set(t);
    this.messages.set([]);
    this.view.set('thread');
    this.threadLoading.set(true);
    this.error.set('');
    this.api
      .get(t.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.current.set(res.data.ticket);
          this.messages.set(res.data.messages);
          this.threadLoading.set(false);
        },
        error: () => {
          this.error.set('Could not open that ticket.');
          this.threadLoading.set(false);
        },
      });
  }

  protected reply(body: string): void {
    const t = this.current();
    if (!t) return;
    this.sending.set(true);
    this.api
      .reply(t.id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.messages.update((list) => [...list, res.data]);
          this.current.update((c) => (c ? { ...c, status: 'pending' } : c));
          this.sending.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err, 'Could not send your reply.'));
          this.sending.set(false);
        },
      });
  }

  protected setStatus(status: SupportStatus): void {
    const t = this.current();
    if (!t) return;
    this.updating.set(true);
    this.api
      .setStatus(t.id, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.current.set(res.data);
          this.updating.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err, 'Could not update the ticket.'));
          this.updating.set(false);
        },
      });
  }

  protected statusClass(s: string): string {
    return STATUS_CLASS[s] ?? 'bg-cloud text-slate';
  }
  protected statusLabel(s: string): string {
    return STATUS_LABEL[s] ?? s;
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
