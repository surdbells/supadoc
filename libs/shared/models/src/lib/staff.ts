import type {
  AppointmentDto,
  MedicalDto,
  RecordingDto,
  SpecialistAdminDto,
  SpecialistDto,
} from './appointment-api';

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
  email?: string;
  photo_url?: string;
  location?: string;
  languages?: string;
  years_experience?: number | string | null;
  gender?: 'male' | 'female' | '';
  offers_in_person?: boolean;
  available?: boolean;
  weekly_hours?: Record<string, [string, string][]> | null;
}

// ----- Doctor schedule -----

/** A row in the doctor's schedule — an appointment plus join affordances. */
export interface DoctorAppointmentDto extends AppointmentDto {
  patient_name: string;
  join_url: string;
}

/** `GET /api/doctor/appointments` payload. */
export interface DoctorScheduleDto {
  specialist: SpecialistDto;
  appointments: DoctorAppointmentDto[];
}

/** `GET /api/doctor/dashboard` — headline metrics + today's agenda. */
export interface DoctorDashboardDto {
  today: number;
  pending: number;
  upcoming: number;
  completed_month: number;
  patients: number;
  rating: string;
  reviews_count: number;
  earnings_month: string;
  currency: string;
  next: DoctorAppointmentDto | null;
  agenda: DoctorAppointmentDto[];
}

/** The doctor's own profile (specialist + contact email + weekly availability). */
export interface DoctorProfileDto extends SpecialistAdminDto {
  weekly_hours?: WeeklyHours | null;
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
