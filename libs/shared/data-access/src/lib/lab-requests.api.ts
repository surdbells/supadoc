import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';
import type {
  AcceptLabRequestInput,
  AdminLabRequestSummaryDto,
  CorrectLabStatusInput,
  CreateLabRequestInput,
  LabListGroup,
  LabListMeta,
  LabOptionsDto,
  LabPatientPickDto,
  LabRequestContextDto,
  LabRequestDto,
  LabRequestLinkDto,
  LabRequestSummaryDto,
  LabResultUploadedDto,
  LabReviewOutcome,
  PaginatedResponse,
  PatientLabRequestDto,
  PatientLabRequestSummaryDto,
  SuccessResponse,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiRequestOptions, ApiService, QueryParams } from './api.service';
import { DOCUMENT_VIEWER_HEADER, type PatientDocumentView } from './doctor.api';
import { parseDocumentView } from './document-view';
import { apiFileUrl } from './prescriptions.api';

const DOCTOR = 'api/doctor/lab-requests';
const PORTAL = 'api/portal/lab-requests';
const ADMIN = 'api/admin/lab-requests';

/** A lab-request list: the page plus the per-group counts (`meta.counts`). */
export interface LabRequestListResponse<T> {
  status: string;
  message: string;
  data: T[];
  meta: LabListMeta;
}

/** GET /api/doctor/lab-requests/patients query. */
export interface LabPatientsQuery {
  search?: string;
  page?: number;
  per_page?: number;
}

/** GET /api/doctor/lab-requests query (`q` matches patient name, number or a test). */
export interface DoctorLabListQuery {
  group?: LabListGroup;
  q?: string;
  appointment_id?: string;
  patient_id?: string;
  page?: number;
  per_page?: number;
}

/** GET /api/portal/lab-requests query. */
export interface PatientLabListQuery {
  group?: LabListGroup;
  appointment_id?: string;
  page?: number;
  per_page?: number;
}

/** POST …/results/{resultId}/review body: a note is required for Abnormal (3–1000). */
export interface LabReviewInput {
  outcome: LabReviewOutcome;
  comment?: string;
}

/**
 * The patient's result-upload choices. `item_ids` empty / absent = the file
 * covers every test. `share` decides for the requesting doctor; other doctors
 * holding a whole-folder share who must **not** see this file go in
 * `exclude_specialist_ids` (ask at upload, as the documents page).
 */
export interface LabResultUploadOptions {
  document_type?: string;
  item_ids?: string[];
  share: boolean;
  exclude_specialist_ids?: string[];
}

/** Query params without the unset ones: undefined, null and blank strings are left out. */
function query(params: object | undefined): QueryParams | undefined {
  if (!params) return undefined;
  const out: QueryParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** Distinct, non-empty ids in their first order. */
function ids(list: readonly string[] | undefined): string[] {
  return [...new Set((list ?? []).filter((id) => typeof id === 'string' && id !== ''))];
}

function seg(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Laboratory & Diagnostics — every lab-request endpoint for the three portals:
 * the doctor (`/api/doctor/lab-requests*`, staff token), the patient
 * (`/api/portal/lab-requests*`, customer token) and the back office
 * (`/api/admin/*lab-requests*`, `monitoring.view` / `labs.manage`). Tokens are
 * attached by each app's interceptor; nothing here reads a token.
 *
 * Request PDFs are reached only through short-lived signed links (`link`,
 * `myLink`, `staffLink`): the shared viewer and Download fetch the link's PDF as
 * a Blob through `HttpClient` ({@link fileBlob}), never as a cross-origin
 * `<a href>` or a new tab. A doctor views a result only through the view-only
 * viewer ({@link viewResult}, which sends `X-SD-Viewer: 1`); the patient opens
 * their own result with `DocumentsApi.fileBlob(document.id)`.
 */
@Injectable({ providedIn: 'root' })
export class LabRequestsApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /** Absolute URL of a signed request-PDF link (`/api/public/lab-requests/file?token=…`). */
  fileUrl(link: LabRequestLinkDto): string {
    return apiFileUrl(this.config.baseUrl, link.url);
  }

  /**
   * GET a signed link's request PDF as a Blob through `HttpClient`
   * (`link.url` is the relative `/api/public/lab-requests/file?token=…`, which
   * `ApiService` prefixes with the API base). For the shared viewer and
   * `saveSignedLink`; the link itself stays short-lived and audited.
   */
  fileBlob(link: LabRequestLinkDto): Observable<Blob> {
    return this.api.getBlob(link.url);
  }

  // ----- doctor -----

  /** GET /api/doctor/lab-requests/options — the versioned catalogue, limits and `has_signature`. */
  options(): Observable<SuccessResponse<LabOptionsDto>> {
    return this.api.get<SuccessResponse<LabOptionsDto>>(`${DOCTOR}/options`);
  }

  /** GET /api/doctor/lab-requests/patients — patients this doctor has consulted, last visit first. */
  patients(q: LabPatientsQuery = {}): Observable<PaginatedResponse<LabPatientPickDto>> {
    return this.api.get<PaginatedResponse<LabPatientPickDto>>(`${DOCTOR}/patients`, query(q));
  }

  /**
   * GET /api/doctor/lab-requests/context — the patient card, whether to ask
   * Pregnant?, the medication / allergies pre-fill and the consultation.
   * 422 `not_consulted` / `appointment_id` ("This consultation is with another patient.").
   */
  context(patientId: string, appointmentId?: string | null): Observable<SuccessResponse<LabRequestContextDto>> {
    return this.api.get<SuccessResponse<LabRequestContextDto>>(
      `${DOCTOR}/context`,
      query({ patient_id: patientId, appointment_id: appointmentId }),
    );
  }

  /**
   * GET /api/doctor/lab-requests — my requests, most recent activity first,
   * with group counts. `group` is always sent (`all` when not given): the API
   * answers 422 "Unknown filter" for anything outside its groups. A background
   * re-read passes `{ passive: true }`.
   */
  list(q: DoctorLabListQuery = {}, options?: ApiRequestOptions): Observable<LabRequestListResponse<LabRequestSummaryDto>> {
    return this.api.get<LabRequestListResponse<LabRequestSummaryDto>>(
      DOCTOR,
      query({ ...q, group: q.group ?? 'all' }),
      options,
    );
  }

  /**
   * POST /api/doctor/lab-requests — send (create is send). The body goes as
   * given: its `client_key` is the form's idempotency key, so a retry after a
   * network error re-sends the same key and answers 200 with the request
   * already sent (never a second request). The caller mints a new key per
   * patient and after any 409 (`idempotency_conflict`, `catalogue_changed`);
   * this method never generates or rewrites one.
   */
  create(body: CreateLabRequestInput): Observable<SuccessResponse<LabRequestDto>> {
    return this.api.post<SuccessResponse<LabRequestDto>>(DOCTOR, body);
  }

  /** GET /api/doctor/lab-requests/{id} — 404 when it isn't yours. */
  get(id: string): Observable<SuccessResponse<LabRequestDto>> {
    return this.api.get<SuccessResponse<LabRequestDto>>(`${DOCTOR}/${seg(id)}`);
  }

  /** POST …/{id}/cancel — reason required (3–500), shown to the patient. */
  cancel(id: string, reason: string): Observable<SuccessResponse<LabRequestDto>> {
    return this.api.post<SuccessResponse<LabRequestDto>>(`${DOCTOR}/${seg(id)}/cancel`, { reason });
  }

  /** POST …/{id}/results/{resultId}/review — 409 `not_shared` / `not_viewable` / `status_changed`. */
  review(id: string, resultId: string, body: LabReviewInput): Observable<SuccessResponse<LabRequestDto>> {
    return this.api.post<SuccessResponse<LabRequestDto>>(
      `${DOCTOR}/${seg(id)}/results/${seg(resultId)}/review`,
      body,
    );
  }

  /** POST …/{id}/link — a signed short-lived PDF link (fetch it with {@link fileBlob}). */
  link(id: string, download = false): Observable<SuccessResponse<LabRequestLinkDto>> {
    return this.api.post<SuccessResponse<LabRequestLinkDto>>(`${DOCTOR}/${seg(id)}/link`, { download });
  }

  /**
   * GET …/{id}/results/{resultId}/file for the view-only viewer (sends
   * `X-SD-Viewer: 1`). Every view is recorded and shown to the patient.
   * `viewRef` is the API's `X-SD-View-Ref` when well-formed, else null;
   * `viewedAt` is `X-SD-Viewed-At`, else now. Errors: 404 `not_shared`, 415
   * `not_viewable`, 409 `update_required`, 503 `view_unavailable`.
   */
  viewResult(id: string, resultId: string): Observable<PatientDocumentView> {
    return this.api
      .getBlobResponse(`${DOCTOR}/${seg(id)}/results/${seg(resultId)}/file`, undefined, {
        [DOCUMENT_VIEWER_HEADER]: '1',
      })
      .pipe(map((r) => parseDocumentView(r)));
  }

  /**
   * POST …/{id}/results/{resultId}/printed — record a print before printing
   * (the patient sees it). Sends `{ view_ref }` only with a view reference,
   * else `{}`. Print only after this succeeds.
   */
  resultPrinted(
    id: string,
    resultId: string,
    viewRef: string | null,
  ): Observable<SuccessResponse<{ recorded: boolean }>> {
    return this.api.post<SuccessResponse<{ recorded: boolean }>>(
      `${DOCTOR}/${seg(id)}/results/${seg(resultId)}/printed`,
      viewRef ? { view_ref: viewRef } : {},
    );
  }

  // ----- patient -----

  /**
   * GET /api/portal/lab-requests — my requests (no test names), with group
   * counts; `group` defaults to `all`. A background re-read passes `{ passive: true }`.
   */
  mine(q: PatientLabListQuery = {}, options?: ApiRequestOptions): Observable<LabRequestListResponse<PatientLabRequestSummaryDto>> {
    return this.api.get<LabRequestListResponse<PatientLabRequestSummaryDto>>(
      PORTAL,
      query({ ...q, group: q.group ?? 'all' }),
      options,
    );
  }

  /** GET /api/portal/lab-requests/{id} — one of my requests (no review outcome). */
  mineOne(id: string): Observable<SuccessResponse<PatientLabRequestDto>> {
    return this.api.get<SuccessResponse<PatientLabRequestDto>>(`${PORTAL}/${seg(id)}`);
  }

  /** POST …/{id}/accept — consent (409 `consent_changed` when the wording changed). */
  accept(id: string, body: AcceptLabRequestInput): Observable<SuccessResponse<PatientLabRequestDto>> {
    return this.api.post<SuccessResponse<PatientLabRequestDto>>(`${PORTAL}/${seg(id)}/accept`, body);
  }

  /**
   * POST …/{id}/decline — the reason is optional (≤ 500) and only sent when
   * given. The API answers 200 "Request declined"; its `data` is not part of
   * the contract (spec §2.3), so reload the request with {@link mineOne}.
   */
  decline(id: string, reason?: string | null): Observable<SuccessResponse<unknown>> {
    const body = typeof reason === 'string' && reason.trim() !== '' ? { reason } : {};
    return this.api.post<SuccessResponse<unknown>>(`${PORTAL}/${seg(id)}/decline`, body);
  }

  /**
   * POST …/{id}/sample — "I've given my sample" (booked → in lab). The API
   * answers 200 "Sample recorded"; its `data` is not part of the contract
   * (spec §2.3), so reload the request with {@link mineOne}.
   */
  sampleGiven(id: string): Observable<SuccessResponse<unknown>> {
    return this.api.post<SuccessResponse<unknown>>(`${PORTAL}/${seg(id)}/sample`, {});
  }

  /**
   * POST …/{id}/results (multipart) with upload-progress events. Fields:
   * `file`; `document_type` (when chosen); one `item_ids[]` per covered test
   * (none = every test); `share` `1`/`0`; one `exclude_specialist_ids[]` per
   * whole-folder holder left unticked. The response's `result.share_outcome`
   * says what really happened.
   */
  uploadResult(
    id: string,
    file: File,
    opts: LabResultUploadOptions,
  ): Observable<HttpEvent<SuccessResponse<LabResultUploadedDto>>> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (opts.document_type) form.append('document_type', opts.document_type);
    for (const itemId of ids(opts.item_ids)) form.append('item_ids[]', itemId);
    form.append('share', opts.share ? '1' : '0');
    for (const doctorId of ids(opts.exclude_specialist_ids)) form.append('exclude_specialist_ids[]', doctorId);

    return this.http.post<SuccessResponse<LabResultUploadedDto>>(
      this.api.absoluteUrl(`${PORTAL}/${seg(id)}/results`),
      form,
      { reportProgress: true, observe: 'events' },
    );
  }

  /** POST …/{id}/link — my signed PDF link; 409 `status_changed` until accepted. */
  myLink(id: string, download = false): Observable<SuccessResponse<LabRequestLinkDto>> {
    return this.api.post<SuccessResponse<LabRequestLinkDto>>(`${PORTAL}/${seg(id)}/link`, { download });
  }

  // ----- back office -----

  /** GET /api/admin/patients/{id}/lab-requests — summary rows only (`monitoring.view`). */
  forPatient(patientId: string): Observable<SuccessResponse<AdminLabRequestSummaryDto[]>> {
    return this.api.get<SuccessResponse<AdminLabRequestSummaryDto[]>>(
      `api/admin/patients/${seg(patientId)}/lab-requests`,
    );
  }

  /** POST /api/admin/lab-requests/{id}/link — signed PDF link for staff (`labs.manage`, audited). */
  staffLink(id: string, download = false): Observable<SuccessResponse<LabRequestLinkDto>> {
    return this.api.post<SuccessResponse<LabRequestLinkDto>>(`${ADMIN}/${seg(id)}/link`, { download });
  }

  /**
   * POST /api/admin/lab-requests/{id}/status — correct a status (`labs.manage`);
   * answers the updated row. `sample_date` ('Y-m-d') is left out when empty.
   */
  correctStatus(id: string, body: CorrectLabStatusInput): Observable<SuccessResponse<AdminLabRequestSummaryDto>> {
    const sampleDate = typeof body.sample_date === 'string' ? body.sample_date.trim() : '';
    const payload: CorrectLabStatusInput = sampleDate
      ? { status: body.status, reason: body.reason, sample_date: sampleDate }
      : { status: body.status, reason: body.reason };
    return this.api.post<SuccessResponse<AdminLabRequestSummaryDto>>(`${ADMIN}/${seg(id)}/status`, payload);
  }
}
