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
 * The patient's clinical summary shown to the consulting doctor in-call. Only
 * present when `you.role === 'doctor'` — a guest's join link never carries it.
 */
export interface JoinPatientSummary {
  name: string;
  date_of_birth: string | null;
  gender: string | null;
  allergies: AllergyRow[];
  conditions: ConditionRow[];
  medications: MedicationRow[];
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
  /** Present for the doctor role only — the patient's clinical summary. */
  patient?: JoinPatientSummary;
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

/** One post-finalize edit to a clinical note (audit history entry). */
export interface ClinicalNoteAmendment {
  at: string;
  author: string;
  previous: {
    subjective: string | null;
    objective: string | null;
    assessment: string | null;
    plan: string | null;
  };
}

/** The clinician's SOAP note for a consultation (doctor view). */
export interface ClinicalNoteDto {
  appointment_id: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  status: 'draft' | 'finalized';
  finalized_at: string | null;
  author: string | null;
  amendments: ClinicalNoteAmendment[];
  updated_at: string | null;
}

/** The four SOAP fields the doctor saves. */
export interface ClinicalNoteInput {
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
}

/**
 * The patient's view of the consultation write-up (GET
 * /portal/appointments/{id}/consultation). `available` is false until the doctor
 * finalizes the note; a draft is never exposed to the patient.
 */
export interface ConsultationSummaryDto {
  available: boolean;
  subjective?: string | null;
  assessment?: string | null;
  plan?: string | null;
  finalized_at?: string | null;
  author?: string | null;
}

/** One medication line on an e-prescription. */
export interface PrescriptionItem {
  medication: string;
  strength?: string;
  dosage?: string;
  frequency?: string;
  route?: string;
  duration?: string;
  quantity?: string;
  instructions?: string;
  refills?: string;
}

/** An issued (or draft) e-prescription for a consultation. */
export interface PrescriptionDto {
  id: string;
  appointment_id: string;
  items: PrescriptionItem[];
  notes: string | null;
  status: 'draft' | 'signed';
  signed_at: string | null;
  author: string | null;
  created_at: string;
}

/** Body for issuing a prescription (POST .../prescriptions). */
export interface CreatePrescriptionParams {
  items: PrescriptionItem[];
  notes?: string | null;
}

/** A lab / investigation order placed during a consultation. */
export interface LabOrderDto {
  id: string;
  appointment_id: string;
  tests: string[];
  instructions: string | null;
  priority: 'routine' | 'urgent';
  status: string;
  author: string | null;
  created_at: string;
}

/** Body for placing a lab order. */
export interface CreateLabOrderParams {
  tests: string[];
  instructions?: string | null;
  priority?: 'routine' | 'urgent';
}

/** The care plan (doctor-editable view). */
export interface CarePlanDto {
  appointment_id: string;
  items: string[];
  published: boolean;
  author: string | null;
  updated_at: string | null;
}

/** The patient's view of the care plan (available:false until published). */
export interface PatientCarePlanDto {
  available: boolean;
  items: string[];
  author?: string | null;
}

/** A referral raised during a consultation. */
export interface ReferralDto {
  id: string;
  appointment_id: string;
  referral_type: 'specialist' | 'hospital' | 'laboratory' | 'imaging';
  target: string;
  reason: string;
  clinical_summary: string | null;
  priority: 'routine' | 'urgent';
  status: string;
  author: string | null;
  created_at: string;
}

/** Body for raising a referral. */
export interface CreateReferralParams {
  referral_type: 'specialist' | 'hospital' | 'laboratory' | 'imaging';
  target: string;
  reason: string;
  clinical_summary?: string | null;
  priority?: 'routine' | 'urgent';
}

/** One consent decision for a consultation. */
export interface ConsentDto {
  type: 'recording' | 'ai_transcription' | 'data_sharing';
  granted: boolean;
  by_role: string | null;
  by_name: string | null;
  version: string;
  decided_at: string | null;
}

/** A cloud-recording session for a consultation. */
export interface RecordingDto {
  id: string;
  appointment_id: string;
  status: 'recording' | 'stopped' | 'failed';
  started_by: string | null;
  started_at: string;
  stopped_at: string | null;
  files: string[];
}

/** Doctor's recording state (GET .../recording). */
export interface DoctorRecordingStateDto {
  configured: boolean;
  active: boolean;
  recording: RecordingDto | null;
}

/** Patient's recording state (GET .../recordings). */
export interface PatientRecordingsDto {
  active: boolean;
  recordings: RecordingDto[];
}

/** One utterance in the live consultation transcript. */
export interface TranscriptSegmentDto {
  id: string;
  role: 'patient' | 'doctor';
  text: string;
  at: string;
}

/** The AI copilot's structured draft for a consultation (clinician-review only). */
export interface CopilotDraftDto {
  appointment_id: string;
  summary: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  symptoms: string[];
  medications: string[];
  diagnoses: string[];
  follow_up: string | null;
  generated_by: string | null;
  generated_at: string;
}

/** Doctor's copilot state (GET .../copilot). */
export interface DoctorCopilotStateDto {
  configured: boolean;
  draft: CopilotDraftDto | null;
}

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
