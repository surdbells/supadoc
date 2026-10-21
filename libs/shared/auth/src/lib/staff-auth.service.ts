import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ApiService, apiErrorCode, apiErrorMessage, apiErrorReason } from '@supadoc/data-access';
import type { StaffLoginData, StaffUserDto } from '@supadoc/models';
import { STAFF_AUTH_CONFIG } from './provide-staff-auth';
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

const REDIRECT_KEY = 'videomed.staff.redirect';

/**
 * Auth state for a staff silo (doctor or back-office), backed by the shared API
 * (`POST /api/auth/login`, `GET /api/me`, `POST /api/auth/refresh`). Unlike the
 * customer `AuthService`, it captures the `user` payload so the app can gate nav
 * on roles/permissions. Token + user persist under the app's configured key.
 * Implements {@link SessionAuth} for the shared idle-timeout watcher, and
 * mirrors sign-in/out made in other tabs so every tab agrees.
 */
@Injectable({ providedIn: 'root' })
export class StaffAuthService implements SessionAuth {
  private readonly api = inject(ApiService);
  private readonly config = inject(STAFF_AUTH_CONFIG);
  private readonly reloadPage = inject(RELOAD_PAGE);

  private readonly _token = signal<string | null>(this.read(this.tokenKey));
  private readonly _user = signal<StaffUserDto | null>(this.readUser());
  private readonly backoff = new RefreshBackoff();

  readonly token = this._token.asReadonly();
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);
  /** The signed-in staff user's id (the access token's `sub`), or null. */
  readonly subject = computed(() => jwtSubject(this._token()));
  readonly roles = computed(() => this._user()?.roles ?? []);
  readonly permissions = computed(() => this._user()?.permissions ?? []);
  readonly displayName = computed(() => {
    const u = this._user();
    return u ? `${u.first_name} ${u.last_name}`.trim() : '';
  });

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => this.onStorage(e));
    }
  }

  /** Shared (cross-tab) last-activity timestamp for the idle timeout. */
  get activityKey(): string {
    return `${this.config.storageKey}.activity`;
  }

  /** super_admin bypasses every permission check (mirrors the API RBAC). */
  hasPermission(permission: string): boolean {
    const u = this._user();
    if (!u) return false;
    return u.roles.includes('super_admin') || u.permissions.includes(permission);
  }

  hasRole(role: string): boolean {
    return this._user()?.roles.includes(role) ?? false;
  }

  /** The role this app requires (if any), from the app's provider config. */
  requiredRole(): string | undefined {
    return this.config.requiredRole;
  }

  /**
   * Sign in with email + password. Throws if the account lacks the app's
   * required role (e.g. a non-doctor signing into the doctor app), after
   * clearing any partial session.
   */
  async login(email: string, password: string): Promise<StaffUserDto> {
    const res = await firstValueFrom(
      this.api.post<{ data: StaffLoginData }>('api/auth/login', {
        email: email.trim(),
        password,
      }),
    );
    return this.adopt(res.data);
  }

  /**
   * POST /api/auth/staff/accept-invite — an invited doctor chooses their first
   * password from the emailed link, and is signed in.
   */
  async acceptInvite(token: string, password: string): Promise<StaffUserDto> {
    const res = await firstValueFrom(
      this.api.post<{ data: StaffLoginData }>('api/auth/staff/accept-invite', {
        token,
        password,
      }),
    );
    return this.adopt(res.data);
  }

  /** POST /api/auth/staff/reset-password — new password from a reset link, then signed in. */
  async resetPassword(token: string, password: string): Promise<StaffUserDto> {
    const res = await firstValueFrom(
      this.api.post<{ data: StaffLoginData }>('api/auth/staff/reset-password', {
        token,
        password,
      }),
    );
    return this.adopt(res.data);
  }

  /**
   * POST /api/auth/staff/forgot-password — email a reset link. Resolves with the
   * server's message, which is the same whether or not the account exists.
   */
  async requestPasswordReset(email: string): Promise<string> {
    const res = await firstValueFrom(
      this.api.post<{ message?: string; data?: { sent?: boolean } }>(
        'api/auth/staff/forgot-password',
        { email: email.trim() },
      ),
    );
    return res.message ?? 'If an account exists for that email, we have sent a reset link.';
  }

  /** Keep a fresh session — after checking it has the role this app requires. */
  private adopt(data: StaffLoginData): StaffUserDto {
    const required = this.config.requiredRole;
    if (required && !data.user.roles.includes(required)) {
      throw new Error(`This account is not a ${required} login.`);
    }
    this.store(data.access_token, data.refresh_token ?? null, data.user);
    return data.user;
  }

  /** Refresh the cached user from `GET /api/me` (roles/permissions can change). */
  async loadMe(): Promise<StaffUserDto | null> {
    try {
      const res = await firstValueFrom(
        this.api.get<{ data: StaffUserDto }>('api/me'),
      );
      this._user.set(res.data);
      this.write(this.userKey, JSON.stringify(res.data));
      return res.data;
    } catch {
      return null;
    }
  }

  /** POST /api/me/password — change the signed-in staff user's password. */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await firstValueFrom(
      this.api.post('api/me/password', {
        current_password: currentPassword,
        new_password: newPassword,
      }),
    );
  }

  hasRefreshToken(): boolean {
    return this.read(this.refreshKey) !== null;
  }

  private refreshInFlight: Promise<boolean> | null = null;

  /**
   * Exchange the refresh token for a fresh access token (one request however
   * many callers). False when it failed: a definitive rejection has then ended
   * the session; a transient one (offline, 5xx, 429) leaves the user signed in
   * and makes further attempts wait a little (see {@link RefreshBackoff}).
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
    const refresh = this.read(this.refreshKey);
    if (!refresh) return false;
    const before = this._token();
    return withRefreshLock(`${this.tokenKey}.refresh`, async () => {
      // Another tab refreshed while this one waited for the lock: use its token.
      if (this.adoptStoredToken(before)) return true;
      try {
        const res = await firstValueFrom(
          this.api
            .post<{ data: { access_token?: string } }>(
              'api/auth/refresh',
              { refresh_token: refresh },
              passive ? { passive: true } : undefined,
            )
            // An unanswered refresh is a transient failure (no status → back-off below).
            .pipe(timeout({ first: REFRESH_TIMEOUT_MS })),
        );
        // Signed out (or someone else signed in) meanwhile: never bring this session back.
        if (this.read(this.refreshKey) !== refresh) return this._token() !== null;
        const access = res?.data?.access_token;
        if (!access) {
          this.expire('expired');
          return false;
        }
        this.backoff.reset();
        this._token.set(access);
        this.write(this.tokenKey, access);
        this.write(this.clockKey, String(clockOffsetFrom(access)));
        return true;
      } catch (err) {
        if (this.read(this.refreshKey) !== refresh) return this._token() !== null;
        // Only a definitive rejection ends the session — offline / 5xx / a CDN error page must not.
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

  /** A token another tab stored since `before`, with a minute or more left, is adopted. */
  private adoptStoredToken(before: string | null): boolean {
    const stored = this.read(this.tokenKey);
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
  logout(): void {
    const refresh = this.read(this.refreshKey);
    writeEndedMarker(this.endedKey, { reason: 'signed-out' });
    // A page remembered for this user is not for whoever signs in next.
    clearReturnTarget(REDIRECT_KEY);
    this.clear();
    this.revokeOnServer(refresh);
  }

  /** {@inheritDoc SessionAuth.expire} */
  expire(reason: SessionEndReason, message?: string): void {
    if (this._token() === null && !this.hasRefreshToken()) return;
    const refresh = this.read(this.refreshKey);
    this.tieReturnTarget();
    setSessionNotice(reason, message);
    writeEndedMarker(this.endedKey, { reason, message });
    this.clear();
    this.revokeOnServer(refresh);
  }

  /** {@inheritDoc SessionAuth.keepAlive} — also refreshes roles/permissions. */
  async keepAlive(): Promise<void> {
    if (this.isAuthenticated()) await this.loadMe();
  }

  /** {@inheritDoc SessionAuth.sessionDeadline} */
  sessionDeadline(): number | null {
    // Token expiries are server time; translate to this device's clock.
    const offset = this.clockOffset();
    return localExpiryMs(this.read(this.refreshKey), offset) ?? localExpiryMs(this._token(), offset);
  }

  /**
   * Device-clock minus server-clock (ms), from when the current token was
   * issued — to compare a time taken on this device with one the API gave.
   */
  clockOffset(): number {
    return Number(this.read(this.clockKey) ?? 0) || 0;
  }

  /**
   * The session is ending under this user: whatever page is remembered next
   * in this tab (the one they were on) is theirs only.
   */
  private tieReturnTarget(): void {
    const sub = jwtSubject(this._token());
    if (sub === null) return;
    const prev = readReturnTarget(REDIRECT_KEY);
    const url = prev && (!prev.sub || prev.sub === sub) ? prev.url : undefined;
    writeReturnTarget(REDIRECT_KEY, { url, sub });
  }

  private revokeOnServer(refresh: string | null): void {
    if (!refresh) return;
    this.api
      .post('api/auth/logout', { refresh_token: refresh })
      .subscribe({ error: () => undefined });
  }

  /** Mirror a sign-in, token refresh or sign-out made in another tab. */
  private onStorage(e: StorageEvent): void {
    // The user is written after the token (see `store`): the token's event can
    // arrive before it, so take the user (roles, name) when its own write lands.
    if (e.key === this.userKey) {
      this._user.set(this.readUser());
      return;
    }
    if (e.key !== null && e.key !== this.tokenKey) return;
    const next = e.key === null ? null : e.newValue;
    const prev = this._token();
    if (next === prev) return;
    if (next === null) {
      if (prev !== null) {
        const marker = readEndedMarker(this.endedKey);
        setSessionNotice(
          marker && marker.reason !== 'signed-out' ? marker.reason : 'elsewhere',
          marker?.message,
        );
        this.tieReturnTarget();
      }
      this._user.set(null);
    } else {
      this._user.set(this.readUser());
      this.backoff.reset();
    }
    this._token.set(next);
    // Someone else signed in in another tab: start this one over under them,
    // rather than showing the previous user's page (and data) with their token.
    if (next !== null && prev !== null && jwtSubject(next) !== jwtSubject(prev)) this.reloadPage();
  }

  // ----- redirect memory (per tab, via sessionStorage) -----

  /**
   * Remember a page to return to after signing in. Only same-app paths are
   * kept; a page left by an involuntary sign-out is tied to that user, so
   * someone else signing in at this screen lands on their own home instead.
   */
  rememberRedirect(url: string): void {
    if (!isSafeReturnUrl(url)) return;
    const sub = jwtSubject(this._token()) ?? readReturnTarget(REDIRECT_KEY)?.sub ?? null;
    writeReturnTarget(REDIRECT_KEY, { url, sub });
  }

  /** The remembered page (cleared) — null when none, or when it was another user's. */
  consumeRedirect(): string | null {
    const url = returnUrlFor(readReturnTarget(REDIRECT_KEY), jwtSubject(this._token()));
    clearReturnTarget(REDIRECT_KEY);
    return url;
  }

  // ----- storage -----

  private get tokenKey(): string {
    return this.config.storageKey;
  }
  private get refreshKey(): string {
    return `${this.config.storageKey}.refresh`;
  }
  private get userKey(): string {
    return `${this.config.storageKey}.user`;
  }
  /** Device-clock minus server-clock (ms), measured when a token was issued. */
  private get clockKey(): string {
    return `${this.config.storageKey}.clock-offset`;
  }
  private get endedKey(): string {
    return `${this.config.storageKey}.ended`;
  }

  private store(access: string, refresh: string | null, user: StaffUserDto): void {
    // A fresh sign-in supersedes any "you were signed out" note still pending.
    consumeSessionNotice();
    this.backoff.reset();
    this._token.set(access);
    this._user.set(user);
    this.write(this.tokenKey, access);
    this.write(this.clockKey, String(clockOffsetFrom(access)));
    this.write(this.userKey, JSON.stringify(user));
    if (refresh !== null) this.write(this.refreshKey, refresh);
  }

  private clear(): void {
    this._token.set(null);
    this._user.set(null);
    for (const key of [this.tokenKey, this.refreshKey, this.userKey, this.clockKey]) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* no-op */
      }
    }
  }

  private readUser(): StaffUserDto | null {
    const raw = this.read(this.userKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StaffUserDto;
    } catch {
      return null;
    }
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* keep the in-memory session */
    }
  }
}
