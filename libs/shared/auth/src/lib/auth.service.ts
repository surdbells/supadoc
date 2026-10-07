import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, AuthApi } from '@supadoc/data-access';
import type {
  LoginParams,
  LoginResponse,
  RegisterParams,
  ResetPasswordParams,
  TwoFactorChallenge,
} from '@supadoc/models';
import type { SessionAuth, SessionEndReason } from './session/session-auth';
import {
  consumeSessionNotice,
  SESSION_END_MESSAGES,
  setSessionNotice,
} from './session/session-notice';
import {
  isDefinitiveAuthFailure,
  clockOffsetFrom,
  localExpiryMs,
  readEndedMarker,
  writeEndedMarker,
} from './session/session-utils';

const TOKEN_KEY = 'videomed.token';
const REFRESH_KEY = 'videomed.refresh';
const REDIRECT_KEY = 'videomed.redirect';
const ENDED_KEY = 'videomed.session.ended';
/** Device-clock minus server-clock (ms), measured when a token was issued. */
const CLOCK_KEY = 'videomed.clock-offset';

/**
 * Central auth state for every app, backed by the VideoMed API (via `AuthApi`).
 * The bearer token is exposed as a signal so guards/interceptors react to
 * sign-in/out without extra plumbing. Implements {@link SessionAuth} so the
 * shared idle-timeout watcher can end the session, and mirrors sign-in/out
 * made in other tabs (via the `storage` event) so every tab agrees.
 */
@Injectable({ providedIn: 'root' })
export class AuthService implements SessionAuth {
  private readonly authApi = inject(AuthApi);

  private readonly _token = signal<string | null>(this.readToken());
  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);

  /** Shared (cross-tab) last-activity timestamp for the idle timeout. */
  readonly activityKey = 'videomed.activity';

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => this.onStorage(e));
    }
  }

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
   * `POST /login`. On success stores the access + refresh tokens and resolves
   * with `null`. When the account has 2FA enabled, no session is stored and a
   * {@link TwoFactorChallenge} is returned instead — the caller must then call
   * {@link verifyTwoFactor}. `remember` decides where tokens live: `localStorage`
   * (persists across restarts) when true, else `sessionStorage`.
   */
  async login(
    params: LoginParams,
    remember = true,
  ): Promise<TwoFactorChallenge | null> {
    const res = await firstValueFrom(this.authApi.login(params));
    const data = (res?.['data'] ?? null) as
      | { two_factor_required?: boolean; challenge?: string }
      | null;
    if (data?.two_factor_required && data.challenge) {
      return { challenge: data.challenge, remember };
    }
    this.storeSession(res, remember);
    return null;
  }

  /**
   * Second step of a 2FA sign-in: exchange the challenge + a TOTP / recovery code
   * for a session.
   */
  async verifyTwoFactor(
    challenge: string,
    code: string,
    remember = true,
  ): Promise<void> {
    const res = await firstValueFrom(
      this.authApi.verifyTwoFactor(challenge, code),
    );
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
        this.expire('expired');
        return false;
      }
      this.updateAccessToken(access);
      return true;
    } catch (err) {
      // Only a definitive rejection (expired, idle, signed out elsewhere) ends
      // the session — being offline or a 5xx must not sign anyone out.
      if (isDefinitiveAuthFailure(err)) {
        this.expire('expired', apiErrorMessage(err, SESSION_END_MESSAGES.expired));
      }
      return false;
    }
  }

  /**
   * Sign out on purpose: clear the session here (and in other tabs) at once,
   * then revoke it server-side in the background so a copied token dies too.
   */
  async logout(): Promise<void> {
    const refresh = this.readStored(REFRESH_KEY);
    writeEndedMarker(ENDED_KEY, { reason: 'signed-out' });
    this.clear();
    this.revokeOnServer(refresh);
  }

  /** {@inheritDoc SessionAuth.expire} */
  expire(reason: SessionEndReason, message?: string): void {
    if (this._token() === null && !this.hasRefreshToken()) return;
    const refresh = this.readStored(REFRESH_KEY);
    setSessionNotice(reason, message);
    writeEndedMarker(ENDED_KEY, { reason, message });
    this.clear();
    this.revokeOnServer(refresh);
  }

  /** {@inheritDoc SessionAuth.keepAlive} */
  async keepAlive(): Promise<void> {
    if (!this.isAuthenticated()) return;
    try {
      // Any authed call restarts the server idle clock; a 401 here goes through
      // the refresh interceptor, which ends the session if it is truly over.
      await firstValueFrom(this.authApi.keepAlive());
    } catch {
      /* transient failures are ignored; definitive ones were handled above */
    }
  }

  /** {@inheritDoc SessionAuth.sessionDeadline} */
  sessionDeadline(): number | null {
    // Token expiries are server time; translate to this device's clock so a
    // device with a wrong date/time is not signed out early (or never).
    const offset = Number(this.readStored(CLOCK_KEY) ?? 0) || 0;
    return localExpiryMs(this.readStored(REFRESH_KEY), offset) ?? localExpiryMs(this._token(), offset);
  }

  private revokeOnServer(refresh: string | null): void {
    if (!refresh) return;
    this.authApi.logout(refresh).subscribe({ error: () => undefined });
  }

  /** Mirror a sign-in, token refresh or sign-out made in another tab. */
  private onStorage(e: StorageEvent): void {
    if (e.key !== null && e.key !== TOKEN_KEY) return;
    try {
      if (e.storageArea !== localStorage) return;
    } catch {
      return;
    }
    const next = e.key === null ? null : e.newValue;
    if (next === this._token()) return;
    if (next === null && this._token() !== null) {
      const marker = readEndedMarker(ENDED_KEY);
      // A deliberate sign-out elsewhere still deserves a word on this tab.
      setSessionNotice(
        marker && marker.reason !== 'signed-out' ? marker.reason : 'elsewhere',
        marker?.message,
      );
    }
    this._token.set(next);
  }

  private clear(): void {
    this._token.set(null);
    for (const s of this.storages()) {
      try {
        s.removeItem(TOKEN_KEY);
        s.removeItem(REFRESH_KEY);
        s.removeItem(CLOCK_KEY);
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
    // A fresh sign-in supersedes any "you were signed out" note still pending.
    consumeSessionNotice();
    this._token.set(access);
    try {
      const primary = remember ? localStorage : sessionStorage;
      const secondary = remember ? sessionStorage : localStorage;
      primary.setItem(TOKEN_KEY, access);
      secondary.removeItem(TOKEN_KEY);
      primary.setItem(CLOCK_KEY, String(clockOffsetFrom(access)));
      secondary.removeItem(CLOCK_KEY);
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
      store.setItem(CLOCK_KEY, String(clockOffsetFrom(access)));
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
