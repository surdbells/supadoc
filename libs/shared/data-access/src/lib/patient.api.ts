import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { PatientProfileDto, SuccessResponse } from '@supadoc/models';
import { ApiService } from './api.service';

/**
 * The signed-in patient's own account. Scoped by the bearer token on the
 * VideoMed backend, so there is no id to pass.
 */
@Injectable({ providedIn: 'root' })
export class PatientApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/me — the signed-in patient's profile. */
  me(): Observable<SuccessResponse<PatientProfileDto>> {
    return this.api.get<SuccessResponse<PatientProfileDto>>('api/portal/me');
  }

  /** POST /api/portal/me/verify-phone — confirm the number with a proof token. */
  verifyPhone(
    verificationToken: string,
  ): Observable<SuccessResponse<PatientProfileDto>> {
    return this.api.post<SuccessResponse<PatientProfileDto>>(
      'api/portal/me/verify-phone',
      { verification_token: verificationToken },
    );
  }
}

