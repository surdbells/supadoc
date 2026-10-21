import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom, type Subscription } from 'rxjs';
import { apiErrorCode, apiErrorMessage, DocumentSharingApi } from '@supadoc/data-access';
import type { DocumentGrantDto, DocumentShareResultDto, RevokeResultDto } from '@supadoc/models';
import { AlertComponent, DialogService, IconComponent } from '@supadoc/ui';
import { AccessHistory } from './access-history';
import { AccessRequestsBanner } from './access-requests-banner';
import { type ApproveOutcome, approveOutcomeLine } from './approve-request-dialog';
import { isSharingUnavailable, shareResultLine, SHARING_UNAVAILABLE } from './document-sharing';
import { type RevokeNotice, SharingDoctorsPanel, type SharingStats } from './sharing-doctors-panel';
import { ShareDialog } from './share-dialog';

type Tab = 'doctors' | 'activity';

/**
 * Manage sharing (`/dashboard/documents/sharing`): which doctors can see the
 * patient's documents and until when, doctors' requests, and the sharing
 * activity — built from the portal's existing patterns (back link + title,
 * the pill section nav, cards). Every stop can be undone for 10 minutes.
 */
@Component({
  selector: 'pat-manage-sharing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AccessHistory,
    AccessRequestsBanner,
    AlertComponent,
    IconComponent,
    RouterLink,
    ShareDialog,
    SharingDoctorsPanel,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/dashboard/documents" class="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-left" [size]="18" />Medical Documents
      </a>

      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Manage sharing</h1>
          <p class="font-sans text-body text-slate">Choose which doctors can see your documents and for how long.</p>
        </div>
        @if (!unavailable()) {
          <div class="flex flex-wrap gap-2">
            <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-field bg-cerulean px-5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="shareOpen.set(true)">
              <sd-icon name="share-2" [size]="18" />Share documents
            </button>
            @if (activeDoctors() > 0) {
              <button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-field border border-alert px-5 font-sans text-body-sm font-semibold text-alert-ink transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="stopping()" (click)="stopAll()">
                <sd-icon name="shield-off" [size]="18" />Stop sharing with everyone
              </button>
            }
          </div>
        }
      </header>

      <!-- Both alerts announce themselves (role="status" / "alert"): no second live region. -->
      @if (undo(); as u) {
        <sd-alert tone="info">
          <span class="flex flex-wrap items-center justify-between gap-2">
            <span>{{ u.text }}</span>
            @if (undoable()) {
              <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field px-2 font-sans text-body-sm font-semibold text-cerulean-dark underline-offset-2 transition-colors hover:underline disabled:opacity-60" [disabled]="restoring()" (click)="restore()">
                <sd-icon name="undo-2" [size]="16" />Undo
              </button>
            }
          </span>
        </sd-alert>
      }
      @if (message(); as m) {
        <sd-alert [tone]="m.ok ? 'success' : 'error'">{{ m.text }}</sd-alert>
      }

      @if (unavailable()) {
        <p class="flex items-start gap-2 rounded-card border border-haze bg-white p-5 font-sans text-body-sm text-slate shadow-card" role="status">
          <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
        </p>
      } @else {
        <pat-access-requests-banner (handled)="answered($event)" />

        <nav aria-label="Sharing sections" class="flex w-full items-center gap-1 rounded-pill border border-haze bg-glacier p-1 shadow-bar sm:w-fit">
          <a
            routerLink="."
            [queryParams]="{ tab: null }"
            queryParamsHandling="merge"
            [attr.aria-current]="tab() === 'doctors' ? 'page' : null"
            class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-pill px-4 py-2 font-sans text-body-sm transition-colors sm:flex-none"
            [class]="tab() === 'doctors' ? activeTab : idleTab"
          >
            <sd-icon name="users" [size]="16" />Doctors
            @if (activeDoctors() > 0) {
              <span class="rounded-pill px-2 py-0.5 font-sans text-caption font-semibold" [class]="tab() === 'doctors' ? 'bg-white/20 text-white' : 'bg-frost text-cerulean-dark'" [attr.aria-label]="activeDoctors() + ' with access'">{{ activeDoctors() }}</span>
            }
          </a>
          <a
            routerLink="."
            [queryParams]="{ tab: 'activity', doctor: null }"
            queryParamsHandling="merge"
            [attr.aria-current]="tab() === 'activity' ? 'page' : null"
            class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-pill px-4 py-2 font-sans text-body-sm transition-colors sm:flex-none"
            [class]="tab() === 'activity' ? activeTab : idleTab"
          >
            <sd-icon name="history" [size]="16" />Activity
          </a>
        </nav>

        @if (tab() === 'doctors') {
          <pat-sharing-doctors-panel
            [focusDoctorId]="focusDoctor()"
            [version]="version()"
            (stats)="onStats($event)"
            (revoked)="onRevoked($event)"
            (notice)="say($event)"
          />
        } @else {
          <pat-access-history [version]="version()" />
        }
      }
    </div>

    @if (shareOpen()) {
      <pat-share-dialog surface="manage_sharing" (done)="shared($event)" (closed)="shareOpen.set(false)" />
    }
  `,
})
export class ManageSharing {
  private readonly route = inject(ActivatedRoute);
  private readonly sharing = inject(DocumentSharingApi);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly banner = viewChild(AccessRequestsBanner);

  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly activeTab = 'bg-cerulean font-medium text-white shadow-control inset-shadow-rim';
  protected readonly idleTab = 'text-slate hover:text-ink';

  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  protected readonly tab = computed<Tab>(() => (this.query().get('tab') === 'activity' ? 'activity' : 'doctors'));
  protected readonly focusDoctor = computed(() => this.query().get('doctor'));

  protected readonly version = signal(0);
  protected readonly activeDoctors = signal(0);
  protected readonly unavailable = signal(false);
  protected readonly shareOpen = signal(false);
  protected readonly stopping = signal(false);
  protected readonly restoring = signal(false);
  protected readonly message = signal<{ ok: boolean; text: string } | null>(null);

  private statsSub?: Subscription;

  /** The last stop, for Undo (while `restorable_until` lasts). */
  protected readonly undo = signal<RevokeNotice | null>(null);
  private readonly clock = signal(Date.now());
  protected readonly undoable = computed(() => {
    const u = this.undo();
    const until = u?.restorableUntil ? Date.parse(u.restorableUntil) : NaN;
    return !!u?.grantId && !isNaN(until) && this.clock() < until;
  });

  constructor() {
    const tick = setInterval(() => this.clock.set(Date.now()), 15_000);
    this.destroyRef.onDestroy(() => clearInterval(tick));
    // The header's count badge and "Stop sharing with everyone" need the
    // doctors' access on every tab: the Doctors panel reports it, so on
    // Activity (opened directly, or after a change there) read it here.
    effect(() => {
      const tab = this.tab();
      this.version();
      if (tab === 'activity') untracked(() => this.loadStats());
    });
  }

  private loadStats(): void {
    this.statsSub?.unsubscribe();
    this.statsSub = this.sharing
      .doctors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) =>
          this.onStats({ activeDoctors: (res.data ?? []).filter((d) => d.access.state !== 'none').length, unavailable: false }),
        error: (err: unknown) => {
          if (isSharingUnavailable(err)) this.onStats({ activeDoctors: 0, unavailable: true });
          // Otherwise keep what is known; the Activity panel shows its own load error.
        },
      });
  }

  protected onStats(s: SharingStats): void {
    this.activeDoctors.set(s.activeDoctors);
    this.unavailable.set(s.unavailable);
  }

  protected say(text: string, ok = true): void {
    this.message.set({ ok, text });
    // A share may have answered a doctor's request.
    if (ok) this.banner()?.reload();
  }

  protected onRevoked(n: RevokeNotice): void {
    this.message.set(null);
    this.undo.set(n);
    this.version.update((v) => v + 1);
  }

  protected shared(result: DocumentShareResultDto | DocumentGrantDto): void {
    this.undo.set(null);
    this.say('outcomes' in result ? shareResultLine(result) : 'Changes saved.');
    this.version.update((v) => v + 1);
  }

  protected answered(outcome: ApproveOutcome): void {
    const line = approveOutcomeLine(outcome);
    if (line) this.say(line);
    this.version.update((v) => v + 1);
  }

  protected async stopAll(): Promise<void> {
    let result: RevokeResultDto | null = null;
    this.stopping.set(true);
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'shield-off',
      title: 'Stop sharing with everyone?',
      message:
        "No doctor will be able to see your documents. Copies they've already downloaded aren't affected. Requests waiting for your answer stay open.",
      confirmLabel: 'Stop sharing with everyone',
      cancelLabel: 'Keep sharing',
      action: async () => {
        result = (await firstValueFrom(this.sharing.revokeAll())).data;
      },
      errorMessage: (err) =>
        isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not stop sharing. Please try again.'),
    });
    this.stopping.set(false);
    if (!confirmed || !result) return;
    const r = result as RevokeResultDto;
    this.onRevoked({
      text: 'Stopped sharing with everyone.',
      grantId: r.revoked[0]?.id ?? null,
      restorableUntil: r.restorable_until,
    });
  }

  protected restore(): void {
    const u = this.undo();
    if (!u?.grantId || this.restoring()) return;
    this.restoring.set(true);
    this.sharing
      .restoreGrant(u.grantId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.restoring.set(false);
          this.undo.set(null);
          const skipped = res.data.skipped_grant_ids.length;
          this.say(skipped > 0 ? `Sharing restored, except ${skipped} that had already ended.` : 'Sharing restored.');
          this.version.update((v) => v + 1);
        },
        error: (err: unknown) => {
          this.restoring.set(false);
          if (apiErrorCode(err) === 'restore_expired') {
            this.undo.set(null);
            this.say('It’s too late to undo that. Share again to give access.', false);
            return;
          }
          // Anything else (offline, a server hiccup): the bar and its Undo stay
          // while the 10 minutes last, so the patient can try again.
          this.say(
            isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not restore sharing. Please try again.'),
            false,
          );
        },
      });
  }
}
