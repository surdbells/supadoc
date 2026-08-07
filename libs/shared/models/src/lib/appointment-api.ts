/**
 * Wire shapes returned by the VideoMed backend (apps/api) — these mirror the
 * entities' `toArray()` output and the standard `{status,message,data,meta}`
 * envelope. Distinct from the richer domain types in `appointment.ts`, which
 * predate the real API.
 */

export type ApiAppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'rescheduled'
  | 'completed'
  | 'cancelled';

export interface ApiSpecialistRef {
  id: string;
  name: string;
  specialty?: string | null;
}

/** One appointment as serialised by `Appointment::toArray()`. */
export interface AppointmentDto {
  id: string;
  patient_id: string;
  specialist: ApiSpecialistRef;
  scheduled_at: string;
  type: string;
  type_label: string;
  status: ApiAppointmentStatus;
  status_label: string;
  amount: string;
  created_at: string;
}

export interface PageMeta {
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

/** Single-resource success envelope: `{ status, message, data }`. */
export interface SuccessResponse<T> {
  status: string;
  message: string;
  data: T;
}

/** Paginated success envelope: `{ status, message, data: T[], meta }`. */
export interface PaginatedResponse<T> {
  status: string;
  message: string;
  data: T[];
  meta: PageMeta;
}

/** One specialist as serialised by `Specialist::toArray()`. */
export interface SpecialistDto {
  id: string;
  name: string;
  specialty: string;
  location: string | null;
  consultation_fee: string;
  rating: string;
  reviews_count: number;
  available: boolean;
}

/** Agora RTC join credentials for a consultation call. */
export interface CallTokenDto {
  app_id: string;
  channel: string;
  uid: number;
  token: string;
  expires_in: number;
}

/** The signed-in patient's profile, from `Patient::toArray()`. */
export interface PatientProfileDto {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  phone_verified: boolean;
  date_of_birth: string | null;
  gender: string | null;
  address: string | null;
  created_at: string;
}

/** Patient app preferences, from `PatientSettings` (boolean toggles by area). */
export interface PatientSettingsDto {
  notifications: {
    appointment_reminder: boolean;
    consultation_updates: boolean;
    payment_notifications: boolean;
    account_security_alerts: boolean;
    marketing_announcements: boolean;
  };
  delivery: {
    sms: boolean;
    push: boolean;
    email: boolean;
  };
  privacy: {
    two_factor: boolean;
    biometrics: boolean;
  };
}

/** A partial settings patch — any subset of the groups/keys. */
export type PatientSettingsPatch = {
  [G in keyof PatientSettingsDto]?: Partial<PatientSettingsDto[G]>;
};

/** Patient health profile, from `HealthProfile` (all fields free text). */
export interface EmergencyContactDto {
  full_name: string;
  relationship: string;
  phone: string;
  email: string;
}
export interface InsuranceDto {
  provider: string;
  plan: string;
  policy_number: string;
  coverage_status: string;
  expiry_date: string;
}
export interface MedicalHistoryRow {
  condition: string;
  year: string;
  note: string;
}
export interface AllergyRow {
  allergen: string;
  severity: string;
  reaction: string;
}
export interface MedicationRow {
  name: string;
  dosage: string;
  frequency: string;
}
export interface ConditionRow {
  condition: string;
  status: string;
  since: string;
}
export interface MedicalDto {
  history: MedicalHistoryRow[];
  allergies: AllergyRow[];
  medications: MedicationRow[];
  conditions: ConditionRow[];
}
export interface HealthProfileDto {
  emergency_contact: EmergencyContactDto;
  insurance: InsuranceDto;
  medical: MedicalDto;
}
/** A partial save — any subset of the three sections. */
export type HealthProfilePatch = Partial<HealthProfileDto>;

/** One notification, from `Notification::toArray()`. */
export interface NotificationDto {
  id: string;
  type: 'appointment' | 'prescription' | 'payment' | 'system';
  type_label: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

/** Notifications list — the page meta also carries the total unread count. */
export interface NotificationsResponse {
  status: string;
  message: string;
  data: NotificationDto[];
  meta: PageMeta & { unread: number };
}

/** Query params accepted by the portal appointments list endpoint. */
export interface ListAppointmentsQuery {
  page?: number;
  per_page?: number;
  status?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}
