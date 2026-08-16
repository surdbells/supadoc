import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { AppointmentsApi } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

interface SharedDoc {
  readonly name: string;
  readonly size: string;
}

interface DetailsVm {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly date: string;
  readonly time: string;
  readonly typeLabel: string;
  readonly typeIcon: string;
  readonly statusLabel: string;
  readonly statusClass: string;
  readonly amount: string;
  readonly guests: string[];
}

const NAIRA = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

const TYPE_ICON: Record<string, string> = {
  video: 'video',
  follow_up: 'refresh-cw',
  urgent: 'zap',
  routine: 'calendar-check',
};

function toDetails(a: AppointmentDto): DetailsVm {
  const when = new Date(a.scheduled_at);
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
    typeLabel: a.type_label,
    typeIcon: TYPE_ICON[a.type] ?? 'calendar-check',
    statusLabel: a.status_label,
    statusClass: STATUS_CLASS[a.status] ?? 'bg-cloud text-slate',
    amount: `₦${NAIRA.format(Number(a.amount) || 0)}`,
    guests: (a.guests ?? []).map((g) => g.name),
  };
}

/** Appointment details (Figma 648:9480) — wired to GET /api/portal/appointments/{id}. */
@Component({
  selector: 'pat-appointment-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <a
            routerLink="/dashboard/appointments"
            class="mb-1 flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean"
          >
            <sd-icon name="chevron-right" [size]="16" class="rotate-180" />
            My Appointments
          </a>
          <h1 class="font-heading text-h3 text-ink">Appointment Details</h1>
          <p class="font-sans text-body text-slate">
            View and manage your scheduled consultations
          </p>
        </div>
        <sd-button size="sm" (click)="book()">
          <sd-icon name="plus" [size]="18" />
          Book Consultation
        </sd-button>
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-6">
            <div class="h-28 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
          </div>
        }
        @case ('error') {
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span
              class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert"
            >
              <sd-icon name="calendar-off" [size]="36" />
            </span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                Appointment not found
              </h2>
              <p class="font-sans text-body-sm text-slate">
                This appointment doesn't exist or is no longer available.
              </p>
            </div>
            <sd-button routerLink="/dashboard/appointments">
              Back to appointments
            </sd-button>
          </div>
        }
        @default {
          @if (vm(); as v) {
            <!-- Summary -->
            <section
              class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 md:flex-row md:items-center md:justify-between"
            >
              <div class="flex items-center gap-4">
                <img
                  src="/dashboard/avatar-james.png"
                  alt=""
                  width="64"
                  height="64"
                  class="size-16 shrink-0 rounded-full object-cover"
                />
                <div class="flex flex-col gap-1">
                  <p class="font-sans text-body-lg font-semibold text-ink">
                    {{ v.name }}
                  </p>
                  <p class="font-sans text-caption text-slate">
                    {{ v.specialty }}
                  </p>
                </div>
              </div>
              <div class="flex items-start justify-between gap-8 md:items-center">
                <div
                  class="flex flex-col gap-2 font-sans text-caption text-slate"
                >
                  <span class="flex items-center gap-2">
                    <sd-icon name="calendar-days" [size]="16" />{{ v.date }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon name="clock" [size]="16" />{{ v.time }}
                  </span>
                  <span class="flex items-center gap-2">
                    <sd-icon [name]="v.typeIcon" [size]="16" />{{ v.typeLabel }}
                  </span>
                </div>
                <span
                  class="shrink-0 rounded-lg px-4 py-1.5 font-sans text-body-sm font-medium"
                  [class]="v.statusClass"
                  >{{ v.statusLabel }}</span
                >
              </div>
            </section>

            <!-- Instructions + actions -->
            <section
              class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 lg:flex-row lg:justify-between"
            >
              <div class="flex flex-col gap-3">
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="clipboard-list" [size]="20" />
                  Consultation Instructions
                </h2>
                <div
                  class="flex flex-col gap-3 font-sans text-body-sm text-slate"
                >
                  <p>
                    Please ensure you have a stable internet connection.<br />
                    Join the consultation 5-10minutes early.
                  </p>
                  <p>
                    Upload any relevant medical reports or tests below, so the
                    doctor can review them.
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 flex-col gap-3 lg:w-[240px]">
                <sd-button [full]="true" (click)="joinCall(v.id)">
                  <sd-icon name="video" [size]="18" />
                  Join Consultation
                </sd-button>
                <sd-button variant="outline" [full]="true"
                  >Reschedule Appointment</sd-button
                >
                <button
                  type="button"
                  class="inline-flex w-full items-center justify-center gap-2 rounded-field border border-alert px-4 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5"
                >
                  <sd-icon name="trash-2" [size]="18" />
                  Cancel Appointment
                </button>
              </div>
            </section>

            <!-- Documents + payment -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
              >
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="file-text" [size]="20" />
                  Shared Documents
                </h2>
                <ul class="flex flex-col gap-3">
                  @for (doc of documents; track doc.name) {
                    <li class="flex items-center gap-3">
                      <sd-icon
                        name="file-text"
                        [size]="20"
                        class="shrink-0 text-slate"
                      />
                      <span
                        class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink"
                      >
                        {{ doc.name }} ({{ doc.size }})
                      </span>
                    </li>
                  } @empty {
                    <li class="font-sans text-body-sm text-slate">
                      No documents were shared for this consultation.
                    </li>
                  }
                </ul>
              </section>

              <section
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
              >
                <h2
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="credit-card" [size]="20" />
                  Consultation Fee
                </h2>
                <span
                  class="flex items-center gap-2 font-sans text-body-sm text-ink"
                >
                  <sd-icon name="credit-card" [size]="20" class="text-slate" />
                  Amount: {{ v.amount }}
                </span>
                @if (v.guests.length > 0) {
                  <span
                    class="flex items-start gap-2 font-sans text-body-sm text-ink"
                  >
                    <sd-icon name="users" [size]="20" class="mt-0.5 shrink-0 text-slate" />
                    Guests: {{ v.guests.join(', ') }}
                  </span>
                }
              </section>
            </div>
          }
        }
      }
    </div>
  `,
})
export class AppointmentDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly appointments = inject(AppointmentsApi);

  protected joinCall(id: string): void {
    void this.router.navigate(['/dashboard/call', id]);
  }

  /** Booking starts at the specialist directory (same as the dashboard CTA). */
  protected book(): void {
    void this.router.navigate(['/dashboard/specialists']);
  }

  // Document sharing isn't modelled by the backend yet — show an empty state
  // rather than fabricated files.
  protected readonly documents: SharedDoc[] = [];

  private readonly result = toSignal(
    this.route.paramMap.pipe(
      map((p) => p.get('id') ?? ''),
      switchMap((id) =>
        this.appointments.getMine(id).pipe(
          map((res) => ({ state: 'loaded' as const, appt: res.data })),
          catchError(() => of({ state: 'error' as const, appt: null })),
          startWith({ state: 'loading' as const, appt: null }),
        ),
      ),
    ),
    { initialValue: { state: 'loading' as const, appt: null } },
  );

  protected readonly viewState = computed(() => this.result().state);

  protected readonly vm = computed<DetailsVm | null>(() => {
    const appt = this.result().appt;
    return appt ? toDetails(appt) : null;
  });
}
