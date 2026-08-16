import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  DayAvailability,
  ListAppointmentsQuery,
  PaginatedResponse,
  SpecialistDto,
  SpecialistFacets,
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
  location?: string;
  language?: string;
  gender?: string;
  mode?: 'online' | 'in_person';
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

  /** GET /api/public/specialists/{id} — one specialist (public, for booking). */
  getPublic(id: string): Observable<SuccessResponse<SpecialistDto>> {
    return this.api.get<SuccessResponse<SpecialistDto>>(
      `api/public/specialists/${encodeURIComponent(id)}`,
    );
  }

  /** GET /api/portal/specialists/specialties — distinct specialties for filtering. */
  specialties(): Observable<SuccessResponse<string[]>> {
    return this.api.get<SuccessResponse<string[]>>(
      'api/portal/specialists/specialties',
    );
  }

  /** GET /api/public/specialists/{id}/slots — the specialist's open slots (public). */
  slots(
    id: string,
    days = 7,
  ): Observable<SuccessResponse<DayAvailability[]>> {
    return this.api.get<SuccessResponse<DayAvailability[]>>(
      `api/public/specialists/${encodeURIComponent(id)}/slots`,
      { days },
    );
  }

  /** GET /api/public/specialties — specialties + counts (no auth, homepage). */
  publicSpecialties(): Observable<SuccessResponse<SpecialtyCount[]>> {
    return this.api.get<SuccessResponse<SpecialtyCount[]>>(
      'api/public/specialties',
    );
  }

  /** GET /api/public/facets — filter options (specialties/locations/languages). */
  publicFacets(): Observable<SuccessResponse<SpecialistFacets>> {
    return this.api.get<SuccessResponse<SpecialistFacets>>(
      'api/public/facets',
    );
  }

  /** GET /api/public/specialists — public specialist search (no auth). */
  publicSearch(params: {
    search?: string;
    specialty?: string;
    location?: string;
    language?: string;
    gender?: string;
    mode?: 'online' | 'in_person';
    limit?: number;
  }): Observable<SuccessResponse<SpecialistDto[]>> {
    return this.api.get<SuccessResponse<SpecialistDto[]>>(
      'api/public/specialists',
      params as QueryParams,
    );
  }
}
