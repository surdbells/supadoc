import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PaginatedResponse,
  PatientAccountDto,
  PatientDetailDto,
  PatientSummaryDto,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/** Staff patient lookup + admin patient administration. */
@Injectable({ providedIn: 'root' })
export class AdminPatientsApi {
  private readonly api = inject(ApiService);

  /** GET /api/patients?search= — name / email / phone (min 2 chars). */
  search(term: string, limit = 10): Observable<SuccessResponse<PatientSummaryDto[]>> {
    return this.api.get<SuccessResponse<PatientSummaryDto[]>>('api/patients', {
      search: term,
      limit,
    });
  }

  /** GET /api/admin/patients — paginated roster (?search=). */
  list(query?: {
    page?: number;
    per_page?: number;
    search?: string;
  }): Observable<PaginatedResponse<PatientAccountDto>> {
    return this.api.get<PaginatedResponse<PatientAccountDto>>(
      'api/admin/patients',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/admin/patients/{id} — account record + recent appointments. */
  get(id: string): Observable<SuccessResponse<PatientDetailDto>> {
    return this.api.get<SuccessResponse<PatientDetailDto>>(
      `api/admin/patients/${encodeURIComponent(id)}`,
    );
  }
}
