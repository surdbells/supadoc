import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent } from '@supadoc/ui';
import { Announcer } from '../core/announcer';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { formatPhone } from '../core/format';
import { TrackStore } from '../core/track.store';
import { StepShellComponent } from '../shared/step-shell';
import { ONB_TEXT_BUTTON, ONB_WIDTH, onbButton } from '../shared/ui-classes';

/** /apply/submitted (Figma App 23): the reference, Copy reference, what happens next. Memory only. */
@Component({
  selector: 'onb-submitted',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, StepShellComponent],
  template: `
    <onb-step-shell headerAction="check-status" heading="Application Submitted" [centred]="true" announcement="Application submitted">
      <span stepBadge class="mx-auto mb-4 inline-flex size-20 items-center justify-center rounded-full bg-sage/10 text-sage" aria-hidden="true">
        <sd-icon name="circle-check-big" [size]="44" [strokeWidth]="1.25" />
      </span>
      <div stepIntro class="flex flex-col items-center">
        <p class="mx-auto mt-2 max-w-[560px] font-sans text-body-sm text-slate">
          Thank you. We've sent a confirmation to {{ submission()?.email }} and a text to {{ phone() }}.
        </p>
      </div>

      <div class="mx-auto mt-6 flex w-full max-w-[654px] flex-col gap-6">
        <section class="flex flex-col items-center gap-1 rounded-field border border-haze bg-snow p-4 text-center" aria-labelledby="onb-ref-label">
          <p id="onb-ref-label" class="font-sans text-caption text-slate">Your reference number</p>
          <p class="font-sans text-[18px] font-medium leading-7 tracking-[0.06em] text-abyss">{{ submission()?.reference }}</p>
          <button type="button" [class]="copyClass" (click)="copy()">
            <sd-icon [name]="copied() ? 'check' : 'copy'" [size]="16" [strokeWidth]="1.5" />
            {{ copied() ? 'Copied' : 'Copy reference' }}
          </button>
          <p class="font-sans text-caption text-slate">
            Keep this safe. You'll need it, plus your email or phone number, to check your status.
          </p>
        </section>

        <section class="rounded-field border border-haze bg-snow px-6 py-4" aria-labelledby="onb-next-label">
          <h2 id="onb-next-label" class="font-sans text-caption font-semibold text-slate">What happens next:</h2>
          <ul class="mt-2 flex flex-col gap-3">
            @for (item of next; track item.lead) {
              <li class="flex items-start gap-2 font-sans text-body-sm text-slate">
                <sd-icon name="check-check" [size]="20" [strokeWidth]="1.5" class="mt-0.5 shrink-0 text-sage" />
                <span><strong class="font-semibold text-ink">{{ item.lead }}</strong> {{ item.text }}</span>
              </li>
            }
          </ul>
        </section>
      </div>

      <div class="mt-10 flex flex-col-reverse gap-3 min-[900px]:mt-20 min-[900px]:flex-row min-[900px]:justify-center min-[900px]:gap-6">
        <button type="button" [class]="homeClass" (click)="home()">Back to home</button>
        <button type="button" [class]="trackClass" (click)="track()">Track my application</button>
      </div>
    </onb-step-shell>
  `,
})
export class OnbSubmitted {
  private readonly store = inject(ApplicationDraftStore);
  private readonly trackStore = inject(TrackStore);
  private readonly router = inject(Router);
  private readonly announcer = inject(Announcer);

  protected readonly submission = this.store.submission;
  protected readonly phone = computed(() => formatPhone(this.submission()?.phone));
  protected readonly copied = signal(false);
  protected readonly copyClass = `${ONB_TEXT_BUTTON} mt-1 h-10 px-2 text-body-sm`;
  protected readonly homeClass = `${onbButton('neutral')} ${ONB_WIDTH[250]}`;
  protected readonly trackClass = `${onbButton('primary')} ${ONB_WIDTH[250]}`;
  protected readonly next = [
    { lead: 'We review.', text: 'Our team verifies your licence, qualifications and documents.' },
    { lead: 'We keep you posted.', text: "You'll get an email and SMS whenever your status changes." },
    { lead: 'Decision.', text: "If you're approved, we'll guide you through setting up your profile." },
  ];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  protected async copy(): Promise<void> {
    const ref = this.submission()?.reference;
    if (!ref) return;
    try {
      await navigator.clipboard.writeText(ref);
    } catch {
      return; // clipboard blocked: the reference is on screen to copy by hand
    }
    this.copied.set(true);
    this.announcer.announce('Reference copied');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.copied.set(false), 2000);
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
  }

  protected track(): void {
    this.trackStore.prefill(this.submission()?.reference);
    void this.router.navigateByUrl('/?dialog=track');
  }
}
