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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { apiErrorMessage, DoctorApi, injectCallPresence } from '@supadoc/data-access';
import type { DoctorAppointmentDto } from '@supadoc/models';
import { CallPresenceComponent, IconComponent } from '@supadoc/ui';
import { canConfirm, isPast, statusDetail, statusLook, type StatusLook } from '../appointment/appointment-status';
import { doctorStatusLabel, isOpenProposal, whenLabel } from '../appointment/follow-ups';

type TabKey = 'upcoming' | 'today' | 'pending' | 'attention';

/**
 * The doctor's schedule (route `/schedule`) — what is still to come or under
 * way, split by TIME (`?when=upcoming`): Upcoming / Today / Pending (requests
 * to confirm). Anything over lives in History. "Needs attention" (only shown
 * when there is something in it) lists past bookings that were never closed:
 * requests not confirmed in time and confirmed visits being finalised, until
 * the reminders cron closes them.
 */
@Component({
  selector: 'doc-schedule',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CallPresenceComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Schedule</h1>
        <p class="font-sans text-body text-slate">View and manage your patient consultations. Past ones are in <a routerLink="/appointments/history" class="font-semibold text-cerulean hover:text-ocean">History</a>.</p>
      </header>

      @if (notice()) {
        <div class="flex items-center gap-2 rounded-card bg-alert/10 px-4 py-2.5 font-sans text-caption text-alert" role="alert">
          <sd-icon name="triangle-alert" [size]="16" class="shrink-0" />{{ notice() }}
        </div>
      }

      <!-- Tabs (scroll sideways on a narrow phone) -->
      <div class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-haze bg-glacier p-1 shadow-bar" role="group" aria-label="Schedule views">
        @for (t of visibleTabs(); track t.key) {
          <button type="button"
            class="flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 sm:px-5"
            [class]="tab() === t.key ? 'bg-frost text-cerulean-dark shadow-control' : 'text-slate hover:text-ink'"
            [attr.aria-pressed]="tab() === t.key"
            (click)="tab.set(t.key)">
            @if (t.key === 'attention') { <sd-icon name="circle-alert" [size]="16" class="shrink-0" /> }
            {{ t.label }}
            @if (count(t.key) > 0) {
              <span class="flex size-5 items-center justify-center rounded-full text-[11px] font-semibold"
                [class]="tab() === t.key ? 'bg-cerulean text-white' : 'bg-cloud text-slate'">{{ count(t.key) }}</span>
            }
          </button>
        }
      </div>

      @if (tab() === 'attention' && visible().length > 0) {
        <p class="flex items-start gap-2 rounded-card border border-warning/30 bg-warning/5 px-4 py-3 font-sans text-caption text-ink">
          <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0 text-warning" />
          <span>These consultations have ended but are still open. Requests you didn't confirm in time are cancelled automatically, and anything paid goes back to the patient. If you both joined one, it closes as completed once your note or a prescription shows it took place; otherwise our team reviews it. A confirmed one closes as completed once your note, a prescription or the call shows it took place — otherwise it's marked missed. If it took place, open it to finish your note or mark it completed.</span>
        </p>
      }

      @if (loading()) {
        <div class="flex flex-col gap-3">
          <div class="sd-shimmer h-24 rounded-card"></div>
          <div class="sd-shimmer h-24 rounded-card"></div>
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white py-16 text-center shadow-card">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (visible().length === 0) {
        <!-- Empty state -->
        <div class="flex flex-col items-center gap-5 py-20 text-center">
          <span class="flex size-24 items-center justify-center rounded-full bg-cloud/60 text-slate">
            <sd-icon name="calendar-days" [size]="40" />
          </span>
          <div class="flex max-w-sm flex-col gap-1">
            <h2 class="font-heading text-h5 text-ink">No Appointment yet</h2>
            <p class="font-sans text-body-sm text-slate">{{ emptyText() }}</p>
          </div>
          <a routerLink="/availability" class="rounded-field bg-cerulean px-6 py-3 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim transition hover:bg-ocean hover:shadow-btn-hover disabled:shadow-none">View Availability</a>
        </div>
      } @else {
        <ul class="flex flex-col gap-4">
          @for (a of visible(); track a.id) {
            @let label = statusLabel(a);
            @let look = statusLook(a);
            <li>
              <div class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card transition hover:border-cerulean/40 lg:flex-row lg:items-center lg:gap-6">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean-dark">{{ initialsFor(a.patient_name) }}</span>
                  <div class="flex min-w-0 flex-col">
                    <span class="truncate font-heading text-body-lg text-ink">{{ a.patient_name }}</span>
                    <span class="truncate font-sans text-body-sm text-slate">{{ a.type_label }}</span>
                    <!-- People the patient invited to the call (names are on the details page). -->
                    @if (a.guests?.length; as n) {
                      <span class="flex items-center gap-1 font-sans text-caption text-slate">
                        <sd-icon name="users" [size]="13" class="shrink-0" />+ {{ n }} {{ n === 1 ? 'guest' : 'guests' }}
                      </span>
                    }
                  </div>
                </div>
                <div class="flex flex-col gap-1 lg:w-44">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(a.scheduled_at) }}</span>
                </div>
                <div class="flex flex-col gap-1.5 lg:w-52">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="video" [size]="16" class="text-slate" />Video Consultation</span>
                  <!-- Status + who is in the call; wraps rather than overflowing on narrow rows. -->
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="inline-flex w-fit items-center gap-1 rounded-pill px-3 py-0.5 font-sans text-caption font-semibold inset-ring inset-ring-current/20" [class]="look.pill">
                      <sd-icon [name]="look.icon" [size]="13" />{{ label }}
                    </span>
                    <sd-call-presence [presence]="presence()[a.id]" viewer="doctor" />
                  </div>
                  @if (a.status === 'proposed' && a.expires_at) {
                    <span class="font-sans text-caption text-slate">Reply due {{ when(a.expires_at) }}</span>
                  } @else if (detail(a, label); as d) {
                    <span class="font-sans text-caption text-slate">{{ d }}</span>
                  }
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  @if (a.status === 'proposed') {
                    <!-- A follow-up offer: no call until the patient accepts it. -->
                    <a [routerLink]="['/appointments', a.id]" class="flex min-h-11 items-center justify-center rounded-field border border-haze bg-white px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none">View proposal</a>
                  } @else if (canConfirm(a)) {
                    <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim transition hover:bg-ocean hover:shadow-btn-hover disabled:opacity-60 disabled:shadow-none" [disabled]="busyId() === a.id" (click)="confirm(a)">
                      {{ busyId() === a.id ? 'Working…' : 'Confirm' }}
                    </button>
                  } @else if (a.status === 'confirmed' && !isPast(a)) {
                    <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim transition hover:bg-ocean hover:shadow-btn-hover disabled:shadow-none" (click)="join(a)">
                      <sd-icon name="video" [size]="18" />Join Call
                    </button>
                  } @else {
                    <!-- Over (or a request it's too late to confirm): the record has what can still be done. -->
                    <a [routerLink]="['/appointments', a.id]" class="flex min-h-11 items-center justify-center rounded-field border border-haze bg-white px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none">Open record</a>
                  }
                  <a [routerLink]="['/appointments', a.id]" class="flex size-11 items-center justify-center text-slate transition-colors hover:text-cerulean" [attr.aria-label]="'Open details for ' + a.patient_name"><sd-icon name="chevron-right" [size]="22" /></a>
                </div>
              </div>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class DoctorSchedule implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  /** Still to come or live (`?when=upcoming`, soonest first). */
  protected readonly appointments = signal<DoctorAppointmentDto[]>([]);
  /** Over but never closed (`?when=attention`, newest first). */
  protected readonly attention = signal<DoctorAppointmentDto[]>([]);
  protected readonly busyId = signal<string | null>(null);
  protected readonly tab = signal<TabKey>('upcoming');
  /** Who is in each consultation's call right now (polled). */
  protected readonly presence = injectCallPresence(() => this.api.presence());

  private readonly tabs: ReadonlyArray<{ key: TabKey; label: string }> = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'today', label: 'Today' },
    { key: 'pending', label: 'Pending' },
    { key: 'attention', label: 'Needs attention' },
  ];
  /** "Needs attention" only while it has something in it (or is the open tab). */
  protected readonly visibleTabs = computed(() =>
    this.tabs.filter((t) => t.key !== 'attention' || this.attention().length > 0 || this.tab() === 'attention'),
  );

  private readonly buckets = computed(() => {
    const now = Date.now();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const today: DoctorAppointmentDto[] = [];
    const upcoming: DoctorAppointmentDto[] = [];
    const pending: DoctorAppointmentDto[] = [];
    for (const a of this.appointments()) {
      // A follow-up proposal holds its slot but isn't booked: Upcoming only, while the patient can still answer.
      if (a.status === 'proposed') {
        if (isOpenProposal(a, now)) upcoming.push(a);
        continue;
      }
      // (The list is still-to-come or live only — nothing here is over.)
      if (isPast(a, now)) continue;
      if (a.status === 'pending' || a.status === 'rescheduled') pending.push(a);
      const t = new Date(a.scheduled_at).getTime();
      if (t >= start.getTime() && t <= end.getTime()) today.push(a);
      else upcoming.push(a);
    }
    return { today, upcoming, pending, attention: this.attention() };
  });

  protected count(key: TabKey): number {
    return this.buckets()[key].length;
  }
  protected readonly visible = computed(() => this.buckets()[this.tab()]);
  protected emptyText(): string {
    switch (this.tab()) {
      case 'pending':
        return 'No upcoming consultations are waiting for your confirmation.';
      case 'today':
        return "You have no more consultations today. Finished ones are in History.";
      case 'attention':
        return 'Nothing needs your attention — every past consultation is closed.';
      default:
        return "You haven't received any appointment yet";
    }
  }

  ngOnInit(): void {
    // ?tab=pending (the dashboard's "awaiting your confirmation" link) opens that tab.
    const wanted = this.route.snapshot.queryParamMap.get('tab');
    if (wanted && this.tabs.some((t) => t.key === wanted)) this.tab.set(wanted as TabKey);
    this.load();
  }

  private load(): void {
    this.api
      .schedule('upcoming')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.appointments.set(res.data.appointments ?? []);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not load your consultations.'));
          this.loading.set(false);
        },
      });
    // Secondary: a failure only hides the tab.
    this.api
      .schedule('attention')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.attention.set(res.data.appointments ?? []),
        error: () => this.attention.set([]),
      });
  }

  protected confirm(a: DoctorAppointmentDto): void {
    if (this.busyId()) return;
    this.busyId.set(a.id);
    this.notice.set('');
    this.api
      .confirm(a.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // The whole lifecycle state comes back (status, label, can_confirm…); keep the list-only fields.
          this.appointments.update((list) => list.map((x) => (x.id === a.id ? { ...x, ...res.data } : x)));
          this.busyId.set(null);
        },
        error: (err: unknown) => {
          // E.g. "This consultation has ended, so it can no longer be confirmed": show the lists as they are now.
          this.notice.set(apiErrorMessage(err, 'Could not confirm the appointment.'));
          this.busyId.set(null);
          this.load();
        },
      });
  }

  protected join(a: DoctorAppointmentDto): void {
    // The API decides per consultation: owing the terms blocks one that hasn't
    // started (accept them first), never one already under way.
    if (a.join_blocked) {
      void this.router.navigateByUrl(a.join_blocked.code === 'terms_required' ? '/onboarding/terms' : '/account-status');
      return;
    }
    // No link on an unaccepted follow-up proposal — there is no call to join yet.
    const url = a.join_url;
    if (!url) return;
    const marker = '/call/join/';
    const idx = url.indexOf(marker);
    const token = idx >= 0 ? url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = url;
  }

  protected initialsFor(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  protected statusLook(a: DoctorAppointmentDto): StatusLook {
    return statusLook(a);
  }
  /** "Awaiting patient" for a follow-up proposal, else the lifecycle label (In progress, Being finalised…). */
  protected statusLabel(a: DoctorAppointmentDto): string {
    return doctorStatusLabel(a);
  }
  protected detail(a: DoctorAppointmentDto, label: string): string | null {
    return statusDetail(a, label);
  }
  protected canConfirm(a: DoctorAppointmentDto): boolean {
    return canConfirm(a);
  }
  protected isPast(a: DoctorAppointmentDto): boolean {
    return isPast(a);
  }
  protected when(iso: string): string {
    return whenLabel(iso);
  }
  protected dateLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
  protected time(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
}
