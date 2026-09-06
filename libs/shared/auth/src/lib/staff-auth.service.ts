import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@supadoc/data-access';
import type { StaffLoginData, StaffUserDto } from '@supadoc/models';
import { STAFF_AUTH_CONFIG } from './provide-staff-auth';

const REDIRECT_KEY = 'videomed.staff.redirect';

/**
 * Auth state for a staff silo (doctor or back-office), backed by the shared API
 * (`POST /api/auth/login`, `GET /api/me`, `POST /api/auth/refresh`). Unlike the
 * customer `AuthService`, it captures the `user` payload so the app can gate nav
 * on roles/permissions. Token + user persist under the app's configured key.
 */
@Injectable({ providedIn: 'root' })
export class StaffAuthService {
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
        this.clear();
        return false;
      }
      this._token.set(access);
      this.write(this.tokenKey, access);
      return true;
    } catch {
      this.clear();
      return false;
    }
  }

  /** No server logout endpoint exists; clear the local session. */
  logout(): void {
    this.clear();
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

  private store(access: string, refresh: string | null, user: StaffUserDto): void {
    this._token.set(access);
    this._user.set(user);
    this.write(this.tokenKey, access);
    this.write(this.userKey, JSON.stringify(user));
    if (refresh !== null) this.write(this.refreshKey, refresh);
  }

  private clear(): void {
    this._token.set(null);
    this._user.set(null);
    for (const key of [this.tokenKey, this.refreshKey, this.userKey]) {
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
