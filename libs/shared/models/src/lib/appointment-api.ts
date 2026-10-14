/**
 * Wire shapes returned by the VideoMed backend (apps/api) — these mirror the
 * entities' `toArray()` output and the standard `{status,message,data,meta}`
 * envelope. Distinct from the richer domain types in `appointment.ts`, which
 * predate the real API.
 */
import type { MedicalDocumentDto } from './message';
import type { VitalReadingDto } from './vitals';

/**
 * `proposed` is a follow-up the doctor offered that the patient hasn't answered:
 * it holds the slot until `expires_at` but is not a booking yet (no call, no
 * reminders). Accepting it → `confirmed`; declining, withdrawal or expiry →
 * `cancelled`. Label it "Proposed" (patient: "Awaiting your reply"; doctor:
 * "Awaiting patient").
 */
export type ApiAppointmentStatus =
  | 'proposed'
  | 'pending'
  | 'confirmed'
  | 'rescheduled'
  | 'completed'
  | 'cancelled';

/** Who created a follow-up: the doctor proposed it, or the patient booked it. */
export type FollowUpProposedBy = 'doctor' | 'patient';

/** The back office's follow-up fee mode (inside the follow-up window). */
export type FollowUpFeeMode = 'full' | 'percent' | 'free';

/**
 * Which rule priced a follow-up: the doctor waived it, free / percent / full
 * mode inside the window, or the full fee because it starts after the window.
 */
export type FollowUpPriceRule = 'waived' | 'free' | 'percent' | 'full' | 'outside_window';

/** How a follow-up was priced (`AppointmentDto.follow_up_pricing`). Money is a string. */
export interface FollowUpPriceDto {
  /** The doctor's full consultation fee. */
  base_fee: string;
  /** The follow-up consultation price (before any guest fees). */
  amount: string;
  rule: FollowUpPriceRule;
  /** The discount applied: 0 for full / outside_window, 100 for free / waived. */
  discount_percent: number;
  window_days: number;
  /** Follow-up pricing applies to follow-ups starting up to this time. */
  window_ends_at: string;
  waived: boolean;
}

/**
 * A follow-up price before proposing / booking / accepting (the follow-up
 * quote endpoints). When `free`, there is no card checkout, no wallet posting
 * and no platform fee (`platform_fee` is 0).
 */
export interface FollowUpQuoteDto extends FollowUpPriceDto {
  parent_appointment_id: string;
  /** The start time this price is for. */
  scheduled_at: string;
  currency: string;
  within_window: boolean;
  free: boolean;
  platform_fee: number;
}

/** A follow-up's summary of the consultation it follows on from. */
export interface AppointmentParentRef {
  id: string;
  scheduled_at: string;
  status: ApiAppointmentStatus;
  specialist_name: string;
}

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

/** Patient identity on the admin appointment payload (Appointment::toAdminArray). */
export interface AppointmentPatientRef {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

/** One appointment as serialised by `Appointment::toArray()`. */
export interface AppointmentDto {
  id: string;
  patient_id: string;
  /** Present on admin endpoints (toAdminArray) — who booked the appointment. */
  patient?: AppointmentPatientRef;
  specialist: ApiSpecialistRef;
  scheduled_at: string;
  type: string;
  type_label: string;
  status: ApiAppointmentStatus;
  status_label: string;
  amount: string;
  notes?: string | null;
  /**
   * Legacy public attachment URL — null once the API's prod migration has run.
   * Booking attachments are medical documents now: list them with
   * `DocumentsApi.list({ appointment_id })`.
   */
  document_url?: string | null;
  /** A free consultation (amount 0) is `paid` from the start — nothing is owed. */
  payment_status?: 'unpaid' | 'pending' | 'paid' | 'refunded';
  guests?: GuestInvite[];
  // ----- Follow-ups (null on an ordinary booking; absent from older APIs) -----
  /** The consultation this follow-up follows on from. */
  parent_appointment_id?: string | null;
  parent?: AppointmentParentRef | null;
  proposed_by?: FollowUpProposedBy | null;
  /**
   * The doctor's note to the patient on a proposal — patient and doctor
   * payloads only (never admin), never in emails or notifications.
   */
  follow_up_note?: string | null;
  follow_up_pricing?: FollowUpPriceDto | null;
  /** When an unanswered proposal closes. Only meaningful while `status === 'proposed'`. */
  expires_at?: string | null;
  /** The patient's reason for declining a proposal (patient and doctor payloads only). */
  decline_reason?: string | null;
  /**
   * How a doctor's proposal closed unaccepted (status `cancelled`): declined by
   * the patient, withdrawn (by the doctor or the back office), or expired
   * unanswered. null while open, once accepted, and on proposals closed
   * before it was recorded.
   */
  follow_up_outcome?: FollowUpOutcome | null;
  created_at: string;
}

/** {@link AppointmentDto.follow_up_outcome}. */
export type FollowUpOutcome = 'declined' | 'withdrawn' | 'expired';

/** A patient account as serialised by `Patient::toArray()` (admin console). */
export interface PatientAccountDto {
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
  two_factor_enabled: boolean;
  created_at: string;
}

/** GET /api/admin/patients/{id} payload — the account plus recent appointments. */
export interface PatientDetailDto {
  patient: PatientAccountDto;
  appointments: AppointmentDto[];
  appointments_total: number;
}

/**
 * Back-office-configurable consultation pricing (GET /public/pricing). A
 * follow-up starting within `follow_up_window_days` of the consultation it
 * follows costs the doctor's fee (`full`), that fee less
 * `follow_up_discount_percent` (`percent`) or nothing (`free`); later than that
 * it is the full fee. Optional on older APIs.
 */
export interface PricingDto {
  currency: string;
  guest_fee: number;
  platform_fee: number;
  follow_up_fee_mode?: FollowUpFeeMode;
  follow_up_discount_percent?: number;
  follow_up_window_days?: number;
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
/** A structured qualification entry, e.g. { title: 'MBBS', institution: 'CMC', year: '2011' }. */
export interface QualificationEntry {
  title: string;
  institution: string;
  year: string;
}

/** A structured certification entry, e.g. { name: '…', body: 'RSSDI', year: '2019' }. */
export interface CertificationEntry {
  name: string;
  body: string;
  year: string;
}

export interface SpecialistDto {
  id: string;
  name: string;
  specialty: string;
  location: string | null;
  country?: string | null;
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
  bio?: string | null;
  qualifications?: string | null;
  expertise?: string[];
  qualification_entries?: QualificationEntry[];
  certifications?: CertificationEntry[];
  slot_minutes?: number;
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

/** Body for POST /api/specialists — onboard a new specialist (back office). */
export interface CreateSpecialistParams {
  name: string;
  specialty: string;
  email?: string;
  consultation_fee?: string;
  bio?: string;
  languages?: string;
  location?: string;
  years_experience?: number | string;
  gender?: 'male' | 'female' | '';
  photo_url?: string;
  available?: boolean;
  verified?: boolean;
}

/**
 * A specialist as returned by the staff edit endpoint — the base fields plus the
 * normally server-side `email`, echoed back so the operator can confirm the save.
 */
export type SpecialistAdminDto = SpecialistDto & {
  email: string | null;
  /** Back office only: where the doctor is in onboarding (absent on older payloads). */
  status?: SpecialistStatus;
  status_label?: string;
  rejection_reason?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  /** The doctor login linked to this specialist, or null when not invited yet. */
  login?: DoctorLoginStateDto | null;
};

/**
 * Doctor onboarding status: invited (setting up) → pending_review → approved, or
 * rejected (sent back with a reason) / suspended. A legacy doctor reads as approved.
 */
export type SpecialistStatus =
  | 'invited'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'suspended';

/** A specialist's doctor-login state, as the back office sees it. */
export interface DoctorLoginStateDto {
  id: string;
  email: string;
  active: boolean;
  /** False until the doctor chooses a password from their invite link. */
  password_set: boolean;
  /** An invite email is out and its link still works. */
  invite_pending: boolean;
  invite_expires_at: string | null;
}

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
  /**
   * Up to 10 of the patient's documents to attach — ids from
   * `AppointmentsApi.uploadDocument`. Each must be theirs and not attached to
   * another booking, or the booking is refused (422 `document_ids.N`).
   */
  document_ids?: string[];
  guests?: GuestInvite[];
  /** Paystack reference from pay-init — pays by card instead of the wallet. */
  payment_reference?: string;
  /**
   * Book a follow-up of this completed consultation (same doctor): the booking
   * becomes type `follow_up`, linked to it and priced by the follow-up rules
   * (422 `parent_appointment_id` / `specialist_id` otherwise).
   */
  parent_appointment_id?: string;
}

/** Body for POST /api/doctor/appointments/{id}/follow-up (the doctor proposes). */
export interface ProposeFollowUpParams {
  /** One of the doctor's open slots, at least 2h30 from now. */
  scheduled_at: string;
  /** Shown to the patient in the app only (≤ 1000 characters). */
  note?: string;
  /** Make it free. */
  waive_fee?: boolean;
}

/** Body for POST /api/portal/appointments/{id}/follow-up/accept. */
export interface AcceptFollowUpParams {
  /** Required unless the follow-up is free. */
  payment_method?: 'wallet' | 'card';
  /** With `card`: the pay-init reference once paid. */
  payment_reference?: string;
  /** Another open slot of the same doctor instead of the proposed time. */
  scheduled_at?: string;
}

/**
 * The answer to POST /api/portal/appointments/{id}/follow-up/accept. `meta` is
 * there when it had been accepted already and the card payment this request
 * brought wasn't needed: it was credited to the wallet (the message says so).
 */
export interface AcceptFollowUpResponse extends SuccessResponse<AppointmentDto> {
  meta?: { card_payment: 'credited_to_wallet'; credited_amount: string };
}

/**
 * What pay-init prices: a follow-up booking of a completed consultation
 * (`parent_appointment_id` + `scheduled_at`) on top of the doctor + guests.
 */
export interface PayInitFollowUp {
  parent_appointment_id: string;
  scheduled_at: string;
}

/**
 * Response of POST /portal/appointment-documents: the file, filed privately in
 * the patient's medical documents as a Booking Attachment. `url` is the
 * authenticated download route (it needs the bearer token), never a public URL.
 */
export interface AppointmentDocumentDto extends MedicalDocumentDto {
  readonly url: string;
}

/** Response of POST /portal/appointments/pay-init — a direct card checkout. */
export interface AppointmentPayInitDto {
  authorization_url: string;
  access_code: string;
  reference: string;
  amount: string;
  currency: string;
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
  /** Present on the doctor-gated payload — lets the doctor open the full record. */
  id?: string;
  name: string;
  date_of_birth: string | null;
  gender: string | null;
  allergies: AllergyRow[];
  conditions: ConditionRow[];
  medications: MedicationRow[];
  history: MedicalHistoryRow[];
  /** Latest reading of each type (who recorded it, whether it is out of date). */
  vitals?: VitalReadingDto[];
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
  two_factor_enabled?: boolean;
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
  /** What it is for (groups the doctor's side panel). */
  reason?: string;
  /** "1" when herbal / traditional; "" otherwise. */
  herbal?: string;
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

// Prescription models live in ./prescription.ts.

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

/** A medical certificate issued during a consultation. */
export interface MedicalCertificateDto {
  id: string;
  appointment_id: string;
  type: 'sick_leave' | 'fitness' | 'general';
  type_label: string;
  diagnosis: string | null;
  statement: string;
  from_date: string | null;
  to_date: string | null;
  days: number | null;
  author: string | null;
  created_at: string;
}

/**
 * The doctor's certificates list. `meta` is the sick-leave backdate floor on the
 * clinic calendar (absent from an older API) — a picker hint; the POST decides.
 */
export interface CertificatesListResponse extends SuccessResponse<MedicalCertificateDto[]> {
  meta?: { earliest_from_date: string; backdate_days: number };
}

/** Body for issuing a medical certificate. */
export interface CreateCertificateParams {
  type: 'sick_leave' | 'fitness' | 'general';
  statement: string;
  diagnosis?: string | null;
  from_date?: string | null;
  to_date?: string | null;
}

/** A printable clinical document kind, addressable via .../documents/{kind}/{id}. */
/** HTML-rendered clinical documents. Prescriptions are PDF-only (signed links). */
export type ClinicalDocumentKind = 'referral' | 'certificate';

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
export type NotificationType = 'appointment' | 'prescription' | 'payment' | 'message' | 'system';

/** How many notifications of one type the patient has, and how many are unread. */
export interface NotificationTypeCount {
  total: number;
  unread: number;
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  type_label: string;
  title: string;
  body: string;
  /** In-app deep link opened when tapped (e.g. /dashboard/prescriptions/{id}). */
  link?: string | null;
  read: boolean;
  created_at: string;
}

/**
 * Notifications list — the page meta also carries the total unread count and
 * (newer APIs) the total / unread per type for the filter tabs.
 */
export interface NotificationsResponse {
  status: string;
  message: string;
  data: NotificationDto[];
  meta: PageMeta & { unread: number; counts?: Record<NotificationType, NotificationTypeCount> };
}

/** Query params accepted by the portal appointments list endpoint. */
export interface ListAppointmentsQuery {
  page?: number;
  per_page?: number;
  status?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}

/** Who is in an appointment's call right now (from their call screens' heartbeats). */
export interface CallPresenceDto {
  doctor: boolean;
  patient: boolean;
}

/** Presence by appointment id — only appointments with someone in the call. */
export type CallPresenceMap = Record<string, CallPresenceDto>;
