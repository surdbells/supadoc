import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  HealthProfileDto,
  HealthProfilePatch,
  PatientProfileDto,
  PatientSettingsDto,
  PatientSettingsPatch,
  SuccessResponse,
} from '@supadoc/models';
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

  /** PATCH /api/portal/me — update the profile (only the given fields change). */
  updateProfile(params: {
    first_name?: string;
    last_name?: string;
    phone?: string | null;
    date_of_birth?: string | null;
    gender?: string;
    address?: string;
  }): Observable<SuccessResponse<PatientProfileDto>> {
    return this.api.patch<SuccessResponse<PatientProfileDto>>(
      'api/portal/me',
      params,
    );
  }

  /** POST /api/portal/me/password — change the password. */
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Observable<SuccessResponse<{ changed: boolean }>> {
    return this.api.post<SuccessResponse<{ changed: boolean }>>(
      'api/portal/me/password',
      { current_password: currentPassword, new_password: newPassword },
    );
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

  /** GET /api/portal/me/settings — the signed-in patient's preferences. */
  settings(): Observable<SuccessResponse<PatientSettingsDto>> {
    return this.api.get<SuccessResponse<PatientSettingsDto>>(
      'api/portal/me/settings',
    );
  }

  /** PATCH /api/portal/me/settings — merge a partial preferences patch. */
  updateSettings(
    patch: PatientSettingsPatch,
  ): Observable<SuccessResponse<PatientSettingsDto>> {
    return this.api.patch<SuccessResponse<PatientSettingsDto>>(
      'api/portal/me/settings',
      patch,
    );
  }

  /** GET /api/portal/me/health-profile — emergency contact, insurance, medical. */
  healthProfile(): Observable<SuccessResponse<HealthProfileDto>> {
    return this.api.get<SuccessResponse<HealthProfileDto>>(
      'api/portal/me/health-profile',
    );
  }

  /** PATCH /api/portal/me/health-profile — save one or more sections. */
  updateHealthProfile(
    patch: HealthProfilePatch,
  ): Observable<SuccessResponse<HealthProfileDto>> {
    return this.api.patch<SuccessResponse<HealthProfileDto>>(
      'api/portal/me/health-profile',
      patch,
    );
  }
}

