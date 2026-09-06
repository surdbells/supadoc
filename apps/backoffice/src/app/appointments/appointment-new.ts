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
import {
  AdminAppointmentsApi,
  AdminPatientsApi,
  apiErrorMessage,
  SpecialistsApi,
} from '@supadoc/data-access';
import type { PatientSummaryDto, SpecialistAdminDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

const FIELD =
  'w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

const TYPES = [
  { value: 'video', label: 'Video consultation' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'routine', label: 'Routine' },
];

/** Book an appointment on a patient's behalf (route `/appointments/new`). */
@Component({
  selector: 'bo-appointment-new',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-2xl flex-col gap-6 py-2">
      <a routerLink="/appointments" class="flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Appointments
      </a>
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">New appointment</h1>
        <p class="font-sans text-body text-slate">Book a consultation on a patient's behalf.</p>
      </header>

      <!-- Patient -->
      <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
        <h2 class="font-heading text-body-lg text-ink">1. Patient</h2>
        @if (patient(); as p) {
          <div class="flex items-center justify-between gap-3 rounded-field border border-cerulean bg-frost/30 px-4 py-3">
            <div class="flex flex-col">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ p.first_name }} {{ p.last_name }}</span>
              <span class="font-sans text-caption text-slate">{{ p.email }}{{ p.phone ? ' · ' + p.phone : '' }}</span>
            </div>
            <button type="button" class="font-sans text-caption font-semibold text-cerulean hover:underline" (click)="clearPatient()">Change</button>
          </div>
        } @else {
          <div class="relative">
            <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input class="${FIELD} pl-9" placeholder="Search by name, email or phone…" [value]="patientTerm()" (input)="onPatientInput($any($event.target).value)" />
          </div>
          @if (searchingPatient()) {
            <p class="font-sans text-caption text-slate">Searching…</p>
          } @else if (patientResults().length > 0) {
            <ul class="flex flex-col divide-y divide-cloud overflow-hidden rounded-field border border-cloud">
              @for (p of patientResults(); track p.id) {
                <li>
                  <button type="button" class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-glacier" (click)="pickPatient(p)">
                    <span class="flex flex-col">
                      <span class="font-sans text-body-sm text-ink">{{ p.first_name }} {{ p.last_name }}</span>
                      <span class="font-sans text-caption text-slate">{{ p.email }}{{ p.phone ? ' · ' + p.phone : '' }}</span>
                    </span>
                    <sd-icon name="plus" [size]="16" class="text-cerulean" />
                  </button>
                </li>
              }
            </ul>
          } @else if (patientTerm().trim().length >= 2) {
            <p class="font-sans text-caption text-slate">No patients match “{{ patientTerm() }}”.</p>
          }
        }
      </section>

      <!-- Specialist -->
      <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
        <h2 class="font-heading text-body-lg text-ink">2. Specialist</h2>
        @if (specialist(); as s) {
          <div class="flex items-center justify-between gap-3 rounded-field border border-cerulean bg-frost/30 px-4 py-3">
            <div class="flex flex-col">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ s.name }}</span>
              <span class="font-sans text-caption text-slate">{{ s.specialty }} · {{ money(s.consultation_fee) }}</span>
            </div>
            <button type="button" class="font-sans text-caption font-semibold text-cerulean hover:underline" (click)="clearSpecialist()">Change</button>
          </div>
        } @else {
          <div class="relative">
            <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input class="${FIELD} pl-9" placeholder="Search specialist by name or specialty…" [value]="specialistTerm()" (input)="specialistTerm.set($any($event.target).value)" />
          </div>
          @if (filteredSpecialists().length > 0) {
            <ul class="flex flex-col divide-y divide-cloud overflow-hidden rounded-field border border-cloud">
              @for (s of filteredSpecialists(); track s.id) {
                <li>
                  <button type="button" class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-glacier" (click)="pickSpecialist(s)">
                    <span class="flex flex-col">
                      <span class="font-sans text-body-sm text-ink">{{ s.name }}</span>
                      <span class="font-sans text-caption text-slate">{{ s.specialty }} · {{ money(s.consultation_fee) }}</span>
                    </span>
                    <sd-icon name="plus" [size]="16" class="text-cerulean" />
                  </button>
                </li>
              }
            </ul>
          } @else if (specialistTerm().trim().length >= 1) {
            <p class="font-sans text-caption text-slate">No specialists match “{{ specialistTerm() }}”.</p>
          }
        }
      </section>

      <!-- When -->
      <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
        <h2 class="font-heading text-body-lg text-ink">3. Schedule</h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Date &amp; time</span>
            <input type="datetime-local" class="${FIELD}" [value]="scheduledAt()" (input)="scheduledAt.set($any($event.target).value)" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Type</span>
            <select class="${FIELD}" [value]="type()" (change)="type.set($any($event.target).value)">
              @for (t of types; track t.value) { <option [value]="t.value">{{ t.label }}</option> }
            </select>
          </label>
        </div>
      </section>

      @if (error()) {
        <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert">{{ error() }}</p>
      }
      <div class="flex items-center gap-3">
        <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-6 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="!readyToBook() || creating()" (click)="create()">
          {{ creating() ? 'Booking…' : 'Book appointment' }}
        </button>
        <a routerLink="/appointments" class="font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink">Cancel</a>
      </div>
    </div>
  `,
})
export class AdminAppointmentNew implements OnInit {
  private readonly appointments = inject(AdminAppointmentsApi);
  private readonly patients = inject(AdminPatientsApi);
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly types = TYPES;

  // Patient
  protected readonly patientTerm = signal('');
  protected readonly patientResults = signal<PatientSummaryDto[]>([]);
  protected readonly patient = signal<PatientSummaryDto | null>(null);
  protected readonly searchingPatient = signal(false);
  private patientTimer?: ReturnType<typeof setTimeout>;

  // Specialist
  private readonly specialists = signal<SpecialistAdminDto[]>([]);
  protected readonly specialistTerm = signal('');
  protected readonly specialist = signal<SpecialistAdminDto | null>(null);
  protected readonly filteredSpecialists = computed(() => {
    const t = this.specialistTerm().trim().toLowerCase();
    if (t === '') return [];
    return this.specialists()
      .filter((s) => s.name.toLowerCase().includes(t) || s.specialty.toLowerCase().includes(t))
      .slice(0, 8);
  });

  // Schedule
  protected readonly scheduledAt = signal('');
  protected readonly type = signal('video');

  protected readonly creating = signal(false);
  protected readonly error = signal('');

  protected readonly readyToBook = computed(
    () => this.patient() !== null && this.specialist() !== null && this.scheduledAt().trim() !== '',
  );

  ngOnInit(): void {
    this.specialistsApi
      .listAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.specialists.set(res.data), error: () => undefined });
  }

  protected onPatientInput(value: string): void {
    this.patientTerm.set(value);
    clearTimeout(this.patientTimer);
    const term = value.trim();
    if (term.length < 2) {
      this.patientResults.set([]);
      return;
    }
    this.patientTimer = setTimeout(() => this.searchPatients(term), 300);
  }

  private searchPatients(term: string): void {
    this.searchingPatient.set(true);
    this.patients
      .search(term)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.patientResults.set(res.data);
          this.searchingPatient.set(false);
        },
        error: () => this.searchingPatient.set(false),
      });
  }

  protected pickPatient(p: PatientSummaryDto): void {
    this.patient.set(p);
    this.patientResults.set([]);
    this.patientTerm.set('');
  }
  protected clearPatient(): void {
    this.patient.set(null);
  }

  protected pickSpecialist(s: SpecialistAdminDto): void {
    this.specialist.set(s);
    this.specialistTerm.set('');
  }
  protected clearSpecialist(): void {
    this.specialist.set(null);
  }

  protected create(): void {
    const patient = this.patient();
    const specialist = this.specialist();
    if (!patient || !specialist || this.scheduledAt().trim() === '' || this.creating()) return;
    this.creating.set(true);
    this.error.set('');
    this.appointments
      .create({
        patient_id: patient.id,
        specialist_id: specialist.id,
        scheduled_at: new Date(this.scheduledAt()).toISOString(),
        type: this.type(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => void this.router.navigate(['/appointments', res.data.id]),
        error: (err) => {
          this.error.set(apiErrorMessage(err, 'Could not book the appointment.'));
          this.creating.set(false);
        },
      });
  }

  protected money(amount: string): string {
    const n = Number(amount);
    return isNaN(n) ? '—' : '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
