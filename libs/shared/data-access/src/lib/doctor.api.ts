import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  CarePlanDto,
  ClinicalNoteDto,
  ClinicalNoteInput,
  ConsentDto,
  CopilotDraftDto,
  CreateLabOrderParams,
  CreatePrescriptionParams,
  CreateReferralParams,
  DoctorAppointmentDto,
  DoctorCopilotStateDto,
  DoctorDashboardDto,
  DoctorPatientListItemDto,
  DoctorPatientRecordDto,
  DoctorProfileDto,
  DoctorProfileUpdate,
  DoctorRecordingStateDto,
  DoctorScheduleDto,
  EarningsSummaryDto,
  EarningsTxnDto,
  LabOrderDto,
  PaginatedResponse,
  PayoutAccountDto,
  PayoutAccountInput,
  PayoutDto,
  PrescriptionDto,
  ReviewDto,
  ReviewSummaryDto,
  RecordingDto,
  RecordingFilesDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/**
 * The doctor portal's clinical API — every `/api/doctor/*` endpoint, returning
 * the shared model DTOs. Authorization is enforced server-side (the signed-in
 * doctor must own the appointment); the staff bearer token is attached by
 * `staffAuthInterceptor`.
 */
@Injectable({ providedIn: 'root' })
export class DoctorApi {
  private readonly api = inject(ApiService);

  private base(id: string): string {
    return `api/doctor/appointments/${encodeURIComponent(id)}`;
  }

  /** GET /api/doctor/dashboard — headline metrics + today's agenda. */
  dashboard(): Observable<SuccessResponse<DoctorDashboardDto>> {
    return this.api.get<SuccessResponse<DoctorDashboardDto>>('api/doctor/dashboard');
  }

  /** GET /api/doctor/appointments — the signed-in doctor's schedule. */
  schedule(): Observable<SuccessResponse<DoctorScheduleDto>> {
    return this.api.get<SuccessResponse<DoctorScheduleDto>>(
      'api/doctor/appointments',
    );
  }

  /** GET /api/doctor/appointments/history — paginated, filterable history. */
  history(query?: {
    page?: number;
    per_page?: number;
    status?: string;
    search?: string;
  }): Observable<PaginatedResponse<DoctorAppointmentDto>> {
    return this.api.get<PaginatedResponse<DoctorAppointmentDto>>(
      'api/doctor/appointments/history',
      query as QueryParams | undefined,
    );
  }

  /** POST /api/doctor/appointments/{id}/decline — decline + refund. */
  decline(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      `${this.base(id)}/decline`,
      {},
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

  // ----- Prescriptions -----

  listPrescriptions(id: string): Observable<SuccessResponse<PrescriptionDto[]>> {
    return this.api.get<SuccessResponse<PrescriptionDto[]>>(
      `${this.base(id)}/prescriptions`,
    );
  }

  createPrescription(
    id: string,
    params: CreatePrescriptionParams,
  ): Observable<SuccessResponse<PrescriptionDto>> {
    return this.api.post<SuccessResponse<PrescriptionDto>>(
      `${this.base(id)}/prescriptions`,
      params,
    );
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
