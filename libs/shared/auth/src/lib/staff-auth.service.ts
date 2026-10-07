import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, apiErrorMessage } from '@supadoc/data-access';
import type { StaffLoginData, StaffUserDto } from '@supadoc/models';
import { STAFF_AUTH_CONFIG } from './provide-staff-auth';
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

  private readonly _token = signal<string | null>(this.read(this.tokenKey));
  private readonly _user = signal<StaffUserDto | null>(this.readUser());

  readonly token = this._token.asReadonly();
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);
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
    const data = res.data;
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

  /** Exchange the refresh token for a fresh access token (shared in-flight). */
  refresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const refresh = this.read(this.refreshKey);
    if (!refresh) return false;
    try {
      const res = await firstValueFrom(
        this.api.post<{ data: { access_token?: string } }>(
          'api/auth/refresh',
          { refresh_token: refresh },
        ),
      );
      const access = res?.data?.access_token;
      if (!access) {
        this.expire('expired');
        return false;
      }
      this._token.set(access);
      this.write(this.tokenKey, access);
      this.write(this.clockKey, String(clockOffsetFrom(access)));
      return true;
    } catch (err) {
      // Only a definitive rejection ends the session — offline / 5xx must not.
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
  logout(): void {
    const refresh = this.read(this.refreshKey);
    writeEndedMarker(this.endedKey, { reason: 'signed-out' });
    this.clear();
    this.revokeOnServer(refresh);
  }

  /** {@inheritDoc SessionAuth.expire} */
  expire(reason: SessionEndReason, message?: string): void {
    if (this._token() === null && !this.hasRefreshToken()) return;
    const refresh = this.read(this.refreshKey);
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
    const offset = Number(this.read(this.clockKey) ?? 0) || 0;
    return localExpiryMs(this.read(this.refreshKey), offset) ?? localExpiryMs(this._token(), offset);
  }

  private revokeOnServer(refresh: string | null): void {
    if (!refresh) return;
    this.api
      .post('api/auth/logout', { refresh_token: refresh })
      .subscribe({ error: () => undefined });
  }

  /** Mirror a sign-in, token refresh or sign-out made in another tab. */
  private onStorage(e: StorageEvent): void {
    if (e.key !== null && e.key !== this.tokenKey) return;
    const next = e.key === null ? null : e.newValue;
    if (next === this._token()) return;
    if (next === null) {
      if (this._token() !== null) {
        const marker = readEndedMarker(this.endedKey);
        setSessionNotice(
          marker && marker.reason !== 'signed-out' ? marker.reason : 'elsewhere',
          marker?.message,
        );
      }
      this._user.set(null);
    } else {
      this._user.set(this.readUser());
    }
    this._token.set(next);
  }

  // ----- redirect memory (shared across staff apps via sessionStorage) -----

  rememberRedirect(url: string): void {
    if (!url || url.startsWith('/auth')) return;
    try {
      sessionStorage.setItem(REDIRECT_KEY, url);
    } catch {
      /* best-effort */
    }
  }

  consumeRedirect(): string | null {
    try {
      const url = sessionStorage.getItem(REDIRECT_KEY);
      sessionStorage.removeItem(REDIRECT_KEY);
      return url;
    } catch {
      return null;
    }
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
