import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DoctorApplicationsApi } from '@supadoc/data-access';
import type { ApplicationStatusDto } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { firstValueFrom } from 'rxjs';
import { Announcer } from '../core/announcer';
import { bannerMessage, errorStatus } from '../core/errors';
import { buildInterviewIcs, downloadIcs } from '../core/ics';
import { NOTICE, Notices } from '../core/notices';
import { OnboardingConfigStore } from '../core/onboarding-config.store';
import { TrackStore } from '../core/track.store';
import { CancelDialogComponent, type WithdrawChoice } from '../shared/cancel-dialog';
import { StatusTimelineComponent } from '../shared/status-timeline';
import { StepShellComponent } from '../shared/step-shell';
import { ONB_PILL, ONB_WIDTH, onbButton } from '../shared/ui-classes';
import { interviewLabel } from './interview';

/** /status (Figma App 24 and its six states): the timeline, what to do now, and withdraw. */
@Component({
  selector: 'onb-status-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, CancelDialogComponent, IconComponent, RouterLink, StatusTimelineComponent, StepShellComponent],
  template: `
    <onb-step-shell headerAction="none" titleSpacing="status" heading="Application status" [subtitle]="subtitle()">
      @if (notice()) {
        <sd-alert tone="success" class="mt-6">{{ notice() }}</sd-alert>
      }
      @if (moved()) {
        <sd-alert tone="info" class="mt-6">{{ moved() }}</sd-alert>
      }
      @if (loading()) {
        <div class="mt-10 flex flex-col gap-4" aria-busy="true" aria-label="Loading your status">
          @for (i of [1, 2, 3, 4]; track i) {
            <div class="sd-shimmer h-6 w-2/3 rounded-md"></div>
          }
        </div>
      } @else if (loadError()) {
        <sd-alert tone="error" class="mt-8">
          {{ loadError() }}
          <button type="button" class="ml-1 font-medium underline underline-offset-2" (click)="load()">Try again</button>
        </sd-alert>
      } @else if (status(); as s) {
        <div class="mt-8 min-[900px]:mt-10">
          <onb-status-timeline [rows]="s.timeline">
            @switch (s.status) {
              @case ('more_info_needed') {
                @if (s.info_request; as req) {
                  <div class="mt-2 flex flex-col gap-2">
                    <p class="whitespace-pre-line rounded-lg bg-snow p-3 font-sans text-body-sm text-ink">{{ req.message }}</p>
                    <ul class="list-disc pl-5 font-sans text-caption text-slate">
                      @for (item of req.items; track item.key + item.label) {
                        <li>{{ item.label }}</li>
                      }
                    </ul>
                    <div><a routerLink="/status/respond" [class]="pill.primary">Send requested items</a></div>
                  </div>
                }
              }
              @case ('interview_scheduled') {
                @if (s.interview; as iv) {
                  <div class="mt-2 flex flex-col gap-2">
                    <p class="font-sans text-body-sm font-medium text-ink">{{ when() }}</p>
                    @if (iv.note) {
                      <p class="whitespace-pre-line font-sans text-caption text-slate">{{ iv.note }}</p>
                    }
                    <div class="flex flex-wrap gap-3">
                      <a [href]="iv.meeting_url" target="_blank" rel="noopener noreferrer" [class]="pill.primary">
                        <sd-icon name="video" [size]="16" [strokeWidth]="1.5" />
                        Join interview
                      </a>
                      <button type="button" [class]="pill.neutral" (click)="addToCalendar()">
                        <sd-icon name="calendar" [size]="16" [strokeWidth]="1.5" />
                        Add to calendar
                      </button>
                    </div>
                    <p class="font-sans text-caption text-slate">Meeting link host: {{ iv.meeting_host }}</p>
                  </div>
                }
              }
              @case ('approved') {
                <div class="mt-2 flex flex-col gap-2">
                  @if (s.doctor_portal_url) {
                    <div>
                      <a [href]="portalLogin()" target="_blank" rel="noopener noreferrer" [class]="pill.primary">
                        Set up my profile
                        <sd-icon name="external-link" [size]="14" [strokeWidth]="1.5" />
                        <span class="sr-only">(opens in a new tab)</span>
                      </a>
                    </div>
                  }
                  <p class="font-sans text-caption text-slate">
                    Use the link we emailed to {{ s.email_masked }} to choose your password first. Link expired? Use “Forgot
                    password?” on the sign-in page.
                  </p>
                </div>
              }
              @case ('rejected') {
                <div class="mt-2 flex flex-col gap-2">
                  @if (s.rejection_reason) {
                    <div class="rounded-lg bg-snow p-3">
                      <p class="font-sans text-caption font-semibold text-ink">Reason</p>
                      <p class="mt-1 whitespace-pre-line font-sans text-body-sm text-ink">{{ s.rejection_reason }}</p>
                    </div>
                  }
                  <div>
                    <a [href]="'mailto:' + config().support_email" [class]="pill.neutral">
                      <sd-icon name="mail" [size]="16" [strokeWidth]="1.5" />
                      Contact support
                    </a>
                  </div>
                </div>
              }
            }
          </onb-status-timeline>
        </div>

        @if (s.can_withdraw) {
          <section
            class="mt-10 flex flex-col gap-4 rounded-field border border-haze bg-white px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
            aria-labelledby="onb-withdraw-title"
          >
            <div>
              <h2 id="onb-withdraw-title" class="font-sans text-body font-semibold text-ink">Need to withdraw?</h2>
              <p class="mt-1 font-sans text-body-sm text-slate">
                You can withdraw your application at any time before a decision is made.
              </p>
            </div>
            <button type="button" [class]="withdrawClass" (click)="openWithdraw()">
              <sd-icon name="ban" [size]="20" [strokeWidth]="1.5" />
              Withdraw application
            </button>
          </section>
        }
      }

      <div class="mt-10 flex justify-center min-[900px]:mt-20">
        <button type="button" [class]="homeClass" (click)="home()">Back to home</button>
      </div>
    </onb-step-shell>

    <onb-cancel-dialog
      mode="submitted"
      [open]="withdrawOpen()"
      [statusLabel]="status()?.status_label ?? ''"
      [busy]="withdrawBusy()"
      [error]="withdrawError()"
      (confirm)="withdraw($event)"
      (closed)="withdrawOpen.set(false)"
    />
  `,
})
export class OnbStatusPage {
  private readonly api = inject(DoctorApplicationsApi);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);
  private readonly announcer = inject(Announcer);
  private readonly track = inject(TrackStore);
  private readonly configStore = inject(OnboardingConfigStore);

  protected readonly config = this.configStore.config;
  protected readonly pill = ONB_PILL;
  protected readonly status = signal<ApplicationStatusDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(this.notices.take('status'));
  /** The application moved on while a page was open (a 409): the server's wording, shown above the fresh status. */
  protected readonly moved = signal<string | null>(this.notices.take('status-info'));
  protected readonly withdrawOpen = signal(false);
  protected readonly withdrawBusy = signal(false);
  protected readonly withdrawError = signal<string | null>(null);
  protected readonly homeClass = `${onbButton('primary')} ${ONB_WIDTH[250]}`;
  protected readonly withdrawClass = `${onbButton('outlineAlert')} w-full shrink-0 sm:w-auto`;
  private readonly dialog = viewChild(CancelDialogComponent);

  protected readonly subtitle = computed(() => {
    const s = this.status();
    return s ? `${s.full_name} · Reference ${s.reference}` : '';
  });
  protected readonly when = computed(() => {
    const iv = this.status()?.interview;
    return iv ? interviewLabel(iv.starts_at) : '';
  });
  protected readonly portalLogin = computed(() => {
    const base = this.status()?.doctor_portal_url ?? this.config().doctor_portal_url;
    return `${base.replace(/\/+$/, '')}/auth/login`;
  });

  constructor() {
    void this.configStore.load();
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const res = await firstValueFrom(this.api.status());
      this.status.set(res.data);
    } catch (err) {
      if (errorStatus(err) === 401) {
        this.toTrack();
        return;
      }
      this.loadError.set(bannerMessage(err, "We couldn't load your application status."));
    } finally {
      this.loading.set(false);
    }
  }

  protected addToCalendar(): void {
    const s = this.status();
    const iv = s?.interview;
    if (!s || !iv) return;
    downloadIcs(
      buildInterviewIcs({ startsAtUtc: iv.starts_at, minutes: iv.duration_minutes, url: iv.meeting_url, reference: s.reference }),
    );
  }

  protected openWithdraw(): void {
    this.withdrawError.set(null);
    this.dialog()?.reset();
    this.withdrawOpen.set(true);
  }

  protected async withdraw(choice: WithdrawChoice): Promise<void> {
    this.withdrawBusy.set(true);
    this.withdrawError.set(null);
    try {
      const res = await firstValueFrom(this.api.withdraw({ confirm: true, reason: choice.reason }));
      this.status.set(res.data);
      this.withdrawOpen.set(false);
      this.moved.set(null);
      this.announcer.announce('Your application was withdrawn.');
      void this.load();
    } catch (err) {
      if (errorStatus(err) === 401) {
        this.withdrawOpen.set(false);
        this.toTrack();
        return;
      }
      if (errorStatus(err) === 409) {
        // Decided (or otherwise moved on) since this page loaded: say so and show where it stands now.
        this.withdrawOpen.set(false);
        this.moved.set(bannerMessage(err, 'This application can no longer be withdrawn.'));
        this.announcer.announce(this.moved() ?? '');
        void this.load();
        return;
      }
      this.withdrawError.set(bannerMessage(err, "We couldn't withdraw your application. Please try again."));
    } finally {
      this.withdrawBusy.set(false);
    }
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
  }

  private toTrack(): void {
    this.track.signOut();
    this.notices.set('track', NOTICE.trackSessionEnded);
    void this.router.navigateByUrl('/?dialog=track');
  }
}
