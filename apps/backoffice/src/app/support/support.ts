import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { distinctUntilChanged, map, tap } from 'rxjs';
import { AdminSupportApi, apiErrorMessage } from '@supadoc/data-access';
import type {
  SupportMessageDto,
  SupportStatus,
  SupportTicketDto,
} from '@supadoc/models';
import type { ThreadMessage } from '@supadoc/ui';
import { AlertComponent, DialogService, EmptyStateComponent, IconComponent, MessageThreadComponent } from '@supadoc/ui';
import { afterDialogCloses, focusIfLost } from '../shared/after-dialog';
import {
  BACK_LINK,
  BTN_GHOST,
  BTN_SECONDARY,
  BTN_SUCCESS_OUTLINE,
  CARD_LIST,
  EMPTY_FRAME,
  FOCUS_RING,
  INLINE_ERROR,
  LOAD_MORE,
  PAGE,
  PAGE_HEADER,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PILL,
  SECTION,
  SECTION_TITLE,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED_WRAP,
  SEGMENT_FILL,
} from '../shared/layout';

const STATUS_CLASS: Record<string, string> = {
  open: 'bg-warning/15 text-warning-ink',
  pending: 'bg-frost text-cerulean-dark',
  resolved: 'bg-sage/15 text-sage-ink',
  closed: 'bg-cloud text-slate',
};
/** Every status reads as icon + words. */
const STATUS_ICON: Record<string, string> = {
  open: 'mail',
  pending: 'hourglass',
  resolved: 'circle-check',
  closed: 'lock',
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
  imports: [IconComponent, AlertComponent, EmptyStateComponent, MessageThreadComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER}">
        <div class="${PAGE_HEADER_TEXT}">
          <h1 class="${PAGE_TITLE}">Support</h1>
          <p class="${PAGE_SUBTITLE}">Patient tickets and conversations.</p>
        </div>
        @if (view() === 'thread') {
          <button type="button" class="${BACK_LINK}" (click)="showList()">
            <sd-icon name="chevron-right" [size]="18" class="rotate-180" />Queue
          </button>
        }
      </header>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      @if (view() === 'list') {
        <div class="${SEGMENTED_WRAP}" role="group" aria-label="Ticket status">
          @for (f of filters; track f.key) {
            <button type="button" class="${SEGMENT} ${SEGMENT_FILL}" [class]="filter() === f.key ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'" [attr.aria-pressed]="filter() === f.key" (click)="setFilter(f.key)">{{ f.label }}</button>
          }
        </div>

        @if (loading()) {
          <div class="${CARD_LIST}" aria-busy="true">
            <span class="sr-only">Loading tickets…</span>
            @for (i of [1, 2, 3, 4]; track i) { <div class="sd-shimmer h-24 rounded-card" aria-hidden="true"></div> }
          </div>
        } @else {
          <ul class="${CARD_LIST}">
            @for (t of tickets(); track t.id) {
              <li>
                <button type="button" class="group flex w-full items-start gap-4 rounded-card border border-haze bg-white p-5 text-left shadow-card transition hover:border-cerulean/40 hover:shadow-card-hover ${FOCUS_RING}" (click)="openTicket(t)">
                  <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="min-w-0 truncate font-heading text-body-lg text-ink transition-colors group-hover:text-cerulean">{{ t.subject }}</span>
                      <span class="${PILL} shrink-0" [class]="statusClass(t.status)"><sd-icon [name]="statusIcon(t.status)" [size]="13" />{{ statusLabel(t.status) }}</span>
                    </span>
                    <span class="font-sans text-body-sm text-slate">{{ t.patient_name }} • {{ t.category }}</span>
                    <span class="truncate font-sans text-caption text-slate">{{ t.last_message_role === 'staff' ? 'You: ' : t.patient_name + ': ' }}{{ t.last_message_preview }}</span>
                  </span>
                  <span class="flex shrink-0 flex-col items-end gap-1">
                    <span class="font-sans text-caption text-slate">{{ when(t.last_message_at) }}</span>
                    <sd-icon name="chevron-right" [size]="22" class="text-slate transition-colors group-hover:text-cerulean" />
                  </span>
                </button>
              </li>
            } @empty {
              <li>
                @if (listError()) {
                  <div class="${EMPTY_FRAME}" role="alert">
                    <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load tickets" [message]="listError()">
                      <button type="button" class="${BTN_SECONDARY}" (click)="loadList()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
                    </sd-empty-state>
                  </div>
                } @else {
                  <sd-empty-state icon="headphones" tone="brand" [title]="filter() === 'all' ? 'No tickets yet' : 'No tickets in this state'" message="Tickets patients open from their portal show up here." />
                }
              </li>
            }
          </ul>
          @if ((listError() && tickets().length > 0) || hasMore()) {
            <div class="${LOAD_MORE}">
              @if (listError() && tickets().length > 0) {
                <p class="${INLINE_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ listError() }}</p>
              }
              @if (hasMore()) {
                <button type="button" class="${BTN_SECONDARY}" [disabled]="loading()" (click)="loadMore()"><sd-icon name="chevron-down" [size]="16" />Load more</button>
              }
            </div>
          }
        }
      } @else {
        @if (current(); as t) {
          <section class="${SECTION} !gap-4" aria-labelledby="bo-support-subject">
            <div class="flex flex-wrap items-center gap-2">
              <h2 id="bo-support-subject" class="${SECTION_TITLE}"><sd-icon name="headphones" [size]="20" class="text-cerulean" />{{ t.subject }}</h2>
              <span class="${PILL} shrink-0" [class]="statusClass(t.status)"><sd-icon [name]="statusIcon(t.status)" [size]="13" />{{ statusLabel(t.status) }}</span>
            </div>
            <p class="font-sans text-body-sm text-slate">{{ t.patient_name }} &lt;{{ t.patient_email }}&gt; • {{ t.category }} • opened {{ when(t.created_at) }}</p>
            <div class="flex flex-wrap gap-3">
              @if (t.status !== 'resolved') {
                <button type="button" class="${BTN_SUCCESS_OUTLINE}" [disabled]="updating()" (click)="setStatus('resolved')"><sd-icon name="circle-check" [size]="16" />Mark resolved</button>
              }
              @if (t.status !== 'closed') {
                <button type="button" class="${BTN_GHOST} border border-haze bg-white shadow-control active:shadow-none disabled:shadow-none" [disabled]="updating()" (click)="askClose(t)" #closeBtn><sd-icon name="lock" [size]="16" />Close</button>
              } @else {
                <button type="button" class="${BTN_SECONDARY}" [disabled]="updating()" (click)="setStatus('open')" #reopenBtn><sd-icon name="refresh-cw" [size]="16" />Reopen</button>
              }
            </div>
          </section>
          <div class="h-[54vh] rounded-card border border-haze bg-white p-4 shadow-card">
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
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  /** The status buttons swap places (Close ↔ Reopen; Mark resolved goes): focus follows. */
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');
  private readonly reopenBtn = viewChild<ElementRef<HTMLButtonElement>>('reopenBtn');

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
  /** Queue-load failure, shown in place of the list's empty state. */
  protected readonly listError = signal('');
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
    // The filter lives in the address (?status=open — the dashboard links
    // there): reload, back/forward and the nav's plain /support all agree
    // with what the list shows.
    this.route.queryParamMap
      .pipe(
        map((q) => this.filters.find((f) => f.key === q.get('status'))?.key ?? 'all'),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((f) => {
        this.filter.set(f);
        this.page = 1;
        this.loadList();
      });
  }

  protected setFilter(f: Filter): void {
    if (f === this.filter()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { status: f === 'all' ? null : f },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected loadMore(): void {
    this.page += 1;
    this.loadList(true);
  }

  protected loadList(append = false): void {
    this.loading.set(true);
    this.listError.set('');
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
        error: (err: unknown) => {
          if (append && this.page > 1) this.page -= 1;
          // A failed first page must not read as "No tickets".
          if (!append) this.tickets.set([]);
          this.listError.set(apiErrorMessage(err, 'Could not load the support queue.'));
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
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not open that ticket.'));
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
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not send your reply.'));
          this.sending.set(false);
        },
      });
  }

  /** Closing stops the patient replying: ask first. */
  protected async askClose(t: SupportTicketDto): Promise<void> {
    this.error.set('');
    await this.dialogs.confirm({
      tone: 'warning',
      icon: 'message-square-x',
      title: 'Close this ticket?',
      message: `${t.patient_name || 'The patient'} can't reply to it any more and would need to open a new ticket. You can reopen it later.`,
      details: [{ label: 'Subject', value: t.subject }],
      confirmLabel: 'Close ticket',
      cancelLabel: 'Keep it open',
      busyLabel: 'Closing…',
      errorMessage: (err) => apiErrorMessage(err, 'Could not close the ticket.'),
      action: () =>
        this.api.setStatus(t.id, 'closed').pipe(
          tap((res) => {
            if (this.current()?.id !== res.data.id) return;
            this.current.set(res.data);
            // Close was replaced by Reopen: put focus there once the prompt has gone.
            afterDialogCloses(() => focusIfLost(this.reopenBtn()?.nativeElement, this.doc), this.doc);
          }),
        ),
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
          // Reopen and Mark resolved remove themselves: Close is where they were.
          afterDialogCloses(() => focusIfLost(this.closeBtn()?.nativeElement, this.doc), this.doc);
        },
        error: (err: unknown) => {
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
  protected statusIcon(s: string): string {
    return STATUS_ICON[s] ?? 'info';
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
