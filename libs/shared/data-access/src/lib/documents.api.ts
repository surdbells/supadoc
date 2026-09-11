import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  DocumentTypeOption,
  MedicalDocumentDto,
  PaginatedResponse,
  SuccessResponse,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService, QueryParams } from './api.service';

export interface DocumentListQuery {
  page?: number;
  per_page?: number;
  search?: string;
  type?: string;
  sort_dir?: 'asc' | 'desc';
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
   */
  upload(
    file: File,
    documentType: string,
    customType?: string,
  ): Observable<HttpEvent<SuccessResponse<MedicalDocumentDto>>> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('document_type', documentType);
    if (customType) form.append('custom_type', customType);

    const base = this.config.baseUrl.replace(/\/+$/, '');
    return this.http.post<SuccessResponse<MedicalDocumentDto>>(
      `${base}/api/portal/documents`,
      form,
      { reportProgress: true, observe: 'events' },
    );
  }

  /** GET /api/portal/documents/{id}/file — the file bytes (authenticated). */
  fileBlob(id: string): Observable<Blob> {
    return this.api.getBlob(`api/portal/documents/${encodeURIComponent(id)}/file`);
  }
}
