import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AcceptFollowUpParams,
  AcceptFollowUpResponse,
  AddGuestParams,
  AddGuestResultDto,
  AppointmentDocumentDto,
  AppointmentDto,
  AppointmentPayInitDto,
  BookAppointmentParams,
  FollowUpQuoteDto,
  PayInitFollowUp,
  CallLobbyDto,
  CallPresenceMap,
  CallTokenDto,
  ClinicalDocumentKind,
  ConsentDto,
  ConsultationSummaryDto,
  GuestConsentParams,
  GuestConsentResultDto,
  JoinInfoDto,
  PatientGuestListDto,
  RemoveGuestResultDto,
  LabOrderDto,
  ListMyAppointmentsQuery,
  MedicalCertificateDto,
  MessageDto,
  PaginatedResponse,
  PatientCarePlanDto,
  PatientRecordingsDto,
  PrescriptionDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService, QueryParams } from './api.service';

/**
 * Appointments client for the VideoMed backend. `listMine` hits the customer
 * portal route — the API scopes it to the signed-in patient via the bearer
 * token, so callers never pass a patient id. The attachment upload uses
 * HttpClient directly so it can report progress events.
 */
@Injectable({ providedIn: 'root' })
export class AppointmentsApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /**
   * GET /api/portal/appointments — the signed-in patient's own appointments.
   * `when: 'upcoming'` — still to come or live, soonest first (Appointments;
   * `per_page: 1` is the dashboard's next appointment); `when: 'past'` — over
   * (completed, cancelled, missed, or ended), newest first (History). With
   * `when` the order is fixed. Only upcoming | past (`attention` is a staff
   * and doctor split: the endpoint answers anything else with 422).
   */
  listMine(
    query?: ListMyAppointmentsQuery,
  ): Observable<PaginatedResponse<AppointmentDto>> {
    return this.api.get<PaginatedResponse<AppointmentDto>>(
      'api/portal/appointments',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/portal/appointments/{id} — one of the patient's own appointments. */
  getMine(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.get<SuccessResponse<AppointmentDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}`,
    );
  }

  /** POST /api/portal/appointments — book a consultation for the signed-in patient. */
  book(
    params: BookAppointmentParams,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      'api/portal/appointments',
      params,
    );
  }

  /**
   * POST /api/portal/appointments/{id}/cancel — cancel the patient's own
   * booking. A paid booking is refunded to the wallet server-side (in full,
   * or the late-cancellation share — see `cancel_policy` on {@link getMine}).
   * Only before the start: 422 "This consultation has started" after it
   * (`can_cancel` says whether it still can be).
   */
  cancel(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/cancel`,
      {},
    );
  }

  /**
   * POST /api/portal/appointments/{id}/reschedule — move the booking to a new
   * time (status rescheduled until the doctor confirms it). Only before the
   * start: 422 "This consultation has started" after it (`can_reschedule`).
   */
  reschedule(
    id: string,
    scheduledAt: string,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/reschedule`,
      { scheduled_at: scheduledAt },
    );
  }

  /** POST /api/portal/appointments/{id}/review — rate a completed consultation. */
  review(
    id: string,
    rating: number,
    comment?: string,
  ): Observable<SuccessResponse<{ id: string; rating: number }>> {
    return this.api.post<SuccessResponse<{ id: string; rating: number }>>(
      `api/portal/appointments/${encodeURIComponent(id)}/review`,
      { rating, comment },
    );
  }

  /**
   * POST /api/portal/appointments/pay-init — start a direct card payment for a
   * booking. Pass `followUp` when booking a follow-up of a completed
   * consultation, so the card is charged the follow-up price for that slot.
   */
  payInit(
    specialistId: string,
    guestCount: number,
    followUp?: PayInitFollowUp,
  ): Observable<SuccessResponse<AppointmentPayInitDto>> {
    return this.api.post<SuccessResponse<AppointmentPayInitDto>>(
      'api/portal/appointments/pay-init',
      { specialist_id: specialistId, guest_count: guestCount, ...(followUp ?? {}) },
    );
  }

  /**
   * POST /api/portal/appointments/pay-init `{appointment_id}` — start a card
   * payment to accept the doctor's follow-up proposal `id` (at its price, or
   * re-priced for `scheduledAt`). Then call `acceptFollowUp` with the reference.
   */
  payInitForProposal(
    id: string,
    scheduledAt?: string,
  ): Observable<SuccessResponse<AppointmentPayInitDto>> {
    return this.api.post<SuccessResponse<AppointmentPayInitDto>>(
      'api/portal/appointments/pay-init',
      scheduledAt ? { appointment_id: id, scheduled_at: scheduledAt } : { appointment_id: id },
    );
  }

  /**
   * POST /api/portal/appointments/{id}/follow-up/accept — accept the doctor's
   * follow-up proposal (free → confirmed at once; else wallet or a verified
   * card reference), optionally at another open slot. 422 `errors.wallet =
   * 'insufficient_funds'` when the wallet is short. A card payment the
   * acceptance can't use goes to the wallet: 422 `errors.card_payment =
   * 'credited_to_wallet'` when refused, or — on a repeat (message "Follow-up
   * already accepted…") — `meta.card_payment`.
   */
  acceptFollowUp(
    id: string,
    params: AcceptFollowUpParams = {},
  ): Observable<AcceptFollowUpResponse> {
    return this.api.post<AcceptFollowUpResponse>(
      `api/portal/appointments/${encodeURIComponent(id)}/follow-up/accept`,
      params,
    );
  }

  /** POST /api/portal/appointments/{id}/follow-up/decline — decline the proposal (reason goes to the doctor). */
  declineFollowUp(
    id: string,
    reason?: string,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/follow-up/decline`,
      reason ? { reason } : {},
    );
  }

  /**
   * GET /api/portal/appointments/{id}/follow-up/quote — the price before
   * paying: `id` is a completed consultation (booking a follow-up of it) or an
   * open proposal (accepting it, re-priced when `scheduledAt` is another slot).
   */
  followUpQuote(
    id: string,
    scheduledAt?: string,
  ): Observable<SuccessResponse<FollowUpQuoteDto>> {
    return this.api.get<SuccessResponse<FollowUpQuoteDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/follow-up/quote`,
      { scheduled_at: scheduledAt },
    );
  }

  /** GET /api/portal/appointments/{id}/follow-ups — the follow-ups of one of my consultations (any status). */
  followUps(id: string): Observable<SuccessResponse<AppointmentDto[]>> {
    return this.api.get<SuccessResponse<AppointmentDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/follow-ups`,
    );
  }

  /**
   * POST /api/portal/appointment-documents (multipart) — one file for a
   * booking, filed privately in the patient's medical documents. Emits
   * HttpEvents (UploadProgress for the bar, Response for the document); the
   * booking then attaches it by id in `document_ids`.
   */
  uploadDocument(
    file: File,
  ): Observable<HttpEvent<SuccessResponse<AppointmentDocumentDto>>> {
    const form = new FormData();
    form.append('document', file, file.name);
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return this.http.post<SuccessResponse<AppointmentDocumentDto>>(
      `${base}/api/portal/appointment-documents`,
      form,
      { reportProgress: true, observe: 'events' },
    );
  }

  // ----- Guests -----

  /**
   * GET /api/portal/appointments/{id}/guests — the patient's guests on one of
   * their consultations (email, status, in the call now, personal join link to
   * copy), the guest fee, and whether the list can change.
   */
  guests(id: string): Observable<SuccessResponse<PatientGuestListDto>> {
    return this.api.get<SuccessResponse<PatientGuestListDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/guests`,
    );
  }

  /**
   * POST /api/portal/appointments/{id}/guests — invite a guest (max 3). The
   * guest fee (`guest_fee`; "0.00" = free, send no payment) is paid from the
   * wallet (422 `errors.wallet = 'insufficient_funds'` when short) or by card
   * with the reference from {@link payInitForGuest}. 422 `errors.status` /
   * `errors.guests` / `errors.name` / `errors.email` / `errors.payment*`; a
   * payment taken for a guest that then couldn't be added goes to the wallet
   * (`errors.payment = 'credited_to_wallet'`). Answers the list + `guest`.
   */
  addGuest(id: string, params: AddGuestParams): Observable<SuccessResponse<AddGuestResultDto>> {
    return this.api.post<SuccessResponse<AddGuestResultDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/guests`,
      params,
    );
  }

  /**
   * POST /api/portal/appointments/{id}/guests/pay-init — start a card payment
   * of the guest fee (the checkout returns to /dashboard/appointments/{id};
   * keep the guest's name + email to send with the reference). 422
   * `errors.payment = 'free'` when the fee is 0 — add the guest directly.
   */
  payInitForGuest(id: string): Observable<SuccessResponse<AppointmentPayInitDto>> {
    return this.api.post<SuccessResponse<AppointmentPayInitDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/guests/pay-init`,
      {},
    );
  }

  /**
   * DELETE /api/portal/appointments/{id}/guests/{gid} — remove a guest: their
   * link stops working at once and they are emailed. Before the consultation
   * starts a paid fee is refunded to the wallet (`refunded`); after, nothing.
   */
  removeGuest(id: string, guestId: string): Observable<SuccessResponse<RemoveGuestResultDto>> {
    return this.api.delete<SuccessResponse<RemoveGuestResultDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/guests/${encodeURIComponent(guestId)}`,
    );
  }

  /**
   * POST /api/portal/appointments/{id}/guests/{gid}/resend — email the guest
   * their invitation again; at most every 2 minutes (429 with
   * `errors.retry_after` seconds).
   */
  resendGuestInvite(id: string, guestId: string): Observable<SuccessResponse<PatientGuestListDto>> {
    return this.api.post<SuccessResponse<PatientGuestListDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/guests/${encodeURIComponent(guestId)}/resend`,
      {},
    );
  }

  /** GET /api/portal/appointments/{id}/call-token — Agora RTC join credentials (uid 1) + `participants`. */
  callToken(id: string): Observable<SuccessResponse<CallTokenDto>> {
    return this.api.get<SuccessResponse<CallTokenDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/call-token`,
    );
  }

  /**
   * GET /api/portal/appointments/{id}/consultation — the patient's consultation
   * write-up. `available` is false until the doctor finalizes the note.
   */
  consultationSummary(
    id: string,
  ): Observable<SuccessResponse<ConsultationSummaryDto>> {
    return this.api.get<SuccessResponse<ConsultationSummaryDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/consultation`,
    );
  }

  /** GET /api/portal/appointments/{id}/prescriptions — the patient's issued scripts. */
  prescriptions(id: string): Observable<SuccessResponse<PrescriptionDto[]>> {
    return this.api.get<SuccessResponse<PrescriptionDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/prescriptions`,
    );
  }

  /** GET /api/portal/appointments/{id}/lab-orders — the patient's lab orders. */
  labOrders(id: string): Observable<SuccessResponse<LabOrderDto[]>> {
    return this.api.get<SuccessResponse<LabOrderDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/lab-orders`,
    );
  }

  /** GET /api/portal/appointments/{id}/care-plan — the published care plan. */
  carePlan(id: string): Observable<SuccessResponse<PatientCarePlanDto>> {
    return this.api.get<SuccessResponse<PatientCarePlanDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/care-plan`,
    );
  }

  /** GET /api/portal/appointments/{id}/referrals — the patient's referrals. */
  referrals(id: string): Observable<SuccessResponse<ReferralDto[]>> {
    return this.api.get<SuccessResponse<ReferralDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/referrals`,
    );
  }

  /** GET /api/portal/appointments/{id}/certificates — the patient's medical certificates. */
  certificates(id: string): Observable<SuccessResponse<MedicalCertificateDto[]>> {
    return this.api.get<SuccessResponse<MedicalCertificateDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/certificates`,
    );
  }

  /** GET a rendered clinical document as HTML (open via openClinicalDocument). */
  document(
    id: string,
    kind: ClinicalDocumentKind,
    docId: string,
  ): Observable<string> {
    return this.api.getText(
      `api/portal/appointments/${encodeURIComponent(id)}/documents/${kind}/${encodeURIComponent(docId)}`,
    );
  }

  /** GET /api/portal/appointments/{id}/consents — the patient's consent decisions. */
  consents(id: string): Observable<SuccessResponse<ConsentDto[]>> {
    return this.api.get<SuccessResponse<ConsentDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/consents`,
    );
  }

  /** POST /api/portal/appointments/{id}/consents — grant or withdraw a consent. */
  setConsent(
    id: string,
    type: ConsentDto['type'],
    granted: boolean,
  ): Observable<SuccessResponse<ConsentDto[]>> {
    return this.api.post<SuccessResponse<ConsentDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/consents`,
      { type, granted },
    );
  }

  /** GET /api/portal/appointments/{id}/recordings — recording state + finished files. */
  recordings(id: string): Observable<SuccessResponse<PatientRecordingsDto>> {
    return this.api.get<SuccessResponse<PatientRecordingsDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/recordings`,
    );
  }

  /** POST /api/portal/appointments/{id}/metrics — report an RTC quality sample. */
  reportMetric(
    id: string,
    payload: { uplink: number; downlink: number; rtt: number | null },
  ): Observable<SuccessResponse<{ recorded: boolean }>> {
    return this.api.post<SuccessResponse<{ recorded: boolean }>>(
      `api/portal/appointments/${encodeURIComponent(id)}/metrics`,
      payload,
    );
  }

  /** GET /api/portal/appointments/{id}/transcript — recent transcript for captions. */
  transcript(id: string): Observable<SuccessResponse<TranscriptSegmentDto[]>> {
    return this.api.get<SuccessResponse<TranscriptSegmentDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/transcript`,
    );
  }

  /** POST /api/portal/appointments/{id}/transcript — append a transcribed utterance. */
  appendTranscript(
    id: string,
    text: string,
  ): Observable<SuccessResponse<{ recorded: boolean }>> {
    return this.api.post<SuccessResponse<{ recorded: boolean }>>(
      `api/portal/appointments/${encodeURIComponent(id)}/transcript`,
      { text },
    );
  }

  /** GET /api/portal/appointments/{id}/messages — the doctor thread (marks doctor messages read). */
  messages(id: string): Observable<SuccessResponse<MessageDto[]>> {
    return this.api.get<SuccessResponse<MessageDto[]>>(
      `api/portal/appointments/${encodeURIComponent(id)}/messages`,
    );
  }

  /** POST /api/portal/appointments/{id}/messages — send a message to the doctor. */
  sendMessage(id: string, body: string): Observable<SuccessResponse<MessageDto>> {
    return this.api.post<SuccessResponse<MessageDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/messages`,
      { body },
    );
  }

  /** GET /api/portal/appointments/presence — who is in each of my appointments' calls now. */
  presence(): Observable<SuccessResponse<CallPresenceMap>> {
    return this.api.get<SuccessResponse<CallPresenceMap>>('api/portal/appointments/presence');
  }

  /** Absolute URL of the signed-in patient's call heartbeat (POST {state}). */
  presenceUrl(id: string): string {
    return this.api.absoluteUrl(`api/portal/appointments/${encodeURIComponent(id)}/presence`);
  }

  /** Absolute URL of the join-link call heartbeat (POST {state}); the token is the credential. */
  joinPresenceUrl(token: string): string {
    return this.api.absoluteUrl(`api/public/call/${encodeURIComponent(token)}/presence`);
  }

  /**
   * GET /api/public/call/{token} — resolve a preauthenticated join link (from an
   * invite email) into the meeting details + Agora credentials. No auth: the
   * signed token in the path is the credential. Call again to renew the RTC
   * token. Refusals carry `errors.code` ({@link CallRefusalCode}): 410
   * cancelled / ended / withdrawn, 409 not_confirmed, 425 too_early (guests;
   * `errors.opens_at`), 403 consent_required (guests; accept the notice first).
   */
  joinInfo(token: string): Observable<SuccessResponse<JoinInfoDto>> {
    return this.api.get<SuccessResponse<JoinInfoDto>>(
      `api/public/call/${encodeURIComponent(token)}`,
    );
  }

  /**
   * GET /api/public/call/{token}/lobby — the pre-join screen without joining:
   * the consultation, who invited a guest, participants, the guest's notice
   * state, `can_join` (false until `opens_at` for an early guest) and
   * `server_time`. Refuses like {@link joinInfo} except too early.
   */
  joinLobby(token: string): Observable<SuccessResponse<CallLobbyDto>> {
    return this.api.get<SuccessResponse<CallLobbyDto>>(
      `api/public/call/${encodeURIComponent(token)}/lobby`,
    );
  }

  /**
   * POST /api/public/call/{token}/consent — a guest accepts the recording +
   * privacy notice (and may set the name they show as, 1–60 characters).
   * Required before joining when `consent.required`.
   */
  consentToCall(
    token: string,
    params: GuestConsentParams,
  ): Observable<SuccessResponse<GuestConsentResultDto>> {
    return this.api.post<SuccessResponse<GuestConsentResultDto>>(
      `api/public/call/${encodeURIComponent(token)}/consent`,
      params,
    );
  }
}
