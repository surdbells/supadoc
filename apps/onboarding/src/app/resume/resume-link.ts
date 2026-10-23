import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DoctorApplicationsApi } from '@supadoc/data-access';
import { LogoComponent } from '@supadoc/ui';
import { firstValueFrom } from 'rxjs';
import { Announcer } from '../core/announcer';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { bannerMessage } from '../core/errors';
import { Notices } from '../core/notices';
import { stepUrl } from '../core/wizard-steps';

export const LINK_INVALID =
  'This link has expired or was replaced by a newer one. Enter your email and draft code instead.';

/** The resume-link token from `#t=…` (never sent in a URL to the server). */
export function tokenFromHash(hash: string): string | null {
  const match = /(?:^#|&)t=([A-Za-z0-9_-]{20,200})(?:&|$)/.exec(hash);
  return match ? match[1] : null;
}

/**
 * /resume#t={token}: the link in the resume email. The fragment is removed
 * from the address bar before anything else, exchanged by POST, and the
 * applicant lands on the first unfinished step.
 */
@Component({
  selector: 'onb-resume-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LogoComponent],
  template: `
    <main class="flex min-h-dvh flex-col items-center justify-center gap-6 bg-snow px-4" aria-busy="true">
      <sd-logo [size]="48" />
      <h1 class="font-sans text-h4 text-ink">Resuming your application</h1>
      <div class="flex w-full max-w-sm flex-col gap-3" aria-hidden="true">
        <div class="sd-shimmer h-4 w-3/4 rounded-md"></div>
        <div class="sd-shimmer h-4 w-full rounded-md"></div>
        <div class="sd-shimmer h-4 w-2/3 rounded-md"></div>
      </div>
    </main>
  `,
})
export class OnbResumeLink {
  private readonly doc = inject(DOCUMENT);
  private readonly api = inject(DoctorApplicationsApi);
  private readonly store = inject(ApplicationDraftStore);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);
  private readonly announcer = inject(Announcer);

  constructor() {
    const token = tokenFromHash(this.doc.defaultView?.location.hash ?? '');
    // Strip the token from the address bar (and history) before the request.
    this.doc.defaultView?.history.replaceState(null, '', '/resume');
    this.announcer.announce('Resuming your application');
    void this.resume(token);
  }

  private async resume(token: string | null): Promise<void> {
    if (!token) return this.fail(LINK_INVALID);
    try {
      const res = await firstValueFrom(this.api.resumeWithLink(token));
      this.store.adopt(res.data.draft_token, res.data.draft);
      await this.router.navigateByUrl(stepUrl(res.data.draft.next_step), { replaceUrl: true });
    } catch (err) {
      this.fail(bannerMessage(err, LINK_INVALID));
    }
  }

  private fail(message: string): void {
    this.notices.set('resume', message);
    void this.router.navigateByUrl('/?dialog=resume', { replaceUrl: true });
  }
}
