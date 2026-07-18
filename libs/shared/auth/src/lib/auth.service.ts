import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@supadoc/data-access';
import type { ApiResponse, User } from '@supadoc/models';

const TOKEN_KEY = 'supadoc.token';

export interface LoginCredentials {
  email: string;
  password: string;
}

interface AuthResult {
  token: string;
  user: User;
}

/**
 * Central auth state for every app. Token + current user are exposed as
 * signals so components and guards react to sign-in/out without extra plumbing.
 *
 * Endpoints (`auth/login`, ...) are placeholders — align them with the real
 * API once published.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);

  private readonly _token = signal<string | null>(this.readToken());
  private readonly _user = signal<User | null>(null);

  readonly token = this._token.asReadonly();
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);

  async login(credentials: LoginCredentials): Promise<User> {
    const res = await firstValueFrom(
      this.api.post<ApiResponse<AuthResult>>('auth/login', credentials),
    );
    this.setSession(res.data.token, res.data.user);
    return res.data.user;
  }

  logout(): void {
    this._token.set(null);
    this._user.set(null);
    this.clearToken();
  }

  private setSession(token: string, user: User): void {
    this._token.set(token);
    this._user.set(user);
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
