import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { PatientSummaryDto, SuccessResponse } from '@supadoc/models';
import { ApiService } from './api.service';

/** Staff patient lookup (for booking on a patient's behalf). */
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
}
