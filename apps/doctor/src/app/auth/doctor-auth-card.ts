import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The centred card the doctor sign-in screens share (sign in, set password,
 * forgot / reset password): VideoMed wordmark + "Doctor" badge, a title, a
 * line of help, then the page's own form projected below.
 */
@Component({
  selector: 'doc-auth-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-h-screen bg-glacier' },
  template: `
    <div class="flex min-h-screen items-center justify-center px-4 py-10">
      <div
        class="w-full max-w-md rounded-card border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.06)] sm:p-8"
      >
        <div class="mb-6 flex items-center gap-2">
          <span class="font-heading text-h4 tracking-tight">
            <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
          </span>
          <span
            class="rounded-pill bg-cerulean/10 px-2.5 py-1 font-sans text-caption font-semibold text-cerulean"
            >Doctor</span
          >
        </div>
        <h1 class="font-heading text-h4 text-ink">{{ heading() }}</h1>
        @if (subtitle()) {
          <p class="mt-1 font-sans text-body-sm text-slate">{{ subtitle() }}</p>
        }
        <ng-content />
      </div>
    </div>
  `,
})
export class DoctorAuthCard {
  readonly heading = input.required<string>();
  readonly subtitle = input('');
}
