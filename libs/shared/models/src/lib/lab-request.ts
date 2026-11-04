/**
 * Laboratory & Diagnostics (lab requests, 2026-11) — the shared contract.
 *
 * Mirrors the API's `LabRequestPresenter` output (doctor summary / detail /
 * result, patient summary / detail / result, back-office row) and the request
 * bodies of `/api/doctor/lab-requests*`, `/api/portal/lab-requests*` and
 * `/api/admin/lab-requests*`. `lab-request-keys.fixture.json` (next to this
 * file) pins the keys of every DTO (`doctor_summary`, …, `admin_row`) **and**
 * of each nested object, as `"<section>.<field>"` entries — the keys of that
 * object, or of each element when the field is a list (e.g.
 * `doctor_detail.prescriber` holds `registration_number`, never the stored
 * `mdcn_number`; `patient_result.review` is exactly `comment` + `reviewed_at`).
 * A nested entry under a summary section applies to the detail too. The API's
 * `DtoShapeTest` compares every entry with the presenter output.
 *
 * Instants are ISO strings; `valid_until`, `lab_date`, `sample_date` and
 * `consented_on` are clinic calendar dates (`'Y-m-d'`) — print them as dates,
 * never through `new Date('Y-m-d')` or a time-zone conversion.
 *
 * Patient payloads never carry a review outcome, `abnormal`, infection alerts,
 * transfusion, pregnancy or history / medication / allergies.
 */

import type { PageMeta } from './appointment-api';

/** Stored status; DTOs always carry the **effective** one (expiry is computed on read). */
export type LabRequestStatus = 'awaiting_consent' | 'booked' | 'in_lab' | 'result_ready' | 'declined' | 'cancelled' | 'expired';
export type LabPriority = 'routine' | 'urgent' | 'stat';
export type LabPurpose = 'diagnosis' | 'monitoring' | 'screening' | 'pre_operative';
export type LabItemKind = 'lab' | 'imaging' | 'physiological';
export type LabItemCategory = 'routine_panel' | 'single_test' | 'microbiology' | 'imaging' | 'physiological';
export type LabModality = 'x_ray' | 'ultrasound' | 'ct' | 'mri' | 'other';
export type LabSite = 'urine' | 'blood' | 'stool' | 'sputum' | 'wound_swab' | 'csf';
export type LabSpecimenMode = 'auto' | 'manual';
export type LabPreparation = 'none' | 'full_bladder' | 'fasting' | 'bowel_prep';
export type LabInfectionAlert = 'hiv' | 'hep_b' | 'hep_c' | 'tb';
export type LabMobility = 'walking' | 'chair' | 'bed' | 'portable';
export type LabYesNo = 'yes' | 'no';
/** List filter: awaiting_patient = Awaiting Consent; in_progress = Booked + In Lab; result_ready = both result chips. */
export type LabListGroup = 'all' | 'awaiting_patient' | 'in_progress' | 'result_ready';
/** Doctor-only: never serialised to the patient. */
export type LabReviewOutcome = 'normal' | 'abnormal';
/** What happened to a result's sharing at upload. */
export type LabShareOutcome = 'shared' | 'private' | 'sharing_unavailable' | 'doctor_unavailable';
/** State of the request's results grant (drives the upload dialog's Share default). */
export type LabResultsSharing = 'active' | 'ended' | 'none';
export type LabEventType = 'sent' | 'accepted' | 'declined' | 'sample_given' | 'result_added' | 'result_reviewed'
  | 'cancelled' | 'expired' | 'reminded' | 'status_corrected';
export type LabActorRole = 'doctor' | 'patient' | 'staff' | 'system';
/** Back-office status corrections (C1–C4). */
export type LabCorrectionTarget = 'booked' | 'in_lab' | 'awaiting_consent';

export interface LabOption<T extends string = string> { readonly value: T; readonly label: string; }
export interface LabCatalogueItem {
  readonly code: string; readonly kind: LabItemKind; readonly category: LabItemCategory;
  readonly modality: LabModality | null; readonly site: LabSite | null;
  readonly label: string; readonly name: string; readonly short: string; readonly synonyms: readonly string[];
  readonly common: boolean; readonly default_specimen: string | null; readonly fasting_hours: number | null;
  readonly default_preparation: LabPreparation | null; readonly contrast_possible: boolean; readonly ionising: boolean;
}
/** GET /api/doctor/lab-requests/options — the versioned catalogue and form limits. */
export interface LabOptionsDto {
  readonly catalogue_version: string;
  readonly priorities: readonly (LabOption<LabPriority> & { readonly subtitle: string })[];
  readonly purposes: readonly LabOption<LabPurpose>[];
  readonly categories: readonly LabOption<'routine_panel' | 'single_test' | 'microbiology'>[];
  readonly sites: readonly (LabOption<LabSite> & { readonly specimen: string })[];
  readonly modalities: readonly LabOption<LabModality>[];
  readonly specimens: readonly (LabOption & { readonly manual: boolean })[];
  readonly preparations: readonly (LabOption<LabPreparation> & { readonly patient_text: string | null })[];
  readonly infection_alerts: readonly LabOption<LabInfectionAlert>[];
  readonly mobility: readonly LabOption<LabMobility>[];
  readonly items: readonly LabCatalogueItem[];
  readonly limits: { readonly max_items: number; readonly question_min: number; readonly question_max: number; readonly text_max: number;
    readonly fasting_hours: readonly [number, number]; readonly weeks_pregnant: readonly [number, number];
    readonly comment_max: number; readonly reason_max: number };
  readonly has_signature: boolean;
}
/** One patient in the "Choose a patient" picker (only patients this doctor has consulted). */
export interface LabPatientPickDto { readonly patient_id: string; readonly name: string; readonly email: string; readonly reference: string; readonly avatar_url: string | null; readonly last_visit: string | null; }
/** GET /api/doctor/lab-requests/context — the patient card, pregnancy question and pre-fill. */
export interface LabRequestContextDto {
  readonly patient: { readonly id: string; readonly name: string; readonly first_name: string; readonly email: string;
    readonly age: number | null; readonly sex: string | null; readonly reference: string; readonly avatar_url: string | null };
  readonly ask_pregnancy: boolean;
  readonly prefill: { readonly medication: string; readonly allergies: string };
  readonly appointment: { readonly id: string; readonly scheduled_at: string } | null;
}
export interface LabClinicalFlags {
  readonly fasting: boolean | null; readonly fasting_hours: number | null; readonly pregnancy_asked: boolean;
  readonly pregnant: boolean | null; readonly weeks_pregnant: number | null;
  readonly infection_alerts: readonly LabInfectionAlert[]; readonly transfusion_3m: boolean | null;
}
export interface LabImagingSafety { readonly contrast_allergy: LabYesNo; readonly mobility: LabMobility; readonly pregnant: 'yes' | 'no' | 'na'; }
export interface LabRequestItemInput { code: string; specimen_mode?: LabSpecimenMode; specimen_code?: string | null; preparation_code?: LabPreparation; }
/**
 * POST /api/doctor/lab-requests — create is send. `client_key` is a uuid v4
 * the form generates (a new one per patient and after any 409); a retry with
 * the same key and body answers 200 with the request already sent.
 * `catalogue_version` pins what the doctor previewed (409 `catalogue_changed`).
 * `clinical.pregnant` / `weeks_pregnant` may be left out when Pregnant? isn't
 * asked (`ask_pregnancy` false): the server ignores them then, and a missing
 * key hashes as null.
 */
export interface CreateLabRequestInput {
  client_key: string; catalogue_version: string; patient_id: string; appointment_id?: string | null; duplicated_from?: string | null;
  priority: LabPriority; purpose: LabPurpose | null; clinical_question: string;
  history?: string; medication?: string; allergies?: string;
  clinical: Omit<LabClinicalFlags, 'pregnancy_asked' | 'pregnant' | 'weeks_pregnant'>
    & { pregnant?: boolean | null; weeks_pregnant?: number | null };
  items: LabRequestItemInput[];
  imaging_safety?: { contrast_allergy: LabYesNo; mobility: LabMobility } | null;
  attest: true;
  signature: { mode: 'saved' } | { mode: 'drawn'; image: string; save?: boolean };
}
export interface LabRequestItemDto {
  readonly id: string; readonly position: number; readonly code: string; readonly kind: LabItemKind; readonly category: LabItemCategory;
  readonly modality: LabModality | null; readonly site: LabSite | null; readonly label: string; readonly short: string;
  readonly specimen_mode: LabSpecimenMode | null; readonly specimen_code: string | null; readonly specimen_label: string | null;
  readonly preparation_code: LabPreparation | null; readonly preparation_label: string | null; readonly contrast_possible: boolean;
  readonly ionising: boolean;
}
export interface LabRequestEventDto {
  readonly event: LabEventType; readonly from_status: LabRequestStatus | null; readonly to_status: LabRequestStatus | null;
  readonly actor_role: LabActorRole; readonly actor_name: string | null; readonly at: string;
  readonly sample_date: string | null;   // 'Y-m-d', C1 corrections only
}
/** A doctor's list row (`GET /api/doctor/lab-requests`). */
export interface LabRequestSummaryDto {
  readonly id: string; readonly number: string; readonly status: LabRequestStatus; readonly priority: LabPriority;
  readonly appointment_id: string | null;
  readonly patient: { readonly id: string; readonly name: string; readonly age: number | null; readonly sex: string | null };
  readonly clinical_question: string; readonly tests_label: string; readonly items_count: number;
  readonly counts: { readonly lab: number; readonly imaging: number; readonly physiological: number };
  readonly results_count: number; readonly unreviewed_count: number; readonly abnormal: boolean;   // unreviewed_count: reviewable only
  readonly sent_at: string; readonly valid_until: string; readonly expires_at: string; readonly last_activity_at: string;
}
/** A result as the requesting doctor sees it: `document` is null when it isn't shared with them now. */
export interface DoctorLabResultDto {
  readonly id: string; readonly uploaded_at: string; readonly item_ids: readonly string[]; readonly visible: boolean; readonly reviewable: boolean;
  readonly document: { readonly title: string; readonly type_label: string; readonly extension: string; readonly size_label: string; readonly viewable: boolean } | null;
  readonly review: { readonly outcome: LabReviewOutcome; readonly comment: string | null; readonly reviewed_at: string } | null;
}
/** The doctor's request detail (`GET /api/doctor/lab-requests/{id}`). */
export interface LabRequestDto extends LabRequestSummaryDto {
  readonly appointment_scheduled_at: string | null;
  readonly purpose: LabPurpose | null; readonly history: string | null; readonly medication: string | null; readonly allergies: string | null;
  readonly clinical: LabClinicalFlags; readonly imaging_safety: LabImagingSafety | null;
  readonly catalogue_version: string; readonly items: readonly LabRequestItemDto[];
  readonly prescriber: { readonly id: string; readonly name: string; readonly specialty: string; readonly qualifications: string;
    readonly registration_label: string; readonly registration_number: string };
  readonly patient_snapshot: { readonly name: string; readonly reference: string; readonly email: string;
    readonly date_of_birth: string | null; readonly age: number | null; readonly sex: string | null };
  readonly consent: { readonly version: string; readonly consented_at: string; readonly share_results: boolean } | null;
  readonly lab_name: string | null; readonly lab_date: string | null;
  readonly declined_at: string | null; readonly decline_reason: string | null; readonly sample_at: string | null;
  readonly result_ready_at: string | null; readonly reviewed_at: string | null;
  readonly cancelled_at: string | null; readonly cancel_reason: string | null; readonly expired_at: string | null;
  readonly duplicated_from: string | null;
  readonly results: readonly DoctorLabResultDto[]; readonly timeline: readonly LabRequestEventDto[];
  readonly can: { readonly cancel: boolean; readonly review: boolean; readonly duplicate: boolean };
}
/** A patient's list row (`GET /api/portal/lab-requests`): no test names, no clinical question. */
export interface PatientLabRequestSummaryDto {
  readonly id: string; readonly number: string; readonly status: LabRequestStatus; readonly priority: LabPriority;
  readonly doctor: { readonly id: string; readonly name: string; readonly specialty: string };
  readonly items_count: number; readonly results_count: number; readonly reviewed: boolean; readonly awaiting_review: boolean;
  readonly appointment_id: string | null; readonly sent_at: string; readonly valid_until: string; readonly expires_at: string; readonly last_activity_at: string;
}
export interface LabConsentStatement { readonly key: 'tests' | 'pays_lab' | 'lab_disclosure' | 'share_results'; readonly text: string; readonly required: boolean; readonly default: boolean; }
export interface LabPatientInstruction { readonly key: string; readonly title: string; readonly text: string; }
/** A result as the patient sees it — never the review outcome. */
export interface PatientLabResultDto {
  readonly id: string; readonly uploaded_at: string; readonly item_ids: readonly string[];
  readonly document: { readonly id: string; readonly title: string; readonly type_label: string; readonly extension: string; readonly size_label: string };
  readonly share_outcome: LabShareOutcome; readonly shared_now: boolean; readonly viewable: boolean; readonly reviewable: boolean;
  readonly review: { readonly comment: string | null; readonly reviewed_at: string } | null;
}
/** The patient's request detail (`GET /api/portal/lab-requests/{id}`). */
export interface PatientLabRequestDto extends PatientLabRequestSummaryDto {
  readonly clinical_question: string; readonly purpose: LabPurpose | null;
  readonly items: readonly Pick<LabRequestItemDto, 'id' | 'kind' | 'label' | 'short' | 'specimen_label' | 'preparation_code' | 'preparation_label'>[];
  readonly instructions: readonly LabPatientInstruction[];
  readonly consent_version: string; readonly consent_statements: readonly LabConsentStatement[];
  readonly consent: { readonly version: string; readonly consented_at: string; readonly share_results: boolean } | null;
  readonly lab_name: string | null; readonly lab_date: string | null; readonly declined_at: string | null; readonly decline_reason: string | null;
  readonly sample_at: string | null; readonly result_ready_at: string | null;
  readonly cancelled_at: string | null; readonly cancel_reason: string | null; readonly expired_at: string | null;
  readonly results_sharing: LabResultsSharing; readonly doctor_available: boolean;
  readonly results: readonly PatientLabResultDto[]; readonly timeline: readonly LabRequestEventDto[];
  readonly can: { readonly accept: boolean; readonly decline: boolean; readonly sample: boolean; readonly upload: boolean; readonly pdf: boolean };
  readonly result_document_types: readonly LabOption[]; readonly default_document_type: string;
}
/** POST /api/portal/lab-requests/{id}/accept. `lab_date` is a calendar date `'Y-m-d'` ≤ `valid_until`. */
export interface AcceptLabRequestInput { consent_version: string; agree_tests: true; agree_pays_lab: true; agree_disclosure: true; share_results: boolean; lab_name?: string | null; lab_date?: string | null; }
/** 201 of POST /api/portal/lab-requests/{id}/results. */
export interface LabResultUploadedDto { readonly result: PatientLabResultDto; readonly request: PatientLabRequestDto; }
/** A signed, short-lived request-PDF link (resolve with `LabRequestsApi.fileUrl`). */
export interface LabRequestLinkDto { readonly url: string; readonly expires_at: string; readonly filename: string; }
/** A back-office row (`GET /api/admin/patients/{id}/lab-requests`): summary only, no clinical content. */
export interface AdminLabRequestSummaryDto {
  readonly id: string; readonly number: string; readonly status: LabRequestStatus; readonly priority: LabPriority;
  readonly doctor_name: string; readonly items_count: number; readonly results_count: number;
  readonly sent_at: string; readonly last_activity_at: string; readonly corrections: readonly LabCorrectionTarget[];
  readonly consented_on: string | null;            // clinic 'Y-m-d' of consent (C1 sample-date lower bound)
  readonly last_correction_note: string | null;    // staff_note; null unless the caller holds labs.manage
}
/** POST /api/admin/lab-requests/{id}/status (`labs.manage`). `sample_date` ('Y-m-d') only for In Lab. */
export interface CorrectLabStatusInput { status: LabCorrectionTarget; reason: string; sample_date?: string | null; }
/** `lab_requests` block of GET /api/admin/monitoring/overview. */
export interface MonitoringLabRequestsDto { readonly total: number; readonly awaiting_consent: number; readonly in_progress: number; readonly result_ready: number; readonly needs_review: number; readonly review_overdue: number; }
/** List meta: the page plus the per-group counts (counts ignore `group`, honour the other filters). */
export type LabListMeta = PageMeta & { readonly counts: Record<LabListGroup, number> };
/** `GVM-REQ-YYYYMMDD-NNNNN` (clinic calendar day + daily sequence). */
export const LAB_REQUEST_NUMBER_PATTERN = /^GVM-REQ-\d{8}-\d{5}$/;
