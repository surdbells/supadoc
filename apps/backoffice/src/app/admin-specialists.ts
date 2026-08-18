import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  signal,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import { environment } from '../environments/environment';

interface AdminSpecialist {
  id: string;
  name: string;
  specialty: string;
  email: string;
  consultation_fee: string;
  photo_url: string;
  available: boolean;
  verified: boolean;
  saving: boolean;
  saved: boolean;
  error: string;
}

const ADMIN_TOKEN_KEY = 'videomed.admin.token';

/**
 * Minimal back-office page (route `/admin`) to edit specialists — chiefly their
 * contact email (which drives confirmation + join-link delivery), plus fee and
 * availability. Self-contained: it talks to the staff API with `fetch` and its
 * own token key, so it never entangles with the patient app's customer-scoped
 * auth. Requires a staff account with the `specialists.manage` permission.
 */
@Component({
  selector: 'bo-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block min-h-screen bg-glacier' },
  template: `
    <div class="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8">
      <header class="flex items-center justify-between gap-4">
        <span class="font-heading text-h4 tracking-tight">
          <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
          <span
            class="ml-2 rounded-pill bg-ink/10 px-2.5 py-1 align-middle font-sans text-caption font-semibold text-ink"
            >Admin</span
          >
        </span>
        @if (token()) {
          <button
            type="button"
            class="flex items-center gap-1.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-alert"
            (click)="logout()"
          >
            <sd-icon name="log-out" [size]="18" />Sign out
          </button>
        }
      </header>

      @if (!token()) {
        <!-- Login -->
        <div
          class="mx-auto mt-10 w-full max-w-md rounded-card border border-cloud bg-white p-8 shadow-[0_4px_24px_rgba(10,22,40,0.06)]"
        >
          <h1 class="font-heading text-h4 text-ink">Admin sign in</h1>
          <p class="mt-1 font-sans text-body-sm text-slate">
            Staff account with specialist management access.
          </p>
          <form class="mt-6 flex flex-col gap-4" (submit)="login($event)">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Email</span>
              <input
                type="email"
                autocomplete="username"
                [value]="email()"
                (input)="email.set($any($event.target).value)"
                placeholder="admin@videomed.test"
                class="rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
              />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Password</span>
              <input
                type="password"
                autocomplete="current-password"
                [value]="password()"
                (input)="password.set($any($event.target).value)"
                placeholder="Enter your password"
                class="rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
              />
            </label>
            @if (loginError()) {
              <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">
                {{ loginError() }}
              </p>
            }
            <button
              type="submit"
              class="mt-2 flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
              [disabled]="busy()"
            >
              {{ busy() ? 'Signing in…' : 'Sign in' }}
            </button>
          </form>
        </div>
      } @else {
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Specialists</h1>
          <p class="font-sans text-body text-slate">
            Edit contact email, fee and availability.
          </p>
        </div>

        @if (loading()) {
          <div class="h-40 animate-pulse rounded-card border border-cloud bg-white/60"></div>
        } @else if (listError()) {
          <div
            class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center"
          >
            <sd-icon name="wifi-off" [size]="32" class="text-alert" />
            <p class="font-sans text-body-sm text-slate">{{ listError() }}</p>
          </div>
        } @else {
          <ul class="flex flex-col gap-3">
            @for (s of specialists(); track s.id) {
              <li class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex flex-col">
                    <span class="font-heading text-body font-semibold text-ink">{{ s.name }}</span>
                    <span class="font-sans text-caption text-cerulean">{{ s.specialty }}</span>
                  </div>
                  <div class="flex items-center gap-3">
                    @if (s.saved) {
                      <span class="flex items-center gap-1 font-sans text-caption text-sage">
                        <sd-icon name="circle-check" [size]="16" />Saved
                      </span>
                    }
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-field bg-cerulean px-4 py-2 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
                      [disabled]="s.saving"
                      (click)="save(s.id)"
                    >
                      {{ s.saving ? 'Saving…' : 'Save' }}
                    </button>
                  </div>
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-slate">Contact email</span>
                    <input
                      type="email"
                      [value]="s.email"
                      (input)="setField(s.id, 'email', $any($event.target).value)"
                      placeholder="doctor@example.com"
                      class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                    />
                  </label>
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold text-slate">Consultation fee (₦)</span>
                    <input
                      type="number"
                      min="0"
                      step="500"
                      [value]="s.consultation_fee"
                      (input)="setField(s.id, 'consultation_fee', $any($event.target).value)"
                      class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
                    />
                  </label>
                </div>

                <label class="flex flex-col gap-1.5">
                  <span class="font-sans text-caption font-semibold text-slate">Photo URL</span>
                  <div class="flex items-center gap-3">
                    @if (photoSrc(s.photo_url); as src) {
                      <img
                        [src]="src"
                        [alt]="s.name"
                        class="size-10 shrink-0 rounded-full border border-cloud object-cover"
                      />
                    } @else {
                      <span
                        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-sans text-caption font-semibold text-cerulean"
                        >{{ initials(s.name) }}</span
                      >
                    }
                    <input
                      type="url"
                      [value]="s.photo_url"
                      (input)="setField(s.id, 'photo_url', $any($event.target).value)"
                      placeholder="https://… or /uploads/…"
                      class="w-full rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                    />
                  </div>
                </label>

                <div class="flex flex-wrap items-center gap-6">
                  <label class="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      class="size-4 accent-cerulean"
                      [checked]="s.available"
                      (change)="setField(s.id, 'available', $any($event.target).checked)"
                    />
                    <span class="font-sans text-body-sm text-ink">Available for booking</span>
                  </label>
                  <label class="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      class="size-4 accent-cerulean"
                      [checked]="s.verified"
                      (change)="setField(s.id, 'verified', $any($event.target).checked)"
                    />
                    <span class="font-sans text-body-sm text-ink">Verified</span>
                  </label>
                </div>

                @if (s.error) {
                  <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">
                    {{ s.error }}
                  </p>
                }
              </li>
            }
          </ul>
        }
      }
    </div>
  `,
})
export class AdminSpecialists implements OnInit {
  protected readonly token = signal<string | null>(this.readToken());
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly loginError = signal('');

  protected readonly loading = signal(false);
  protected readonly listError = signal('');
  protected readonly specialists = signal<AdminSpecialist[]>([]);

  private readonly base = environment.apiBaseUrl.replace(/\/+$/, '');

  ngOnInit(): void {
    if (this.token()) void this.load();
  }

  protected async login(event: Event): Promise<void> {
    event.preventDefault();
    this.loginError.set('');
    this.busy.set(true);
    try {
      const res = await fetch(`${this.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.email().trim(),
          password: this.password(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        this.loginError.set(body?.message ?? 'Invalid email or password');
        return;
      }
      const access: string | undefined = body?.data?.access_token;
      const perms: string[] = body?.data?.user?.permissions ?? [];
      if (!access) {
        this.loginError.set('Sign in failed. Please try again.');
        return;
      }
      if (!perms.includes('specialists.manage')) {
        this.loginError.set('This account lacks specialist-management access.');
        return;
      }
      this.storeToken(access);
      this.token.set(access);
      this.password.set('');
      await this.load();
    } catch {
      this.loginError.set('Could not reach the server. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.listError.set('');
    try {
      const res = await fetch(`${this.base}/api/specialists`, {
        headers: { Authorization: `Bearer ${this.token()}` },
      });
      if (res.status === 401) {
        this.logout();
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        this.listError.set(body?.message ?? 'Could not load specialists.');
        return;
      }
      this.specialists.set(
        (body?.data ?? []).map(
          (s: Record<string, unknown>): AdminSpecialist => ({
            id: String(s['id']),
            name: String(s['name'] ?? ''),
            specialty: String(s['specialty'] ?? ''),
            email: String(s['email'] ?? ''),
            consultation_fee: String(s['consultation_fee'] ?? ''),
            photo_url: String(s['photo_url'] ?? ''),
            available: Boolean(s['available']),
            verified: Boolean(s['verified']),
            saving: false,
            saved: false,
            error: '',
          }),
        ),
      );
    } catch {
      this.listError.set('Could not reach the server. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }

  protected setField(
    id: string,
    key: 'email' | 'consultation_fee' | 'photo_url' | 'available' | 'verified',
    value: string | boolean,
  ): void {
    this.specialists.update((list) =>
      list.map((s) =>
        s.id === id ? { ...s, [key]: value, saved: false, error: '' } : s,
      ),
    );
  }

  private patch(id: string, patch: Partial<AdminSpecialist>): void {
    this.specialists.update((list) =>
      list.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }

  protected async save(id: string): Promise<void> {
    const row = this.specialists().find((s) => s.id === id);
    if (!row) return;
    this.patch(id, { saving: true, error: '', saved: false });
    try {
      const res = await fetch(`${this.base}/api/specialists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token()}`,
        },
        body: JSON.stringify({
          email: row.email.trim(),
          consultation_fee: row.consultation_fee,
          photo_url: row.photo_url.trim(),
          available: row.available,
          verified: row.verified,
        }),
      });
      if (res.status === 401) {
        this.logout();
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const fieldError =
          body?.errors && typeof body.errors === 'object'
            ? Object.values(body.errors)[0]
            : null;
        this.patch(id, {
          saving: false,
          error: (fieldError as string) ?? body?.message ?? 'Could not save.',
        });
        return;
      }
      const data = body?.data ?? {};
      this.patch(id, {
        saving: false,
        saved: true,
        email: String(data.email ?? row.email),
        consultation_fee: String(data.consultation_fee ?? row.consultation_fee),
        photo_url: String(data.photo_url ?? row.photo_url ?? ''),
      });
    } catch {
      this.patch(id, { saving: false, error: 'Could not reach the server.' });
    }
  }

  /** Resolve a relative /uploads photo path to an absolute URL for preview. */
  protected photoSrc(url: string): string | null {
    const v = url.trim();
    if (v === '') return null;
    if (/^https?:\/\//.test(v)) return v;
    return `${this.base}/${v.replace(/^\/+/, '')}`;
  }

  /** Initials fallback when a specialist has no photo. */
  protected initials(name: string): string {
    return name
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }

  protected logout(): void {
    this.clearToken();
    this.token.set(null);
    this.specialists.set([]);
  }

  private readToken(): string | null {
    try {
      return localStorage.getItem(ADMIN_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private storeToken(token: string): void {
    try {
      localStorage.setItem(ADMIN_TOKEN_KEY, token);
    } catch {
      /* keep the in-memory session */
    }
  }

  private clearToken(): void {
    try {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch {
      /* no-op */
    }
  }
}
