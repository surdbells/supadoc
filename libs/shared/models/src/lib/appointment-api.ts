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

/** An invited third party on a consultation (adds the guest fee). */
export interface GuestInvite {
  name: string;
  email: string;
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
  notes?: string | null;
  document_url?: string | null;
  payment_status?: 'unpaid' | 'pending' | 'paid';
  guests?: GuestInvite[];
  created_at: string;
}

/** Back-office-configurable consultation pricing (GET /public/pricing). */
export interface PricingDto {
  currency: string;
  guest_fee: number;
  platform_fee: number;
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
  years_experience: number | null;
  languages: string | null;
  verified: boolean;
  gender: string | null;
  offers_in_person: boolean;
  photo_url: string | null;
}

/**
 * Back-office partial update of a specialist (PATCH /specialists/{id}). Only the
 * fields present are changed; an empty `email` string clears it.
 */
export interface UpdateSpecialistParams {
  email?: string | null;
  consultation_fee?: string;
  photo_url?: string | null;
  available?: boolean;
  verified?: boolean;
}

/**
 * A specialist as returned by the staff edit endpoint — the base fields plus the
 * normally server-side `email`, echoed back so the operator can confirm the save.
 */
export type SpecialistAdminDto = SpecialistDto & { email: string | null };

/** Filter options for the directory (GET /public/facets). */
export interface SpecialistFacets {
  specialties: SpecialtyCount[];
  locations: string[];
  languages: string[];
}

/** A specialty with its specialist count (GET /public/specialties). */
export interface SpecialtyCount {
  name: string;
  count: number;
}

/** Body for booking a consultation (POST /portal/appointments). */
export interface BookAppointmentParams {
  specialist_id: string;
  scheduled_at: string;
  type?: 'video' | 'follow_up' | 'urgent' | 'routine';
  notes?: string;
  document_url?: string;
  guests?: GuestInvite[];
}

/** One open consultation slot (from GET /portal/specialists/{id}/slots). */
export interface SlotOption {
  iso: string;
  label: string;
  time: string;
}
/** A day with at least one open slot. */
export interface DayAvailability {
  date: string;
  weekday: string;
  day: string;
  slots: SlotOption[];
}

/**
 * Agora RTC join credentials for a consultation call. `token` is null when the
 * project runs in App-ID-only mode (no App Certificate) — the client then joins
 * token-less.
 */
export interface CallTokenDto {
  app_id: string;
  channel: string;
  uid: number;
  token: string | null;
  expires_in: number | null;
}

/**
 * Resolved preauthenticated join link (GET /public/call/{token}). Carries the
 * meeting details and, when video is configured, the Agora credentials.
 */
export interface JoinInfoDto {
  appointment_id: string;
  scheduled_at: string;
  specialist: { name: string; specialty?: string };
  you: { name: string; role: 'patient' | 'doctor' | 'guest' };
  configured: boolean;
  app_id?: string;
  channel?: string;
  uid?: number;
  token?: string | null;
  expires_in?: number | null;
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
  avatar_url: string | null;
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

/** One active sign-in session, from GET /portal/me/sessions. */
export interface SessionDto {
  id: string;
  device: string;
  icon: 'laptop' | 'smartphone';
  ip: string | null;
  created_at: string;
  current: boolean;
}

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
