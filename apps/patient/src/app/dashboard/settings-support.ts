import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { apiErrorMessage, SupportApi } from '@supadoc/data-access';
import type {
  SupportCategory,
  SupportMessageDto,
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
  pending: 'Awaiting you',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Settings › Help › Support tickets — open a ticket and chat with support. */
@Component({
  selector: 'pat-settings-support',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, IconComponent, MessageThreadComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Support</h1>
          <p class="font-sans text-body text-slate">Get help from our care team.</p>
        </div>
        @if (view() === 'list') {
          <a routerLink="/dashboard/settings/help" class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
            <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Back
          </a>
        } @else {
          <button type="button" class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean" (click)="showList()">
            <sd-icon name="chevron-right" [size]="18" class="rotate-180" />All tickets
          </button>
        }
      </div>

      @if (error()) {
        <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert">{{ error() }}</p>
      }

      @switch (view()) {
        @case ('list') {
          <button type="button" class="flex w-fit items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="showNew()">
            <sd-icon name="plus" [size]="18" />New ticket
          </button>
          @if (loading()) {
            @for (i of [1,2,3]; track i) { <div class="h-20 animate-pulse rounded-card bg-cloud/70"></div> }
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
                      <span class="truncate font-sans text-caption text-slate">{{ t.last_message_role === 'staff' ? 'Support: ' : 'You: ' }}{{ t.last_message_preview }}</span>
                      <span class="font-sans text-caption text-slate">{{ when(t.last_message_at) }}</span>
                    </span>
                    <sd-icon name="chevron-right" [size]="18" class="mt-1 shrink-0 text-slate" />
                  </button>
                </li>
              } @empty {
                <li class="rounded-card border border-cloud bg-white px-5 py-16 text-center font-sans text-body-sm text-slate">No tickets yet. Open one and we'll help you out.</li>
              }
            </ul>
          }
        }

        @case ('new') {
          <div class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
            <h2 class="font-heading text-body-lg text-ink">New support ticket</h2>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Subject</span>
              <input [(ngModel)]="subject" placeholder="Briefly, what's it about?" class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Category</span>
              <select [(ngModel)]="category" class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none">
                <option value="general">General</option>
                <option value="billing">Billing &amp; payments</option>
                <option value="technical">Technical issue</option>
                <option value="appointment">Appointments</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">How can we help?</span>
              <textarea rows="5" [(ngModel)]="message" placeholder="Describe your issue…" class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"></textarea>
            </label>
            <div class="flex gap-3">
              <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="sending()" (click)="submit()">{{ sending() ? 'Sending…' : 'Submit ticket' }}</button>
              <button type="button" class="font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink" (click)="showList()">Cancel</button>
            </div>
          </div>
        }

        @case ('thread') {
          @if (current(); as t) {
            <div class="flex flex-col gap-1 rounded-card border border-cloud bg-white p-5">
              <div class="flex items-center gap-2">
                <h2 class="font-heading text-body-lg text-ink">{{ t.subject }}</h2>
                <span class="shrink-0 rounded-pill px-2 py-0.5 font-sans text-[10px] font-semibold" [class]="statusClass(t.status)">{{ statusLabel(t.status) }}</span>
              </div>
              <p class="font-sans text-caption text-slate">Opened {{ when(t.created_at) }}</p>
            </div>
            <div class="h-[56vh] rounded-card border border-cloud bg-white p-4">
              <sd-message-thread
                viewerRole="patient"
                [messages]="threadMessages()"
                [loading]="threadLoading()"
                [sending]="sending()"
                [readOnly]="t.status === 'closed'"
                placeholder="Reply to support…"
                emptyText="No messages yet."
                (send)="reply($event)"
              />
            </div>
            @if (t.status === 'closed') {
              <p class="text-center font-sans text-caption text-slate">This ticket is closed. Open a new one if you still need help.</p>
            }
          }
        }
      }
    </div>
  `,
})
export class SettingsSupport implements OnInit {
  private readonly api = inject(SupportApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly view = signal<'list' | 'new' | 'thread'>('list');
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly sending = signal(false);

  protected readonly tickets = signal<SupportTicketDto[]>([]);
  protected readonly current = signal<SupportTicketDto | null>(null);
  protected readonly threadLoading = signal(false);
  private readonly messages = signal<SupportMessageDto[]>([]);

  protected subject = '';
  protected category: SupportCategory = 'general';
  protected message = '';

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

  private loadList(): void {
    this.loading.set(true);
    this.api
      .list({ per_page: 50 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.tickets.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load your tickets.');
          this.loading.set(false);
        },
      });
  }

  protected showList(): void {
    this.view.set('list');
    this.error.set('');
    this.loadList();
  }

  protected showNew(): void {
    this.subject = '';
    this.category = 'general';
    this.message = '';
    this.error.set('');
    this.view.set('new');
  }

  protected submit(): void {
    if (this.subject.trim() === '' || this.message.trim() === '') {
      this.error.set('Please add a subject and a message.');
      return;
    }
    this.sending.set(true);
    this.error.set('');
    this.api
      .create({ subject: this.subject.trim(), category: this.category, message: this.message.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.sending.set(false);
          this.openTicket(res.data);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err, 'Could not create the ticket.'));
          this.sending.set(false);
        },
      });
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
          this.current.update((c) => (c ? { ...c, status: 'open' } : c));
          this.sending.set(false);
        },
        error: (err) => {
          this.error.set(apiErrorMessage(err, 'Could not send your reply.'));
          this.sending.set(false);
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
