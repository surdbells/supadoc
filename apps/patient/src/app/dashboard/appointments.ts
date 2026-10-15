import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import {
  apiErrorMessage,
  AppointmentsApi,
  injectCallPresence,
} from '@supadoc/data-access';
import type { ApiAppointmentStatus, AppointmentDto } from '@supadoc/models';
import {
  ButtonComponent,
  CallPresenceComponent,
  EmptyStateComponent,
  IconComponent,
} from '@supadoc/ui';
import { detailsLink, StatusBadge, statusBadge } from './appointment-status';
import { isOpenProposal, priceLabel, whenLabel } from './follow-up';

type Status = ApiAppointmentStatus;
/** Appointments lists what is still to come (or live) only — what is over lives in History. */
type Tab = 'all' | 'confirmed' | 'pending' | 'rescheduled';

interface Appointment {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeIcon: string;
  readonly typeLabel: string;
  readonly status: Status;
  readonly tab: Exclude<Tab, 'all'> | null;
  /** The server's label ("Confirmed", "In progress"…), its colours and the line under it. */
  readonly badge: StatusBadge;
  /** Started (or someone is in the call): the row says so. */
  readonly live: boolean;
  /** Its details page (History once it is over — e.g. it ended while this list was open). */
  readonly link: string[];
}

/** A follow-up the doctor proposed that is waiting for the patient's answer. */
interface ProposalCard {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  /** "Tue 21 Oct, 3:00 PM", local time. */
  readonly when: string;
  readonly price: string;
  readonly free: boolean;
  /** "Respond by Mon 20 Oct, 1:00 PM". */
  readonly respondBy: string;
}

/** The "Action needed" cards' pill (a doctor's follow-up proposal: not booked until accepted). */
const PROPOSED_BADGE = { label: 'Proposed', class: 'bg-teal/10 text-teal' };

/**
 * Every status an upcoming row can have, and its tab. Closed ones (completed,
 * cancelled, missed) are History's and never come back with `when=upcoming`;
 * an unanswered proposal is an "Action needed" card, not a row.
 */
const TAB_OF: Record<Status, Exclude<Tab, 'all'> | null> = {
  proposed: null,
  confirmed: 'confirmed',
  pending: 'pending',
  rescheduled: 'rescheduled',
  completed: null,
  cancelled: null,
  missed: null,
};

const EMPTY_TAB: Record<Tab, string> = {
  all: 'Nothing else is booked yet.',
  confirmed: 'No confirmed consultations coming up.',
  pending: 'No bookings waiting for your doctor to confirm.',
  rescheduled: 'No rescheduled consultations waiting for your doctor.',
};

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

/** Maps a backend appointment onto the row shape this screen renders. */
export function toAppointmentRow(a: AppointmentDto): Appointment {
  const when = new Date(a.scheduled_at);
  const badge = statusBadge(a);
  return {
    id: a.id,
    name: a.specialist.name,
    specialty: a.specialist.specialty ?? '',
    date: new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(when),
    time: new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(when),
    typeIcon: TYPE_ICON[a.type] ?? 'calendar-check',
    typeLabel: a.type_label,
    status: a.status,
    tab: TAB_OF[a.status],
    badge,
    live: badge.key === 'live',
    link: detailsLink(a),
  };
}

function toProposalCard(a: AppointmentDto): ProposalCard {
  return {
    id: a.id,
    name: a.specialist.name,
    specialty: a.specialist.specialty ?? '',
    when: whenLabel(a.scheduled_at),
    price: priceLabel(a.amount),
    free: !(Number(a.amount) > 0),
    respondBy: `Respond by ${whenLabel(a.expires_at)}`,
  };
}

/**
 * My Appointments (Figma 497:7793) with inline loading, empty (826:12182) and
 * error (826:12960) states. Data comes from `GET /api/portal/appointments?when=upcoming`
 * — what is still to come or live, soonest first; anything over (completed,
 * cancelled, missed, or ended) is in History, whatever its status.
 * `?view=empty|error` still forces a state for design QA. Row → details route.
 * Follow-ups the doctor proposed and the patient hasn't answered are pinned on
 * top as "Action needed" cards; each answer is given on the details page.
 */
@Component({
  selector: 'pat-appointments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ButtonComponent,
    CallPresenceComponent,
    EmptyStateComponent,
    IconComponent,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">My Appointments</h1>
          <p class="font-sans text-body text-slate">
            Your upcoming consultations.
            <a routerLink="/dashboard/history" class="font-semibold text-cerulean hover:underline">Past ones are in your history.</a>
          </p>
        </div>
        <sd-button size="sm" (click)="book()">
          <sd-icon name="plus" [size]="18" />
          Book Consultation
        </sd-button>
      </div>

      <!-- Follow-ups the doctor proposed, waiting for an answer — pinned above the list -->
      @if (proposals().length > 0) {
        <section class="flex flex-col gap-3" aria-labelledby="action-needed-title">
          <h2
            id="action-needed-title"
            class="flex items-center gap-2 font-sans text-body font-semibold text-ink"
          >
            <sd-icon name="bell" [size]="18" class="text-teal" />
            Action needed
            <span
              class="rounded-pill bg-teal/10 px-2 py-0.5 font-sans text-caption font-semibold text-teal"
              >{{ proposals().length }}</span
            >
          </h2>
          @for (p of proposals(); track p.id) {
            <article
              class="flex flex-col gap-4 rounded-card border border-teal/30 bg-white p-4 sm:p-5"
              [attr.aria-labelledby]="'proposal-' + p.id"
            >
              <div class="flex items-start gap-3 sm:gap-4">
                <span
                  class="flex size-12 shrink-0 items-center justify-center rounded-full bg-teal/10 font-heading text-body font-semibold text-teal"
                  aria-hidden="true"
                  >{{ initials(p.name) }}</span
                >
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p
                    [id]="'proposal-' + p.id"
                    class="font-sans text-body font-semibold text-ink"
                  >
                    {{ p.name }} proposed a follow-up
                  </p>
                  <p class="truncate font-sans text-caption text-slate">
                    {{ p.specialty }}
                  </p>
                </div>
                <span
                  class="shrink-0 rounded-lg px-2.5 py-0.5 font-sans text-caption font-medium"
                  [class]="proposedStatus.class"
                  >{{ proposedStatus.label }}</span
                >
              </div>
              <dl
                class="grid grid-cols-1 gap-2 font-sans text-body-sm text-ink sm:grid-cols-3"
              >
                <div class="flex items-center gap-2">
                  <dt class="flex shrink-0 text-slate">
                    <sd-icon name="calendar-clock" [size]="16" /><span class="sr-only">When</span>
                  </dt>
                  <dd>{{ p.when }}</dd>
                </div>
                <div class="flex items-center gap-2">
                  <dt class="flex shrink-0 text-slate">
                    <sd-icon name="credit-card" [size]="16" /><span class="sr-only">Price</span>
                  </dt>
                  <dd class="font-semibold">{{ p.price }}</dd>
                </div>
                <div class="flex items-center gap-2">
                  <dt class="flex shrink-0 text-warning">
                    <sd-icon name="hourglass" [size]="16" /><span class="sr-only">Deadline</span>
                  </dt>
                  <dd>{{ p.respondBy }}</dd>
                </div>
              </dl>
              <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <sd-button (click)="respond(p, 'accept')">
                  <sd-icon name="circle-check" [size]="18" />
                  {{ p.free ? 'Accept' : 'Accept & pay' }}
                </sd-button>
                <sd-button variant="outline" (click)="respond(p, 'time')">
                  <sd-icon name="calendar-days" [size]="18" />
                  Choose another time
                </sd-button>
                <button
                  type="button"
                  class="inline-flex min-h-11 items-center justify-center gap-2 rounded-field px-4 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40"
                  (click)="respond(p, 'decline')"
                >
                  <sd-icon name="circle-x" [size]="18" />
                  Decline
                </button>
              </div>
            </article>
          }
        </section>
      }

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
            [attr.aria-pressed]="activeTab() === t.key"
            (click)="activeTab.set(t.key)"
          >
            {{ t.label }}
            @if (countOf(t.key) > 0) {
              <span
                class="flex h-4 min-w-4 items-center justify-center rounded-full bg-cerulean px-1 text-[10px] font-semibold text-white"
                >{{ countOf(t.key) }}<span class="sr-only"> appointments</span></span
              >
            }
          </button>
        }
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-4">
            @for (n of [1, 2, 3]; track n) {
              <div
                class="flex items-center gap-4 rounded-card border border-cloud bg-white p-4"
              >
                <div class="sd-shimmer size-14 shrink-0 rounded-full"></div>
                <div class="flex flex-1 flex-col gap-2">
                  <div class="sd-shimmer h-3 w-40 rounded"></div>
                  <div class="sd-shimmer h-3 w-24 rounded"></div>
                </div>
              </div>
            }
          </div>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Unable to load appointments"
            [message]="loadError() || loadErrorFallback"
          >
            <sd-button variant="outline" (click)="reload()">Try Again</sd-button>
          </sd-empty-state>
        }
        @case ('empty') {
          <sd-empty-state
            icon="calendar-off"
            title="No upcoming appointments"
            message="Book a consultation with our healthcare professionals. Consultations that are over are in your history."
          >
            <div class="flex flex-col gap-3 sm:flex-row">
              <sd-button (click)="book()">
                <sd-icon name="calendar-days" [size]="18" />
                Book a Consultation
              </sd-button>
              <sd-button variant="outline" routerLink="/dashboard/history">
                <sd-icon name="history" [size]="18" />
                View history
              </sd-button>
            </div>
          </sd-empty-state>
        }
        @default {
          <div class="flex flex-col gap-4">
            @if (filtered().length === 0) {
              <p class="rounded-card border border-cloud bg-white p-6 text-center font-sans text-body-sm text-slate">
                {{ emptyTabText() }}
              </p>
            }
            @for (a of filtered(); track a.id) {
              <button
                type="button"
                class="sd-card-hover flex items-center gap-4 rounded-card border bg-white p-4 text-left hover:border-cerulean/50"
                [class]="a.live ? 'border-success/50' : 'border-cloud'"
                (click)="open(a)"
              >
                <span
                  class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-body-lg font-semibold text-cerulean"
                  >{{ initials(a.name) }}</span
                >
                <div class="flex min-w-0 flex-1 flex-col">
                  <p
                    class="truncate font-sans text-body font-semibold text-ink"
                  >
                    {{ a.name }}
                  </p>
                  <p class="truncate font-sans text-caption text-slate">
                    {{ a.specialty }}
                  </p>
                  <!-- Compact meta for narrow screens (date + status + who's in the call) -->
                  <div
                    class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 md:hidden"
                  >
                    <span
                      class="flex items-center gap-1 font-sans text-caption text-slate sm:hidden"
                    >
                      <sd-icon name="calendar-days" [size]="14" />{{ a.date }}, {{ a.time }}
                    </span>
                    <span
                      class="inline-flex items-center gap-1 rounded-lg px-2.5 py-0.5 font-sans text-[10px] font-medium"
                      [class]="a.badge.class"
                      ><sd-icon [name]="a.badge.icon" [size]="12" />{{ a.badge.label }}</span
                    >
                    <sd-call-presence
                      [presence]="presence()[a.id]"
                      viewer="patient"
                    />
                  </div>
                  @if (a.badge.detail) {
                    <p class="mt-1 font-sans text-caption text-slate md:hidden">{{ a.badge.detail }}</p>
                  }
                </div>
                <div
                  class="hidden flex-col gap-1 font-sans text-caption text-slate sm:flex"
                >
                  <span class="flex items-center gap-2">
                    <sd-icon name="calendar-days" [size]="16" />{{ a.date }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon name="clock" [size]="16" />{{ a.time }}
                  </span>
                </div>
                <div class="hidden flex-col items-start gap-2 md:flex">
                  <span
                    class="flex items-center gap-2 font-sans text-caption text-slate"
                  >
                    <sd-icon [name]="a.typeIcon" [size]="16" />{{ a.typeLabel }}
                  </span>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-lg px-4 py-1 font-sans text-caption font-medium"
                    [class]="a.badge.class"
                    ><sd-icon [name]="a.badge.icon" [size]="14" />{{ a.badge.label }}</span
                  >
                  @if (a.badge.detail) {
                    <span class="max-w-[12rem] font-sans text-caption text-slate">{{ a.badge.detail }}</span>
                  }
                  <sd-call-presence
                    [presence]="presence()[a.id]"
                    viewer="patient"
                  />
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
      }
    </div>
  `,
})
export class Appointments {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly appointments = inject(AppointmentsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Who is in each appointment's call right now — polled while the page is open. */
  protected readonly presence = injectCallPresence(() =>
    this.appointments.presence(),
  );

  protected readonly activeTab = signal<Tab>('all');
  protected readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'pending', label: 'Pending' },
    { key: 'rescheduled', label: 'Rescheduled' },
  ];

  private readonly all = signal<Appointment[]>([]);
  /** Open follow-up proposals — shown as "Action needed" cards, not list rows. */
  protected readonly proposals = signal<ProposalCard[]>([]);
  protected readonly proposedStatus = PROPOSED_BADGE;
  private readonly loading = signal(true);
  /** The API's reason the list failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');
  protected readonly loadErrorFallback =
    "We couldn't retrieve your appointments. Check your connection and try again.";

  private readonly view = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('view'))),
    { initialValue: null },
  );

  constructor() {
    this.load();
  }

  protected open(a: Appointment): void {
    void this.router.navigate(a.link);
  }

  /** Answer a proposal on its details page (payment, slots and the decline reason live there). */
  protected respond(p: ProposalCard, action: 'accept' | 'time' | 'decline'): void {
    void this.router.navigate(['/dashboard/appointments', p.id], {
      queryParams: { respond: action },
    });
  }

  protected initials(name: string): string {
    return (name ?? '')
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';
  }

  /** Booking starts at the specialist directory (same as the dashboard CTA). */
  protected book(): void {
    void this.router.navigate(['/dashboard/specialists']);
  }

  protected reload(): void {
    this.load();
  }

  /** Rows per tab (the tab pills' counts). */
  private readonly counts = computed(() => {
    const counts: Record<Tab, number> = { all: 0, confirmed: 0, pending: 0, rescheduled: 0 };
    for (const a of this.all()) {
      counts.all++;
      if (a.tab) counts[a.tab]++;
    }
    return counts;
  });

  protected countOf(tab: Tab): number {
    return this.counts()[tab];
  }

  protected readonly filtered = computed(() => {
    const tab = this.activeTab();
    const all = this.all();
    if (tab === 'all') return all;
    return all.filter((a) => a.tab === tab);
  });

  /** The list line when this tab has no rows but proposal cards show above it. */
  protected readonly emptyTabText = computed(() => EMPTY_TAB[this.activeTab()]);

  protected readonly viewState = computed<
    'loading' | 'list' | 'empty' | 'error'
  >(() => {
    if (this.view() === 'error' || this.loadError()) return 'error';
    if (this.loading()) return 'loading';
    if (this.view() === 'empty' || this.filtered().length === 0) {
      // Open proposals, or rows on other tabs: not "no upcoming appointments",
      // so the list says so for this tab instead.
      if (this.view() === 'empty') return 'empty';
      return this.proposals().length > 0 || this.all().length > 0 ? 'list' : 'empty';
    }
    return 'list';
  });

  /**
   * What is still to come or live (`when=upcoming`, soonest first). Anything
   * over — whatever its status — is History's, so a stale booking from last
   * month never sits here.
   */
  private load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.appointments
      .listMine({ when: 'upcoming', per_page: 100 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const now = Date.now();
          const open = res.data.filter((a) => isOpenProposal(a, now));
          this.proposals.set(open.map(toProposalCard));
          this.all.set(
            res.data.filter((a) => !open.includes(a)).map(toAppointmentRow),
          );
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, this.loadErrorFallback));
          this.loading.set(false);
        },
      });
  }
}
