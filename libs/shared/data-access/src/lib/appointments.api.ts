import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  ListAppointmentsQuery,
  PaginatedResponse,
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
}
