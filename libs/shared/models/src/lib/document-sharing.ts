/**
 * Patient-controlled document sharing — the wire contract between the API
 * (`apps/api`, DocumentSharing / Doctor actions) and the patient + doctor apps.
 *
 * A patient's medical documents are private by default. The patient shares the
 * whole folder (including later uploads) or selected documents with a doctor
 * they have booked, for a period or with no end date, and can change or stop
 * sharing at any time. Doctors may ask for access; the patient approves (scope +
 * duration) or declines.
 *
 * Date fields named `*_label_at` are the ones to format for display (the
 * exclusive end of an `until` share minus one second); never format the raw
 * `until` / `expires_at` / `shared_until` instants.
 */
import type { MedicalDocumentDto } from './message';

/** Whole folder (incl. later uploads, minus hidden ones) or picked documents. */
export type DocumentShareScope = 'all' | 'selected';

export type AfterDuration = 'after_24h' | 'after_7d' | 'after_30d';
/** How long a share lasts. `after_*` = after the linked consultation ends. */
export type DocumentShareDuration = '24h' | '7d' | '30d' | 'until' | 'indefinite' | AfterDuration;
export type BookingShareDuration = AfterDuration | 'indefinite';

/** `paused` = the doctor isn't practising now (computed; never stored). */
export type DocumentGrantStatus = 'active' | 'paused' | 'expired' | 'revoked';
export type DocumentGrantSource = 'share' | 'upload' | 'booking' | 'request' | 'restore';
export type DocumentGrantEndReason =
  | 'revoked' | 'expired' | 'appointment_cancelled' | 'emptied' | 'merged' | 'account_closed' | 'doctor_unavailable';
export type DocumentShareSurface =
  | 'documents_page' | 'manage_sharing' | 'document_access' | 'upload' | 'booking'
  | 'appointment_details' | 'call' | 'request';
export type DocumentAccessRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'expired';
export type DocumentAccessRequestKind = 'access' | 'extend';
export type DocumentAccessEventType =
  | 'viewed' | 'shared' | 'changed' | 'extended' | 'revoked' | 'restored'
  | 'document_removed' | 'document_shown' | 'expired'
  | 'requested' | 'request_approved' | 'request_declined' | 'request_cancelled' | 'request_expired'
  | 'requests_blocked' | 'requests_allowed';

/** ISO exclusive end of each after_* option for one appointment; null = not offered. */
export interface AfterOptionsDto {
  readonly after_24h: string | null;
  readonly after_7d: string | null;
  readonly after_30d: string | null;
}

export interface SharingDoctorRefDto {
  readonly id: string;
  readonly name: string;
  readonly specialty: string | null;
  readonly photo_url: string | null;
}

export interface SharingAppointmentRefDto {
  readonly id: string;
  readonly scheduled_at: string;
  readonly ends_at: string;
  readonly after_options: AfterOptionsDto;
}

/** One doctor who can see a given document (patient view). */
export interface DocumentSharedWithDto {
  readonly specialist_id: string;
  readonly name: string;
  readonly via: 'folder' | 'document';
  readonly until: string | null;
  /** Format this, never `until` (until − 1 s for `until` shares). */
  readonly until_label_at: string | null;
  readonly indefinite: boolean;
  readonly paused: boolean;
}

/** A patient's view of what one doctor can see now. */
export interface DoctorAccessSummaryDto {
  readonly state: 'none' | 'active' | 'paused';
  /** 'all' when any folder share is active, else 'selected'; null when none. */
  readonly scope: DocumentShareScope | null;
  readonly document_count: number;
  /**
   * End of the doctor's whole visible set: the latest end among active
   * shares, NULL wins (an individually shared document with no end date makes
   * this null even while the folder share ends sooner). For "whole folder
   * until …" copy use `folder_until_label_at` / `folder_indefinite`.
   */
  readonly until: string | null;
  /** Format this, never `until` (latest end among active shares, NULL wins). */
  readonly until_label_at: string | null;
  /** True when any active share has no end date. */
  readonly indefinite: boolean;
  /**
   * The single active whole-folder share's end, to format: null when there is
   * no folder share or it has no end date (tell them apart with
   * `folder_indefinite`).
   */
  readonly folder_until_label_at: string | null;
  /** The active whole-folder share has no end date; false when there is none. */
  readonly folder_indefinite: boolean;
  /** Earliest end among active shares — refetch then. */
  readonly next_change_at: string | null;
  readonly last_viewed_at: string | null;
  readonly active_grant_ids: readonly string[];
  /** Documents hidden from this doctor's folder access (open hidden rows). */
  readonly hidden_count: number;
  /** Capped at 200. */
  readonly hidden_document_ids: readonly string[];
}

export interface DocumentGrantDto {
  readonly id: string;
  readonly specialist: SharingDoctorRefDto;
  readonly scope: DocumentShareScope;
  readonly status: DocumentGrantStatus;
  readonly source: DocumentGrantSource;
  readonly surface: DocumentShareSurface | 'restore';
  readonly duration: DocumentShareDuration;
  readonly starts_at: string;
  readonly expires_at: string | null;
  readonly until_label_at: string | null;
  readonly ended_at: string | null;
  readonly end_reason: DocumentGrantEndReason | null;
  readonly ended_by: 'patient' | 'system' | null;
  /** selected: the shared documents (≤ 500); all: []. */
  readonly document_ids: readonly string[];
  readonly document_count: number;
  readonly appointment: SharingAppointmentRefDto | null;
  readonly request_id: string | null;
  readonly revoke_batch_id: string | null;
  /** Undo allowed until this instant (patient revokes only); else null. */
  readonly restorable_until: string | null;
  readonly last_accessed_at: string | null;
  readonly access_count: number;
  readonly created_at: string;
}

export interface DocumentAccessRequestSuggestionDto {
  /** null: no sensible default — the patient must choose. */
  readonly scope: DocumentShareScope | null;
  /** The request appointment's attachments (≤ 200). */
  readonly document_ids: readonly string[];
  readonly duration: DocumentShareDuration;
  readonly appointment_id: string | null;
}

export interface DocumentAccessRequestDto {
  readonly id: string;
  readonly specialist: SharingDoctorRefDto;
  /** null when that consultation was cancelled or deleted. */
  readonly appointment: SharingAppointmentRefDto | null;
  readonly kind: DocumentAccessRequestKind;
  readonly status: DocumentAccessRequestStatus;
  /** The doctor's note — plain text, app only. */
  readonly message: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly grant_id: string | null;
  readonly suggestion: DocumentAccessRequestSuggestionDto;
}

/** GET /portal/document-access/doctors — a doctor the patient has booked. */
export interface SharingDoctorDto {
  readonly specialist: SharingDoctorRefDto;
  readonly can_share: boolean;
  readonly unavailable_reason: 'doctor_unavailable' | null;
  readonly last_appointment_at: string | null;
  readonly next_appointment: SharingAppointmentRefDto | null;
  readonly access: DoctorAccessSummaryDto;
  readonly pending_request: DocumentAccessRequestDto | null;
  readonly requests_blocked: boolean;
}

export interface DocumentAccessEventDto {
  readonly id: string;
  readonly event: DocumentAccessEventType;
  readonly actor: 'patient' | 'doctor' | 'system';
  readonly specialist: SharingDoctorRefDto | null;
  /** The patient's own document; title null when it no longer exists. */
  readonly document: { readonly id: string; readonly title: string | null } | null;
  readonly grant_id: string | null;
  readonly request_id: string | null;
  readonly details: {
    readonly scope?: DocumentShareScope;
    readonly duration?: DocumentShareDuration;
    readonly expires_at?: string | null;
    readonly until_label_at?: string | null;
    readonly document_count?: number;
    readonly end_reason?: DocumentGrantEndReason;
    readonly capped?: boolean;
  } | null;
  readonly created_at: string;
}

/** GET /portal/documents/{id}/access */
export interface DocumentAccessDetailDto {
  readonly document_id: string;
  readonly doctors: readonly (DocumentSharedWithDto & {
    readonly specialist: SharingDoctorRefDto;
    readonly grant_ids: readonly string[];
    readonly last_viewed_at: string | null;
  })[];
  /** Folder-share holders this document is hidden from ("Show again"). */
  readonly hidden_from: readonly { readonly specialist: SharingDoctorRefDto; readonly folder_until_label_at: string | null }[];
  readonly eligible_doctors: readonly SharingDoctorRefDto[];
  readonly history: readonly DocumentAccessEventDto[];
}

/** A document a doctor can see, from the patient's side. */
export interface PatientVisibleDocumentDto extends MedicalDocumentDto {
  readonly via: 'folder' | 'document';
  readonly until: string | null;
  readonly until_label_at: string | null;
  readonly indefinite: boolean;
}

/** GET /portal/appointments/{id}/document-access */
export interface AppointmentDocumentAccessDto {
  readonly specialist: SharingDoctorRefDto;
  readonly appointment: SharingAppointmentRefDto;
  readonly can_share: boolean;
  readonly unavailable_reason: 'doctor_unavailable' | null;
  readonly access: DoctorAccessSummaryDto;
  readonly visible_documents: readonly PatientVisibleDocumentDto[];
  readonly unshared_attachments: readonly MedicalDocumentDto[];
  readonly pending_request: DocumentAccessRequestDto | null;
}

/** POST /portal/documents and /portal/appointment-documents responses. */
export interface UploadedDocumentDto extends MedicalDocumentDto {
  readonly shared_with: readonly DocumentSharedWithDto[];
  readonly share_outcome: 'shared' | 'partly_shared' | 'share_ended' | 'private' | 'sharing_unavailable';
  /** Doctors whose batch share had already ended (file not shared with them). */
  readonly share_ended_for: readonly string[];
}

// ----- Inputs -----

export interface CreateDocumentShareInput {
  specialist_ids: string[];
  scope: DocumentShareScope;
  /** Required (1–200) for `selected`. */
  document_ids?: string[];
  duration: DocumentShareDuration;
  /** ISO with Z or ±hh:mm; only for `until` (exclusive end). */
  expires_at?: string | null;
  /** Validated whenever present; required for after_*. */
  appointment_id?: string | null;
  /** One uuid per dialog submission. */
  client_key: string;
  /** Closes that pending request as answered (`shared_directly`). */
  answers_request_id?: string | null;
  /** scope `all`: also show documents previously hidden from these doctors. */
  show_hidden_for_specialist_ids?: string[];
  surface: DocumentShareSurface;
}

export interface UpdateDocumentGrantInput {
  duration?: DocumentShareDuration;
  expires_at?: string | null;
  appointment_id?: string | null;
  scope?: DocumentShareScope;
  /** Replace the selection (scope selected). */
  document_ids?: string[];
  /** ≤ 200 each. */
  add_document_ids?: string[];
  remove_document_ids?: string[];
}

export interface ApproveAccessRequestInput {
  scope: DocumentShareScope;
  document_ids?: string[];
  duration: DocumentShareDuration;
  expires_at?: string | null;
  /** Defaults to the request's appointment for after_*. */
  appointment_id?: string | null;
  /** scope `all`: also show previously hidden documents. */
  show_hidden?: boolean;
}

export interface DeclineAccessRequestInput {
  block_future_requests?: boolean;
}

/** Extra multipart fields for POST /portal/documents. */
export interface UploadShareOptions {
  /** May be empty (exclude-only upload). */
  specialist_ids: string[];
  /** Required when specialist_ids is non-empty. */
  duration?: DocumentShareDuration;
  expires_at?: string | null;
  /** Required when specialist_ids is non-empty; same for every file of one batch. */
  batch_id?: string;
  appointment_id?: string | null;
  /** Folder-share holders who must not see this file. */
  exclude_specialist_ids?: string[];
  surface?: 'documents_page' | 'appointment_details';
}

export interface DocumentShareOutcomeDto {
  readonly specialist_id: string;
  readonly grant_id: string;
  readonly outcome: 'created' | 'merged' | 'extended' | 'unchanged';
}

export interface DocumentShareResultDto {
  readonly grants: readonly DocumentGrantDto[];
  readonly outcomes: readonly DocumentShareOutcomeDto[];
  readonly approved_request_ids: readonly string[];
  readonly replayed: boolean;
}

export interface RevokeResultDto {
  readonly revoked: readonly DocumentGrantDto[];
  readonly revoke_batch_id: string | null;
  readonly restorable_until: string | null;
}

export interface RestoreResultDto {
  readonly restored: readonly DocumentGrantDto[];
  readonly skipped_grant_ids: readonly string[];
}

// ----- Doctor side -----

export type DoctorAccessRequestBlock =
  | 'request_pending' | 'request_cooldown' | 'request_limit' | 'has_full_access'
  | 'appointment_not_eligible' | 'request_blocked' | 'sharing_unavailable';

export interface DoctorAccessRequestDto {
  readonly id: string;
  readonly kind: DocumentAccessRequestKind;
  readonly status: DocumentAccessRequestStatus;
  readonly message: string | null;
  readonly appointment_id: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
}

/** Explicit allowlist — never extends the patient DTOs (no shared_with). */
export interface DoctorSharedDocumentDto {
  readonly id: string;
  readonly patient_id: string;
  readonly uploader_role: 'patient' | 'doctor' | 'staff';
  /** The patient's name for their own uploads; null otherwise. */
  readonly uploader_name: string | null;
  /** Only when that consultation is yours; else null. */
  readonly appointment_id: string | null;
  readonly document_type: string;
  readonly custom_type: string | null;
  readonly type_label: string;
  readonly title: string;
  readonly extension: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly size_label: string;
  readonly created_at: string;
  readonly via: 'folder' | 'document';
  readonly shared_until: string | null;
  /** Format this, never shared_until. */
  readonly shared_until_label_at: string | null;
  readonly shared_indefinitely: boolean;
  readonly shared_at: string;
}

/** GET /doctor/appointments/{id}/document-access */
export interface DoctorDocumentAccessDto {
  readonly access: {
    readonly state: 'none' | 'active';
    readonly scope: DocumentShareScope | null;
    readonly document_count: number;
    /**
     * End of everything you can see: the latest end among the patient's
     * active shares with you, NULL wins. For "whole folder until …" copy use
     * `folder_until_label_at` / `folder_indefinite`.
     */
    readonly until: string | null;
    /** Format this, never `until`. */
    readonly until_label_at: string | null;
    /** True when any active share has no end date. */
    readonly indefinite: boolean;
    /**
     * The active whole-folder share's end, to format: null when there is no
     * folder share or it has no end date (tell them apart with
     * `folder_indefinite`).
     */
    readonly folder_until_label_at: string | null;
    /** The active whole-folder share has no end date; false when there is none. */
    readonly folder_indefinite: boolean;
    readonly next_change_at: string | null;
    /** A folder share ends within 48 h. */
    readonly ends_soon: boolean;
    readonly had_access_before: boolean;
  };
  readonly documents: readonly DoctorSharedDocumentDto[];
  readonly request: {
    readonly can_request: boolean;
    /** What a new request would be: an extension when a folder share ends soon. */
    readonly kind: DocumentAccessRequestKind | null;
    readonly blocked_reason: DoctorAccessRequestBlock | null;
    readonly available_at: string | null;
    readonly pending: DoctorAccessRequestDto | null;
    /** Most recent decided request, if any. */
    readonly last: DoctorAccessRequestDto | null;
  };
  readonly server_time: string;
}
