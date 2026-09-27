import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AdminPatientsApi } from '@supadoc/data-access';
import type { AppointmentDto, PatientDetailDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** A single patient record + their recent appointments (route `/patients/:id`). */
@Component({
  selector: 'bo-patient-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/patients" class="flex w-fit items-center gap-1 font-sans text-body-sm font-semibold text-cerulean hover:underline">
        <sd-icon name="chevron-left" [size]="18" /> Back to patients
      </a>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card"></div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (data(); as d) {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <div class="flex items-center gap-4">
            <span class="flex size-14 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">{{ initials(d) }}</span>
            <div class="flex flex-col">
              <span class="font-heading text-h5 text-ink">{{ d.patient.first_name }} {{ d.patient.last_name }}</span>
              <span class="font-sans text-body-sm text-slate">{{ d.patient.email }}</span>
            </div>
          </div>
          <dl class="grid grid-cols-1 gap-x-8 gap-y-2 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex justify-between gap-4"><dt class="text-slate">Phone</dt><dd class="text-ink">{{ d.patient.phone || '—' }}{{ d.patient.phone && d.patient.phone_verified ? ' ✓' : '' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Date of birth</dt><dd class="text-ink">{{ d.patient.date_of_birth || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Gender</dt><dd class="capitalize text-ink">{{ d.patient.gender || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">2FA</dt><dd class="text-ink">{{ d.patient.two_factor_enabled ? 'Enabled' : 'Off' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Joined</dt><dd class="text-ink">{{ when(d.patient.created_at) }}</dd></div>
          </dl>
        </section>

        <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
          <h2 class="font-heading text-body-lg text-ink">Appointments ({{ d.appointments_total }})</h2>
          @if (d.appointments.length === 0) {
            <p class="font-sans text-body-sm text-slate">No appointments yet.</p>
          } @else {
            <ul class="flex flex-col divide-y divide-cloud">
              @for (a of d.appointments; track a.id) {
                <li class="flex items-center justify-between gap-3 py-3">
                  <div class="flex flex-col">
                    <a [routerLink]="['/appointments', a.id]" class="font-sans text-body-sm font-medium text-ink hover:text-cerulean">{{ a.specialist.name }}</a>
                    <span class="font-sans text-caption text-slate">{{ when(a.scheduled_at) }} · {{ a.type_label }}</span>
                  </div>
                  <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
                </li>
              }
            </ul>
          }
        </section>
      }
    </div>
  `,
})
export class AdminPatientDetail implements OnInit {
  private readonly api = inject(AdminPatientsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<PatientDetailDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.api
      .get(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load this patient.');
          this.loading.set(false);
        },
      });
  }

  protected initials(d: PatientDetailDto): string {
    return `${d.patient.first_name?.[0] ?? ''}${d.patient.last_name?.[0] ?? ''}`.toUpperCase() || '?';
  }

  protected statusClass(status: AppointmentDto['status']): string {
    switch (status) {
      case 'confirmed':
      case 'completed':
        return 'bg-sage/15 text-sage';
      case 'cancelled':
        return 'bg-alert/10 text-alert';
      case 'rescheduled':
        return 'bg-cloud text-slate';
      default:
        return 'bg-warning/15 text-warning';
    }
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
}
