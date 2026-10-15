import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  ListAppointmentsQuery,
  PaginatedResponse,
  ResolveAppointmentParams,
  ResolvedAppointmentDto,
  SuccessResponse,
  UpdateAppointmentStatusParams,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

export interface CreateAppointmentParams {
  patient_id: string;
  specialist_id: string;
  scheduled_at: string;
  type?: string;
}

/**
 * Staff appointments API — the back-office `/api/appointments` routes (distinct
 * from the customer portal's `AppointmentsApi`). Gated by `appointments.*`
 * permissions server-side.
 */
@Injectable({ providedIn: 'root' })
export class AdminAppointmentsApi {
  private readonly api = inject(ApiService);

  /**
   * GET /api/appointments — paginated, optional `status` (CSV, e.g.
   * `rescheduled`, `missed`) and `when` (upcoming | past | attention — the
   * "Needs attention" chip: past and still open) filters.
   */
  list(
    query?: ListAppointmentsQuery,
  ): Observable<PaginatedResponse<AppointmentDto>> {
    return this.api.get<PaginatedResponse<AppointmentDto>>(
      'api/appointments',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/appointments/{id}. */
  get(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.get<SuccessResponse<AppointmentDto>>(
      `api/appointments/${encodeURIComponent(id)}`,
    );
  }

  /** POST /api/appointments — book on a patient's behalf. */
  create(
    params: CreateAppointmentParams,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      'api/appointments',
      params,
    );
  }

  /**
   * PATCH /api/appointments/{id}/status — move along the lifecycle (audited).
   * `cancelled` refunds in full by default (guest fees included); pass
   * `{ refund: 'none', reason }` to keep the money, or `{ refund: 'amount',
   * amount, reason? }`; the response then adds `refunded_now`. `completed`
   * goes through the completer (only once started). `missed` is refused —
   * use {@link resolve}.
   */
  updateStatus(
    id: string,
    status: string,
    options?: Omit<UpdateAppointmentStatusParams, 'status'>,
  ): Observable<SuccessResponse<ResolvedAppointmentDto>> {
    return this.api.patch<SuccessResponse<ResolvedAppointmentDto>>(
      `api/appointments/${encodeURIComponent(id)}/status`,
      { ...options, status },
    );
  }

  /**
   * POST /api/appointments/{id}/resolve — settle a missed or stale
   * consultation: mark it held, mark who didn't come (missed), cancel it, or
   * refund more — with a `reason` (audited). See {@link ResolveAppointmentParams}.
   * Answers the appointment plus `refunded_now`.
   */
  resolve(
    id: string,
    params: ResolveAppointmentParams,
  ): Observable<SuccessResponse<ResolvedAppointmentDto>> {
    return this.api.post<SuccessResponse<ResolvedAppointmentDto>>(
      `api/appointments/${encodeURIComponent(id)}/resolve`,
      params,
    );
  }
}
