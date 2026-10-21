import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDocumentAccessDto,
  ApproveAccessRequestInput,
  CreateDocumentShareInput,
  DeclineAccessRequestInput,
  DocumentAccessEventDto,
  DocumentAccessRequestDto,
  DocumentGrantDto,
  DocumentShareResultDto,
  PaginatedResponse,
  RestoreResultDto,
  RevokeResultDto,
  SharingDoctorDto,
  SuccessResponse,
  UpdateDocumentGrantInput,
} from '@supadoc/models';
import { ApiRequestOptions, ApiService, QueryParams } from './api.service';

const BASE = 'api/portal/document-access';

/** One path segment (an id from a route, a query string or a DTO), safely encoded. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

/**
 * The patient's document-sharing API (`/api/portal/document-access/*`): which
 * doctors they have booked and what each can see, shares (whole folder or
 * selected documents, for a period or with no end date), changes, revokes +
 * Undo, doctors' access requests (approve / decline) and the activity ledger.
 *
 * Everything is private by default; nothing here shares implicitly. Render
 * every outcome from the response (`outcomes`, `replayed`, `status`), never
 * from what was asked for. Per-document access lives on `DocumentsApi`
 * (`access`, `removeDoctorAccess`, `unhideForDoctor`); the doctor side on
 * `DoctorApi` (`documentAccess`, `requestDocumentAccess`, …).
 *
 * A 503 `errors.code = 'sharing_unavailable'` means sharing is switched off on
 * the server — show "Sharing is unavailable right now. Your documents stay
 * private." with no actions.
 */
@Injectable({ providedIn: 'root' })
export class DocumentSharingApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/document-access/doctors — every doctor the patient has booked, most recent first. */
  doctors(): Observable<SuccessResponse<SharingDoctorDto[]>> {
    return this.api.get<SuccessResponse<SharingDoctorDto[]>>(`${BASE}/doctors`);
  }

  /**
   * GET /api/portal/document-access/grants — `status: 'active'` (default; a
   * paused doctor's shares come back as `status: 'paused'`) or `'ended'` (the
   * last 90 days, newest first), optionally for one doctor.
   */
  grants(query?: {
    status?: 'active' | 'ended';
    specialist_id?: string;
  }): Observable<SuccessResponse<DocumentGrantDto[]>> {
    return this.api.get<SuccessResponse<DocumentGrantDto[]>>(
      `${BASE}/grants`,
      query as QueryParams | undefined,
    );
  }

  /**
   * POST /api/portal/document-access/grants — share with 1–5 doctors in one
   * transaction (any refusal shares with nobody). 201 created, or 200 with
   * `replayed: true` for a repeat of the same `client_key` + body; the same
   * key with a different body is 409 `idempotency_conflict` (make a new key).
   */
  share(input: CreateDocumentShareInput): Observable<SuccessResponse<DocumentShareResultDto>> {
    return this.api.post<SuccessResponse<DocumentShareResultDto>>(`${BASE}/grants`, input);
  }

  /**
   * PATCH /api/portal/document-access/grants/{id} — change the end, the scope
   * or the selected documents. 409 `grant_ended` when it already ended. A
   * scope → `all` change may merge into the doctor's other folder share: the
   * survivor comes back.
   */
  updateGrant(id: string, input: UpdateDocumentGrantInput): Observable<SuccessResponse<DocumentGrantDto>> {
    return this.api.patch<SuccessResponse<DocumentGrantDto>>(`${BASE}/grants/${seg(id)}`, input);
  }

  /** POST /api/portal/document-access/grants/{id}/revoke — stop one share (idempotent); carries `restorable_until`. */
  revokeGrant(id: string): Observable<SuccessResponse<DocumentGrantDto>> {
    return this.api.post<SuccessResponse<DocumentGrantDto>>(`${BASE}/grants/${seg(id)}/revoke`, {});
  }

  /**
   * POST /api/portal/document-access/grants/{id}/restore — Undo, for 10
   * minutes after a revoke: restores every share that revoke ended (those that
   * would have ended anyway come back in `skipped_grant_ids`). 409
   * `restore_expired` after that.
   */
  restoreGrant(id: string): Observable<SuccessResponse<RestoreResultDto>> {
    return this.api.post<SuccessResponse<RestoreResultDto>>(`${BASE}/grants/${seg(id)}/restore`, {});
  }

  /** POST /api/portal/document-access/doctors/{id}/revoke — stop every share with one doctor (pending requests stay open). */
  stopSharingWith(specialistId: string): Observable<SuccessResponse<RevokeResultDto>> {
    return this.api.post<SuccessResponse<RevokeResultDto>>(
      `${BASE}/doctors/${seg(specialistId)}/revoke`,
      {},
    );
  }

  /** POST /api/portal/document-access/revoke-all — stop sharing with everyone (pending requests stay open). */
  revokeAll(): Observable<SuccessResponse<RevokeResultDto>> {
    return this.api.post<SuccessResponse<RevokeResultDto>>(`${BASE}/revoke-all`, {});
  }

  /** POST /api/portal/document-access/doctors/{id}/allow-requests — let a blocked doctor ask again (idempotent). */
  allowRequests(specialistId: string): Observable<SuccessResponse<SharingDoctorDto>> {
    return this.api.post<SuccessResponse<SharingDoctorDto>>(
      `${BASE}/doctors/${seg(specialistId)}/allow-requests`,
      {},
    );
  }

  /** GET /api/portal/document-access/requests — `pending` (still open) or `all` (the last 90 days). */
  requests(query?: { status?: 'pending' | 'all' }): Observable<SuccessResponse<DocumentAccessRequestDto[]>> {
    return this.api.get<SuccessResponse<DocumentAccessRequestDto[]>>(
      `${BASE}/requests`,
      query as QueryParams | undefined,
    );
  }

  /** GET /api/portal/document-access/requests/{id} — one of the patient's requests (404 otherwise). */
  request(id: string): Observable<SuccessResponse<DocumentAccessRequestDto>> {
    return this.api.get<SuccessResponse<DocumentAccessRequestDto>>(`${BASE}/requests/${seg(id)}`);
  }

  /**
   * POST /api/portal/document-access/requests/{id}/approve — approve with the
   * chosen scope + duration (one transaction with the share). 409
   * `request_not_pending` with the fresh `errors.status` when it already
   * closed: treat `approved` as success, anything else with the info copy.
   */
  approveRequest(
    id: string,
    input: ApproveAccessRequestInput,
  ): Observable<SuccessResponse<{ request: DocumentAccessRequestDto; grant: DocumentGrantDto }>> {
    return this.api.post<SuccessResponse<{ request: DocumentAccessRequestDto; grant: DocumentGrantDto }>>(
      `${BASE}/requests/${seg(id)}/approve`,
      input,
    );
  }

  /** POST /api/portal/document-access/requests/{id}/decline — optionally stop that doctor asking again. */
  declineRequest(
    id: string,
    input?: DeclineAccessRequestInput,
  ): Observable<SuccessResponse<DocumentAccessRequestDto>> {
    return this.api.post<SuccessResponse<DocumentAccessRequestDto>>(
      `${BASE}/requests/${seg(id)}/decline`,
      input ?? {},
    );
  }

  /** GET /api/portal/document-access/history — the sharing ledger (every doctor view included), newest first. */
  history(query?: {
    page?: number;
    per_page?: number;
    specialist_id?: string;
    document_id?: string;
  }): Observable<PaginatedResponse<DocumentAccessEventDto>> {
    return this.api.get<PaginatedResponse<DocumentAccessEventDto>>(
      `${BASE}/history`,
      query as QueryParams | undefined,
    );
  }

  /**
   * GET /api/portal/appointments/{id}/document-access — what this
   * consultation's doctor can see, the booking's unshared attachments and any
   * pending request. Pass `{ passive: true }` for background refreshes (at
   * `access.next_change_at`) so they never extend the idle session.
   */
  forAppointment(
    appointmentId: string,
    options?: ApiRequestOptions,
  ): Observable<SuccessResponse<AppointmentDocumentAccessDto>> {
    return this.api.get<SuccessResponse<AppointmentDocumentAccessDto>>(
      `api/portal/appointments/${seg(appointmentId)}/document-access`,
      undefined,
      options,
    );
  }
}
