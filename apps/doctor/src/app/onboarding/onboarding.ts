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
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorOnboardingDto, OnboardingItemKey } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';

interface ChecklistItem {
  readonly key: OnboardingItemKey;
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
  readonly link: string;
}

/** The steps, in order, and where each one is completed. */
const ITEMS: readonly ChecklistItem[] = [
  { key: 'photo', label: 'Profile photo', hint: 'A clear, professional headshot patients will see.', icon: 'camera', link: '/profile' },
  { key: 'bio', label: 'About you', hint: 'A short bio for your public profile.', icon: 'file-text', link: '/profile' },
  { key: 'qualifications', label: 'Qualifications', hint: 'Your degrees and specialist training.', icon: 'graduation-cap', link: '/profile' },
  { key: 'mdcn', label: 'MDCN registration number', hint: 'Printed on every prescription you send.', icon: 'id-card', link: '/profile' },
  { key: 'signature', label: 'Signature', hint: 'Used to sign your prescriptions.', icon: 'signature', link: '/profile' },
  { key: 'availability', label: 'Availability', hint: 'Weekly hours or open slots patients can book.', icon: 'calendar-clock', link: '/availability' },
  { key: 'payout', label: 'Payout account', hint: 'Where your consultation earnings are paid.', icon: 'wallet', link: '/payouts' },
];

/**
 * First-login onboarding (route `/onboarding`): the checklist a new doctor works
 * through (each step links to the page where it's done), progress, "Submit for
 * review", and the review outcome. Profile, availability, payouts and settings
 * stay reachable throughout — nothing is hard-blocked.
 */
@Component({
  selector: 'doc-onboarding',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AlertComponent, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-3xl flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Get set up on VideoMed</h1>
        <p class="font-sans text-body text-slate">
          Complete each step, then submit your profile for review. Patients can find and book you once it's approved.
        </p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-16 rounded-card"></div>
        <div class="sd-shimmer h-96 rounded-card"></div>
      } @else if (loadError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
          <sd-button variant="outline" size="sm" (click)="load()">
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </sd-button>
        </div>
      } @else if (data(); as d) {
        <!-- Where the review stands -->
        @switch (d.status) {
          @case ('pending_review') {
            <sd-alert tone="info">
              <span class="font-semibold">Your profile is with our team for review.</span>
              We'll email you as soon as it's approved{{ d.submitted_at ? ' (submitted ' + date(d.submitted_at) + ')' : '' }}. You can keep updating your details in the meantime.
            </sd-alert>
          }
          @case ('rejected') {
            <sd-alert tone="warning">
              <span class="block font-semibold">Your profile needs a few changes before it can be approved.</span>
              @if (d.rejection_reason) {
                <span class="mt-1 block whitespace-pre-line break-words text-ink">{{ d.rejection_reason }}</span>
              }
              <span class="mt-1 block">Make the changes below, then submit your profile again.</span>
            </sd-alert>
          }
          @case ('approved') {
            <sd-alert tone="success">
              <span class="font-semibold">You're approved.</span>
              Patients can now find you in the directory and book the times you've made available.
              <a routerLink="/dashboard" class="font-semibold underline">Go to your dashboard</a>
            </sd-alert>
          }
          @case ('suspended') {
            <sd-alert tone="error">
              Your account is suspended, so patients can't book you. Please contact support.
            </sd-alert>
          }
        }

        <section class="flex flex-col rounded-card border border-cloud bg-white">
          <div class="flex flex-col gap-3 border-b border-cloud px-4 py-4 sm:px-5">
            <div class="flex items-center justify-between gap-3">
              <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink">
                <sd-icon name="list-checks" [size]="20" class="text-cerulean" />Your checklist
              </h2>
              <span class="shrink-0 font-sans text-body-sm font-semibold text-slate">{{ d.completed }} of {{ d.total }} done</span>
            </div>
            <div
              class="h-2 w-full overflow-hidden rounded-pill bg-cloud"
              role="progressbar"
              aria-label="Onboarding progress"
              [attr.aria-valuenow]="d.completed"
              aria-valuemin="0"
              [attr.aria-valuemax]="d.total"
            >
              <div class="h-full rounded-pill bg-sage transition-[width] duration-500" [style.width.%]="percent()"></div>
            </div>
          </div>

          <ul class="flex flex-col divide-y divide-cloud">
            @for (item of items; track item.key) {
              @let done = d.checklist[item.key];
              <li class="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-full"
                  [class]="done ? 'bg-sage/15 text-sage' : 'bg-frost text-cerulean'"
                >
                  <sd-icon [name]="done ? 'circle-check' : item.icon" [size]="20" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ item.label }}</span>
                  <span class="font-sans text-caption text-slate">{{ item.hint }}</span>
                </div>
                @if (done) {
                  <a
                    [routerLink]="item.link"
                    class="shrink-0 rounded-field px-2 py-1.5 font-sans text-caption font-semibold text-slate transition-colors hover:text-cerulean"
                    [attr.aria-label]="'Edit ' + item.label"
                    >Edit</a
                  >
                } @else {
                  <a
                    [routerLink]="item.link"
                    class="flex shrink-0 items-center gap-1 rounded-field border border-cloud px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean"
                    [attr.aria-label]="'Add ' + item.label"
                    >Add <sd-icon name="chevron-right" [size]="14"
                  /></a>
                }
              </li>
            }
          </ul>
        </section>

        @if (canSubmit()) {
          <section class="flex flex-col gap-4 rounded-card bg-frost/60 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div class="flex items-start gap-3">
              <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-white text-cerulean shadow-sm">
                <sd-icon name="send" [size]="20" />
              </span>
              <div class="flex min-w-0 flex-col">
                <p class="font-heading text-body-lg text-ink">
                  {{ d.status === 'rejected' ? 'Submit your changes' : 'Ready when you are' }}
                </p>
                <p class="font-sans text-body-sm text-slate">
                  {{ d.complete ? 'An admin will review your profile, usually within a few working days.' : 'Complete every step above to submit your profile for review.' }}
                </p>
              </div>
            </div>
            <sd-button class="shrink-0" [disabled]="!d.complete || submitting()" (click)="submit()">
              {{ submitting() ? 'Submitting…' : 'Submit for review' }}
            </sd-button>
          </section>
        }
        @if (submitError()) {
          <sd-alert tone="error">{{ submitError() }}</sd-alert>
        }
      }
    </div>
  `,
})
export class DoctorOnboarding implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = ITEMS;
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly data = signal<DoctorOnboardingDto | null>(null);
  protected readonly submitting = signal(false);
  protected readonly submitError = signal('');

  protected readonly percent = computed(() => {
    const d = this.data();
    return d && d.total > 0 ? Math.round((d.completed / d.total) * 100) : 0;
  });
  /** Submitting is for a profile still being set up, or one sent back. */
  protected readonly canSubmit = computed(() => {
    const s = this.data()?.status;
    return s === 'invited' || s === 'rejected';
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .onboarding()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load your onboarding checklist.'));
          this.loading.set(false);
        },
      });
  }

  protected submit(): void {
    this.submitting.set(true);
    this.submitError.set('');
    this.api
      .submitOnboarding()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.submitting.set(false);
        },
        error: (err: unknown) => {
          this.submitError.set(apiErrorMessage(err, 'Could not submit your profile. Please try again.'));
          this.submitting.set(false);
        },
      });
  }

  protected date(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
}
