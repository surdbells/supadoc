import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AdminDoctorApplicationsQuery,
  ApproveApplicationInput,
  ApproveApplicationResultDto,
  DoctorApplicationDetailDto,
  DoctorApplicationNoteDto,
  DoctorApplicationQueueDto,
  DoctorApplicationRowDto,
  PaginatedResponse,
  RejectApplicationInput,
  RequestInfoInput,
  ScheduleInterviewInput,
  StartReviewInput,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

const B = 'api/doctor-applications';
const enc = encodeURIComponent;

/**
 * Back-office doctor applications (staff token; every route needs
 * `specialists.manage`). Drafts are never listed. Actions take an optional
 * `expected_status` (409 status_changed when the application moved on).
 * Approval's 422 field keys: `attest`, `consultation_fee`, `specialty`, `email`,
 * `documents`, `documents.{documentId}.{checked|register_reference|number|issued_on|expires_on}`.
 */
@Injectable({ providedIn: 'root' })
export class AdminDoctorApplicationsApi {
  private readonly api = inject(ApiService);

  list(query: AdminDoctorApplicationsQuery): Observable<PaginatedResponse<DoctorApplicationRowDto>> {
    return this.api.get(B, { page: 1, per_page: 20, ...query } as QueryParams);
  }

  /** GET queue — nav badge (`needs_action`) and filter counts. */
  queue(): Observable<SuccessResponse<DoctorApplicationQueueDto>> {
    return this.api.get(`${B}/queue`, undefined, { passive: true });
  }

  detail(id: string): Observable<SuccessResponse<DoctorApplicationDetailDto>> {
    return this.api.get(`${B}/${enc(id)}`);
  }

  /** The document bytes — every view is audited. */
  documentFile(id: string, documentId: string): Observable<Blob> {
    return this.api.getBlob(`${B}/${enc(id)}/documents/${enc(documentId)}/file`);
  }

  startReview(id: string, input: StartReviewInput = {}): Observable<SuccessResponse<DoctorApplicationDetailDto>> {
    return this.api.post(`${B}/${enc(id)}/start-review`, input);
  }

  requestInfo(id: string, input: RequestInfoInput): Observable<SuccessResponse<DoctorApplicationDetailDto>> {
    return this.api.post(`${B}/${enc(id)}/request-info`, input);
  }

  scheduleInterview(id: string, input: ScheduleInterviewInput): Observable<SuccessResponse<DoctorApplicationDetailDto>> {
    return this.api.post(`${B}/${enc(id)}/schedule-interview`, input);
  }

  /** 429 resend_cooldown within 5 minutes. */
  resendInterview(id: string): Observable<SuccessResponse<DoctorApplicationDetailDto>> {
    return this.api.post(`${B}/${enc(id)}/resend-interview`, {});
  }

  approve(id: string, input: ApproveApplicationInput): Observable<SuccessResponse<ApproveApplicationResultDto>> {
    return this.api.post(`${B}/${enc(id)}/approve`, input);
  }

  reject(id: string, input: RejectApplicationInput): Observable<SuccessResponse<DoctorApplicationDetailDto>> {
    return this.api.post(`${B}/${enc(id)}/reject`, input);
  }

  notes(id: string): Observable<SuccessResponse<DoctorApplicationNoteDto[]>> {
    return this.api.get(`${B}/${enc(id)}/notes`);
  }

  addNote(id: string, body: string): Observable<SuccessResponse<DoctorApplicationNoteDto>> {
    return this.api.post(`${B}/${enc(id)}/notes`, { body });
  }
}
