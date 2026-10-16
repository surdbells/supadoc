import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { apiErrorMessage, PatientApi } from '@supadoc/data-access';
import type { SessionDto } from '@supadoc/models';
import { ButtonComponent, DialogService, IconComponent } from '@supadoc/ui';
import { afterDialogsClose } from '../dialog-helpers';
import { askSignOut, askSignOutDevice } from './sign-out';

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
          <h1 #pageTitle tabindex="-1" class="font-heading text-h3 text-ink outline-none">Login Activity</h1>
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
            {{ error() }}
          </p>
          <sd-button size="sm" (click)="load()">Try Again</sd-button>
        </div>
      } @else {
        <div class="flex flex-col gap-4">
          @for (s of sessions(); track s.id) {
            <div
              class="flex items-center gap-4 rounded-card border border-haze bg-white p-5 shadow-card"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean-dark"
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
                      class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage-ink"
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
                  (click)="revoke(s)"
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
  private readonly dialogs = inject(DialogService);
  private readonly injector = inject(Injector);
  private readonly pageTitle = viewChild<ElementRef<HTMLElement>>('pageTitle');

  protected readonly sessions = signal<SessionDto[]>([]);
  protected readonly loading = signal(true);
  /** Why the session list failed to load ('' when it didn't). */
  protected readonly error = signal('');
  protected readonly revokingId = signal('');

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.patient
      .sessions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.sessions.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, 'Could not load your sessions.'));
          this.loading.set(false);
        },
      });
  }

  /**
   * Asked first; the dialog shows the request's progress and why it failed, if
   * it did. The signed-out row's button is gone, so focus lands on the heading.
   */
  protected async revoke(s: SessionDto): Promise<void> {
    if (this.revokingId()) return;
    const signedOut = await askSignOutDevice(
      this.dialogs,
      s.device,
      async () => {
        this.revokingId.set(s.id);
        try {
          await firstValueFrom(this.patient.revokeSession(s.id));
          this.sessions.update((list) => list.filter((x) => x.id !== s.id));
        } finally {
          this.revokingId.set('');
        }
      },
      'Could not sign out that device.',
    );
    if (signedOut) afterDialogsClose(this.dialogs, this.injector, () => this.pageTitle()?.nativeElement.focus());
  }

  protected async signOutCurrent(): Promise<void> {
    if (!(await askSignOut(this.dialogs))) return;
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
