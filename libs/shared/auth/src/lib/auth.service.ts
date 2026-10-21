import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { apiErrorCode, apiErrorMessage, apiErrorReason, AuthApi } from '@supadoc/data-access';
import type {
  LoginParams,
  LoginResponse,
  RegisterParams,
  ResetPasswordParams,
  TwoFactorChallenge,
} from '@supadoc/models';
import { AuthFlowService } from './auth-flow.service';
import type { RefreshOptions, SessionAuth, SessionEndReason } from './session/session-auth';
import {
  consumeSessionNotice,
  SESSION_END_MESSAGES,
  setSessionNotice,
} from './session/session-notice';
import { clearReturnTarget, readReturnTarget, returnUrlFor, writeReturnTarget } from './session/return-url';
import { REFRESH_TIMEOUT_MS, RefreshBackoff, withRefreshLock } from './session/session-refresh';
import {
  clockOffsetFrom,
  endReasonFor,
  isDefinitiveAuthFailure,
  isSafeReturnUrl,
  jwtSubject,
  localExpiryMs,
  readEndedMarker,
  refreshMarginMs,
  RELOAD_PAGE,
  retryAfterMsOf,
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
  private readonly flow = inject(AuthFlowService);
  private readonly reloadPage = inject(RELOAD_PAGE);

  private readonly _token = signal<string | null>(this.readToken());
  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);
  /** The signed-in patient's id (the access token's `sub`), or null. */
  readonly subject = computed(() => jwtSubject(this._token()));

  /** Shared (cross-tab) last-activity timestamp for the idle timeout. */
  readonly activityKey = 'videomed.activity';

  private readonly backoff = new RefreshBackoff();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => this.onStorage(e));
    }
  }

  /**
   * A destination to return to after signing in — set when a visitor is gated
   * mid-flow (e.g. clicking "Book Consultation" while signed out), or when a
   * session ends under a page. Held in sessionStorage so it survives the
   * multi-step register flow and refreshes. Only same-app paths are kept, and
   * a page left by an involuntary sign-out is tied to that patient: someone
   * else signing in at this screen gets their own landing page instead.
   */
  rememberRedirect(url: string): void {
    // Never bounce back into the auth screens themselves, or off this app.
    if (!isSafeReturnUrl(url)) return;
    const sub = jwtSubject(this._token()) ?? readReturnTarget(REDIRECT_KEY)?.sub ?? null;
    writeReturnTarget(REDIRECT_KEY, { url, sub });
  }

  /** The pending post-login destination, if any (without clearing it). */
  peekRedirect(): string | null {
    return returnUrlFor(readReturnTarget(REDIRECT_KEY), jwtSubject(this._token()));
  }

  /**
   * The pending post-login destination, clearing it. Null when there is none,
   * or when it was left by another patient's session.
   */
  consumeRedirect(): string | null {
    const url = returnUrlFor(readReturnTarget(REDIRECT_KEY), jwtSubject(this._token()));
    clearReturnTarget(REDIRECT_KEY);
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
   * Exchange the stored refresh token for a fresh access token. Resolves false
   * when there's no refresh token or the refresh failed: a definitive
   * rejection (expired, idle, signed out elsewhere) has then ended the session;
   * a transient one (offline, 5xx, 429) leaves the patient signed in and makes
   * further attempts wait a little (see {@link RefreshBackoff}). Concurrent
   * callers (e.g. several requests at once) share a single in-flight refresh.
   */
  refresh(options?: RefreshOptions): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (this.backoff.blocked()) return Promise.resolve(false);
    this.refreshInFlight = this.doRefresh(options?.passive === true).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /** {@inheritDoc TokenSession.ensureFreshToken} */
  async ensureFreshToken(minMs = 60_000, options?: RefreshOptions): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    const token = this._token();
    if (token === null || !this.hasRefreshToken() || this.backoff.blocked()) return;
    const exp = this.accessExpiresAt();
    // An opaque token (no readable expiry) is never refreshed ahead — no loop.
    if (exp === null || exp - Date.now() > refreshMarginMs(token, minMs)) return;
    await this.refresh(options);
  }

  /** {@inheritDoc SessionAuth.accessExpiresAt} */
  accessExpiresAt(): number | null {
    return localExpiryMs(this._token(), this.clockOffset());
  }

  /** `passive`: started for a background poll — the API then doesn't count it as activity. */
  private async doRefresh(passive: boolean): Promise<boolean> {
    const refresh = this.readStored(REFRESH_KEY);
    if (!refresh) return false;
    const before = this._token();
    return withRefreshLock(`${TOKEN_KEY}.refresh`, async () => {
      // Another tab refreshed while this one waited for the lock: use its token.
      if (this.adoptStoredToken(before)) return true;
      try {
        const res = await firstValueFrom(
          // An unanswered refresh is a transient failure (no status → back-off below).
          this.authApi.refresh(refresh, passive).pipe(timeout({ first: REFRESH_TIMEOUT_MS })),
        );
        // Signed out (or someone else signed in) meanwhile: never bring this session back.
        if (this.readStored(REFRESH_KEY) !== refresh) return this._token() !== null;
        const access = res?.data?.access_token;
        if (!access) {
          this.expire('expired');
          return false;
        }
        this.backoff.reset();
        this.updateAccessToken(access);
        return true;
      } catch (err) {
        if (this.readStored(REFRESH_KEY) !== refresh) return this._token() !== null;
        // Only a definitive rejection (expired, idle, signed out elsewhere) ends
        // the session — being offline or a 5xx must not sign anyone out.
        if (isDefinitiveAuthFailure(err)) {
          this.expire(
            endReasonFor(apiErrorCode(err), apiErrorReason(err)),
            apiErrorMessage(err, SESSION_END_MESSAGES.expired),
          );
        } else {
          this.backoff.fail(retryAfterMsOf(err));
        }
        return false;
      }
    });
  }

  /**
   * The session is ending under this patient: whatever page is remembered next
   * in this tab (the one they were on) is theirs only.
   */
  private tieReturnTarget(): void {
    const sub = jwtSubject(this._token());
    if (sub === null) return;
    const prev = readReturnTarget(REDIRECT_KEY);
    const url = prev && (!prev.sub || prev.sub === sub) ? prev.url : undefined;
    writeReturnTarget(REDIRECT_KEY, { url, sub });
  }

  /** A token another tab stored since `before`, with a minute or more left, is adopted. */
  private adoptStoredToken(before: string | null): boolean {
    const stored = this.readStored(TOKEN_KEY);
    if (stored === null || stored === before || jwtSubject(stored) !== jwtSubject(before)) return false;
    const exp = localExpiryMs(stored, this.clockOffset());
    if (exp === null || exp - Date.now() <= 60_000) return false;
    if (this._token() !== stored) this._token.set(stored);
    this.backoff.reset();
    return true;
  }

  /**
   * Sign out on purpose: clear the session here (and in other tabs) at once,
   * then revoke it server-side in the background so a copied token dies too.
   */
  async logout(): Promise<void> {
    const refresh = this.readStored(REFRESH_KEY);
    writeEndedMarker(ENDED_KEY, { reason: 'signed-out' });
    // A page remembered for this patient is not for whoever signs in next.
    clearReturnTarget(REDIRECT_KEY);
    this.clear();
    this.revokeOnServer(refresh);
  }

  /** {@inheritDoc SessionAuth.expire} */
  expire(reason: SessionEndReason, message?: string): void {
    if (this._token() === null && !this.hasRefreshToken()) return;
    const refresh = this.readStored(REFRESH_KEY);
    this.tieReturnTarget();
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
    const offset = this.clockOffset();
    return localExpiryMs(this.readStored(REFRESH_KEY), offset) ?? localExpiryMs(this._token(), offset);
  }

  /** Device-clock minus server-clock (ms), from when the current token was issued. */
  private clockOffset(): number {
    return Number(this.readStored(CLOCK_KEY) ?? 0) || 0;
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
    const prev = this._token();
    if (next === prev) return;
    if (next === null && prev !== null) {
      const marker = readEndedMarker(ENDED_KEY);
      // A deliberate sign-out elsewhere still deserves a word on this tab.
      setSessionNotice(
        marker && marker.reason !== 'signed-out' ? marker.reason : 'elsewhere',
        marker?.message,
      );
      this.tieReturnTarget();
    }
    this._token.set(next);
    if (next !== null) this.backoff.reset();
    // Someone else signed in in another tab: start this one over under them,
    // rather than showing the previous patient's page with the new one's token.
    if (next !== null && prev !== null && jwtSubject(next) !== jwtSubject(prev)) this.reloadPage();
  }

  private clear(): void {
    this.flow.reset();
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
    this.backoff.reset();
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
