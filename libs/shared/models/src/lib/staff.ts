import type { AppointmentDto, RecordingDto, SpecialistDto } from './appointment-api';

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
