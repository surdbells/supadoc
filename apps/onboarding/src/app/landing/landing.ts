import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertComponent } from '@supadoc/ui';
import { map } from 'rxjs';
import { Notices } from '../core/notices';
import { OnboardingConfigStore } from '../core/onboarding-config.store';
import { LandingChecklistComponent } from './landing-checklist';
import { LandingCtaCardComponent } from './landing-cta-card';
import { LandingFooterComponent } from './landing-footer';
import { LandingHeaderComponent } from './landing-header';
import { LandingHeroComponent } from './landing-hero';
import { LandingWhyComponent } from './landing-why';
import { ResumeDialogComponent } from './resume-dialog';
import { TrackDialogComponent } from './track-dialog';

export type LandingDialog = 'resume' | 'track';

/**
 * "/" — Join VideoMed as a Doctor (Figma Web Landing Page). `?dialog=resume`
 * and `?dialog=track` open the Resume and Track modals; closing one removes
 * the parameter (replacing the history entry).
 */
@Component({
  selector: 'onb-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    LandingChecklistComponent,
    LandingCtaCardComponent,
    LandingFooterComponent,
    LandingHeaderComponent,
    LandingHeroComponent,
    LandingWhyComponent,
    ResumeDialogComponent,
    TrackDialogComponent,
  ],
  host: { class: 'block min-h-dvh bg-snow' },
  template: `
    <onb-landing-header [loginUrl]="loginUrl()" />
    <main>
      @if (notice()) {
        <div class="mx-auto max-w-[1280px] px-4 pt-4 md:px-8 xl:px-0">
          <sd-alert tone="success">{{ notice() }}</sd-alert>
        </div>
      }
      <onb-landing-hero (checkStatus)="openDialog('track')" (resumeApplication)="openDialog('resume')" />
      <onb-landing-why />
      <onb-landing-checklist>
        <onb-landing-cta-card class="-mb-[76px] mt-10 lg:-mt-14" />
      </onb-landing-checklist>
    </main>
    <onb-landing-footer [config]="config()" />

    <onb-resume-dialog [open]="dialog() === 'resume'" (closed)="closeDialog()" />
    <onb-track-dialog [open]="dialog() === 'track'" (closed)="closeDialog()" />
  `,
})
export class OnbLanding {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly configStore = inject(OnboardingConfigStore);
  private readonly notices = inject(Notices);

  protected readonly config = this.configStore.config;
  protected readonly loginUrl = computed(() => `${this.config().doctor_portal_url.replace(/\/+$/, '')}/auth/login`);
  protected readonly dialog = toSignal(
    this.route.queryParamMap.pipe(
      map((p): LandingDialog | null => {
        const d = p.get('dialog');
        return d === 'resume' || d === 'track' ? d : null;
      }),
    ),
    { initialValue: null },
  );
  protected readonly notice = signal<string | null>(this.notices.take('landing'));

  constructor() {
    void this.configStore.load();
  }

  openDialog(which: LandingDialog): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { dialog: which } });
  }

  closeDialog(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { dialog: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
