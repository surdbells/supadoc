import type {
  AppointmentDto,
  CertificationEntry,
  DoctorLoginStateDto,
  QualificationEntry,
  SpecialistAdminDto,
  UpdateSpecialistParams,
} from './appointment-api';
import type {
  AuditEventDto,
  DoctorOnboardingDto,
  DoctorProfileDto,
  EarningsSummaryDto,
  PayoutAccountDto,
  PayoutDto,
  ReviewSummaryDto,
} from './staff';

// ----- Licensing documents -----

/** A doctor's licensing document kind. */
export type CredentialType =
  | 'mdcn_full_registration'
  | 'annual_practising_licence'
  | 'specialist_certificate';

/** pending → verified | rejected; a verified licence past its date → expired; replaced → superseded. */
export type CredentialStatus = 'pending' | 'verified' | 'rejected' | 'expired' | 'superseded';

/** What a reviewer attested to when verifying a document (back office only). */
export interface CredentialAttestation {
  register_checked: boolean;
  /** The MDCN register entry / search reference they checked. */
  register_reference: string;
  note: string | null;
}

/** One licensing document (GET /api/doctor/credentials, and the reviewer view). */
export interface SpecialistCredentialDto {
  id: string;
  type: CredentialType;
  type_label: string;
  number: string | null;
  /** YYYY-MM-DD */
  issued_at: string | null;
  /** YYYY-MM-DD — the last valid day (required for a licence). */
  expires_at: string | null;
  status: CredentialStatus;
  status_label: string;
  /** Why a reviewer turned it down (shown to the doctor). */
  rejection_reason: string | null;
  original_name: string;
  mime: string;
  size_bytes: number;
  reviewed_at: string | null;
  created_at: string;
  /** Reviewer view only. */
  reviewed_by_name?: string | null;
  attestation?: CredentialAttestation | null;
  sha256?: string;
}

/** A document kind the upload form offers. */
export interface CredentialTypeOption {
  type: CredentialType;
  label: string;
  requires_expiry: boolean;
  requires_number: boolean;
}

/** GET /api/doctor/credentials. */
export interface DoctorCredentialsDto {
  /** Newest first; replaced ones left out. */
  credentials: SpecialistCredentialDto[];
  types: CredentialTypeOption[];
  max_bytes: number;
  /** Accepted MIME types (PDF, JPG, PNG). */
  accepted: string[];
}

/** POST /api/doctor/credentials (sent as multipart). */
export interface UploadCredentialInput {
  file: File;
  type: CredentialType;
  /** Required for a licence. */
  number?: string;
  /** YYYY-MM-DD, not in the future. */
  issued_at?: string;
  /** YYYY-MM-DD, required for a licence, not already past. */
  expires_at?: string;
}

/** POST /api/specialists/{id}/credentials/{cid}/verify. */
export interface VerifyCredentialInput {
  /** Must be true. */
  register_checked: true;
  register_reference: string;
  note?: string;
  /** A licence: confirm / correct its expiry (YYYY-MM-DD). */
  expires_at?: string;
  number?: string;
}

// ----- Practitioner terms -----

export type TermsBlockType = 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol';

/** One block of the terms text — plain text, rendered without HTML. */
export interface TermsBlock {
  type: TermsBlockType;
  text: string;
}

/** GET /api/doctor/terms (and the POST .../accept response). */
export interface PractitionerTermsDto {
  version: string;
  title: string;
  blocks: TermsBlock[];
  sha256: string;
  accepted_version: string | null;
  accepted_at: string | null;
  /** The version in force is accepted. */
  accepted: boolean;
}

/** The terms on the onboarding / review payloads. */
export interface TermsStateDto {
  current_version: string;
  accepted_version: string | null;
  accepted_at: string | null;
  accepted: boolean;
  /** Reviewer view only. */
  accepted_ip?: string | null;
}

// ----- Standing, suspension, licence -----

/**
 * Why a doctor may not do clinical work: suspended, not approved yet, or the
 * practitioner terms in force not accepted. Also the `errors.code` of the 403
 * every refused doctor route answers with (`doctorStandingCode()` in
 * @supadoc/data-access reads it off an error).
 */
export type DoctorStandingCode = 'doctor_suspended' | 'doctor_not_approved' | 'terms_required';

export interface DoctorStandingDto {
  code: DoctorStandingCode;
  message: string;
}

export type SuspensionCode = 'licence_expired' | 'conduct' | 'complaint' | 'admin' | 'other';

export interface DoctorSuspensionDto {
  code: SuspensionCode;
  code_label: string;
  /** Shown to the doctor. */
  reason: string | null;
  suspended_at: string | null;
}

/** valid | expiring (≤ 30 days) | expired | missing. */
export type LicenceStatus = 'valid' | 'expiring' | 'expired' | 'missing';

export interface LicenceStateDto {
  /** YYYY-MM-DD */
  expires_at: string | null;
  status: LicenceStatus;
}

// ----- Locked fields + change requests -----

/** Identity fields that, once approved, change only through a review. */
export type LockedField =
  | 'name'
  | 'specialty'
  | 'mdcn_number'
  | 'qualifications'
  | 'qualification_entries'
  | 'certifications';

/** Requested values waiting for a reviewer. */
export interface PendingChanges {
  name?: string;
  specialty?: string;
  mdcn_number?: string | null;
  qualifications?: string | null;
  qualification_entries?: QualificationEntry[];
  certifications?: CertificationEntry[];
}

/** What a reviewer approved (identity fields + the documents it rested on). */
export interface ApprovedSnapshotDto {
  name: string;
  specialty: string;
  mdcn_number: string | null;
  qualifications: string | null;
  qualification_entries: QualificationEntry[];
  certifications: CertificationEntry[];
  credential_ids: string[];
  approved_by: string | null;
  approved_by_name: string;
  approved_at: string;
}

// ----- Back office: review, list, doctor page -----

/** Whether a reviewer can approve now, and if not why (field → message). */
export interface ApprovalStateDto {
  ready: boolean;
  problems: Partial<Record<'status' | 'checklist' | 'mdcn_certificate' | 'practising_licence' | 'terms' | 'attest', string>>;
}

/** The onboarding payload in the reviewer view (approve / reject / verify / suspend responses). */
export interface SpecialistReviewSummaryDto extends DoctorOnboardingDto {
  approval: ApprovalStateDto;
  credentials_missing: boolean;
  approved_snapshot: ApprovedSnapshotDto | null;
}

/** POST /api/specialists/{id}/approve. */
export interface ApproveSpecialistInput {
  /** The reviewer confirms they checked the documents against the MDCN register. */
  attest: boolean;
  note?: string;
}

/** GET /api/specialists `?filter=`. */
export type SpecialistAdminFilter =
  | 'all'
  | 'review'
  | 'changes'
  | 'onboarding'
  | 'rejected'
  | 'approved'
  | 'suspended'
  | 'licence_expiring'
  | 'licence_expired'
  | 'credentials_missing'
  | 'credentials_pending';

/** GET /api/specialists query (server-paginated back-office list). */
export interface AdminSpecialistsQuery {
  /** Name, specialty, email or MDCN number. */
  q?: string;
  filter?: SpecialistAdminFilter;
  page?: number;
  per_page?: number;
  sort_by?: 'name' | 'specialty' | 'created_at' | 'submitted_at' | 'licence_expires_at';
  sort_dir?: 'asc' | 'desc';
}

/** One row of the back-office list. */
export type SpecialistAdminRowDto = SpecialistAdminDto & {
  suspended_at?: string | null;
  suspension_code?: SuspensionCode | null;
  suspension_reason?: string | null;
  licence_expires_at?: string | null;
  credentials_due_at?: string | null;
  has_pending_changes?: boolean;
  terms_version?: string | null;
  terms_accepted_at?: string | null;
  licence_status: LicenceStatus;
  /** Approved before documents existed and still owes them. */
  credentials_missing: boolean;
  /** Documents waiting for verification. */
  credentials_pending: number;
};

/** GET /api/specialists/review-queue — counts only. `total` is the badge. */
export interface SpecialistReviewQueueDto {
  pending_review: number;
  pending_changes: number;
  credentials_pending: number;
  total: number;
  licences_expiring: number;
  licences_expired: number;
  credentials_missing: number;
}

/** GET /api/specialists/{id} — the doctor page. */
export interface SpecialistDetailDto extends SpecialistReviewSummaryDto {
  profile: DoctorProfileDto;
  login: DoctorLoginStateDto | null;
  /** Account numbers masked to the last four digits. */
  payout_account: PayoutAccountDto | null;
  stats: {
    appointments_by_status: Record<string, number>;
    upcoming: number;
    earnings: EarningsSummaryDto;
    reviews: ReviewSummaryDto;
  };
}

/** PATCH /api/specialists/{id} — the non-locked fields a reviewer may edit. */
export interface AdminSpecialistUpdate extends Omit<UpdateSpecialistParams, 'verified'> {
  bio?: string;
  location?: string;
  country?: string;
  languages?: string;
  years_experience?: number | null;
  gender?: 'male' | 'female' | '';
  offers_in_person?: boolean;
  expertise?: string[];
}

/** A row of GET /api/specialists/{id}/appointments (no patient contact details). */
export interface SpecialistAppointmentRowDto extends AppointmentDto {
  patient_name: string;
}

/** GET /api/specialists/{id}/appointments query. */
export interface SpecialistAppointmentsQuery {
  page?: number;
  per_page?: number;
  /** Comma list of statuses. */
  status?: string;
  /** Patient name. */
  search?: string;
}

/** GET /api/specialists/{id}/payouts. */
export interface SpecialistPayoutsDto {
  earnings: EarningsSummaryDto;
  /** Newest first; account snapshots masked. */
  payouts: PayoutDto[];
  payout_account: PayoutAccountDto | null;
}

/** One change of a doctor's standing (History tab). */
export interface SpecialistStatusEventDto {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  actor_name: string;
  /** e.g. a suspension code. */
  code: string | null;
  reason: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/** GET /api/specialists/{id}/history. */
export interface SpecialistHistoryDto {
  status_events: SpecialistStatusEventDto[];
  audit: AuditEventDto[];
}

/** GET /api/specialists/{id}/suspend/preview — what suspending would do. */
export interface SuspensionPreviewDto {
  already_suspended: boolean;
  /**
   * Future pending / confirmed / rescheduled bookings to cancel — plus any in
   * progress (slot not over) with no proof the consultation is taking place.
   */
  bookings: number;
  /** Open follow-up proposals to withdraw. */
  proposals: number;
  /**
   * Consultations taking place now (a note, prescription, the doctor on the
   * transcript or both on the call): left to finish, not refunded — the cron
   * completes them. Always sent by the API.
   */
  in_progress?: number;
  patients: number;
  /** Paid bookings refunded to wallets. */
  refunds: number;
  refund_total: string;
  guests: number;
  /** Included in refund_total. */
  guest_fees: string;
  currency: string;
  codes: { code: SuspensionCode; label: string }[];
}

/** POST /api/specialists/{id}/suspend. */
export interface SuspendSpecialistInput {
  code: SuspensionCode;
  /** 1–2000 chars, shown to the doctor. */
  reason: string;
}

/** What a suspension did; `incomplete` → call suspend again to finish. */
export interface SuspensionResultDto {
  already_suspended: boolean;
  sessions_revoked: number;
  cancelled: number;
  refunded_count: number;
  refunded_total: string;
  guests_notified: number;
  proposals_withdrawn: number;
  patients_notified: number;
  /** Consultations taking place now, left to finish (see SuspensionPreviewDto). Always sent by the API. */
  in_progress?: number;
  failed: number;
  incomplete: boolean;
  currency: string;
}

/** POST /api/specialists/{id}/suspend response. */
export interface SuspendSpecialistDto {
  summary: SpecialistReviewSummaryDto;
  affected: SuspensionResultDto;
}
