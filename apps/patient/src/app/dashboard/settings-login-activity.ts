import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { PatientApi } from '@supadoc/data-access';
import type { SessionDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/**
 * Settings › Privacy & Security › Login Activity (Figma 916:18056). Lists the
 * patient's real active sessions (GET /portal/me/sessions); "Sign out" revokes
 * another device, and its token is rejected on its next request.
 */
@Component({
  selector: 'pat-settings-login-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, ButtonComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Login Activity</h1>
          <p class="font-sans text-body text-slate">
            Devices currently signed in to your account.
          </p>
        </div>
        <a
          routerLink="/dashboard/settings/privacy"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @if (loading()) {
        <div class="flex flex-col gap-4">
          @for (n of [1, 2]; track n) {
            <div
              class="h-20 animate-pulse rounded-card border border-cloud bg-cloud/40"
            ></div>
          }
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-4 py-16 text-center">
          <sd-icon name="wifi-off" [size]="36" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">
            Could not load your sessions.
          </p>
          <sd-button size="sm" (click)="load()">Try Again</sd-button>
        </div>
      } @else {
        <div class="flex flex-col gap-4">
          @for (s of sessions(); track s.id) {
            <div
              class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
              >
                <sd-icon [name]="s.icon" [size]="22" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-sans text-body font-semibold text-ink">{{
                    s.device
                  }}</span>
                  @if (s.current) {
                    <span
                      class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
                      >This device</span
                    >
                  }
                </div>
                <div
                  class="flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-caption text-slate"
                >
                  <span class="flex items-center gap-1.5">
                    <sd-icon name="clock" [size]="14" />{{ when(s.created_at) }}
                  </span>
                  @if (s.ip) {
                    <span class="flex items-center gap-1.5">
                      <sd-icon name="map-pin" [size]="14" />{{ s.ip }}
                    </span>
                  }
                </div>
              </div>
              @if (!s.current) {
                <button
                  type="button"
                  class="shrink-0 font-sans text-body-sm font-medium text-alert transition-colors hover:brightness-95 disabled:opacity-50"
                  [disabled]="revokingId() === s.id"
                  (click)="revoke(s.id)"
                >
                  {{ revokingId() === s.id ? 'Signing out…' : 'Sign out' }}
                </button>
              }
            </div>
          }
        </div>

        <div class="flex justify-center pt-2">
          <button
            type="button"
            class="inline-flex w-full max-w-md items-center justify-center rounded-field border border-cloud px-5 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5"
            (click)="signOutCurrent()"
          >
            Sign out of this device
          </button>
        </div>
      }
    </div>
  `,
})
export class SettingsLoginActivity implements OnInit {
  private readonly patient = inject(PatientApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly sessions = signal<SessionDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly revokingId = signal('');

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.patient
      .sessions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.sessions.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }

  protected async revoke(id: string): Promise<void> {
    this.revokingId.set(id);
    try {
      await firstValueFrom(this.patient.revokeSession(id));
      this.sessions.update((list) => list.filter((s) => s.id !== id));
    } catch {
      /* leave the session listed on failure */
    } finally {
      this.revokingId.set('');
    }
  }

  protected async signOutCurrent(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/auth/login');
  }

  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  }
}
