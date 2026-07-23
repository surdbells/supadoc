import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '@supadoc/data-access';
import type {
  LoginParams,
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
    const token =
      (res?.token as string | undefined) ??
      (res?.accessToken as string | undefined) ??
      (res?.jwt as string | undefined) ??
      null;
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
