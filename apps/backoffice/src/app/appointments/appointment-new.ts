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
  AvailabilityCalendarStore,
  nowLocalInput,
  SpecialistsApi,
} from '@supadoc/data-access';
import type { PatientSummaryDto, SpecialistAdminDto } from '@supadoc/models';
import { AlertComponent, BookingCalendarComponent, IconComponent } from '@supadoc/ui';
import {
  BACK_LINK_ABOVE,
  BTN_GHOST,
  BTN_PRIMARY,
  FIELD,
  FIELD_ICON,
  FIELD_WITH_ICON,
  FORM_ACTIONS,
  LABEL,
  PAGE_FORM,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SECTION,
  SECTION_TITLE,
} from '../shared/layout';

const TYPES = [
  { value: 'video', label: 'Video consultation' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'routine', label: 'Routine' },
];

const CHOSEN = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Book an appointment on a patient's behalf (route `/appointments/new`). The
 * time comes from the specialist's staff booking calendar (the openings a
 * patient sees — lead time, blocks and bookings applied — but reaching a year
 * ahead, past the patients' booking window, in the viewer's time zone);
 * "Enter another time" types one instead, which the API still checks is on
 * the doctor's availability.
 */
@Component({
  selector: 'bo-appointment-new',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, AlertComponent, BookingCalendarComponent],
  providers: [AvailabilityCalendarStore],
  host: { class: 'block' },
  template: `
    <div class="${PAGE_FORM}">
      <a routerLink="/appointments" class="${BACK_LINK_ABOVE} -mb-3">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Appointments
      </a>
      <header class="${PAGE_HEADER_TEXT}">
        <h1 class="${PAGE_TITLE}">New appointment</h1>
        <p class="${PAGE_SUBTITLE}">Book a consultation on a patient's behalf.</p>
      </header>

      <!-- Patient -->
      <section class="${SECTION} !gap-4">
        <h2 class="${SECTION_TITLE}"><sd-icon name="user-round" [size]="20" class="text-cerulean" />1. Patient</h2>
        @if (patient(); as p) {
          <div class="flex items-center justify-between gap-3 rounded-field border border-cerulean bg-frost/30 px-4 py-3">
            <div class="flex min-w-0 flex-col">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ p.first_name }} {{ p.last_name }}</span>
              <span class="break-all font-sans text-caption text-slate">{{ p.email }}{{ p.phone ? ' · ' + p.phone : '' }}</span>
            </div>
            <button type="button" class="min-h-11 shrink-0 px-2 font-sans text-caption font-semibold text-cerulean hover:underline" (click)="clearPatient()">Change</button>
          </div>
        } @else {
          <div class="relative">
            <sd-icon name="search" [size]="20" class="${FIELD_ICON}" />
            <input class="${FIELD_WITH_ICON}" aria-label="Search patients" placeholder="Search by name, email or phone…" [value]="patientTerm()" (input)="onPatientInput($any($event.target).value)" />
          </div>
          @if (searchingPatient()) {
            <p class="font-sans text-caption text-slate">Searching…</p>
          } @else if (patientResults().length > 0) {
            <ul class="flex flex-col divide-y divide-cloud overflow-hidden rounded-field border border-cloud">
              @for (p of patientResults(); track p.id) {
                <li>
                  <button type="button" class="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-glacier" (click)="pickPatient(p)">
                    <span class="flex min-w-0 flex-col">
                      <span class="font-sans text-body-sm text-ink">{{ p.first_name }} {{ p.last_name }}</span>
                      <span class="break-all font-sans text-caption text-slate">{{ p.email }}{{ p.phone ? ' · ' + p.phone : '' }}</span>
                    </span>
                    <sd-icon name="plus" [size]="16" class="shrink-0 text-cerulean" />
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
      <section class="${SECTION} !gap-4">
        <h2 class="${SECTION_TITLE}"><sd-icon name="stethoscope" [size]="20" class="text-cerulean" />2. Specialist</h2>
        @if (specialist(); as s) {
          <div class="flex items-center justify-between gap-3 rounded-field border border-cerulean bg-frost/30 px-4 py-3">
            <div class="flex min-w-0 flex-col">
              <span class="font-sans text-body-sm font-semibold text-ink">{{ s.name }}</span>
              <span class="font-sans text-caption text-slate">{{ s.specialty }} · {{ money(s.consultation_fee) }}</span>
            </div>
            <button type="button" class="min-h-11 shrink-0 px-2 font-sans text-caption font-semibold text-cerulean hover:underline" (click)="clearSpecialist()">Change</button>
          </div>
        } @else {
          <div class="relative">
            <sd-icon name="search" [size]="20" class="${FIELD_ICON}" />
            <input class="${FIELD_WITH_ICON}" aria-label="Search specialists" placeholder="Search specialist by name or specialty…" [value]="specialistTerm()" (input)="specialistTerm.set($any($event.target).value)" />
          </div>
          @if (specialistsError()) {
            <p class="font-sans text-caption text-alert">{{ specialistsError() }}</p>
          } @else if (filteredSpecialists().length > 0) {
            <ul class="flex flex-col divide-y divide-cloud overflow-hidden rounded-field border border-cloud">
              @for (s of filteredSpecialists(); track s.id) {
                <li>
                  <button type="button" class="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-glacier" (click)="pickSpecialist(s)">
                    <span class="flex min-w-0 flex-col">
                      <span class="font-sans text-body-sm text-ink">{{ s.name }}</span>
                      <span class="font-sans text-caption text-slate">{{ s.specialty }} · {{ money(s.consultation_fee) }}@if (s.status && s.status !== 'approved') { · {{ s.status_label ?? s.status }} }</span>
                    </span>
                    <sd-icon name="plus" [size]="16" class="shrink-0 text-cerulean" />
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
      <section class="${SECTION}">
        <h2 class="${SECTION_TITLE}"><sd-icon name="calendar-days" [size]="20" class="text-cerulean" />3. Schedule</h2>
        <div class="flex min-w-0 flex-col gap-3">
          @if (specialist(); as s) {
            @if (notBookable(s); as why) {
              <p class="font-sans text-caption text-alert">{{ why }}</p>
            } @else {
              @if (!useManual()) {
                <sd-booking-calendar
                  [days]="cal.days()"
                  [month]="cal.month()"
                  (monthChange)="cal.setMonth($event)"
                  [selectedDate]="cal.selectedDate()"
                  (selectedDateChange)="cal.selectDate($event)"
                  [slots]="cal.slots()"
                  [value]="slotIso()"
                  (valueChange)="slotIso.set($event)"
                  [loading]="cal.loading()"
                  [slotsLoading]="cal.slotsLoading()"
                  [min]="cal.min()"
                  [max]="cal.max()"
                  [nextAvailable]="cal.nextAvailable()"
                  [timeZone]="cal.tz()"
                  [timeZoneLabel]="cal.timeZoneLabel()"
                  [weekStartsOn]="cal.weekStartsOn()"
                >
                  <p calendarEmpty class="font-sans text-caption text-slate">
                    Pick another day, or use “Enter another time” for a time that isn't shown.
                  </p>
                </sd-booking-calendar>
                @if (cal.error(); as e) {
                  <sd-alert tone="error">{{ e }}</sd-alert>
                }
                <p class="font-sans text-body-sm text-ink" aria-live="polite">
                  @if (slotIso(); as iso) {
                    <span class="font-semibold">Chosen:</span> {{ chosenLabel(iso) }}
                  }
                </p>
              } @else {
                @if (calendarFailed()) {
                  <sd-alert tone="warning">{{ cal.error() }} You can type the time instead.</sd-alert>
                }
                <label class="flex flex-col gap-1.5">
                  <span class="${LABEL}">Date &amp; time ({{ cal.timeZoneLabel() }})</span>
                  <input type="datetime-local" step="1800" class="${FIELD} sm:max-w-xs" [min]="minAt()" [value]="scheduledAt()" (input)="scheduledAt.set($any($event.target).value)" aria-describedby="bo-appt-manual-hint" />
                </label>
                <span id="bo-appt-manual-hint" class="font-sans text-caption text-slate">
                  Must be on the specialist's availability and after the minimum booking notice. Staff aren't held to the patients' booking window.
                </span>
              }
              @if (calendarFailed()) {
                <!-- The typed time shows because the calendar couldn't load: offer it again. -->
                <button type="button" class="flex min-h-11 w-fit items-center gap-1.5 font-sans text-caption font-semibold text-cerulean hover:underline" (click)="retryCalendar()">
                  <sd-icon name="refresh-cw" [size]="14" />Try the calendar again
                </button>
              } @else {
                <button type="button" class="min-h-11 w-fit font-sans text-caption font-semibold text-cerulean hover:underline" (click)="toggleManual()">
                  {{ manual() ? 'Choose from the calendar' : 'Enter another time' }}
                </button>
              }
            }
          } @else {
            <p class="font-sans text-caption text-slate">Choose a specialist to see their booking calendar.</p>
          }
        </div>
        <label class="flex flex-col gap-1.5 sm:max-w-xs">
          <span class="${LABEL}">Type</span>
          <select class="${FIELD}" (change)="type.set($any($event.target).value)">
            @for (t of types; track t.value) { <option [value]="t.value" [selected]="type() === t.value">{{ t.label }}</option> }
          </select>
        </label>
      </section>

      <div aria-live="assertive">
        @if (error()) {
          <sd-alert tone="error">{{ error() }}</sd-alert>
        }
      </div>
      <div class="${FORM_ACTIONS}">
        <a routerLink="/appointments" class="${BTN_GHOST}">Cancel</a>
        <button type="button" class="${BTN_PRIMARY}" [disabled]="!readyToBook() || creating()" (click)="create()">
          {{ creating() ? 'Booking…' : 'Book appointment' }}
        </button>
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
  protected readonly cal = inject(AvailabilityCalendarStore);

  protected readonly types = TYPES;

  // Patient
  protected readonly patientTerm = signal('');
  protected readonly patientResults = signal<PatientSummaryDto[]>([]);
  protected readonly patient = signal<PatientSummaryDto | null>(null);
  protected readonly searchingPatient = signal(false);
  private patientTimer?: ReturnType<typeof setTimeout>;

  // Specialist
  private readonly specialists = signal<SpecialistAdminDto[]>([]);
  protected readonly specialistsError = signal('');
  protected readonly specialistTerm = signal('');
  protected readonly specialist = signal<SpecialistAdminDto | null>(null);
  protected readonly filteredSpecialists = computed(() => {
    const t = this.specialistTerm().trim().toLowerCase();
    if (t === '') return [];
    return this.specialists()
      .filter((s) => s.name.toLowerCase().includes(t) || s.specialty.toLowerCase().includes(t))
      .slice(0, 8);
  });

  // Schedule — a time from the calendar, or a typed one.
  /** The picked time's ISO start (from the calendar). */
  protected readonly slotIso = signal<string | null>(null);
  /** Typing a time instead (e.g. one the calendar doesn't show). */
  protected readonly manual = signal(false);
  /** The typed time — a local datetime-local value. */
  protected readonly scheduledAt = signal('');
  /** The typed time's earliest value: now, on the half hour. */
  protected readonly minAt = signal(nowLocalInput(30));
  /** The calendar couldn't load at all (not just one day's times). */
  protected readonly calendarFailed = computed(() => !!this.cal.error() && !this.cal.range() && !this.cal.loading());
  /** The typed input shows when chosen, or when the calendar couldn't load. */
  protected readonly useManual = computed(() => this.manual() || this.calendarFailed());
  protected readonly type = signal('video');

  protected readonly creating = signal(false);
  protected readonly error = signal('');

  protected readonly readyToBook = computed(
    () =>
      this.patient() !== null &&
      this.specialist() !== null &&
      (this.useManual() ? this.scheduledAt().trim() !== '' : !!this.slotIso()),
  );

  ngOnInit(): void {
    this.specialistsApi
      .listAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.specialists.set(res.data),
        // Without this list every search would read "No specialists match".
        error: (err: unknown) =>
          this.specialistsError.set(apiErrorMessage(err, 'Could not load specialists.')),
      });
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
    this.resetSchedule();
    // The openings a patient would see (lead time, blocks and bookings applied), a year ahead.
    if (!this.notBookable(s)) this.cal.load(s.id, undefined, { scope: 'staff' });
  }
  protected clearSpecialist(): void {
    this.specialist.set(null);
    this.resetSchedule();
  }

  private resetSchedule(): void {
    this.slotIso.set(null);
    this.manual.set(false);
    this.scheduledAt.set('');
    this.minAt.set(nowLocalInput(30));
    this.error.set('');
  }

  protected toggleManual(): void {
    this.manual.update((m) => !m);
    this.minAt.set(nowLocalInput(30));
    this.error.set('');
  }

  /** Load the calendar again after it failed (and show it, not the typed input). */
  protected retryCalendar(): void {
    this.manual.set(false);
    this.error.set('');
    this.cal.refresh();
  }

  /**
   * Why `s` can't be booked (the API's own reasons), or '' when they can. The
   * admin list includes doctors still onboarding, whose calendar is a 404.
   */
  protected notBookable(s: SpecialistAdminDto): string {
    if (s.status && s.status !== 'approved') {
      return s.status === 'suspended'
        ? "This doctor is suspended, so they can't be booked."
        : "This doctor's profile hasn't been approved yet.";
    }
    return s.available ? '' : "This specialist isn't taking bookings right now.";
  }

  protected create(): void {
    const patient = this.patient();
    const specialist = this.specialist();
    if (!patient || !specialist || this.creating()) return;
    const fromCalendar = !this.useManual();
    let scheduledAt = this.slotIso() ?? '';
    if (!fromCalendar) {
      const at = new Date(this.scheduledAt());
      if (this.scheduledAt().trim() === '' || isNaN(at.getTime())) {
        this.error.set('Enter a valid date and time.');
        return;
      }
      if (at.getTime() <= Date.now()) {
        this.error.set('Choose a time in the future.');
        return;
      }
      scheduledAt = at.toISOString();
    } else if (scheduledAt === '') {
      this.error.set('Pick one of the open times.');
      return;
    }
    this.creating.set(true);
    this.error.set('');
    this.appointments
      .create({
        patient_id: patient.id,
        specialist_id: specialist.id,
        scheduled_at: scheduledAt,
        type: this.type(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => void this.router.navigate(['/appointments', res.data.id]),
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not book the appointment.'));
          this.creating.set(false);
          // The time may just have been taken: show the calendar as it is now.
          // (The http-error interceptor rethrows `{ statusCode }`; a raw HttpErrorResponse has `status`.)
          const e = err as { statusCode?: number; status?: number } | null;
          if (fromCalendar && (e?.statusCode ?? e?.status) === 422) {
            this.slotIso.set(null);
            this.cal.refresh();
          }
        },
      });
  }

  /** "Monday 20 October, 9:30" in the viewer's zone. */
  protected chosenLabel(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : `${CHOSEN.format(d)} (${this.cal.timeZoneLabel()})`;
  }

  protected money(amount: string): string {
    const n = Number(amount);
    return isNaN(n) ? '—' : '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
