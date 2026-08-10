import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  DayAvailability,
  ListAppointmentsQuery,
  PaginatedResponse,
  SpecialistDto,
  SpecialtyCount,
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

  /** GET /api/portal/specialists/{id}/slots — the specialist's open slots. */
  slots(
    id: string,
    days = 7,
  ): Observable<SuccessResponse<DayAvailability[]>> {
    return this.api.get<SuccessResponse<DayAvailability[]>>(
      `api/portal/specialists/${encodeURIComponent(id)}/slots`,
      { days },
    );
  }

  /** GET /api/public/specialties — specialties + counts (no auth, homepage). */
  publicSpecialties(): Observable<SuccessResponse<SpecialtyCount[]>> {
    return this.api.get<SuccessResponse<SpecialtyCount[]>>(
      'api/public/specialties',
    );
  }

  /** GET /api/public/specialists — public specialist search (no auth, homepage). */
  publicSearch(
    search: string,
    limit = 6,
  ): Observable<SuccessResponse<SpecialistDto[]>> {
    return this.api.get<SuccessResponse<SpecialistDto[]>>(
      'api/public/specialists',
      { search, limit },
    );
  }
}
