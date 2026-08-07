import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ListAppointmentsQuery,
  PaginatedResponse,
  SpecialistDto,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/** Query params for the specialist directory. */
export interface ListSpecialistsQuery
  extends Pick<
    ListAppointmentsQuery,
    'page' | 'per_page' | 'sort_by' | 'sort_dir'
  > {
  search?: string;
  specialty?: string;
  available?: boolean;
}

/** Specialist directory client for the VideoMed backend (customer portal). */
@Injectable({ providedIn: 'root' })
export class SpecialistsApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/specialists — the bookable specialist directory. */
  list(
    query?: ListSpecialistsQuery,
  ): Observable<PaginatedResponse<SpecialistDto>> {
    return this.api.get<PaginatedResponse<SpecialistDto>>(
      'api/portal/specialists',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/portal/specialists/specialties — distinct specialties for filtering. */
  specialties(): Observable<SuccessResponse<string[]>> {
    return this.api.get<SuccessResponse<string[]>>(
      'api/portal/specialists/specialties',
    );
  }
}
