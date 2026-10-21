import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  CallPresenceMap,
  AddAvailabilityInput,
  AppointmentDto,
  AppointmentWhen,
  AvailabilityRangeDto,
  BlockAvailabilityInput,
  CarePlanDto,
  ClinicalDocumentKind,
  ClinicalNoteDto,
  ClinicalNoteInput,
  ConsentDto,
  CopilotDraftDto,
  CreateCertificateParams,
  CreateLabOrderParams,
  CancelPrescriptionResult,
  ClinicalSummaryDto,
  CreatePrescriptionInput,
  DoctorSignatureDto,
  DrugDto,
  CreateReferralParams,
  DoctorAppointmentDto,
  DaySlotsDto,
  DoctorAvailabilityDto,
  DoctorAccessRequestDto,
  DoctorCopilotStateDto,
  DoctorDocumentAccessDto,
  DoctorDashboardDto,
  DoctorFollowUpDto,
  FollowUpQuoteDto,
  ProposeFollowUpParams,
  DoctorOnboardingDto,
  DoctorCredentialsDto,
  DoctorStandingCode,
  PractitionerTermsDto,
  SpecialistCredentialDto,
  UploadCredentialInput,
  DoctorPatientListItemDto,
  DoctorPatientRecordDto,
  DoctorProfileDto,
  DoctorProfileUpdate,
  DoctorRecordingStateDto,
  MedicalDocumentDto,
  DoctorScheduleDto,
  EarningsSummaryDto,
  EarningsTxnDto,
  CertificatesListResponse,
  LabOrderDto,
  MedicalCertificateDto,
  MessageDto,
  PaginatedResponse,
  PayoutAccountDto,
  PayoutAccountInput,
  PayoutDto,
  PrescriptionDto,
  PrescriptionFormInput,
  PrescriptionLinkDto,
  PrescriptionOptionsDto,
  PrescriptionStatus,
  PrescriptionSummaryDto,
  SendPrescriptionInput,
  ReviewDto,
  ReviewSummaryDto,
  RecordingDto,
  RecordingFilesDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { apiErrorFields } from './api-error.util';
import { ApiRequestOptions, ApiService, QueryParams } from './api.service';

const STANDING_CODES: readonly DoctorStandingCode[] = ['doctor_suspended', 'doctor_not_approved', 'terms_required'];

/** Whether `code` (e.g. an API `errors.code`) is a doctor-standing refusal. */
export function isDoctorStandingCode(code: unknown): code is DoctorStandingCode {
  return typeof code === 'string' && (STANDING_CODES as readonly string[]).includes(code);
}

/**
 * The doctor-standing refusal an error carries — a 403 from any doctor route
 * (or a call join) while the doctor is suspended, not approved yet, or owes the
 * practitioner terms — else null. Lets a page route to the onboarding / terms
 * screen instead of showing a generic error.
 */
export function doctorStandingCode(err: unknown): DoctorStandingCode | null {
  const code = apiErrorFields(err)['code'];
  return isDoctorStandingCode(code) ? code : null;
}

/**
 * The doctor portal's clinical API — every `/api/doctor/*` endpoint, returning
 * the shared model DTOs. Authorization is enforced server-side (the signed-in
 * doctor must own the appointment); the staff bearer token is attached by
 * `staffAuthInterceptor`.
 */
@Injectable({ providedIn: 'root' })
export class DoctorApi {
  private readonly api = inject(ApiService);
  private readonly config = inject(API_CONFIG);

  private base(id: string): string {
    return `api/doctor/appointments/${encodeURIComponent(id)}`;
  }

  /** Resolve a relative asset path (e.g. a photo_url) to an absolute URL. */
  assetUrl(relative: string | null | undefined): string | null {
    if (!relative) return null;
    if (/^https?:\/\//.test(relative)) return relative;
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return `${base}/${relative.replace(/^\/+/, '')}`;
  }

  /** GET /api/doctor/dashboard — headline metrics + today's agenda. */
  dashboard(): Observable<SuccessResponse<DoctorDashboardDto>> {
    return this.api.get<SuccessResponse<DoctorDashboardDto>>('api/doctor/dashboard');
  }

  /** GET /api/doctor/appointments/presence — who is in each of my consultations' calls now. */
  presence(): Observable<SuccessResponse<CallPresenceMap>> {
    return this.api.get<SuccessResponse<CallPresenceMap>>('api/doctor/appointments/presence');
  }

  /**
   * GET /api/doctor/appointments — the signed-in doctor's schedule: today's
   * and what's coming, then the latest earlier ones. Not every consultation —
   * load one by id with {@link appointment}. With `when` (100 rows) it is split
   * by time instead: `upcoming` (still to come or live, soonest first — the
   * Pending / Upcoming tabs), `past` (over, newest first), `attention` (past
   * and still open, newest first).
   */
  schedule(when?: AppointmentWhen): Observable<SuccessResponse<DoctorScheduleDto>> {
    return this.api.get<SuccessResponse<DoctorScheduleDto>>(
      'api/doctor/appointments',
      when ? { when } : undefined,
    );
  }

  /** GET /api/doctor/appointments/{id} — one of my consultations (any date), as a schedule row. */
  appointment(id: string): Observable<SuccessResponse<DoctorAppointmentDto>> {
    return this.api.get<SuccessResponse<DoctorAppointmentDto>>(this.base(id));
  }

  /**
   * GET /api/doctor/appointments/history — paginated, filterable history.
   * `when` defaults to `past` on the server (over: closed, or ended over 30
   * minutes ago — newest first); `upcoming`, `attention` or `all` otherwise.
   * `status` CSV, e.g. `missed` for the Missed filter.
   */
  history(query?: {
    page?: number;
    per_page?: number;
    status?: string;
    search?: string;
    when?: AppointmentWhen | 'all';
  }): Observable<PaginatedResponse<DoctorAppointmentDto>> {
    return this.api.get<PaginatedResponse<DoctorAppointmentDto>>(
      'api/doctor/appointments/history',
      query as QueryParams | undefined,
    );
  }

  /**
   * POST /api/doctor/appointments/{id}/decline — decline + refund. `reason`
   * (optional, up to 500 characters) is a message to the patient, included
   * in their email.
   */
  decline(id: string, reason?: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `${this.base(id)}/decline`,
      reason ? { reason } : {},
    );
  }

  /** POST /api/doctor/appointments/{id}/reschedule — move to a new time. */
  reschedule(
    id: string,
    scheduledAt: string,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `${this.base(id)}/reschedule`,
      { scheduled_at: scheduledAt },
    );
  }

  /** POST /api/doctor/appointments/{id}/confirm — confirm a pending booking. */
  confirm(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `${this.base(id)}/confirm`,
      {},
    );
  }

  /**
   * POST /api/doctor/appointments/{id}/complete — end the consultation: a
   * confirmed visit that has started becomes completed (and moves to history).
   * Idempotent: an already-completed visit answers 200 too.
   */
  complete(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `${this.base(id)}/complete`,
      {},
    );
  }

  // ----- Follow-ups -----

  /**
   * POST /api/doctor/appointments/{id}/follow-up — propose a follow-up of
   * consultation `id` (in progress or completed) at one of the doctor's open
   * slots. It is `proposed` (holding the slot) until the patient answers or it
   * expires. 422 `errors.follow_up` while another proposal is open.
   */
  proposeFollowUp(
    id: string,
    params: ProposeFollowUpParams,
  ): Observable<SuccessResponse<DoctorFollowUpDto>> {
    return this.api.post<SuccessResponse<DoctorFollowUpDto>>(
      `${this.base(id)}/follow-up`,
      params,
    );
  }

  /**
   * GET /api/doctor/appointments/{id}/follow-up/quote — the patient's price for
   * a follow-up of `id` (starting at `scheduledAt`, default now; `waive` = free).
   */
  followUpQuote(
    id: string,
    query: { scheduledAt?: string; waive?: boolean } = {},
  ): Observable<SuccessResponse<FollowUpQuoteDto>> {
    return this.api.get<SuccessResponse<FollowUpQuoteDto>>(
      `${this.base(id)}/follow-up/quote`,
      { scheduled_at: query.scheduledAt, waive: query.waive ? 1 : undefined },
    );
  }

  /** GET /api/doctor/appointments/{id}/follow-ups — every follow-up of consultation `id` (any status). */
  followUps(id: string): Observable<SuccessResponse<DoctorFollowUpDto[]>> {
    return this.api.get<SuccessResponse<DoctorFollowUpDto[]>>(
      `${this.base(id)}/follow-ups`,
    );
  }

  /**
   * POST /api/doctor/appointments/{id}/follow-up/withdraw — withdraw the
   * unanswered proposal `id` (the proposal's own id). Idempotent; 422 once
   * the patient has accepted it.
   */
  withdrawFollowUp(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `${this.base(id)}/follow-up/withdraw`,
      {},
    );
  }

  // ----- Profile (self-service) -----

  // ----- Patients -----

  patients(query?: {
    page?: number;
    per_page?: number;
    search?: string;
  }): Observable<PaginatedResponse<DoctorPatientListItemDto>> {
    return this.api.get<PaginatedResponse<DoctorPatientListItemDto>>(
      'api/doctor/patients',
      query as QueryParams | undefined,
    );
  }

  patient(id: string): Observable<SuccessResponse<DoctorPatientRecordDto>> {
    return this.api.get<SuccessResponse<DoctorPatientRecordDto>>(
      `api/doctor/patients/${encodeURIComponent(id)}`,
    );
  }

  /**
   * GET .../patient-documents — the documents the patient has shared with you
   * (an empty list when they share none, or when it could not be worked out).
   *
   * @deprecated use documentAccess(): it also says until when, and tells
   * "nothing shared" apart from "could not load".
   */
  patientDocuments(id: string): Observable<SuccessResponse<MedicalDocumentDto[]>> {
    return this.api.get<SuccessResponse<MedicalDocumentDto[]>>(
      `${this.base(id)}/patient-documents`,
    );
  }

  /**
   * GET a patient document's bytes (authenticated) for preview/download. Every
   * open is recorded and shown to the patient. 404 `errors.code = 'not_shared'`
   * when it is no longer shared with you; 503 `view_unavailable` when the
   * open could not be recorded (nothing is streamed then).
   */
  patientDocumentBlob(id: string, docId: string): Observable<Blob> {
    return this.api.getBlob(
      `${this.base(id)}/patient-documents/${encodeURIComponent(docId)}/file`,
    );
  }

  /**
   * GET .../document-access — what the patient shares with you (scope, until
   * when, the documents) and whether you can ask for access. 503
   * `sharing_unavailable` when it could not be loaded — show an error with
   * Try again, never "No documents". Background refreshes pass
   * `{ passive: true }` so they never extend your idle session.
   */
  documentAccess(id: string, options?: ApiRequestOptions): Observable<SuccessResponse<DoctorDocumentAccessDto>> {
    return this.api.get<SuccessResponse<DoctorDocumentAccessDto>>(
      `${this.base(id)}/document-access`,
      undefined,
      options,
    );
  }

  /**
   * POST .../document-access/request — ask the patient to share documents
   * (an optional note, ≤ 500 characters, shown to the patient in the app
   * only). 409 `request_pending` / `request_cooldown` / `request_limit` /
   * `has_full_access` / `request_blocked` (+ `errors.available_at`); 422
   * `appointment_not_eligible` / `doctor_unavailable` / `message`.
   */
  requestDocumentAccess(id: string, message?: string): Observable<SuccessResponse<DoctorAccessRequestDto>> {
    const note = message?.trim();
    return this.api.post<SuccessResponse<DoctorAccessRequestDto>>(
      `${this.base(id)}/document-access/request`,
      note ? { message: note } : {},
    );
  }

  /** POST .../document-access/request/cancel — withdraw your pending request (409 `request_not_pending`). */
  cancelDocumentAccessRequest(id: string): Observable<SuccessResponse<DoctorAccessRequestDto>> {
    return this.api.post<SuccessResponse<DoctorAccessRequestDto>>(
      `${this.base(id)}/document-access/request/cancel`,
      {},
    );
  }

  // ----- Reviews -----

  reviews(query?: {
    page?: number;
    per_page?: number;
  }): Observable<PaginatedResponse<ReviewDto>> {
    return this.api.get<PaginatedResponse<ReviewDto>>(
      'api/doctor/reviews',
      query as QueryParams | undefined,
    );
  }

  reviewsSummary(): Observable<SuccessResponse<ReviewSummaryDto>> {
    return this.api.get<SuccessResponse<ReviewSummaryDto>>('api/doctor/reviews/summary');
  }

  respondReview(id: string, response: string): Observable<SuccessResponse<ReviewDto>> {
    return this.api.post<SuccessResponse<ReviewDto>>(
      `api/doctor/reviews/${encodeURIComponent(id)}/respond`,
      { response },
    );
  }

  // ----- Earnings & payouts -----

  earnings(): Observable<SuccessResponse<EarningsSummaryDto>> {
    return this.api.get<SuccessResponse<EarningsSummaryDto>>('api/doctor/earnings');
  }

  earningsTransactions(query?: {
    page?: number;
    per_page?: number;
  }): Observable<PaginatedResponse<EarningsTxnDto>> {
    return this.api.get<PaginatedResponse<EarningsTxnDto>>(
      'api/doctor/earnings/transactions',
      query as QueryParams | undefined,
    );
  }

  getPayoutAccount(): Observable<SuccessResponse<PayoutAccountDto | null>> {
    return this.api.get<SuccessResponse<PayoutAccountDto | null>>('api/doctor/payout-account');
  }

  savePayoutAccount(
    params: PayoutAccountInput,
  ): Observable<SuccessResponse<PayoutAccountDto>> {
    return this.api.put<SuccessResponse<PayoutAccountDto>>('api/doctor/payout-account', params);
  }

  payouts(): Observable<SuccessResponse<PayoutDto[]>> {
    return this.api.get<SuccessResponse<PayoutDto[]>>('api/doctor/payouts');
  }

  requestPayout(amount: string, note?: string): Observable<SuccessResponse<PayoutDto>> {
    return this.api.post<SuccessResponse<PayoutDto>>('api/doctor/payouts', { amount, note });
  }

  /** GET /api/doctor/onboarding — first-login checklist + review status. */
  onboarding(): Observable<SuccessResponse<DoctorOnboardingDto>> {
    return this.api.get<SuccessResponse<DoctorOnboardingDto>>('api/doctor/onboarding');
  }

  /** POST /api/doctor/onboarding/submit — send the finished profile for review. */
  submitOnboarding(): Observable<SuccessResponse<DoctorOnboardingDto>> {
    return this.api.post<SuccessResponse<DoctorOnboardingDto>>(
      'api/doctor/onboarding/submit',
      {},
    );
  }

  // ----- Licensing documents + practitioner terms (open whatever the doctor's standing) -----

  /** GET /api/doctor/credentials — my documents (replaced ones left out), the types and upload limits. */
  credentials(): Observable<SuccessResponse<DoctorCredentialsDto>> {
    return this.api.get<SuccessResponse<DoctorCredentialsDto>>('api/doctor/credentials');
  }

  /**
   * POST /api/doctor/credentials (multipart) — upload a document: PDF / JPG /
   * PNG ≤ 10MB; a licence needs `number` and `expires_at`. 422 per field.
   */
  uploadCredential(input: UploadCredentialInput): Observable<SuccessResponse<SpecialistCredentialDto>> {
    const form = new FormData();
    form.append('file', input.file);
    form.append('type', input.type);
    if (input.number) form.append('number', input.number);
    if (input.issued_at) form.append('issued_at', input.issued_at);
    if (input.expires_at) form.append('expires_at', input.expires_at);
    return this.api.post<SuccessResponse<SpecialistCredentialDto>>('api/doctor/credentials', form);
  }

  /** DELETE /api/doctor/credentials/{id} — delete a document still waiting for review. */
  deleteCredential(id: string): Observable<SuccessResponse<null>> {
    return this.api.delete<SuccessResponse<null>>(
      `api/doctor/credentials/${encodeURIComponent(id)}`,
    );
  }

  /** GET /api/doctor/credentials/{id}/file — one of my documents as a Blob (show from an object URL). */
  credentialFile(id: string): Observable<Blob> {
    return this.api.getBlob(`api/doctor/credentials/${encodeURIComponent(id)}/file`);
  }

  /** GET /api/doctor/terms — the practitioner terms in force, as plain blocks, and whether I accepted them. */
  terms(): Observable<SuccessResponse<PractitionerTermsDto>> {
    return this.api.get<SuccessResponse<PractitionerTermsDto>>('api/doctor/terms');
  }

  /**
   * POST /api/doctor/terms/accept — accept `version` (the one shown). 422
   * `version` when the terms changed meanwhile (reload them).
   */
  acceptTerms(version: string): Observable<SuccessResponse<PractitionerTermsDto>> {
    return this.api.post<SuccessResponse<PractitionerTermsDto>>('api/doctor/terms/accept', {
      version,
      agree: true,
    });
  }

  /** DELETE /api/doctor/profile/changes — withdraw my change request still waiting for review. */
  withdrawProfileChanges(): Observable<SuccessResponse<DoctorProfileDto>> {
    return this.api.delete<SuccessResponse<DoctorProfileDto>>('api/doctor/profile/changes');
  }

  /** GET /api/doctor/profile — the doctor's own profile (email + weekly hours). */
  getProfile(): Observable<SuccessResponse<DoctorProfileDto>> {
    return this.api.get<SuccessResponse<DoctorProfileDto>>('api/doctor/profile');
  }

  /** PATCH /api/doctor/profile — update the doctor's own profile. */
  updateProfile(
    params: DoctorProfileUpdate,
  ): Observable<SuccessResponse<DoctorProfileDto>> {
    return this.api.patch<SuccessResponse<DoctorProfileDto>>(
      'api/doctor/profile',
      params,
    );
  }

  /** POST /api/doctor/avatar — upload the doctor's headshot (multipart). */
  uploadAvatar(file: File): Observable<SuccessResponse<DoctorProfileDto>> {
    const form = new FormData();
    form.append('avatar', file);
    return this.api.post<SuccessResponse<DoctorProfileDto>>(
      'api/doctor/avatar',
      form,
    );
  }

  /** DELETE /api/doctor/avatar — remove the doctor's headshot. */
  removeAvatar(): Observable<SuccessResponse<DoctorProfileDto>> {
    return this.api.delete<SuccessResponse<DoctorProfileDto>>(
      'api/doctor/avatar',
    );
  }

  // ----- Availability (date-specific slots) -----

  /** GET /api/doctor/availability — open/booked/blocked slots for a window. */
  availability(
    from?: string,
    to?: string,
  ): Observable<SuccessResponse<DoctorAvailabilityDto>> {
    return this.api.get<SuccessResponse<DoctorAvailabilityDto>>(
      'api/doctor/availability',
      { from, to },
    );
  }

  /** POST /api/doctor/availability — publish open slots for a date. */
  addAvailability(
    input: AddAvailabilityInput,
  ): Observable<SuccessResponse<{ created: number }>> {
    return this.api.post<SuccessResponse<{ created: number }>>(
      'api/doctor/availability',
      input,
    );
  }

  /** POST /api/doctor/availability/block — block a day or time span. */
  blockAvailability(
    input: BlockAvailabilityInput,
  ): Observable<SuccessResponse<unknown>> {
    return this.api.post<SuccessResponse<unknown>>(
      'api/doctor/availability/block',
      input,
    );
  }

  /** DELETE /api/doctor/availability/{id} — remove a slot or block. */
  deleteAvailability(id: string): Observable<SuccessResponse<unknown>> {
    return this.api.delete<SuccessResponse<unknown>>(
      `api/doctor/availability/${encodeURIComponent(id)}`,
    );
  }

  /**
   * GET /api/doctor/calendar — the doctor's own booking calendar (reschedule /
   * follow-up pickers): like the public one, but reaching a year ahead (not
   * the patient horizon) and shown while switched off for bookings. Use it
   * through `AvailabilityCalendarStore.load(id, tz, { scope: 'doctor' })`.
   */
  calendar(params: {
    from: string;
    to: string;
    tz?: string;
  }): Observable<SuccessResponse<AvailabilityRangeDto>> {
    return this.api.get<SuccessResponse<AvailabilityRangeDto>>(
      'api/doctor/calendar',
      params,
    );
  }

  /** GET /api/doctor/calendar/slots?date= — the doctor's own open times on one date (in `tz`). */
  calendarSlots(
    date: string,
    tz?: string,
  ): Observable<SuccessResponse<DaySlotsDto>> {
    return this.api.get<SuccessResponse<DaySlotsDto>>(
      'api/doctor/calendar/slots',
      { date, tz },
    );
  }

  // ----- Secure messaging -----

  /** GET .../messages — the patient thread (marks the patient's messages read). */
  messages(id: string): Observable<SuccessResponse<MessageDto[]>> {
    return this.api.get<SuccessResponse<MessageDto[]>>(`${this.base(id)}/messages`);
  }

  /** POST .../messages — reply to the patient. */
  sendMessage(id: string, body: string): Observable<SuccessResponse<MessageDto>> {
    return this.api.post<SuccessResponse<MessageDto>>(
      `${this.base(id)}/messages`,
      { body },
    );
  }

  // ----- Clinical note (SOAP) -----

  getNote(id: string): Observable<SuccessResponse<ClinicalNoteDto>> {
    return this.api.get<SuccessResponse<ClinicalNoteDto>>(`${this.base(id)}/note`);
  }

  saveNote(
    id: string,
    input: ClinicalNoteInput,
  ): Observable<SuccessResponse<ClinicalNoteDto>> {
    return this.api.put<SuccessResponse<ClinicalNoteDto>>(
      `${this.base(id)}/note`,
      input,
    );
  }

  finalizeNote(
    id: string,
    input: ClinicalNoteInput,
  ): Observable<SuccessResponse<ClinicalNoteDto>> {
    return this.api.post<SuccessResponse<ClinicalNoteDto>>(
      `${this.base(id)}/note/finalize`,
      input,
    );
  }

  // ----- Prescriptions (GVM-RX-01/02) -----

  /** GET .../appointments/{id}/prescriptions — this consultation's prescriptions (drafts included). */
  listPrescriptions(id: string): Observable<SuccessResponse<PrescriptionDto[]>> {
    return this.api.get<SuccessResponse<PrescriptionDto[]>>(
      `${this.base(id)}/prescriptions`,
    );
  }

  /** GET /api/doctor/drugs — search the RxNorm prescribable catalogue. */
  searchDrugs(q: string, limit = 20): Observable<SuccessResponse<DrugDto[]>> {
    return this.api.get<SuccessResponse<DrugDto[]>>('api/doctor/drugs', { q, limit });
  }

  /** GET /api/doctor/prescriptions/options — defaults, option lists, signature/MDCN status. */
  prescriptionOptions(): Observable<SuccessResponse<PrescriptionOptionsDto>> {
    return this.api.get<SuccessResponse<PrescriptionOptionsDto>>('api/doctor/prescriptions/options');
  }

  /** GET /api/doctor/prescriptions — all my prescriptions (paginated, filterable). */
  allPrescriptions(params: {
    status?: PrescriptionStatus;
    patient_id?: string;
    page?: number;
    per_page?: number;
  } = {}): Observable<PaginatedResponse<PrescriptionSummaryDto>> {
    return this.api.get<PaginatedResponse<PrescriptionSummaryDto>>('api/doctor/prescriptions', params);
  }

  /** GET /api/doctor/prescriptions/{rxId} */
  getPrescription(rxId: string): Observable<SuccessResponse<PrescriptionDto>> {
    return this.api.get<SuccessResponse<PrescriptionDto>>(`api/doctor/prescriptions/${encodeURIComponent(rxId)}`);
  }

  /** POST /api/doctor/prescriptions — start a draft (consultation or standalone). */
  createPrescription(input: CreatePrescriptionInput): Observable<SuccessResponse<PrescriptionDto>> {
    return this.api.post<SuccessResponse<PrescriptionDto>>('api/doctor/prescriptions', input);
  }

  /** PUT /api/doctor/prescriptions/{rxId} — save the whole draft form. */
  updatePrescription(rxId: string, form: PrescriptionFormInput): Observable<SuccessResponse<PrescriptionDto>> {
    return this.api.put<SuccessResponse<PrescriptionDto>>(`api/doctor/prescriptions/${encodeURIComponent(rxId)}`, form);
  }

  /** DELETE /api/doctor/prescriptions/{rxId} — discard a draft. */
  deletePrescription(rxId: string): Observable<SuccessResponse<null>> {
    return this.api.delete<SuccessResponse<null>>(`api/doctor/prescriptions/${encodeURIComponent(rxId)}`);
  }

  /** POST .../{rxId}/send — checklist + signature; locks and sends to the patient. */
  sendPrescription(rxId: string, input: SendPrescriptionInput): Observable<SuccessResponse<PrescriptionDto>> {
    return this.api.post<SuccessResponse<PrescriptionDto>>(`api/doctor/prescriptions/${encodeURIComponent(rxId)}/send`, input);
  }

  /** POST .../{rxId}/cancel — cancel an active prescription, optionally starting a replacement draft. */
  cancelPrescription(rxId: string, reason: string, replace: boolean): Observable<SuccessResponse<CancelPrescriptionResult>> {
    return this.api.post<SuccessResponse<CancelPrescriptionResult>>(
      `api/doctor/prescriptions/${encodeURIComponent(rxId)}/cancel`,
      { reason, replace },
    );
  }

  /** POST .../{rxId}/link — a signed short-lived PDF link (resolve with `apiFileUrl`). */
  prescriptionLink(rxId: string, download = false): Observable<SuccessResponse<PrescriptionLinkDto>> {
    return this.api.post<SuccessResponse<PrescriptionLinkDto>>(
      `api/doctor/prescriptions/${encodeURIComponent(rxId)}/link`,
      { download },
    );
  }

  /** GET /api/doctor/patients/{id}/clinical-summary — the read-only prescribing side panel. */
  clinicalSummary(patientId: string): Observable<SuccessResponse<ClinicalSummaryDto>> {
    return this.api.get<SuccessResponse<ClinicalSummaryDto>>(
      `api/doctor/patients/${encodeURIComponent(patientId)}/clinical-summary`,
    );
  }

  /** GET /api/doctor/signature */
  getSignature(): Observable<SuccessResponse<DoctorSignatureDto>> {
    return this.api.get<SuccessResponse<DoctorSignatureDto>>('api/doctor/signature');
  }

  /** POST /api/doctor/signature — a PNG/JPG file (< 500 KB) or a drawn `data:` URL. */
  saveSignature(source: File | string): Observable<SuccessResponse<DoctorSignatureDto>> {
    if (typeof source === 'string') {
      return this.api.post<SuccessResponse<DoctorSignatureDto>>('api/doctor/signature', { image: source });
    }
    const form = new FormData();
    form.append('signature', source);
    return this.api.post<SuccessResponse<DoctorSignatureDto>>('api/doctor/signature', form);
  }

  /** DELETE /api/doctor/signature */
  deleteSignature(): Observable<SuccessResponse<DoctorSignatureDto>> {
    return this.api.delete<SuccessResponse<DoctorSignatureDto>>('api/doctor/signature');
  }

  // ----- Lab orders -----

  listLabOrders(id: string): Observable<SuccessResponse<LabOrderDto[]>> {
    return this.api.get<SuccessResponse<LabOrderDto[]>>(
      `${this.base(id)}/lab-orders`,
    );
  }

  createLabOrder(
    id: string,
    params: CreateLabOrderParams,
  ): Observable<SuccessResponse<LabOrderDto>> {
    return this.api.post<SuccessResponse<LabOrderDto>>(
      `${this.base(id)}/lab-orders`,
      params,
    );
  }

  // ----- Care plan -----

  getCarePlan(id: string): Observable<SuccessResponse<CarePlanDto>> {
    return this.api.get<SuccessResponse<CarePlanDto>>(`${this.base(id)}/care-plan`);
  }

  saveCarePlan(
    id: string,
    items: string[],
  ): Observable<SuccessResponse<CarePlanDto>> {
    return this.api.put<SuccessResponse<CarePlanDto>>(
      `${this.base(id)}/care-plan`,
      { items },
    );
  }

  // ----- Referrals -----

  listReferrals(id: string): Observable<SuccessResponse<ReferralDto[]>> {
    return this.api.get<SuccessResponse<ReferralDto[]>>(
      `${this.base(id)}/referrals`,
    );
  }

  createReferral(
    id: string,
    params: CreateReferralParams,
  ): Observable<SuccessResponse<ReferralDto>> {
    return this.api.post<SuccessResponse<ReferralDto>>(
      `${this.base(id)}/referrals`,
      params,
    );
  }

  // ----- Certificates + printable documents -----

  /** `meta.earliest_from_date` is the earliest sick-leave start the API accepts. */
  listCertificates(id: string): Observable<CertificatesListResponse> {
    return this.api.get<CertificatesListResponse>(
      `${this.base(id)}/certificates`,
    );
  }

  createCertificate(
    id: string,
    params: CreateCertificateParams,
  ): Observable<SuccessResponse<MedicalCertificateDto>> {
    return this.api.post<SuccessResponse<MedicalCertificateDto>>(
      `${this.base(id)}/certificates`,
      params,
    );
  }

  /** GET a rendered clinical document as HTML (open via openClinicalDocument). */
  document(
    id: string,
    kind: ClinicalDocumentKind,
    docId: string,
  ): Observable<string> {
    return this.api.getText(
      `${this.base(id)}/documents/${kind}/${encodeURIComponent(docId)}`,
    );
  }

  // ----- Consents (read) -----

  consents(id: string): Observable<SuccessResponse<ConsentDto[]>> {
    return this.api.get<SuccessResponse<ConsentDto[]>>(`${this.base(id)}/consents`);
  }

  // ----- Recording -----

  recordingState(
    id: string,
  ): Observable<SuccessResponse<DoctorRecordingStateDto>> {
    return this.api.get<SuccessResponse<DoctorRecordingStateDto>>(
      `${this.base(id)}/recording`,
    );
  }

  startRecording(id: string): Observable<SuccessResponse<RecordingDto>> {
    return this.api.post<SuccessResponse<RecordingDto>>(
      `${this.base(id)}/recording/start`,
      {},
    );
  }

  stopRecording(
    id: string,
  ): Observable<SuccessResponse<RecordingDto | { active: false }>> {
    return this.api.post<SuccessResponse<RecordingDto | { active: false }>>(
      `${this.base(id)}/recording/stop`,
      {},
    );
  }

  /** GET .../recording/files — playback/download URLs for the appt's recordings. */
  recordingFiles(id: string): Observable<SuccessResponse<RecordingFilesDto>> {
    return this.api.get<SuccessResponse<RecordingFilesDto>>(
      `${this.base(id)}/recording/files`,
    );
  }

  // ----- Transcript + AI copilot -----

  transcript(id: string): Observable<SuccessResponse<TranscriptSegmentDto[]>> {
    return this.api.get<SuccessResponse<TranscriptSegmentDto[]>>(
      `${this.base(id)}/transcript`,
    );
  }

  appendTranscript(
    id: string,
    text: string,
  ): Observable<SuccessResponse<{ recorded: boolean }>> {
    return this.api.post<SuccessResponse<{ recorded: boolean }>>(
      `${this.base(id)}/transcript`,
      { text },
    );
  }

  copilot(id: string): Observable<SuccessResponse<DoctorCopilotStateDto>> {
    return this.api.get<SuccessResponse<DoctorCopilotStateDto>>(
      `${this.base(id)}/copilot`,
    );
  }

  generateCopilot(id: string): Observable<SuccessResponse<CopilotDraftDto>> {
    return this.api.post<SuccessResponse<CopilotDraftDto>>(
      `${this.base(id)}/copilot/draft`,
      {},
    );
  }
}
