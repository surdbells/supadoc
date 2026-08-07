import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  LoginParams,
  LoginResponse,
  RegisterParams,
  ResetPasswordParams,
  VerifyOtpParams,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService } from './api.service';

/**
 * Typed client for the VideoMed API Auth endpoints. `appId` (required on most
 * calls) is injected from the app's `ApiConfig`, so callers never pass it.
 */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly api = inject(ApiService);
  private readonly config = inject(API_CONFIG);

  private get appId(): string {
    return this.config.appId ?? '';
  }

  login(params: LoginParams): Observable<LoginResponse> {
    return this.api.post<LoginResponse>(this.config.loginPath ?? 'login', {
      ...params,
      appId: this.appId,
    });
  }

  /**
   * Exchange a Google (Firebase) ID token for a session — VideoMed backend only
   * (POST /api/portal/auth/google).
   */
  googleLogin(idToken: string): Observable<LoginResponse> {
    return this.api.post<LoginResponse>('api/portal/auth/google', {
      id_token: idToken,
    });
  }

  // ----- Termii phone flow (VideoMed backend) -----

  /** Send an SMS OTP; resolves with the pin id used to verify it. */
  requestPhoneOtp(phone: string): Observable<{ data: { pin_id: string } }> {
    return this.api.post<{ data: { pin_id: string } }>(
      'api/portal/auth/phone/request-otp',
      { phone },
    );
  }

  /** Verify an OTP; resolves with a short-lived phone verification token. */
  verifyPhoneOtp(
    pinId: string,
    otp: string,
    phone: string,
  ): Observable<{ data: { verification_token: string } }> {
    return this.api.post<{ data: { verification_token: string } }>(
      'api/portal/auth/phone/verify-otp',
      { pin_id: pinId, otp, phone },
    );
  }

  /** Register a patient after phone verification. */
  registerByPhone(params: {
    verificationToken: string;
    email: string;
    firstName: string;
    lastName: string;
    password: string;
  }): Observable<LoginResponse> {
    return this.api.post<LoginResponse>('api/portal/auth/phone/register', {
      verification_token: params.verificationToken,
      email: params.email,
      first_name: params.firstName,
      last_name: params.lastName,
      password: params.password,
    });
  }

  /** Sign in with a verified phone number. */
  loginByPhone(verificationToken: string): Observable<LoginResponse> {
    return this.api.post<LoginResponse>('api/portal/auth/phone/login', {
      verification_token: verificationToken,
    });
  }

  /** Step 1 of registration — email OTP to a not-yet-registered user. */
  sendRegisterOtp(email: string): Observable<unknown> {
    return this.api.post('Create_NonRegisteredUser_OtpCodeAsync', {
      email,
      appId: this.appId,
    });
  }

  /** Step 2 of registration — verify the OTP for a not-yet-registered user. */
  verifyRegisterOtp(params: VerifyOtpParams): Observable<unknown> {
    return this.api.post('Verify_NonRegisteredUser_OtpAsync', {
      ...params,
      appId: this.appId,
    });
  }

  /** Step 3 of registration — create the account with the verified OTP. */
  register(params: RegisterParams): Observable<unknown> {
    return this.api.post('register', { ...params, appId: this.appId });
  }

  /** Password recovery — send an OTP to a registered (verified) user's email. */
  sendResetOtp(email: string): Observable<unknown> {
    return this.api.post('SendVerifiedUserOTPCodeByEmail', {
      email,
      appId: this.appId,
    });
  }

  /** Verify an OTP for a registered user (e.g. during recovery). */
  verifyOtp(params: VerifyOtpParams): Observable<unknown> {
    return this.api.post('VerifyOTPCode', { ...params, appId: this.appId });
  }

  resetPassword(params: ResetPasswordParams): Observable<unknown> {
    return this.api.post('reset-password-with-otp', {
      ...params,
      appId: this.appId,
    });
  }

  logout(): Observable<unknown> {
    return this.api.post('api/Auth/logout', {});
  }
}
