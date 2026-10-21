import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  DocumentAccessDetailDto,
  DocumentTypeOption,
  MedicalDocumentDto,
  PaginatedResponse,
  SuccessResponse,
  UploadedDocumentDto,
  UploadShareOptions,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService, QueryParams } from './api.service';

export interface DocumentListQuery {
  page?: number;
  per_page?: number;
  search?: string;
  type?: string;
  sort_dir?: 'asc' | 'desc';
  /** Only the files attached to this booking (one of the patient's own). */
  appointment_id?: string;
  /** P2 — not served yet: only documents shared with a doctor now / only private ones. */
  sharing?: 'shared' | 'private';
}

/**
 * Append the optional sharing fields of an upload to its multipart body,
 * skipping empty / undefined ones. Array fields repeat with the `[]` suffix.
 *
 * The share fields (`share_duration`, `share_expires_at`, `share_batch_id`,
 * `share_appointment_id`) go only with at least one doctor to share with: the
 * API validates `share_appointment_id` whenever it is present and needs it to
 * match one of those doctors, so an exclude-only upload ("Don't share with
 * anyone new", opened from an appointment) sends just
 * `exclude_specialist_ids[]` (+ `share_surface`), never a 422 `appointment_id`.
 */
function appendShareFields(form: FormData, share: UploadShareOptions): void {
  const shareIds = (share.specialist_ids ?? []).filter(Boolean);
  for (const id of shareIds) form.append('share_specialist_ids[]', id);
  if (shareIds.length > 0) {
    if (share.duration) form.append('share_duration', share.duration);
    if (share.expires_at) form.append('share_expires_at', share.expires_at);
    if (share.batch_id) form.append('share_batch_id', share.batch_id);
    if (share.appointment_id) form.append('share_appointment_id', share.appointment_id);
  }
  for (const id of share.exclude_specialist_ids ?? []) {
    if (id) form.append('exclude_specialist_ids[]', id);
  }
  if (share.surface) form.append('share_surface', share.surface);
}

/**
 * Patient medical-documents API. List/types/blob go through the shared
 * ApiService; the multipart upload uses HttpClient directly so it can report
 * progress events. All calls are authenticated by the app's auth interceptor.
 */
@Injectable({ providedIn: 'root' })
export class DocumentsApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /** GET /api/portal/document-types — the type catalogue for the dropdown. */
  types(): Observable<SuccessResponse<DocumentTypeOption[]>> {
    return this.api.get<SuccessResponse<DocumentTypeOption[]>>(
      'api/portal/document-types',
    );
  }

  /** GET /api/portal/documents — the patient's documents. */
  list(query?: DocumentListQuery): Observable<PaginatedResponse<MedicalDocumentDto>> {
    return this.api.get<PaginatedResponse<MedicalDocumentDto>>(
      'api/portal/documents',
      query as QueryParams | undefined,
    );
  }

  /**
   * POST /api/portal/documents (multipart) with upload-progress events.
   * Emits HttpEvents; the caller reads UploadProgress for the bar and Response
   * for the finished document.
   *
   * `share` (optional) carries the "Who can see these files?" choice: share
   * with doctors (`specialist_ids` + `duration`, one `batch_id` for every file
   * of the batch — retries reuse it) and/or hide the file from folder-share
   * holders (`exclude_specialist_ids`). Without it the file is private, except
   * to doctors who can see the whole folder. The response's `share_outcome`,
   * `shared_with` and `share_ended_for` say what really happened.
   */
  upload(
    file: File,
    documentType: string,
    customType?: string,
    share?: UploadShareOptions,
  ): Observable<HttpEvent<SuccessResponse<UploadedDocumentDto>>> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('document_type', documentType);
    if (customType) form.append('custom_type', customType);
    if (share) appendShareFields(form, share);

    const base = this.config.baseUrl.replace(/\/+$/, '');
    return this.http.post<SuccessResponse<UploadedDocumentDto>>(
      `${base}/api/portal/documents`,
      form,
      { reportProgress: true, observe: 'events' },
    );
  }

  /** GET /api/portal/documents/{id}/file — the file bytes (authenticated). */
  fileBlob(id: string): Observable<Blob> {
    return this.api.getBlob(`api/portal/documents/${encodeURIComponent(id)}/file`);
  }

  /**
   * GET /api/portal/documents/{id}/access — who can see this document now
   * (paused doctors included), the folder-share holders it is hidden from,
   * the doctors it could be shared with, and its recent sharing activity.
   */
  access(id: string): Observable<SuccessResponse<DocumentAccessDetailDto>> {
    return this.api.get<SuccessResponse<DocumentAccessDetailDto>>(
      `api/portal/documents/${encodeURIComponent(id)}/access`,
    );
  }

  /**
   * DELETE /api/portal/documents/{id}/access/{specialistId} — take this one
   * document away from a doctor (also through their whole-folder share);
   * everything else shared with them stays. Idempotent.
   */
  removeDoctorAccess(id: string, specialistId: string): Observable<SuccessResponse<DocumentAccessDetailDto>> {
    return this.api.delete<SuccessResponse<DocumentAccessDetailDto>>(
      `api/portal/documents/${encodeURIComponent(id)}/access/${encodeURIComponent(specialistId)}`,
    );
  }

  /**
   * POST /api/portal/documents/{id}/access/{specialistId}/unhide — "Show
   * again": let a doctor with a whole-folder share see this document again.
   * Idempotent.
   */
  unhideForDoctor(id: string, specialistId: string): Observable<SuccessResponse<DocumentAccessDetailDto>> {
    return this.api.post<SuccessResponse<DocumentAccessDetailDto>>(
      `api/portal/documents/${encodeURIComponent(id)}/access/${encodeURIComponent(specialistId)}/unhide`,
      {},
    );
  }
}
