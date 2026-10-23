// Type-only imports; the cycles with staff.ts and appointment-api.ts (which import LicenceRoute from here) are erased at compile time.
import type { DoctorLoginStateDto, SpecialistStatus } from './appointment-api';
import type { CredentialType } from './doctor-management';
import type { DoctorInviteResultDto } from './staff';

// ----- Shared vocabulary -----

/** Where the doctor is licensed: decides the Licence step and documents. */
export type LicenceRoute = 'ng' | 'abroad';

export type DoctorApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'more_info_needed'
  | 'interview_scheduled'
  | 'approved'
  | 'rejected'
  | 'withdrawn';

/** Every status except `draft` (what staff and the track page ever see). */
export type SubmittedApplicationStatus = Exclude<DoctorApplicationStatus, 'draft'>;

export type ApplicationSectionKey =
  | 'personal'
  | 'professional'
  | 'licence'
  | 'qualifications'
  | 'indemnity'
  | 'consent';

/** The seven wizard steps, in order ("Step N of 7"). */
export type ApplicationStepKey =
  | 'personal'
  | 'professional'
  | 'licence'
  | 'qualifications'
  | 'documents'
  | 'indemnity'
  | 'consent';

export const APPLICATION_STEPS: readonly ApplicationStepKey[] = [
  'personal',
  'professional',
  'licence',
  'qualifications',
  'documents',
  'indemnity',
  'consent',
];

export type ApplicationStepState = 'complete' | 'incomplete' | 'not_started';

export type ApplicationGender = 'male' | 'female' | 'prefer_not_to_say';

export const APPLICATION_LANGUAGES: readonly string[] = [
  'English',
  'Yoruba',
  'Igbo',
  'Hausa',
  'Nigerian Pidgin',
  'French',
  'Arabic',
  'Portuguese',
  'Spanish',
  'Swahili',
  'Twi',
  'Other',
];

/** 5 MB: the server enforces the same limit. */
export const APPLICATION_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** `<input accept>` for every application upload (PDF, PNG, JPG). */
export const APPLICATION_UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
export const APPLICATION_REFERENCE_PATTERN = /^GVM-DR-\d{4}-\d{5}$/;
/** Crockford base32 (no I, L, O, U), 6 characters. */
export const DRAFT_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6}$/;

// ----- Sections (snake_case, as the API stores them) -----

export interface ApplicationPersonal {
  first_name: string;
  last_name: string;
  email: string;
  /** E.164, e.g. "+2348031234567". */
  phone: string;
  /** YYYY-MM-DD */
  date_of_birth: string;
  gender: ApplicationGender;
  /** ISO 3166-1 alpha-2. */
  country_of_residence: string;
  city: string;
}

export interface ApplicationProfessional {
  /** A label from GET /api/public/reference/specialty. */
  specialty: string;
  years_experience: number;
  workplace: string | null;
  /** 1–5 of APPLICATION_LANGUAGES. */
  languages: string[];
  /** 30–280 characters; shown to patients once approved. */
  bio: string;
}

export interface ApplicationLicenceNg {
  mdcn_number: string;
  full_registration_year: number;
  /** YYYY-MM-DD, in the future. */
  licence_expires_on: string;
}

export interface ApplicationLicenceAbroad {
  /** ISO2, never "NG". */
  regulator_country: string;
  regulator_name: string;
  registration_number: string;
  /** YYYY-MM-DD, within the last 6 months. */
  good_standing_issued_on: string;
}

export type ApplicationLicence = ApplicationLicenceNg | ApplicationLicenceAbroad;

export interface ApplicationQualification {
  degree: string;
  institution: string;
  year_awarded: number;
}

/** entries[0] is the primary medical degree. */
export interface ApplicationQualifications {
  entries: ApplicationQualification[];
}

export interface ApplicationIndemnity {
  provider: string;
  policy_number: string;
  /** YYYY-MM-DD, in the future. */
  cover_expires_on: string;
}

export interface ApplicationConsent {
  accept_terms: boolean;
  authorise_verification: boolean;
  confirm_accurate: boolean;
  /** Must contain the applicant's first and last name. */
  signature_name: string;
  /** ApplicationConfigDto.consent_version, echoed back. */
  consent_version: string;
  /** Server-set (ISO). */
  consented_at?: string | null;
}

/** What a draft holds so far (partial saves allowed). */
export interface ApplicationSections {
  personal: Partial<ApplicationPersonal> | null;
  professional: Partial<ApplicationProfessional> | null;
  licence: Partial<ApplicationLicenceNg & ApplicationLicenceAbroad> | null;
  qualifications: ApplicationQualifications | null;
  indemnity: Partial<ApplicationIndemnity> | null;
  consent: Partial<ApplicationConsent> | null;
}

/** Values type per section, for SaveSectionInput. */
export interface ApplicationSectionValues {
  personal: ApplicationPersonal;
  professional: ApplicationProfessional;
  licence: ApplicationLicence;
  qualifications: ApplicationQualifications;
  indemnity: ApplicationIndemnity;
  consent: ApplicationConsent;
}

// ----- Documents -----

export type ApplicationDocumentSlot =
  | 'mdcn_certificate'
  | 'good_standing_certificate'
  | 'government_id'
  | 'medical_degree'
  | 'practising_licence'
  | 'curriculum_vitae'
  | 'indemnity_certificate'
  | 'additional';

export type ApplicationDocumentMime = 'application/pdf' | 'image/png' | 'image/jpeg';

export interface ApplicationDocumentDto {
  id: string;
  slot: ApplicationDocumentSlot;
  /** e.g. "Current MDCN practising licence" (route-aware). */
  slot_label: string;
  /** `additional` only: what the reviewer asked for. */
  label: string | null;
  original_name: string;
  mime: ApplicationDocumentMime;
  size_bytes: number;
  state: 'active' | 'replaced';
  uploaded_during: 'draft' | 'info_response';
  uploaded_at: string;
  /** Staff view only. */
  credential_id?: string | null;
  /** Staff view only. */
  sha256?: string;
}

// ----- Drafts -----

export interface ApplicationDraftDto {
  id: string;
  status: 'draft';
  licence_route: LicenceRoute;
  sections: ApplicationSections;
  /** Active documents only. */
  documents: ApplicationDocumentDto[];
  steps: Record<ApplicationStepKey, ApplicationStepState>;
  /** The first step not complete, or 'review' when ready. */
  next_step: ApplicationStepKey | 'review';
  ready_to_submit: boolean;
  email_verified: boolean;
  /** ISO: the draft is deleted then unless saved again. */
  expires_at: string;
  last_saved_at: string | null;
}

export interface ApplicationConfigDto {
  consent_version: string;
  max_upload_bytes: number;
  accepted_mime: ApplicationDocumentMime[];
  /** The doctor portal paired with this onboarding site. */
  doctor_portal_url: string;
  support_email: string;
  draft_ttl_days: number;
  good_standing_max_age_months: number;
  sms_enabled: boolean;
  /** https URL of the Terms of Service page, or null (show the words without a link). */
  legal_terms_url: string | null;
  /** https URL of the Privacy Policy page, or null. */
  legal_privacy_url: string | null;
  /** The patient site, e.g. "https://patient.dosthq.com" (footer links). */
  patient_site_url: string;
}

export interface CreateDraftInput {
  licence_route: LicenceRoute;
  /** `email` is required even when partial. */
  personal: Partial<ApplicationPersonal>;
  partial?: boolean;
}

export interface DraftSessionDto {
  draft_token: string;
  /** Seconds. */
  expires_in: number;
  draft: ApplicationDraftDto;
  /** Non-production only. */
  dev_draft_code?: string;
  /** Non-production only. */
  dev_resume_link?: string;
}

export interface CreateDraftResultDto extends DraftSessionDto {
  /** Masked, e.g. "ada***@example.com". */
  resume_email_sent_to: string;
}

export interface ResumeDraftInput {
  email: string;
  draft_code: string;
}

export interface SaveSectionInput<K extends ApplicationSectionKey = ApplicationSectionKey> {
  values: Partial<ApplicationSectionValues[K]>;
  /** true: required fields may be blank (Save & continue later). */
  partial?: boolean;
}

export interface ResumeEmailSentDto {
  sent_to: string;
  /** Seconds before another may be sent. */
  resend_after: number;
  dev_draft_code?: string;
  dev_resume_link?: string;
}

export interface CodeSentDto {
  /** A masked destination or the generic text. */
  sent_to: string;
  expires_in: number;
  resend_after: number;
  already_verified?: boolean;
  /** Non-production only (null when nothing was sent). */
  dev_code?: string | null;
}

export interface VerifyCodeInput {
  code: string;
}

export interface SubmittedApplicationDto {
  id: string;
  reference: string;
  status: 'submitted';
  submitted_at: string;
  email: string;
  phone: string;
}

// ----- Track -----

export type ApplicantChannel = 'sms' | 'email';

export interface TrackStartInput {
  reference: string;
  /** Email or phone (local or E.164). */
  contact: string;
}

export interface TrackChannelDto {
  channel: ApplicantChannel;
  /** A masked contact, or "The phone number on your application" when generic. */
  destination: string;
  generic: boolean;
  default: boolean;
}

export interface TrackStartDto {
  track_id: string;
  channels: TrackChannelDto[];
  expires_in: number;
}

export interface TrackRequestCodeInput {
  track_id: string;
  channel: ApplicantChannel;
}

export interface TrackVerifyInput {
  track_id: string;
  code: string;
}

export interface TrackSessionDto {
  access_token: string;
  expires_in: number;
}

export type ApplicationTimelineKey =
  | 'submitted'
  | 'under_review'
  | 'more_info_needed'
  | 'interview_scheduled'
  | 'approved'
  | 'rejected'
  | 'withdrawn';

export interface ApplicationTimelineRowDto {
  key: ApplicationTimelineKey;
  label: string;
  state: 'done' | 'current' | 'pending';
  /** When it last happened (ISO), or null. */
  at: string | null;
  /** The current row only. */
  description: string | null;
}

export interface ApplicationInterviewDto {
  /** ISO 8601 with offset (the instant). */
  starts_at: string;
  /** Clinic time, e.g. "Wednesday 14 October, 10:00 WAT". */
  starts_at_label: string;
  duration_minutes: 15 | 30 | 45 | 60;
  meeting_url: string;
  /** e.g. "meet.google.com". */
  meeting_host: string;
  note: string | null;
}

export interface ApplicationInfoRequestItem {
  kind: 'section' | 'document';
  key: ApplicationSectionKey | ApplicationDocumentSlot;
  label: string;
}

export interface ApplicationInfoRequestDto {
  id: string;
  message: string;
  items: ApplicationInfoRequestItem[];
  requested_at: string;
  responded_at: string | null;
  response_note: string | null;
  /** Staff view only. */
  requested_by_name?: string;
  /** Staff view only: set when start review, reject or withdraw closed it unanswered. */
  closed_at?: string | null;
  /** Staff view only. */
  close_reason?: 'staff_resumed' | 'rejected' | 'withdrawn' | null;
}

export type WithdrawReason =
  | 'accepted_other_role'
  | 'apply_later'
  | 'made_mistake'
  | 'not_right_for_me'
  | 'other';

export const WITHDRAW_REASON_LABELS: Readonly<Record<WithdrawReason, string>> = {
  accepted_other_role: "I've accepted another role",
  apply_later: 'I want to apply later',
  made_mistake: 'I made a mistake in my application',
  not_right_for_me: "VideoMed isn't right for me",
  other: 'Other',
};

export interface ApplicationStatusDto {
  id: string;
  reference: string;
  status: SubmittedApplicationStatus;
  status_label: string;
  full_name: string;
  licence_route: LicenceRoute;
  submitted_at: string;
  timeline: ApplicationTimelineRowDto[];
  interview: ApplicationInterviewDto | null;
  /** The open request only. */
  info_request: ApplicationInfoRequestDto | null;
  rejection_reason: string | null;
  can_withdraw: boolean;
  /** Approved only: the paired doctor portal. */
  doctor_portal_url: string | null;
  email_masked: string;
}

/** GET track/application: what the respond page edits. */
export interface ApplicantApplicationDto {
  id: string;
  reference: string;
  status: SubmittedApplicationStatus;
  licence_route: LicenceRoute;
  sections: ApplicationSections;
  documents: ApplicationDocumentDto[];
  info_request: ApplicationInfoRequestDto | null;
}

export interface InfoResponseSubmitInput {
  note?: string | null;
}

export interface WithdrawInput {
  confirm: true;
  reason?: WithdrawReason | null;
}

// ----- Staff -----

export type DoctorApplicationFilter =
  | 'all'
  | 'needs_action'
  | 'submitted'
  | 'under_review'
  | 'more_info_needed'
  | 'interview_scheduled'
  | 'approved'
  | 'rejected'
  | 'withdrawn';

export type DoctorApplicationSort = 'waiting' | 'newest' | 'interview';

export interface AdminDoctorApplicationsQuery {
  q?: string;
  filter?: DoctorApplicationFilter;
  route?: LicenceRoute;
  sort?: DoctorApplicationSort;
  page?: number;
  per_page?: number;
}

export interface DoctorApplicationRowDto {
  id: string;
  reference: string;
  status: SubmittedApplicationStatus;
  status_label: string;
  full_name: string;
  email: string;
  specialty: string | null;
  licence_route: LicenceRoute;
  /** "Nigeria · MDCN" or "Abroad · United Kingdom". */
  licence_label: string;
  submitted_at: string;
  awaiting_staff: boolean;
  interview_starts_at: string | null;
  last_activity_at: string;
}

export interface DoctorApplicationQueueDto {
  /** The nav badge. */
  needs_action: number;
  submitted: number;
  under_review: number;
  more_info_needed: number;
  interview_scheduled: number;
  interviews_today: number;
}

export type DoctorApplicationEventKind =
  | 'submitted'
  | 'review_started'
  | 'info_requested'
  | 'info_item_updated'
  | 'applicant_replied'
  | 'interview_scheduled'
  | 'interview_rescheduled'
  | 'interview_cancelled'
  | 'interview_resent'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'specialist_created'
  | 'email_sent'
  | 'sms_sent'
  | 'notification_failed';

export interface DoctorApplicationEventDto {
  id: string;
  kind: DoctorApplicationEventKind;
  label: string;
  from_status: DoctorApplicationStatus | null;
  to_status: DoctorApplicationStatus | null;
  actor_type: 'applicant' | 'staff' | 'system';
  actor_name: string | null;
  applicant_visible: boolean;
  public_message: string | null;
  channel: ApplicantChannel | null;
  created_at: string;
}

export type DoctorApplicationAction =
  | 'start_review'
  | 'request_info'
  | 'schedule_interview'
  | 'resend_interview'
  | 'approve'
  | 'reject';

export interface ApprovalDocumentPrefillDto {
  document_id: string;
  slot: ApplicationDocumentSlot;
  slot_label: string;
  original_name: string;
  credential_type: CredentialType;
  needs_number: boolean;
  needs_issue_date: boolean;
  needs_expiry: boolean;
  prefill: {
    number: string | null;
    issued_on: string | null;
    expires_on: string | null;
    register_reference: string;
  };
  reference_hint: string;
  expiry_hint: string | null;
}

export interface ApprovalPreviewDto {
  ready: boolean;
  problems: Record<string, string>;
  documents: ApprovalDocumentPrefillDto[];
  login: {
    state: 'new' | 'reuse_invited_login' | 'blocked';
    problem: string | null;
  };
  specialty_on_list: boolean;
  /** "the MDCN register" or "the General Medical Council register". */
  register_name: string;
}

export interface DoctorApplicationSpecialistDto {
  id: string;
  name: string;
  status: SpecialistStatus;
  login: DoctorLoginStateDto | null;
}

export interface DoctorApplicationDetailDto extends DoctorApplicationRowDto {
  phone: string;
  email_verified_at: string | null;
  sections: ApplicationSections;
  documents: ApplicationDocumentDto[];
  info_requests: ApplicationInfoRequestDto[];
  interview: ApplicationInterviewDto | null;
  rejection_reason: string | null;
  withdraw_reason: WithdrawReason | null;
  withdraw_reason_label: string | null;
  review_started_at: string | null;
  review_started_by_name: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
  consent: (ApplicationConsent & { consent_ip: string | null }) | null;
  specialist: DoctorApplicationSpecialistDto | null;
  actions: DoctorApplicationAction[];
  /** Present while the application can be approved. */
  approval: ApprovalPreviewDto | null;
  events: DoctorApplicationEventDto[];
  notes_count: number;
}

export interface DoctorApplicationNoteDto {
  id: string;
  author_name: string;
  body: string;
  created_at: string;
}

interface ExpectedStatus {
  /** 409 status_changed when the application moved on meanwhile. */
  expected_status?: DoctorApplicationStatus;
}

export type StartReviewInput = ExpectedStatus;

export interface RequestInfoInput extends ExpectedStatus {
  message: string;
  items: Array<
    | { kind: 'section'; key: Exclude<ApplicationSectionKey, 'consent'> }
    | { kind: 'document'; key: ApplicationDocumentSlot; label?: string }
  >;
}

export interface ScheduleInterviewInput extends ExpectedStatus {
  /** ISO 8601 with offset. */
  starts_at: string;
  duration_minutes: 15 | 30 | 45 | 60;
  /** https only. */
  meeting_url: string;
  note?: string | null;
}

export interface ApprovalDocumentInput {
  checked: boolean;
  register_reference: string;
  number?: string | null;
  issued_on?: string | null;
  expires_on?: string | null;
}

export interface ApproveApplicationInput extends ExpectedStatus {
  attest: true;
  /** Naira, two decimals, > 0. */
  consultation_fee: string;
  /** Defaults to the application's. */
  specialty?: string;
  /** Keyed by application document id; every carried document. */
  documents: Record<string, ApprovalDocumentInput>;
}

export interface ApproveApplicationResultDto {
  application: DoctorApplicationDetailDto;
  specialist_id: string;
  invite: DoctorInviteResultDto;
}

export interface RejectApplicationInput extends ExpectedStatus {
  /** Shown to the applicant. */
  reason: string;
}

/** On DoctorOnboardingDto / SpecialistDetailDto. */
export interface SpecialistApplicationLinkDto {
  id: string;
  reference: string;
  approved_at: string | null;
}
