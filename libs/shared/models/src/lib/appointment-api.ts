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
 *
 * `missed` is a confirmed consultation whose time passed with no proof it took
 * place — closed by the reminders cron (or the back office); terminal.
 * `AppointmentDto.no_show` says who didn't come. Don't sort appointments into
 * Upcoming / History by status: use `phase` (or `?when=`), and show
 * `display_status` / `display_label` / `display_detail`.
 */
export type ApiAppointmentStatus =
  | 'proposed'
  | 'pending'
  | 'confirmed'
  | 'rescheduled'
  | 'completed'
  | 'cancelled'
  | 'missed';

/**
 * Where an appointment is in TIME (server-computed): `upcoming` — still to
 * come; `live` — started and not yet 30 minutes past `ends_at`, or someone is
 * in the call; `past` — over: closed (completed / cancelled / missed), ended
 * more than 30 minutes ago, or a proposal past its expiry.
 */
export type AppointmentPhase = 'upcoming' | 'live' | 'past';

/**
 * How every app shows an appointment (server-computed, one mapping):
 * `upcoming` / `live`; `finalising` — ended, being closed (confirmed, or both
 * sides came); `completed`; `cancelled` (incl. a declined / withdrawn
 * proposal); `missed`; `not_confirmed` — the doctor didn't confirm in time;
 * `expired` — a follow-up proposal not taken up.
 */
export type AppointmentDisplayStatus =
  | 'upcoming'
  | 'live'
  | 'finalising'
  | 'completed'
  | 'cancelled'
  | 'missed'
  | 'not_confirmed'
  | 'expired';

/** A missed consultation: who didn't come. */
export type AppointmentNoShow = 'doctor' | 'patient' | 'both';

/**
 * Why it was closed when not by an ordinary patient / doctor action:
 * `expired_unconfirmed` (the doctor never confirmed it before it ended —
 * cancelled, refunded in full), `no_show` (missed), `auto_completed` (closed by
 * the cron on proof it took place), `staff_cancelled` / `staff_completed`.
 */
export type AppointmentClosureReason =
  | 'expired_unconfirmed'
  | 'no_show'
  | 'auto_completed'
  | 'staff_cancelled'
  | 'staff_completed';

/** Who moved an appointment last. A doctor's move confirms it; a patient's waits for the doctor. */
export type AppointmentRescheduledBy = 'patient' | 'doctor' | 'staff';

/**
 * The lists' `?when=` time split: `upcoming` (still to come or live, soonest
 * first), `past` (over, newest first), `attention` (staff and doctor lists
 * only: past and still open — pending / confirmed / rescheduled after it
 * ended). Patients' lists take upcoming | past.
 */
export type AppointmentWhen = 'upcoming' | 'past' | 'attention';

/** GET /portal/appointments/{id} `cancel_policy`: what cancelling now would refund. */
export interface AppointmentCancelPolicyDto {
  /** 100, or the late-cancellation share of the consultation fee (guest fees always in full). */
  refund_percent: number;
  /** What would go back to the wallet ('0.00' when nothing was paid). */
  refund_amount: string;
  /** The late window before the start (0 = none: a full refund until the start). */
  late_cancel_hours: number;
}

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

/** An invited third party on a consultation (adds the guest fee) — what the patient enters. */
export interface GuestInvite {
  name: string;
  email: string;
}

/**
 * A guest as every appointment payload carries them (patient, doctor, back
 * office): names only, never an email. `id` is null only for a guest from
 * before guests had identities, until the API's prod migration has run. The
 * patient's full guest list is `AppointmentsApi.guests(id)`.
 */
export interface AppointmentGuestRef {
  id: string | null;
  name: string;
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
  /** Invited guests — names only (see {@link AppointmentGuestRef}). */
  guests?: AppointmentGuestRef[];
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

  // ----- Lifecycle (server-computed; always sent by this API — optional only for older payloads/fixtures) -----
  /** scheduled_at + the doctor's slot length. */
  ends_at?: string;
  /** By TIME — sort lists by this, not by status. */
  phase?: AppointmentPhase;
  display_status?: AppointmentDisplayStatus;
  /**
   * Badge text: upcoming → the status label (Pending, Confirmed, Rescheduled,
   * Proposed); else In progress, Being finalised, Completed, Cancelled,
   * Declined, Withdrawn, Missed, Not confirmed, Expired.
   */
  display_label?: string;
  /**
   * A line under the badge, worded for the viewer, e.g. patient "You didn't
   * join" / "Doctor didn't attend" / "Neither joined" / "Doctor didn't confirm
   * in time" / "Awaiting doctor confirmation" / "Your doctor moved this
   * consultation"; doctor "Patient didn't join" / "You didn't attend" / "You
   * didn't confirm in time" / "Awaiting your confirmation". null when none.
   */
  display_detail?: string | null;
  /** Past and still open (pending / confirmed / rescheduled): the cron closes it or the back office resolves it. */
  needs_attention?: boolean;
  /** Patient payloads: an open booking before its start (after it: 422 "This consultation has started"). */
  can_cancel?: boolean;
  /**
   * Patient payloads: an open booking before its start (the list and detail also say false inside the
   * late-cancellation window — the reschedule would be a 422). Doctor payloads: an open booking until 30 min after its end.
   */
  can_reschedule?: boolean;
  /** Doctor payloads: pending / rescheduled and not yet 30 min past its end. */
  can_confirm?: boolean;
  /**
   * Doctor payloads: POST /doctor/appointments/{id}/decline is allowed now — a confirmed booking
   * before its start; a pending / rescheduled one until 30 min after its end (else 422 errors.status).
   */
  can_decline?: boolean;
  closure_reason?: AppointmentClosureReason | null;
  /** A missed consultation: who didn't come. */
  no_show?: AppointmentNoShow | null;
  /** When it reached completed / cancelled / missed. */
  closed_at?: string | null;
  rescheduled_by?: AppointmentRescheduledBy | null;
  /**
   * What went back to the wallet for it so far (null: nothing). Partial on a
   * missed consultation or a late cancellation — payment_status stays `paid`
   * until all of it went back.
   */
  refunded_amount?: string | null;
  /** Admin payloads: the doctor's / patient's first call heartbeat inside [start − 15 min, end + 30 min]. */
  doctor_first_joined_at?: string | null;
  patient_first_joined_at?: string | null;
  /** GET /portal/appointments/{id} only: set while it can be cancelled (`can_cancel`), else null. */
  cancel_policy?: AppointmentCancelPolicyDto | null;
}

/** POST /appointments/{id}/resolve and a staff cancel answer the appointment plus what this call refunded. */
export interface ResolvedAppointmentDto extends AppointmentDto {
  refunded_now: string;
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
  /** On directory listings and suggestions: when this doctor is free (no extra request needed). */
  availability?: SpecialistAvailabilitySummary;
}

/**
 * Back-office partial update of a specialist (PATCH /specialists/{id}). Only the
 * fields present are changed; an empty `email` string clears it.
 */
export interface UpdateSpecialistParams {
  email?: string | null;
  consultation_fee?: string;
  /**
   * Only '' / null (clear — the stored upload is deleted) or the current value
   * unchanged; anything else, links included, is refused (422). Upload with
   * `SpecialistsApi.uploadPhoto()`, remove with `SpecialistsApi.removePhoto()`.
   */
  photo_url?: string | null;
  /**
   * Onboarding only: an active label from the specialty reference list
   * (`ReferenceApi.publicList('specialty')`), else 422 "Choose a specialty
   * from the list". Once the doctor is approved only the current value is
   * accepted (a no-op) — a change goes through the doctor's change request.
   */
  specialty?: string;
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
  /**
   * @deprecated Refused unless empty (422): create the specialist, then upload
   * the photo with `SpecialistsApi.uploadPhoto(id, file)`.
   */
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
  /** Genders listed doctors gave, lower-case (absent from older APIs). */
  genders?: string[];
  /** Cheapest / dearest listed fee as decimal strings; null when nobody is listed. */
  fee_range?: { min: string; max: string } | null;
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

/* ---------------------------------------------------------------------------
 * Booking calendar + availability search (GET /public/specialists/{id}/availability,
 * /public/specialists/{id}/slots?date=, /public/specialists/suggestions).
 * Dates are 'YYYY-MM-DD' calendar days in the requested `tz`; instants are ISO UTC.
 * ------------------------------------------------------------------------- */

/**
 * A calendar day's state: open times left (`available`, or `few` at or under the
 * "few left" setting), `full` (had times, all taken), `closed` (no hours),
 * `blocked` (the doctor blocked it), `past` (before today) or `beyond` (after
 * bookable_until).
 */
export type AvailabilityDayStatus = 'available' | 'few' | 'full' | 'closed' | 'blocked' | 'past' | 'beyond';

/** One calendar day of a specialist's availability. */
export interface AvailabilityDayDto {
  /** 'YYYY-MM-DD' in the requested time zone. */
  date: string;
  status: AvailabilityDayStatus;
  /** Open times that day (0 unless available / few). */
  open: number;
  /** The first open time, ISO UTC, or null. */
  first: string | null;
}

/** GET /public/specialists/{id}/availability — one per date in from … to (≤ 42 days). */
export interface AvailabilityRangeDto {
  /** The IANA zone the days are in (an unknown `tz` falls back to the clinic's). */
  tz: string;
  /** 'YYYY-MM-DD' — today in `tz`. */
  today: string;
  /** 'YYYY-MM-DD' — the date of the earliest bookable time (now + lead time). */
  bookable_from: string;
  /** 'YYYY-MM-DD' — the date of the last bookable time (now + horizon). */
  bookable_until: string;
  horizon_days: number;
  slot_minutes: number;
  /** The next open time anywhere in the booking window, ISO UTC, or null. */
  next_available: string | null;
  days: AvailabilityDayDto[];
}

/** Part of the day on the viewer's clock: morning 05–12, afternoon 12–17, evening 17–05. */
export type PartOfDay = 'morning' | 'afternoon' | 'evening';

/** One open time on a day. */
export interface DaySlotDto {
  /** The instant, ISO UTC. */
  iso: string;
  /** 'HH:mm' in the requested time zone. */
  time: string;
  /** e.g. "9:30 AM" in the requested time zone. */
  label: string;
  period: PartOfDay;
}

/** GET /public/specialists/{id}/slots?date= — the open times on one date. */
export interface DaySlotsDto {
  date: string;
  tz: string;
  slots: DaySlotDto[];
}

/**
 * When a listed doctor is free. `date` is the day described (a filtered date's
 * first matching opening, else the next opening); `next_available_at` is the
 * next opening at all.
 */
export interface SpecialistAvailabilitySummary {
  date: string | null;
  open_slots: number;
  first_slot_at: string | null;
  /** Up to three open times that date, ISO UTC. */
  slots_preview: string[];
  next_available_at: string | null;
}

/** Which filter a tier-1 suggestion relaxed. */
export type SuggestionRelaxedFilter = 'part_of_day' | 'location' | 'gender' | 'language' | 'fee';

/** A similar doctor: 0 = every filter holds, 1 = one filter relaxed, 2 = free within 3 days instead. */
export interface SpecialistSuggestionDto {
  specialist: SpecialistDto;
  availability: SpecialistAvailabilitySummary;
  /** `relaxed` holds {@link SuggestionRelaxedFilter} values; `reason` e.g. "Same specialty · free 10:00 AM". */
  match: { tier: number; relaxed: string[]; reason: string };
}

/** GET /public/specialists/suggestions. `requested` is the `like` doctor (null without one). */
export interface SpecialistSuggestionsDto {
  requested: { id: string; available_on_date: boolean; next_available_at: string | null } | null;
  suggestions: SpecialistSuggestionDto[];
}

/** GET/PATCH /settings/booking — the booking rules (settings.manage); out-of-range → 422 per field. */
export interface BookingSettingsDto {
  /** How many days ahead patients may book (7–180). */
  horizon_days: number;
  /** Minimum notice before a consultation, in minutes (15–1440). */
  lead_minutes: number;
  /** A day with this many open times or fewer shows as "few left" (1–10). */
  few_left: number;
  // ----- Past consultations (absent from older APIs) -----
  /** A past consultation closes this long after its end: completed on proof, else a confirmed one is marked missed (1–168, default 12). */
  missed_after_hours?: number;
  /**
   * A request the doctor never confirmed is cancelled (refunded in full) this long after its end
   * (0–1440, default 0) — never inside the doctor's 30-minute confirm grace (effective minimum 30).
   */
  unconfirmed_expiry_minutes_after_end?: number;
  /** Missed, the patient didn't come: % of the fee refunded; the doctor earns the rest (0–100, default 0). */
  noshow_patient_refund_pct?: number;
  /** Missed, neither came: % of the fee refunded; the doctor earns nothing (0–100, default 0). A doctor no-show always refunds 100%. */
  noshow_both_refund_pct?: number;
  /**
   * A confirmed consultation cancelled within this many hours of its start refunds late_cancel_refund_pct,
   * and the patient can no longer move it (0–168; 0 = off, the default). Never a booking the doctor moved.
   */
  late_cancel_hours?: number;
  /** 0–100, default 100. */
  late_cancel_refund_pct?: number;
  /** Staff are alerted when a doctor reaches this many no-shows in 30 days (1–20, default 2). */
  doctor_noshow_alert_threshold?: number;
}

/**
 * POST /appointments/{id}/resolve — settle a missed or stale consultation
 * (appointments.update), audited with `reason` (3–500 characters):
 *  - `held`: → completed (patient notice, earnings); refund none (default) | full | amount.
 *  - `no_show`: a past open booking → missed, or change who didn't come;
 *    `no_show` required; refund policy (default: the no-show rules, topping up,
 *    never taking back) | full | none | amount.
 *  - `cancel`: → cancelled; refund full (default, guest fees included) | none | amount.
 *  - `refund`: give back more of a closed one; refund full (default) | amount.
 * `amount` (money string) with `refund: 'amount'`, at most what is left (422 `amount`).
 */
export type AppointmentResolveAction = 'held' | 'no_show' | 'cancel' | 'refund';
export type AppointmentRefundMode = 'policy' | 'full' | 'none' | 'amount';
export interface ResolveAppointmentParams {
  action: AppointmentResolveAction;
  reason: string;
  no_show?: AppointmentNoShow;
  refund?: AppointmentRefundMode;
  amount?: string;
  /**
   * 8–64 of A–Z a–z 0–9 _ - (e.g. a UUID made when the dialog opens): an
   * `amount` refund retried or double-submitted with the same key posts once.
   */
  idempotency_key?: string;
}

/**
 * PATCH /appointments/{id}/status body. `cancelled` refunds in full by default
 * (`refund: 'none'` needs a `reason`; `'amount'` + `amount`); `completed` goes
 * through the completer (only once started). `missed` is refused — use resolve.
 */
export interface UpdateAppointmentStatusParams {
  status: Exclude<ApiAppointmentStatus, 'proposed' | 'missed'>;
  refund?: 'full' | 'none' | 'amount';
  amount?: string;
  reason?: string;
  /** See {@link ResolveAppointmentParams.idempotency_key}. */
  idempotency_key?: string;
}

/** Who a call participant is. */
export type CallParticipantRole = 'patient' | 'doctor' | 'guest';

/**
 * Someone who may be in the call, keyed by the Agora uid they join as — so a
 * client can label each remote tile. The patient is uid 1, the doctor uid 2,
 * each guest their own stable uid (100+). Names only, never an email. An
 * unknown uid (a guest invited after you loaded this) → refresh it from the
 * next presence heartbeat ({@link CallPresenceBeatDto}).
 */
export interface CallParticipantDto {
  uid: number;
  role: CallParticipantRole;
  /** A guest: the name they chose in the lobby, else the invitation's. */
  name: string;
  /** Guests only: their guest id (matches {@link CallPresenceDto.guests}). */
  id?: string;
  /** Guests only: accepted the recording + privacy notice. */
  consented?: boolean;
}

/** The Agora uids of the patient and the doctor; guests get 100 and up. */
export const PATIENT_CALL_UID = 1;
export const DOCTOR_CALL_UID = 2;

/**
 * Agora RTC join credentials for a consultation call. `token` is null when the
 * project runs in App-ID-only mode (no App Certificate) — the client then joins
 * token-less. The patient joins as uid 1 (`uid`); call again to renew the
 * token (token-privilege-will-expire).
 */
export interface CallTokenDto {
  app_id: string;
  channel: string;
  uid: number;
  token: string | null;
  expires_in: number | null;
  /** Everyone who may be in the call, by uid (absent from older APIs). */
  participants?: CallParticipantDto[];
}

/**
 * A guest's recording + privacy notice (join link / lobby / consent). When
 * `required` (recording could happen: cloud recording is set up and the
 * patient agreed, or one is running) the guest must accept it —
 * `AppointmentsApi.consentToCall` — before joining (else 403
 * `consent_required`). Otherwise show the privacy notice only; still send the
 * consent when the guest ticks it, so a recording started later finds them ready.
 */
export interface GuestConsentStateDto {
  required: boolean;
  recording_possible: boolean;
  recording_active: boolean;
  given: boolean;
  consented_at: string | null;
  version: string;
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

/** Who you are in the call (join link / lobby). */
export interface CallYouDto {
  /** A guest: the name they chose in the lobby, else the invitation's. */
  name: string;
  role: CallParticipantRole;
  /** The Agora uid you join as (absent from older APIs). */
  uid?: number;
  /** Guests only: your guest id. */
  id?: string;
}

/**
 * What every call screen shows (join link and lobby): the consultation, who
 * you are, and everyone who may be in the call by uid. A guest's also say who
 * invited them, when they can join, and their notice state. Never health data
 * (except the doctor's `patient` on the join), never emails.
 */
export interface CallMeetingDto {
  appointment_id: string;
  scheduled_at: string;
  /** scheduled_at + the booked slot length (absent from older APIs). */
  ends_at?: string;
  duration_minutes?: number;
  status?: ApiAppointmentStatus;
  specialist: { name: string; specialty?: string };
  you: CallYouDto;
  /** The uid to join Agora as (= you.uid). */
  uid?: number;
  /** Everyone who may be in the call, by uid (absent from older APIs). */
  participants?: CallParticipantDto[];
  /** Guests only: the patient who invited them. */
  invited_by?: { first_name: string };
  /** Guests only: joining opens 15 minutes before the start… */
  opens_at?: string;
  /** …and closes 60 minutes after the slot ends. */
  closes_at?: string;
  /** Guests only. */
  consent?: GuestConsentStateDto;
}

/**
 * Resolved preauthenticated join link (GET /public/call/{token}). Carries the
 * meeting details and, when video is configured, the Agora credentials. Call
 * it again with the same token to renew (token-privilege-will-expire): the
 * same checks apply, so a refusal then means leave ({@link CallRefusalCode}).
 */
export interface JoinInfoDto extends CallMeetingDto {
  /** Present for the doctor role only — the patient's clinical summary. */
  patient?: JoinPatientSummary;
  configured: boolean;
  app_id?: string;
  channel?: string;
  token?: string | null;
  expires_in?: number | null;
}

/**
 * GET /public/call/{token}/lobby — the pre-join screen, without Agora
 * credentials. An early guest gets it too: `can_join` false until `opens_at`
 * (count down from `server_time`, so a wrong device clock doesn't matter).
 */
export interface CallLobbyDto extends CallMeetingDto {
  server_time: string;
  can_join: boolean;
}

/**
 * Why a join link can't be used now — `errors.code` on a refused join / lobby /
 * consent / heartbeat (`errors.call` is the message):
 *   cancelled, ended, withdrawn → 410 (a final screen; a call in progress leaves),
 *   not_confirmed → 409 (an unaccepted follow-up; `errors.status = 'proposed'`),
 *   too_early → 425 (`errors.starts_at`, `errors.opens_at`, `errors.server_time`),
 *   consent_required → 403 (`errors.consent`: accept the notice, then join).
 */
export type CallRefusalCode =
  | 'cancelled'
  | 'ended'
  | 'withdrawn'
  | 'not_confirmed'
  | 'too_early'
  | 'consent_required';

/** The `errors` of a refused join link (see {@link CallRefusalCode}). */
export interface CallRefusalErrors {
  call: string;
  code: CallRefusalCode;
  status?: 'proposed';
  starts_at?: string;
  opens_at?: string;
  server_time?: string;
  consent?: GuestConsentStateDto;
}

/** Body of POST /public/call/{token}/consent (guest links only). */
export interface GuestConsentParams {
  accepted: true;
  /** The name to show as in the call, 1–60 characters. */
  display_name?: string;
}

/** Answer of POST /public/call/{token}/consent. */
export interface GuestConsentResultDto {
  consent: GuestConsentStateDto;
  you: CallYouDto;
  participants: CallParticipantDto[];
}

/**
 * The answer to an "in" presence heartbeat (POST /public/call/{token}/presence
 * or /portal/appointments/{id}/presence): who is in the call now and everyone
 * who may be. An "out" answers `{state}` only.
 */
export interface CallPresenceBeatDto {
  state: 'in' | 'out';
  presence?: CallPresenceDto;
  participants?: CallParticipantDto[];
  /**
   * Guest links only: their consent state now. When it turns `required` and
   * not `given` (the patient agreed to recording mid-call), ask the guest to
   * accept the notice (POST .../consent) — recording waits for them, and
   * their next renewal needs it once a recording is running.
   */
  consent?: GuestConsentStateDto;
}

// ----- The patient's guests -----

/** invited → consented (accepted the notice in the lobby) → joined (was in the call). */
export type PatientGuestStatus = 'invited' | 'consented' | 'joined';

/** How a guest's fee was paid. */
export type GuestPaidBy = 'booking' | 'wallet' | 'card' | 'free';

/** One of the patient's guests, as the patient sees them (GET .../guests). */
export interface PatientGuestDto {
  /** null only for a guest from before guests had identities, until the prod migration. */
  id: string | null;
  uid: number | null;
  name: string;
  email: string;
  /** The name they chose in the call lobby. */
  display_name: string | null;
  status: PatientGuestStatus;
  /** In the call right now. */
  in_call: boolean;
  /** What inviting them cost (money string). */
  fee: string;
  paid_by: GuestPaidBy;
  invited_at: string | null;
  last_sent_at: string | null;
  /** The invitation can be re-sent from then (once every 2 minutes). */
  resend_available_at: string | null;
  joined_at: string | null;
  consented_at: string | null;
  /** Their personal join link — a bearer credential: share with that guest only. */
  join_url: string | null;
}

/** GET /api/portal/appointments/{id}/guests. */
export interface PatientGuestListDto {
  guests: PatientGuestDto[];
  max_guests: number;
  /** What inviting one more costs now; "0.00" = free (no payment). */
  guest_fee: string;
  currency: string;
  /** Guests can be added / removed / re-sent (pending, confirmed or rescheduled, before the window closes). */
  can_manage: boolean;
  can_add: boolean;
  /** Why not, when `can_manage` is false. */
  manage_problem: string | null;
  /** Removing a paid guest before this refunds their fee to the wallet; after it, nothing. */
  refundable_until: string;
  window_closes_at: string;
  resend_interval_seconds: number;
}

/** Body of POST /api/portal/appointments/{id}/guests. */
export interface AddGuestParams {
  name: string;
  email: string;
  /** Required unless the guest fee is 0. In-call: wallet (or free) only. */
  payment_method?: 'wallet' | 'card';
  /** With card: the reference from `payInitForGuest`, once paid. */
  payment_reference?: string;
}

/** Answer of POST .../guests: the whole list plus the new guest. */
export interface AddGuestResultDto extends PatientGuestListDto {
  guest: PatientGuestDto;
}

/** Answer of DELETE .../guests/{gid}: the remaining list, who was removed, and any refund. */
export interface RemoveGuestResultDto extends PatientGuestListDto {
  removed: { id: string; name: string };
  /** Refunded to the wallet (money string), or null. */
  refunded: string | null;
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
  /**
   * Guests in the call now (by heartbeat, or given a token in the last 10
   * minutes and not left since), and how many of them haven't accepted the
   * recording notice — recording can't start while `pending` > 0 (absent from
   * older APIs). `unknown`: presence couldn't be read, so every invited guest
   * counts.
   */
  guest_consent?: { connected: number; pending: number; pending_ids: string[]; unknown?: boolean };
}

/**
 * `errors` of a 422 from POST .../recording/start when guests haven't agreed
 * (`consent` is the message).
 */
export interface RecordingGuestConsentErrors {
  consent: string;
  guests_without_consent: number;
  guest_ids: string[];
  /** Presence couldn't be read: every invited guest who hasn't agreed counts. */
  presence_unknown?: boolean;
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
  /**
   * Split by time ({@link AppointmentWhen}); the order is then fixed (upcoming
   * soonest first, else newest first). Patient lists: upcoming | past.
   */
  when?: AppointmentWhen;
}

/** The time splits a patient's own list accepts (anything else is a 422 `errors.when`). */
export type PatientAppointmentWhen = Exclude<AppointmentWhen, 'attention'>;

/** Query params of GET /api/portal/appointments (the patient's own list). */
export type ListMyAppointmentsQuery = Omit<ListAppointmentsQuery, 'when'> & {
  when?: PatientAppointmentWhen;
};

/** Who is in an appointment's call right now (from their call screens' heartbeats). */
export interface CallPresenceDto {
  doctor: boolean;
  patient: boolean;
  /** Ids of the guests in the call (absent from older APIs). */
  guests?: string[];
}

/** Presence by appointment id — only appointments with someone in the call. */
export type CallPresenceMap = Record<string, CallPresenceDto>;
