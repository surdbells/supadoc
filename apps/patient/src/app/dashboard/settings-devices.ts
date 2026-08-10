import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PatientApi } from '@supadoc/data-access';
import type { SessionDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/**
 * Settings › Privacy & Security › Connected Device (Figma 1034:45955). Lists the
 * patient's real signed-in devices (GET /portal/me/sessions); a non-current
 * device can be removed (its session is revoked).
 */
@Component({
  selector: 'pat-settings-devices',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, ButtonComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Connected Device</h1>
          <p class="font-sans text-body text-slate">{{ subtitle() }}</p>
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
            Could not load your devices.
          </p>
          <sd-button size="sm" (click)="load()">Try Again</sd-button>
        </div>
      } @else {
        <div class="flex flex-col gap-4">
          @for (d of sessions(); track d.id) {
            <div
              class="flex items-center gap-4 rounded-card border border-cloud bg-white p-5"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost/60 text-cerulean"
              >
                <sd-icon [name]="d.icon" [size]="22" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-sans text-body font-semibold text-ink">{{
                    d.device
                  }}</span>
                  @if (d.current) {
                    <span
                      class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
                      >This device</span
                    >
                  }
                </div>
                <span class="font-sans text-caption text-slate">{{
                  d.current ? 'Currently active' : 'Signed in ' + when(d.created_at)
                }}</span>
              </div>
              @if (!d.current) {
                <button
                  type="button"
                  class="shrink-0 font-sans text-body-sm font-medium text-alert transition-colors hover:brightness-95 disabled:opacity-50"
                  [disabled]="revokingId() === d.id"
                  (click)="revoke(d.id)"
                >
                  {{ revokingId() === d.id ? 'Removing…' : 'Remove' }}
                </button>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class SettingsDevices implements OnInit {
  private readonly patient = inject(PatientApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly sessions = signal<SessionDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly revokingId = signal('');

  protected readonly subtitle = computed(() => {
    const n = this.sessions().length;
    return n === 1 ? '1 device signed in.' : `${n} devices signed in.`;
  });

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
      /* leave the device listed on failure */
    } finally {
      this.revokingId.set('');
    }
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
