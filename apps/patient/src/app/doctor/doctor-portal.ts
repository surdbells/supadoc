import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  signal,
} from '@angular/core';
import { IconComponent } from '@supadoc/ui';
import { environment } from '../../environments/environment';

interface DoctorAppointment {
  id: string;
  scheduled_at: string;
  status: string;
  status_label: string;
  type_label: string;
  patient_name: string;
  amount: string;
  guests?: { name: string; email: string }[];
  join_url: string;
}

const DOCTOR_TOKEN_KEY = 'videomed.doctor.token';

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-frost text-cerulean',
  cancelled: 'bg-alert/10 text-alert',
};

/**
 * Minimal doctor portal (route `/doctor`) — the "one login per specialist" the
 * flow needs, nothing more. A doctor signs in with their seeded staff account,
 * sees their consultations and jumps into a call via a preauthenticated link.
 *
 * Deliberately self-contained: it talks to the API with `fetch` and its own
 * token key, so it never entangles with the patient app's customer-scoped auth.
 */
@Component({
  selector: 'pat-doctor-portal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block min-h-screen bg-glacier' },
  template: `
    <div class="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-8">
      <!-- Header -->
      <header class="flex items-center justify-between gap-4">
        <span class="font-heading text-h4 tracking-tight">
          <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
          <span class="ml-2 rounded-pill bg-cerulean/10 px-2.5 py-1 align-middle font-sans text-caption font-semibold text-cerulean"
            >Doctor</span
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
          <h1 class="font-heading text-h4 text-ink">Doctor sign in</h1>
          <p class="mt-1 font-sans text-body-sm text-slate">
            Sign in to see your consultations and join calls.
          </p>
          <form class="mt-6 flex flex-col gap-4" (submit)="login($event)">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate"
                >Email</span
              >
              <input
                type="email"
                autocomplete="username"
                [value]="email()"
                (input)="email.set($any($event.target).value)"
                placeholder="you@videomed.test"
                class="rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
              />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate"
                >Password</span
              >
              <input
                type="password"
                autocomplete="current-password"
                [value]="password()"
                (input)="password.set($any($event.target).value)"
                placeholder="Enter your password"
                class="rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
              />
            </label>
            @if (error()) {
              <p
                class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert"
              >
                {{ error() }}
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
        <!-- Schedule -->
        <div class="flex flex-col gap-2">
          <h1 class="font-heading text-h3 text-ink">
            {{ specialistName() || 'My consultations' }}
          </h1>
          <p class="font-sans text-body text-slate">
            {{ appointments().length }} consultation{{
              appointments().length === 1 ? '' : 's'
            }}
          </p>
        </div>

        @if (loading()) {
          <div
            class="h-40 animate-pulse rounded-card border border-cloud bg-white/60"
          ></div>
        } @else if (error()) {
          <div
            class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center"
          >
            <sd-icon name="wifi-off" [size]="32" class="text-alert" />
            <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          </div>
        } @else if (appointments().length === 0) {
          <div
            class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center"
          >
            <sd-icon name="calendar-off" [size]="32" class="text-slate" />
            <p class="font-sans text-body-sm text-slate">
              You have no consultations yet.
            </p>
          </div>
        } @else {
          <ul class="flex flex-col gap-3">
            @for (a of appointments(); track a.id) {
              <li
                class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div class="flex flex-col gap-1">
                  <span class="flex items-center gap-2 font-heading text-body font-semibold text-ink">
                    <sd-icon name="user-round" [size]="18" class="text-cerulean" />
                    {{ a.patient_name }}
                    <span
                      class="rounded-pill px-2.5 py-0.5 font-sans text-[10px] font-semibold"
                      [class]="statusClass(a.status)"
                      >{{ a.status_label }}</span
                    >
                  </span>
                  <span class="flex items-center gap-2 font-sans text-body-sm text-slate">
                    <sd-icon name="calendar-days" [size]="16" />{{ when(a.scheduled_at) }}
                  </span>
                  @if (a.guests && a.guests.length > 0) {
                    <span class="flex items-center gap-2 font-sans text-caption text-slate">
                      <sd-icon name="users" [size]="14" />{{ a.guests.length }} guest{{
                        a.guests.length === 1 ? '' : 's'
                      }}
                    </span>
                  }
                </div>
                <a
                  [href]="a.join_url"
                  class="flex shrink-0 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean"
                >
                  <sd-icon name="video" [size]="18" />Join call
                </a>
              </li>
            }
          </ul>
        }
      }
    </div>
  `,
})
export class DoctorPortal implements OnInit {
  protected readonly token = signal<string | null>(this.readToken());
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly loading = signal(false);
  protected readonly specialistName = signal('');
  protected readonly appointments = signal<DoctorAppointment[]>([]);

  private readonly base = environment.apiBaseUrl.replace(/\/+$/, '');

  ngOnInit(): void {
    if (this.token()) void this.loadSchedule();
  }

  protected async login(event: Event): Promise<void> {
    event.preventDefault();
    this.error.set('');
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
        this.error.set(body?.message ?? 'Invalid email or password');
        return;
      }
      const access: string | undefined = body?.data?.access_token;
      const roles: string[] = body?.data?.user?.roles ?? [];
      if (!access) {
        this.error.set('Sign in failed. Please try again.');
        return;
      }
      if (!roles.includes('doctor')) {
        this.error.set('This account is not a doctor login.');
        return;
      }
      this.storeToken(access);
      this.token.set(access);
      this.password.set('');
      await this.loadSchedule();
    } catch {
      this.error.set('Could not reach the server. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }

  private async loadSchedule(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const res = await fetch(`${this.base}/api/doctor/appointments`, {
        headers: { Authorization: `Bearer ${this.token()}` },
      });
      if (res.status === 401) {
        this.logout();
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        this.error.set(body?.message ?? 'Could not load your consultations.');
        return;
      }
      this.specialistName.set(body?.data?.specialist?.name ?? '');
      this.appointments.set(body?.data?.appointments ?? []);
    } catch {
      this.error.set('Could not reach the server. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }

  protected logout(): void {
    this.clearToken();
    this.token.set(null);
    this.appointments.set([]);
    this.specialistName.set('');
  }

  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }

  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }

  private readToken(): string | null {
    try {
      return localStorage.getItem(DOCTOR_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private storeToken(token: string): void {
    try {
      localStorage.setItem(DOCTOR_TOKEN_KEY, token);
    } catch {
      /* keep the in-memory session */
    }
  }

  private clearToken(): void {
    try {
      localStorage.removeItem(DOCTOR_TOKEN_KEY);
    } catch {
      /* no-op */
    }
  }
}
