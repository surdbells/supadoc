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
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorPatientRecordDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

/** A patient's record for the doctor (route `/patients/:id`). */
@Component({
  selector: 'doc-patient-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/patients" class="flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Patients
      </a>

      @if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="user-x" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (record(); as r) {
        <section class="flex items-center gap-4 rounded-card border border-cloud bg-white p-6">
          <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">{{ initials(r.patient.name) }}</span>
          <div class="flex flex-col gap-1">
            <p class="font-heading text-h5 text-ink">{{ r.patient.name }}</p>
            <p class="font-sans text-body-sm text-slate">
              {{ r.patient.email }}{{ r.patient.phone ? ' · ' + r.patient.phone : '' }}
            </p>
            <p class="font-sans text-caption text-slate">
              {{ r.patient.gender || '—' }}{{ r.patient.date_of_birth ? ' · ' + age(r.patient.date_of_birth) + ' yrs' : '' }} · {{ r.visit_count }} visit{{ r.visit_count === 1 ? '' : 's' }}
            </p>
          </div>
        </section>

        <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
            <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="triangle-alert" [size]="18" />Allergies</h2>
            @for (a of r.medical.allergies; track $index) {
              <div class="rounded-field bg-glacier px-3 py-2 font-sans text-body-sm text-ink">{{ a.allergen }}<span class="text-slate">{{ a.severity ? ' · ' + a.severity : '' }}</span></div>
            } @empty { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
          </section>
          <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
            <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="clipboard-list" [size]="18" />Conditions</h2>
            @for (c of r.medical.conditions; track $index) {
              <div class="rounded-field bg-glacier px-3 py-2 font-sans text-body-sm text-ink">{{ c.condition }}<span class="text-slate">{{ c.status ? ' · ' + c.status : '' }}</span></div>
            } @empty { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
          </section>
          <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
            <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="pill" [size]="18" />Medications</h2>
            @for (m of r.medical.medications; track $index) {
              <div class="rounded-field bg-glacier px-3 py-2 font-sans text-body-sm text-ink">{{ m.name }}<span class="text-slate">{{ m.dosage ? ' · ' + m.dosage : '' }}</span></div>
            } @empty { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
          </section>
        </div>

        <section class="flex flex-col gap-3">
          <h2 class="font-heading text-body-lg text-ink">Visit history</h2>
          <ul class="flex flex-col gap-3">
            @for (a of r.appointments; track a.id) {
              <li class="flex flex-col gap-2 rounded-card border border-cloud bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex flex-col">
                  <span class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
                    {{ when(a.scheduled_at) }}
                    <span class="rounded-pill px-2 py-0.5 text-[10px] font-semibold" [class]="statusClass(a.status)">{{ a.status_label }}</span>
                  </span>
                  <span class="font-sans text-caption text-slate">{{ a.type_label }}</span>
                </div>
                <a [routerLink]="['/appointments', a.id]" class="w-fit rounded-field border border-cloud px-4 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean">Open chart</a>
              </li>
            } @empty { <p class="font-sans text-body-sm text-slate">No visits.</p> }
          </ul>
        </section>
      } @else {
        <div class="sd-shimmer h-40 rounded-card"></div>
      }
    </div>
  `,
})
export class DoctorPatientDetail implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly record = signal<DoctorPatientRecordDto | null>(null);
  protected readonly error = signal('');

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.api
      .patient(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.record.set(res.data),
        error: () => this.error.set('Patient not found.'),
      });
  }

  protected initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  protected age(dob: string): number {
    const d = new Date(dob);
    const diff = Date.now() - d.getTime();
    return Math.max(0, Math.floor(diff / (365.25 * 24 * 3600 * 1000)));
  }
  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
}
