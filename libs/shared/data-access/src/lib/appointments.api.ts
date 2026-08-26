import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  BookAppointmentParams,
  CallTokenDto,
  ConsentDto,
  ConsultationSummaryDto,
  JoinInfoDto,
  LabOrderDto,
  ListAppointmentsQuery,
  PaginatedResponse,
  PatientCarePlanDto,
  PatientRecordingsDto,
  PrescriptionDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
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
