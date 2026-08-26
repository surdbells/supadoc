import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  BookAppointmentParams,
  CallTokenDto,
  ConsultationSummaryDto,
  JoinInfoDto,
  ListAppointmentsQuery,
  PaginatedResponse,
  PrescriptionDto,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/**
 * Appointments client for the VideoMed backend. `listMine` hits the customer
 * portal route — the API scopes it to the signed-in patient via the bearer
 * token, so callers never pass a patient id.
 */
@Injectable({ providedIn: 'root' })
export class AppointmentsApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/appointments — the signed-in patient's own appointments. */
  listMine(
    query?: ListAppointmentsQuery,
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

  /** POST /api/portal/appointment-documents — upload a supporting image, returns its URL. */
  uploadDocument(file: File): Observable<SuccessResponse<{ url: string }>> {
    const form = new FormData();
    form.append('document', file);
    return this.api.post<SuccessResponse<{ url: string }>>(
      'api/portal/appointment-documents',
      form,
    );
  }

  /** GET /api/portal/appointments/{id}/call-token — Agora RTC join credentials. */
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

  /**
   * GET /api/public/call/{token} — resolve a preauthenticated join link (from an
   * invite email) into the meeting details + Agora credentials. No auth: the
   * signed token in the path is the credential.
   */
  joinInfo(token: string): Observable<SuccessResponse<JoinInfoDto>> {
    return this.api.get<SuccessResponse<JoinInfoDto>>(
      `api/public/call/${encodeURIComponent(token)}`,
    );
  }
}
