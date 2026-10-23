import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { LicenceRoute } from '@supadoc/models';
import { AlertComponent, DialogService, IconComponent } from '@supadoc/ui';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { Announcer } from '../core/announcer';
import { apiErrorCode, bannerMessage, DRAFT_ENDED } from '../core/errors';
import { NOTICE, Notices } from '../core/notices';
import { stepUrl } from '../core/wizard-steps';
import { RadioCardComponent } from '../shared/radio-card';
import { StepShellComponent } from '../shared/step-shell';
import { ONB_WIDTH, onbButton } from '../shared/ui-classes';

export const LICENCE_CHOICE_SUBTITLE =
  "This decides which licence details and documents we ask for. Licensed in more than one country? Choose the licence you'll practise under with VideoMed.";

/** /apply, "Where are you licensed?" (Figma App 1–3): Nigeria or Abroad, before Step 1. */
@Component({
  selector: 'onb-licence-choice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, IconComponent, RadioCardComponent, StepShellComponent],
  template: `
    <onb-step-shell
      width="choice"
      [step]="null"
      heading="Where are you licensed?"
      [subtitle]="subtitle"
      [centred]="true"
      (back)="back()"
    >
      <fieldset class="mt-8 flex min-w-0 flex-col gap-4 min-[900px]:mt-10" [attr.aria-describedby]="error() ? 'onb-route-error' : null">
        <legend class="sr-only">Where are you licensed?</legend>
        <onb-radio-card
          name="licence-route"
          value="ng"
          title="Nigeria"
          description="I am registered with the Medical and Dental Council of Nigeria (MDCN)"
          [checked]="choice() === 'ng'"
          (picked)="pick('ng')"
        >
          <svg cardIcon width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="0" y="0" width="6.67" height="20" fill="#009933" />
            <rect x="6.67" y="0" width="6.66" height="20" fill="#FFFFFF" />
            <rect x="13.33" y="0" width="6.67" height="20" fill="#009933" />
          </svg>
        </onb-radio-card>
        <onb-radio-card
          name="licence-route"
          value="abroad"
          title="Abroad"
          description="I am licensed by a medical regulator outside Nigeria"
          [checked]="choice() === 'abroad'"
          (picked)="pick('abroad')"
        >
          <sd-icon cardIcon name="globe" [size]="20" [strokeWidth]="1.5" />
        </onb-radio-card>
      </fieldset>
      @if (error()) {
        <p id="onb-route-error" role="alert" class="mt-2 font-label text-caption text-alert">{{ error() }}</p>
      }
      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      <div class="mt-10 flex justify-center min-[900px]:mt-[126px]">
        <button
          type="button"
          [class]="continueClass()"
          [attr.aria-disabled]="!choice() || null"
          [attr.aria-busy]="busy() || null"
          (click)="next()"
        >
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="20" class="animate-spin" />
          }
          Continue
          <sd-icon name="arrow-right" [size]="24" [strokeWidth]="1.5" />
        </button>
      </div>
    </onb-step-shell>
  `,
})
export class OnbLicenceChoice {
  private readonly store = inject(ApplicationDraftStore);
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  private readonly announcer = inject(Announcer);
  private readonly notices = inject(Notices);

  protected readonly subtitle = LICENCE_CHOICE_SUBTITLE;
  protected readonly choice = signal<LicenceRoute | null>(this.store.hasRoute() ? this.store.route() : null);
  protected readonly error = signal<string | null>(null);
  protected readonly banner = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly continueClass = computed(() => `${onbButton('primary', !this.choice())} ${ONB_WIDTH[311]}`);

  constructor() {
    // A resumed draft that came back here: know its route.
    if (this.store.hasToken()) {
      void this.store.ensureLoaded().then((d) => {
        if (d && !this.choice()) this.choice.set(d.licence_route);
      }, () => undefined);
    }
  }

  protected pick(route: LicenceRoute): void {
    this.choice.set(route);
    this.error.set(null);
  }

  protected back(): void {
    void this.router.navigateByUrl('/');
  }

  protected async next(): Promise<void> {
    if (this.busy()) return;
    const route = this.choice();
    if (!route) {
      this.error.set('Choose where you are licensed.');
      document.querySelector<HTMLInputElement>('input[name="licence-route"]')?.focus();
      this.announcer.announce('Choose where you are licensed.');
      return;
    }
    // A resumed draft whose load (started in the constructor) has not finished:
    // wait for it, or the route change would skip the confirm and the PATCH.
    if (this.store.hasToken() && !this.store.draft()) {
      this.busy.set(true);
      this.banner.set(null);
      try {
        await this.store.ensureLoaded(); // null when the token turned out to be no longer valid
      } catch (err) {
        this.banner.set(bannerMessage(err, "We couldn't load your application. Please try again."));
        return;
      } finally {
        this.busy.set(false);
      }
    }
    const draft = this.store.draft();
    if (draft && draft.licence_route !== route) {
      const answer = await this.dialogs.confirm({
        title: 'Change where you are licensed?',
        message: "Changing where you're licensed clears your licence details and certificate. Continue?",
        tone: 'warning',
        confirmLabel: 'Change',
        cancelLabel: 'Keep my answer',
      });
      if (!answer.confirmed) return;
    }
    this.busy.set(true);
    this.banner.set(null);
    try {
      await this.store.chooseRoute(route);
      await this.router.navigateByUrl(stepUrl('personal'));
    } catch (err) {
      if (DRAFT_ENDED.has(apiErrorCode(err) ?? '')) {
        this.notices.set('resume', NOTICE.sessionEnded);
        await this.router.navigateByUrl('/?dialog=resume');
        return;
      }
      this.banner.set(bannerMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
