import type {
  AppointmentDto,
  CertificationEntry,
  DoctorLoginStateDto,
  MedicalDto,
  QualificationEntry,
  RecordingDto,
  SpecialistAdminDto,
  SpecialistDto,
  SpecialistStatus,
} from './appointment-api';
import type {
  DoctorStandingDto,
  DoctorSuspensionDto,
  LicenceStateDto,
  LockedField,
  PendingChanges,
  SpecialistCredentialDto,
  SpecialistReviewSummaryDto,
  SuspensionCode,
  TermsStateDto,
} from './doctor-management';
import type { LicenceRoute, SpecialistApplicationLinkDto } from './doctor-application';
import type { TimeZoneSource } from './time-zone';
import type { MonitoringLabRequestsDto } from './lab-request';

/**
 * Weekly availability: weekday ("0"=Sun … "6"=Sat) → list of [start, end]
 * "HH:MM" windows on the doctor's own clock (their profile zone); an end of
 * "24:00" means midnight.
 */
export type WeeklyHours = Record<string, [string, string][]>;

/** A staff/admin/doctor account (mirrors the API `User::toArray()`). */
export interface StaffUserDto {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  roles: string[];
  permissions: string[];
  active: boolean;
  specialist_id: string | null;
  /** False for an invited login that hasn't chosen a password yet. */
  password_set?: boolean;
  /** An invite email is out and its set-password link still works. */
  invite_pending?: boolean;
  invite_expires_at?: string | null;
  created_at: string;
}

/** `POST /api/auth/login` envelope payload for staff accounts. */
export interface StaffLoginData {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  user: StaffUserDto;
}

// ----- Doctor onboarding -----

/** One item of the doctor's onboarding checklist, in the order they work through them. */
export type OnboardingItemKey =
  | 'photo'
  | 'bio'
  | 'qualifications'
  | 'mdcn'
  /** MDCN full-registration certificate uploaded (waiting or verified). */
  | 'mdcn_certificate'
  /** An unexpired annual practising licence uploaded (waiting or verified). */
  | 'practising_licence'
  | 'signature'
  | 'availability'
  | 'payout'
  /** The practitioner terms in force accepted. */
  | 'terms';

/** GET /api/doctor/onboarding — checklist + review status + standing. */
export interface DoctorOnboardingDto {
  status: SpecialistStatus;
  status_label: string;
  /** Why the last review sent the profile back (when rejected). */
  rejection_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  suspended_at?: string | null;
  suspension_code?: SuspensionCode | null;
  suspension_reason?: string | null;
  /** YYYY-MM-DD — last valid day of the current verified licence. */
  licence_expires_at?: string | null;
  /** YYYY-MM-DD — a doctor approved before documents existed must upload them by then. */
  credentials_due_at?: string | null;
  has_pending_changes?: boolean;
  terms_version?: string | null;
  terms_accepted_at?: string | null;
  checklist: Record<OnboardingItemKey, boolean>;
  completed: number;
  total: number;
  /** Every item done — "Submit for review" is allowed. */
  complete: boolean;
  /** The doctor's documents (the reviewer view also lists replaced ones). */
  credentials: SpecialistCredentialDto[];
  /** Fields that change only through a review ([] while onboarding). */
  locked_fields: LockedField[];
  /** Requested changes waiting for a reviewer. */
  pending_changes: PendingChanges | null;
  pending_changes_submitted_at: string | null;
  /** Why the last change request was turned down. */
  changes_review_note: string | null;
  terms: TermsStateDto;
  licence: LicenceStateDto;
  suspension: DoctorSuspensionDto | null;
  /** Why they may not do clinical work now, or null when they may. */
  standing: DoctorStandingDto | null;
  /** 'ng' unless licensed abroad (null on older payloads reads as 'ng'). */
  licence_route?: LicenceRoute;
  registration?: { regulator_name: string | null; regulator_country: string | null; registration_number: string | null } | null;
  /** Set when the doctor came from an approved application. */
  application?: SpecialistApplicationLinkDto | null;
  /** Application doctor still onboarding: "Go live" approves at once when ready. */
  go_live_on_submit?: boolean;
}

/** GET /api/specialists/{id}/onboarding — the back-office review panel. */
export interface SpecialistOnboardingReviewDto extends SpecialistReviewSummaryDto {
  profile: DoctorProfileDto;
  login: DoctorLoginStateDto | null;
}

/** POST /api/specialists/{id}/invite (and staff invites) — what was sent. */
export interface DoctorInviteResultDto {
  email_sent: boolean;
  expires_at: string;
  /** Non-production only: the set-password link, for testing without mail. */
  dev_link?: string;
  login?: DoctorLoginStateDto | null;
}

/** Slim patient result from the staff `GET /api/patients` search. */
export interface PatientSummaryDto {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
}

// ----- Doctor self-service profile -----

/** Fields a doctor may change on their own profile (all optional/partial). */
export interface DoctorProfileUpdate {
  name?: string;
  specialty?: string;
  email?: string;
  phone?: string;
  date_of_birth?: string | null;
  country?: string;
  photo_url?: string;
  location?: string;
  languages?: string;
  years_experience?: number | string | null;
  gender?: 'male' | 'female' | '';
  offers_in_person?: boolean;
  available?: boolean;
  weekly_hours?: Record<string, [string, string][]> | null;
  bio?: string;
  qualifications?: string;
  /** MDCN registration number (printed on prescriptions). */
  mdcn_number?: string;
  expertise?: string[];
  qualification_entries?: QualificationEntry[];
  certifications?: CertificationEntry[];
  slot_minutes?: number;
}

// ----- Doctor schedule -----

/**
 * A row in the doctor's schedule — an appointment plus join affordances.
 * Never carries the patient-only fields (the legacy `document_url`, the
 * patient's `pending_document_request`, the booking's `document_share`).
 */
export interface DoctorAppointmentDto
  extends Omit<AppointmentDto, 'document_url' | 'pending_document_request' | 'document_share'> {
  patient_name: string;
  /**
   * Preauthenticated call link; null on a follow-up proposal the patient hasn't
   * accepted (no call yet), and null while `join_blocked` is set.
   */
  join_url: string | null;
  /**
   * Why there is no link while the doctor may not start clinical work (e.g.
   * terms_required, or doctor_not_approved on the dashboard), else null. Set on
   * every row of GET /doctor/appointments, GET /doctor/appointments/{id} and
   * the dashboard's `next` / `agenda` (other lists leave it out).
   */
  join_blocked?: DoctorStandingDto | null;
  /**
   * The patient's saved zone, for a "patient's time" label; null when they
   * never set or detected one (absent from older APIs).
   */
  patient_timezone?: string | null;
}

/**
 * A follow-up as the doctor sees it (GET .../follow-ups, POST .../follow-up):
 * the appointment plus the patient's name. `status` 'proposed' = awaiting the
 * patient; `decline_reason` is set when they declined. No patient-only fields.
 */
export interface DoctorFollowUpDto
  extends Omit<AppointmentDto, 'document_url' | 'pending_document_request' | 'document_share'> {
  patient_name: string;
}

/** `GET /api/doctor/appointments` payload. */
export interface DoctorScheduleDto {
  specialist: SpecialistDto;
  appointments: DoctorAppointmentDto[];
}

/** `GET /api/doctor/dashboard` — headline metrics + today's agenda. */
export interface DoctorDashboardDto {
  today: number;
  today_completed: number;
  today_delta: number | null;
  pending: number;
  upcoming: number;
  completed_month: number;
  completed_delta: number | null;
  patients: number;
  patients_week: number;
  patients_delta: number | null;
  rating: string;
  reviews_count: number;
  earnings_month: string;
  earnings_delta: number | null;
  currency: string;
  next: DoctorAppointmentDto | null;
  agenda: DoctorAppointmentDto[];
}

/**
 * The doctor's own profile (specialist + contact email/phone + weekly
 * availability). `timezone` is optional here (unlike {@link SpecialistDto}):
 * an older API leaves it out, and the doctor app then uses the clinic zone.
 */
export interface DoctorProfileDto extends Omit<SpecialistAdminDto, 'timezone'> {
  /** The doctor's effective IANA zone (absent from older APIs). */
  timezone?: string;
  /** `auto` (detected), `manual` (chosen) or null (never set); absent from older APIs. */
  timezone_source?: TimeZoneSource | null;
  phone?: string | null;
  date_of_birth?: string | null;
  weekly_hours?: WeeklyHours | null;
  /** MDCN registration number — printed on prescriptions. */
  mdcn_number?: string | null;
  /** Whether a signature picture is saved for prescriptions. */
  has_signature?: boolean;
  /** Fields that change only through a review once approved ([] while onboarding). */
  locked_fields?: LockedField[];
  /** Requested changes to locked fields waiting for a reviewer. */
  pending_changes?: PendingChanges | null;
  pending_changes_submitted_at?: string | null;
  /** Why the last change request was turned down. */
  changes_review_note?: string | null;
}

// ----- Doctor availability (date-specific slots) -----

/** A slot's derived state on the doctor's availability calendar. */
export type SlotStatus = 'open' | 'booked' | 'blocked';

/** One row on the doctor's availability calendar (GET /api/doctor/availability). */
export interface AvailabilitySlotDto {
  id: string;
  starts_at: string;
  ends_at: string;
  kind: 'open' | 'block';
  status: SlotStatus;
  reason: string | null;
  patient_name?: string;
  /** Set on every time a repeating publish created (remove offers "This and later times"). */
  series_id?: string | null;
  /** A block covering the whole local day in the request's `tz` (absent from older APIs). */
  entire_day?: boolean;
}

/** `GET /api/doctor/availability` payload. */
export interface DoctorAvailabilityDto {
  from: string;
  to: string;
  slot_minutes: number;
  slots: AvailabilitySlotDto[];
  /**
   * The zone the dates and times were read in (echoes the request's `tz`).
   * Absent from an older API, which works in UTC: then adding and blocking
   * times must stay off.
   */
  tz?: string;
  /** The recurring weekly grid in play on days with no published times (absent from older APIs). */
  regular_hours?: WeeklyHours | null;
  /** `own` (the doctor's weekly hours) or `default` (the weekday default); null when none. */
  regular_hours_source?: 'own' | 'default' | null;
}

/**
 * How a publish repeats: `none` (that date only), `daily` (Mon–Sun),
 * `weekly` (the start date's weekday) or `days` (the chosen weekdays).
 */
export type AvailabilityRepeat = 'none' | 'daily' | 'weekly' | 'days';

/**
 * Body for `POST /api/doctor/availability` (publish open slots). Dates and
 * "HH:MM" are wall clock in `tz`.
 */
export interface AddAvailabilityInput {
  /** 'YYYY-MM-DD' — the date, or the first day of a repeating publish. */
  date: string;
  /** "HH:MM". */
  start: string;
  /** "HH:MM", or "24:00" for midnight (the next local midnight). */
  end: string;
  /** Slot length in minutes. */
  duration: number;
  /**
   * The doctor's loaded profile zone (`DoctorClock.profileZone()`), never the
   * device's. A zone that is no longer the profile's is refused with 409
   * `timezone_changed` (errors: `TimeZoneChangedError`).
   */
  tz: string;
  /** Default 'none'. */
  repeat?: AvailabilityRepeat;
  /** `repeat: 'days'` only: weekdays, 0 = Sunday … 6 = Saturday. */
  days?: number[];
  /** 1–26, default 8 (ignored for 'none'). */
  weeks?: number;
  /** @deprecated legacy: true ≡ repeat 'weekly' when `repeat` is absent. */
  recurring?: boolean;
}

/** `POST /api/doctor/availability` result. */
export interface AddAvailabilityResultDto {
  created: number;
  /** Already published at that start (skipped). */
  existing: number;
  /** Overlapped another open time (skipped). */
  overlapping: number;
  /** Earlier times today (a repeating publish skips them). */
  past: number;
  /** Created, but under a block (they open if the block is removed). */
  blocked: number;
  /** The new series' id; null for a one-time publish. */
  series_id: string | null;
  /** First / last created start, ISO UTC; null when none were created. */
  first_at: string | null;
  last_at: string | null;
  /** The zone the request was read in (absent from an older API). */
  tz: string;
  repeat: AvailabilityRepeat;
}

/** Body for `POST /api/doctor/availability/block` — date and times are wall clock in `tz`. */
export interface BlockAvailabilityInput {
  date: string;
  entire_day?: boolean;
  start?: string;
  /** "HH:MM", or "24:00" for midnight. */
  end?: string;
  reason?: string;
  /** The doctor's loaded profile zone (409 `timezone_changed` when stale). */
  tz: string;
}

/** `DELETE /api/doctor/availability/{id}?scope=`: just this time, or it and the later times of its series. */
export type DeleteAvailabilityScope = 'one' | 'following';

/** `DELETE /api/doctor/availability/{id}` result; booked times are never removed. */
export interface DeleteAvailabilityResultDto {
  deleted: number;
  kept_booked: number;
}

// ----- Staff notifications -----

export interface StaffNotificationDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

// ----- Reviews -----

export interface ReviewDto {
  id: string;
  specialist_id: string;
  patient_name: string;
  appointment_id: string | null;
  rating: number;
  comment: string | null;
  response: string | null;
  responded_at: string | null;
  created_at: string;
}

export interface ReviewSummaryDto {
  average: string;
  count: number;
  distribution: Record<string, number>;
}

// ----- Patients (doctor-scoped) -----

export interface DoctorPatientListItemDto {
  patient_id: string;
  first_name: string;
  last_name: string;
  email: string;
  visit_count: number;
  last_visit: string | null;
}

export interface DoctorPatientRecordDto {
  patient: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    gender: string | null;
    date_of_birth: string | null;
  };
  medical: MedicalDto;
  appointments: AppointmentDto[];
  visit_count: number;
}

// ----- Earnings & payouts -----

export interface EarningsSummaryDto {
  currency: string;
  commission_percent: number;
  gross_total: string;
  commission_total: string;
  net_total: string;
  payouts_total: string;
  available_balance: string;
  gross_month: string;
  net_month: string;
  completed_count: number;
  /** Missed consultations the patient didn't come to — they count towards gross (absent from older APIs). */
  patient_no_show_count?: number;
  has_open_payout: boolean;
}

/**
 * One earning consultation: completed, or missed with the patient the one who
 * didn't come. `gross` is its amount less any refund (guest fees, a no-show
 * refund share).
 */
export interface EarningsTxnDto {
  appointment_id: string;
  patient_name: string;
  date: string;
  /** completed | missed (absent from older APIs). */
  status?: 'completed' | 'missed';
  /** 'patient' on a missed one; null otherwise. */
  no_show?: 'doctor' | 'patient' | 'both' | null;
  gross: string;
  commission: string;
  net: string;
}

export interface PayoutAccountDto {
  account_holder: string;
  bank_name: string;
  country: string;
  currency: string;
  account_number: string | null;
  iban: string | null;
  swift: string | null;
  routing_number: string | null;
  updated_at: string | null;
}

export interface PayoutAccountInput {
  account_holder: string;
  bank_name: string;
  country: string;
  currency: string;
  account_number?: string | null;
  iban?: string | null;
  swift?: string | null;
  routing_number?: string | null;
}

export type PayoutStatus = 'pending' | 'approved' | 'paid' | 'rejected';

export interface PayoutDto {
  id: string;
  specialist_id: string;
  specialist_name: string;
  amount: string;
  currency: string;
  status: PayoutStatus;
  note: string | null;
  admin_note: string | null;
  decided_by: string | null;
  reference: string | null;
  account: PayoutAccountDto | null;
  requested_at: string;
  decided_at: string | null;
  paid_at: string | null;
}

// ----- Back-office monitoring -----

export interface MonitoringOverviewDto {
  appointments: { total: number; by_status: Record<string, number> };
  clinical_notes: number;
  prescriptions: number;
  lab_orders: number;
  referrals: number;
  recordings: { total: number; active: number };
  audit_events: number;
  /** Lab requests (2026-11); absent from an API before that release. */
  lab_requests?: MonitoringLabRequestsDto;
}

/** One point in an analytics time-series (a day or a month). */
export interface AnalyticsPoint {
  label: string;
  appointments: number;
  revenue: string;
}

/** One specialist's contribution in the analytics report. */
export interface AnalyticsSpecialist {
  id: string;
  name: string;
  appointments: number;
  revenue: string;
}

/** Booking + revenue analytics (GET /api/admin/analytics). */
export interface AnalyticsDto {
  range: '7d' | '30d' | '90d' | '12m';
  granularity: 'day' | 'month';
  from: string;
  to: string;
  kpis: {
    appointments: number;
    revenue: string;
    paid_count: number;
    avg_fee: string;
    completion_rate: number;
  };
  series: AnalyticsPoint[];
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  top_specialists: AnalyticsSpecialist[];
}

export interface MonitoringConsultationRow {
  id: string;
  patient_name: string;
  specialist: string;
  scheduled_at: string;
  status: string;
  status_label: string;
  recording_active: boolean;
}

/** Agora-scale connection sample (0 unknown … 6 down). */
export interface QualitySample {
  uplink: number;
  downlink: number;
  rtt: number;
  worst: number;
  at: string;
}

export interface QualityRow {
  appointment_id: string;
  patient_name: string;
  specialist: string;
  patient: QualitySample | null;
  doctor: QualitySample | null;
  worst: number;
}

export interface MonitoringQualityDto {
  average_rtt: number | null;
  consultations: QualityRow[];
}

export interface AuditEventDto {
  id: string;
  actor_name: string;
  actor_role: string;
  /** The acting user's id, when known (null: the system / older events). */
  actor_id?: string | null;
  action: string;
  appointment_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Re-export so back-office code can import the recording shape from one place. */
export type MonitoringRecordingDto = RecordingDto;

/** One resolved recording file (url is null when storage isn't configured). */
export interface RecordingFileDto {
  recording_id?: string;
  key: string;
  name: string;
  url: string | null;
}

/** Playback/download URLs for a recording (or a consultation's recordings). */
export interface RecordingFilesDto {
  configured: boolean;
  recording?: RecordingDto;
  files: RecordingFileDto[];
}
