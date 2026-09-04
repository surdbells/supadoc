import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  HealthProfileDto,
  HealthProfilePatch,
  PatientProfileDto,
  PatientSettingsDto,
  PatientSettingsPatch,
  SessionDto,
  SuccessResponse,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService } from './api.service';

/**
 * The signed-in patient's own account. Scoped by the bearer token on the
 * VideoMed backend, so there is no id to pass.
 */
@Injectable({ providedIn: 'root' })
export class PatientApi {
  private readonly api = inject(ApiService);
  private readonly config = inject(API_CONFIG);

  /** Resolve a relative asset path (e.g. an avatar_url) to an absolute URL. */
  assetUrl(relative: string | null | undefined): string | null {
    if (!relative) return null;
    if (/^https?:\/\//.test(relative)) return relative;
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return `${base}/${relative.replace(/^\/+/, '')}`;
  }

  /** POST /api/portal/me/avatar — upload a profile photo (multipart). */
  uploadAvatar(file: File): Observable<SuccessResponse<PatientProfileDto>> {
    const form = new FormData();
    form.append('avatar', file);
    return this.api.post<SuccessResponse<PatientProfileDto>>(
      'api/portal/me/avatar',
      form,
    );
  }

  /** DELETE /api/portal/me/avatar — remove the profile photo. */
  removeAvatar(): Observable<SuccessResponse<PatientProfileDto>> {
    return this.api.delete<SuccessResponse<PatientProfileDto>>(
      'api/portal/me/avatar',
    );
  }

  /** GET /api/portal/me/sessions — active sign-in sessions (devices). */
  sessions(): Observable<SuccessResponse<SessionDto[]>> {
    return this.api.get<SuccessResponse<SessionDto[]>>(
      'api/portal/me/sessions',
    );
  }

  /** DELETE /api/portal/me/sessions/{id} — sign out of a session. */
  revokeSession(id: string): Observable<SuccessResponse<{ revoked: boolean }>> {
    return this.api.delete<SuccessResponse<{ revoked: boolean }>>(
      `api/portal/me/sessions/${encodeURIComponent(id)}`,
    );
  }

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

  /**
   * POST /api/portal/me/email/request-otp — email a verification code to a new
   * address to start changing the account email. `dev_code` is present only in
   * non-production.
   */
  requestEmailChangeOtp(
    email: string,
  ): Observable<SuccessResponse<{ sent: boolean; dev_code?: string }>> {
    return this.api.post<SuccessResponse<{ sent: boolean; dev_code?: string }>>(
      'api/portal/me/email/request-otp',
      { email },
    );
  }

  /** POST /api/portal/me/email — confirm the code and change the account email. */
  changeEmail(
    email: string,
    otp: string,
  ): Observable<SuccessResponse<PatientProfileDto>> {
    return this.api.post<SuccessResponse<PatientProfileDto>>(
      'api/portal/me/email',
      { email, otp },
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

