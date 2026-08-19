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
const REFRESH_KEY = 'videomed.refresh';
const REDIRECT_KEY = 'videomed.redirect';

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

  /**
   * A destination to return to after signing in — set when a visitor is gated
   * mid-flow (e.g. clicking "Book Consultation" while signed out). Held in
   * sessionStorage so it survives the multi-step register flow and refreshes.
   */
  rememberRedirect(url: string): void {
    // Never bounce back into the auth screens themselves.
    if (!url || url.startsWith('/auth')) return;
    try {
      sessionStorage.setItem(REDIRECT_KEY, url);
    } catch {
      /* storage unavailable — the redirect is best-effort */
    }
  }

  /** The pending post-login destination, if any (without clearing it). */
  peekRedirect(): string | null {
    try {
      return sessionStorage.getItem(REDIRECT_KEY);
    } catch {
      return null;
    }
  }

  /** The pending post-login destination, clearing it. Falls back to null. */
  consumeRedirect(): string | null {
    const url = this.peekRedirect();
    try {
      sessionStorage.removeItem(REDIRECT_KEY);
    } catch {
      /* no-op */
    }
    return url;
  }

  /**
   * `POST /login`. Stores the access + refresh tokens. `remember` decides where
   * they live: `localStorage` (persists across browser restarts) when true,
   * `sessionStorage` (cleared when the browser closes) when false.
   */
  async login(params: LoginParams, remember = true): Promise<void> {
    const res = await firstValueFrom(this.authApi.login(params));
    this.storeSession(res, remember);
  }

  /**
   * Sign in with a Google (Firebase) ID token — POST /api/portal/auth/google.
   * The backend verifies the token and returns the same session envelope.
   */
  async loginWithGoogle(idToken: string, remember = true): Promise<void> {
    const res = await firstValueFrom(this.authApi.googleLogin(idToken));
    this.storeSession(res, remember);
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

  /** The refresh token from a login envelope (local API only), or null. */
  private extractRefresh(res: LoginResponse): string | null {
    const data = (res?.['data'] ?? null) as { refresh_token?: string } | null;
    return data?.refresh_token ?? null;
  }

  /** Persist a login response's tokens in the storage chosen by `remember`. */
  private storeSession(res: LoginResponse, remember: boolean): void {
    const access = this.extractToken(res);
    if (access) this.setSession(access, this.extractRefresh(res), remember);
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
    this.storeSession(res, true);
  }

  /** Sign in with a verified phone number. */
  async loginByPhone(verificationToken: string): Promise<void> {
    const res = await firstValueFrom(
      this.authApi.loginByPhone(verificationToken),
    );
    this.storeSession(res, true);
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
    this.storeSession(res, true);
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
    this.storeSession(res, true);
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

  /** Whether a refresh token is available to renew an expired access token. */
  hasRefreshToken(): boolean {
    return this.readStored(REFRESH_KEY) !== null;
  }

  private refreshInFlight: Promise<boolean> | null = null;

  /**
   * Exchange the stored refresh token for a fresh access token. Returns false
   * (and clears the session) when there's no refresh token or it's rejected —
   * the caller should then treat the user as signed out. Concurrent callers
   * (e.g. several requests 401-ing at once) share a single in-flight refresh.
   */
  refresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const refresh = this.readStored(REFRESH_KEY);
    if (!refresh) return false;
    try {
      const res = await firstValueFrom(this.authApi.refresh(refresh));
      const access = res?.data?.access_token;
      if (!access) {
        this.clear();
        return false;
      }
      this.updateAccessToken(access);
      return true;
    } catch {
      this.clear();
      return false;
    }
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
    for (const s of this.storages()) {
      try {
        s.removeItem(TOKEN_KEY);
        s.removeItem(REFRESH_KEY);
      } catch {
        /* no-op */
      }
    }
  }

  /** Store access (+ refresh) in localStorage (remember) or sessionStorage. */
  private setSession(
    access: string,
    refresh: string | null,
    remember: boolean,
  ): void {
    this._token.set(access);
    try {
      const primary = remember ? localStorage : sessionStorage;
      const secondary = remember ? sessionStorage : localStorage;
      primary.setItem(TOKEN_KEY, access);
      secondary.removeItem(TOKEN_KEY);
      if (refresh !== null) {
        primary.setItem(REFRESH_KEY, refresh);
        secondary.removeItem(REFRESH_KEY);
      }
    } catch {
      /* storage unavailable — keep the in-memory session */
    }
  }

  /** Replace just the access token, in whichever storage holds the session. */
  private updateAccessToken(access: string): void {
    this._token.set(access);
    const store =
      this.readStored(REFRESH_KEY, localStorage) !== null
        ? localStorage
        : sessionStorage;
    try {
      store.setItem(TOKEN_KEY, access);
    } catch {
      /* keep the in-memory session */
    }
  }

  private readToken(): string | null {
    return this.readStored(TOKEN_KEY);
  }

  /** Read a key from a specific storage, or from local then session. */
  private readStored(key: string, only?: Storage): string | null {
    try {
      if (only) return only.getItem(key);
      return localStorage.getItem(key) ?? sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private storages(): Storage[] {
    try {
      return [localStorage, sessionStorage];
    } catch {
      return [];
    }
  }
}
