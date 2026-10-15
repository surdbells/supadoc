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

/** Weekly availability: weekday ("0"=Sun … "6"=Sat) → list of [start, end] "HH:MM". */
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

/** A row in the doctor's schedule — an appointment plus join affordances. */
export interface DoctorAppointmentDto extends AppointmentDto {
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
}

/**
 * A follow-up as the doctor sees it (GET .../follow-ups, POST .../follow-up):
 * the appointment plus the patient's name. `status` 'proposed' = awaiting the
 * patient; `decline_reason` is set when they declined.
 */
export interface DoctorFollowUpDto extends AppointmentDto {
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

/** The doctor's own profile (specialist + contact email/phone + weekly availability). */
export interface DoctorProfileDto extends SpecialistAdminDto {
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
}

/** `GET /api/doctor/availability` payload. */
export interface DoctorAvailabilityDto {
  from: string;
  to: string;
  slot_minutes: number;
  slots: AvailabilitySlotDto[];
}

/** Body for `POST /api/doctor/availability` (publish open slots). */
export interface AddAvailabilityInput {
  date: string;
  start: string;
  end: string;
  duration: number;
  recurring?: boolean;
  weeks?: number;
}

/** Body for `POST /api/doctor/availability/block`. */
export interface BlockAvailabilityInput {
  date: string;
  entire_day?: boolean;
  start?: string;
  end?: string;
  reason?: string;
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
  has_open_payout: boolean;
}

export interface EarningsTxnDto {
  appointment_id: string;
  patient_name: string;
  date: string;
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
