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
import { Router, RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorAppointmentDto, DoctorDashboardDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Kpi {
  readonly label: string;
  readonly value: string | number;
  readonly icon: string;
  readonly hint?: string;
  readonly hintClass?: string;
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

/** Doctor home (route `/dashboard`) — metrics, next consult, today's agenda. */
@Component({
  selector: 'doc-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">{{ greeting() }}</h1>
        <p class="font-sans text-body text-slate">{{ today() }}</p>
      </header>

      @if (loading()) {
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          @for (i of [1,2,3,4,5,6]; track i) { <div class="sd-shimmer h-24 rounded-card"></div> }
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (data(); as d) {
        @if (d.pending > 0) {
          <a routerLink="/schedule" class="flex items-center gap-3 rounded-card border border-warning/30 bg-warning/5 px-5 py-4 transition-colors hover:bg-warning/10">
            <sd-icon name="triangle-alert" [size]="20" class="text-warning" />
            <span class="font-sans text-body-sm font-semibold text-warning">{{ d.pending }} booking{{ d.pending === 1 ? '' : 's' }} awaiting your confirmation</span>
            <sd-icon name="chevron-right" [size]="18" class="ml-auto text-warning" />
          </a>
        }

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          @for (k of kpis(); track k.label) {
            <div class="rounded-card border border-cloud bg-white p-4">
              <div class="flex items-center gap-2 text-slate">
                <sd-icon [name]="k.icon" [size]="16" />
                <span class="font-sans text-caption">{{ k.label }}</span>
              </div>
              <p class="mt-1 font-heading text-h4 text-ink">{{ k.value }}</p>
              @if (k.hint) { <p class="font-sans text-caption" [class]="k.hintClass ?? 'text-slate'">{{ k.hint }}</p> }
            </div>
          }
        </div>

        @if (d.next; as n) {
          <section class="flex flex-col gap-4 rounded-card border border-cerulean/30 bg-frost/20 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex flex-col gap-1">
              <span class="font-sans text-caption font-semibold text-cerulean">Next consultation</span>
              <span class="font-heading text-h5 text-ink">{{ n.patient_name }}</span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
                <sd-icon name="calendar-days" [size]="16" />{{ when(n.scheduled_at) }}
              </span>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <a [routerLink]="['/appointments', n.id]" class="rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean">Open chart</a>
              <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="join(n)"><sd-icon name="video" [size]="18" />Join</button>
            </div>
          </section>
        }

        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <h2 class="font-heading text-body-lg text-ink">Today's agenda</h2>
            <a routerLink="/schedule" class="font-sans text-body-sm font-semibold text-cerulean hover:text-ocean">Full schedule</a>
          </div>
          @if (d.agenda.length === 0) {
            <div class="rounded-card border border-cloud bg-white px-5 py-10 text-center font-sans text-body-sm text-slate">No consultations today.</div>
          } @else {
            <ul class="flex flex-col gap-3">
              @for (a of d.agenda; track a.id) {
                <li class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div class="flex items-center gap-3">
                    <span class="flex flex-col items-center rounded-field bg-glacier px-3 py-1.5">
                      <span class="font-heading text-body font-semibold text-cerulean">{{ time(a.scheduled_at) }}</span>
                    </span>
                    <div class="flex flex-col">
                      <span class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
                        {{ a.patient_name }}
                        <span class="rounded-pill px-2 py-0.5 text-[10px] font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
                      </span>
                      <span class="font-sans text-caption text-slate">{{ a.type_label }}</span>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <a [routerLink]="['/appointments', a.id]" class="rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean">Chart</a>
                    <button type="button" class="flex items-center gap-1.5 rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean" (click)="join(a)"><sd-icon name="video" [size]="16" />Join</button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }
    </div>
  `,
})
export class DoctorDashboard implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly auth = inject(StaffAuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly data = signal<DoctorDashboardDto | null>(null);

  protected readonly greeting = computed(() => {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = this.auth.displayName();
    return name ? `${part}, ${name}` : part;
  });
  protected readonly today = computed(() =>
    new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()),
  );

  protected readonly kpis = computed<Kpi[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Today', value: d.today, icon: 'calendar-days' },
      { label: 'Pending', value: d.pending, icon: 'calendar-clock', hint: d.pending > 0 ? 'to confirm' : undefined, hintClass: 'text-warning' },
      { label: 'Upcoming', value: d.upcoming, icon: 'calendar-check' },
      { label: 'Completed', value: d.completed_month, icon: 'circle-check', hint: 'this month' },
      { label: 'Patients', value: d.patients, icon: 'users' },
      { label: 'Earnings', value: this.money(d.currency, d.earnings_month), icon: 'banknote', hint: 'this month' },
    ];
  });

  ngOnInit(): void {
    this.api
      .dashboard()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load your dashboard.');
          this.loading.set(false);
        },
      });
  }

  protected join(a: DoctorAppointmentDto): void {
    const marker = '/call/join/';
    const idx = a.join_url.indexOf(marker);
    const token = idx >= 0 ? a.join_url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = a.join_url;
  }

  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  protected time(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  private money(currency: string, amount: string): string {
    const n = Number(amount);
    return (currency || '₦') + (isNaN(n) ? '0' : n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
  }
}
