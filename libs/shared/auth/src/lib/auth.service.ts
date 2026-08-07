import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '@supadoc/data-access';
import type {
  LoginParams,
  LoginResponse,
  RegisterParams,
  ResetPasswordParams,
} from '@supadoc/models';

const TOKEN_KEY = 'videomed.token';

/**
 * Central auth state for every app, backed by the VideoMed API (via `AuthApi`).
 * The bearer token is exposed as a signal so guards/interceptors react to
 * sign-in/out without extra plumbing.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly authApi = inject(AuthApi);

  private readonly _token = signal<string | null>(this.readToken());
  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);

  /** `POST /login`. Stores the returned bearer token when the API provides one. */
  async login(params: LoginParams): Promise<void> {
    const res = await firstValueFrom(this.authApi.login(params));
    const token = this.extractToken(res);
    if (token) this.setToken(token);
  }

  /**
   * Sign in with a Google (Firebase) ID token — POST /api/portal/auth/google.
   * The backend verifies the token and returns the same session envelope.
   */
  async loginWithGoogle(idToken: string): Promise<void> {
    const res = await firstValueFrom(this.authApi.googleLogin(idToken));
    const token = this.extractToken(res);
    if (token) this.setToken(token);
  }

  /**
   * Pull the bearer token out of a login response — accepts both the betacrest
   * top-level shapes and the local API's envelope ({ data: { access_token } }).
   */
  private extractToken(res: LoginResponse): string | null {
    const data = (res?.['data'] ?? null) as
      | { access_token?: string; token?: string }
      | null;
    return (
      (res?.token as string | undefined) ??
      (res?.accessToken as string | undefined) ??
      (res?.jwt as string | undefined) ??
      data?.access_token ??
      data?.token ??
      null
    );
  }

  // ----- Termii phone flow -----

  /** Send an SMS OTP to `phone`; returns the pin id used to verify it. */
  async requestPhoneOtp(phone: string): Promise<string> {
    const res = await firstValueFrom(this.authApi.requestPhoneOtp(phone));
    return res.data.pin_id;
  }

  /** Verify the OTP; returns a short-lived phone verification (proof) token. */
  async verifyPhoneOtp(
    pinId: string,
    otp: string,
    phone: string,
  ): Promise<string> {
    const res = await firstValueFrom(
      this.authApi.verifyPhoneOtp(pinId, otp, phone),
    );
    return res.data.verification_token;
  }

  /** Register (email collected too) after phone verification, then sign in. */
  async registerByPhone(params: {
    verificationToken: string;
    email: string;
    firstName: string;
    lastName: string;
    password: string;
  }): Promise<void> {
    const res = await firstValueFrom(this.authApi.registerByPhone(params));
    const token = this.extractToken(res);
    if (token) this.setToken(token);
  }

  /** Sign in with a verified phone number. */
  async loginByPhone(verificationToken: string): Promise<void> {
    const res = await firstValueFrom(
      this.authApi.loginByPhone(verificationToken),
    );
    const token = this.extractToken(res);
    if (token) this.setToken(token);
  }

  // ----- Email OTP flow (register + recovery) -----

  /** Send an email verification code; resolves with the dev code in non-prod. */
  async requestEmailOtp(
    email: string,
    purpose: 'register' | 'reset',
  ): Promise<string | undefined> {
    const res = await firstValueFrom(
      this.authApi.requestEmailOtp(email, purpose),
    );
    return res.data.dev_code;
  }

  /** Verify an email code; returns a short-lived email verification token. */
  async verifyEmailOtp(
    email: string,
    otp: string,
    purpose: 'register' | 'reset',
  ): Promise<string> {
    const res = await firstValueFrom(
      this.authApi.verifyEmailOtp(email, otp, purpose),
    );
    return res.data.verification_token;
  }

  /** Register after email verification, then sign in. */
  async registerWithEmail(params: {
    verificationToken: string;
    email: string;
    firstName: string;
    lastName: string;
    password: string;
  }): Promise<void> {
    const res = await firstValueFrom(this.authApi.registerWithEmail(params));
    const token = this.extractToken(res);
    if (token) this.setToken(token);
  }

  /** Set a new password after email verification, then sign in. */
  async resetPasswordWithEmail(params: {
    verificationToken: string;
    email: string;
    newPassword: string;
  }): Promise<void> {
    const res = await firstValueFrom(
      this.authApi.resetPasswordWithEmail(params),
    );
    const token = this.extractToken(res);
    if (token) this.setToken(token);
  }

  // ----- Registration -----
  sendRegisterOtp(email: string): Promise<unknown> {
    return firstValueFrom(this.authApi.sendRegisterOtp(email));
  }
  verifyRegisterOtp(email: string, otpCode: string): Promise<unknown> {
    return firstValueFrom(this.authApi.verifyRegisterOtp({ email, otpCode }));
  }
  register(params: RegisterParams): Promise<unknown> {
    return firstValueFrom(this.authApi.register(params));
  }

  // ----- Password recovery -----
  sendResetOtp(email: string): Promise<unknown> {
    return firstValueFrom(this.authApi.sendResetOtp(email));
  }
  verifyOtp(email: string, otpCode: string): Promise<unknown> {
    return firstValueFrom(this.authApi.verifyOtp({ email, otpCode }));
  }
  resetPassword(params: ResetPasswordParams): Promise<unknown> {
    return firstValueFrom(this.authApi.resetPassword(params));
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.authApi.logout());
    } catch {
      /* clear the local session regardless of the network result */
    } finally {
      this.clear();
    }
  }

  private clear(): void {
    this._token.set(null);
    this.clearToken();
  }

  private setToken(token: string): void {
    this._token.set(token);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable — keep the in-memory session */
    }
  }

  private readToken(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private clearToken(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* no-op */
    }
  }
}
