import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { DoctorStandingStore } from './doctor-standing.store';
import { SECTION_LABELS, ymdLabel } from './standing-rules';

const LINK_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim transition hover:bg-ocean hover:shadow-btn-hover disabled:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2';
const LINK_OUTLINE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-haze bg-white px-5 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

/**
 * Account status (route `/account-status`): where a doctor who may not do
 * clinical work lands — from the standing guard, or when a request is refused
 * mid-session — instead of a page of errors. Says why (the suspension's reason,
 * the onboarding stage, the terms to accept), what still works, and the next
 * step. `?page=schedule` names the page they tried to open.
 */
@Component({
  selector: 'doc-account-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AlertComponent, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-3xl flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 #headingEl tabindex="-1" class="font-heading text-h3 text-ink outline-none">{{ heading() }}</h1>
        @if (blockedPage(); as page) {
          <p class="font-sans text-body text-slate">
            You tried to open {{ page }}, which
            {{ code() === 'doctor_suspended' ? 'is closed while your account is suspended' : 'opens once your profile is approved' }}.
          </p>
        }
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-48 rounded-card" aria-hidden="true"></div>
        <span class="sr-only" role="status">Loading your account status…</span>
      } @else {
        @if (failed()) {
          <!-- Couldn't be read: never claim good standing on a failed load. -->
          <sd-alert tone="warning">
            <span class="block">
              {{ code() ? "We couldn't refresh your account status, so this may be out of date." : "We couldn't load your account status. Check your connection and try again." }}
            </span>
            <sd-button class="mt-2 inline-block" variant="outline" size="sm" (click)="reload()">
              <sd-icon name="refresh-cw" [size]="16" />Try again
            </sd-button>
          </sd-alert>
        }
        @switch (code()) {
          @case ('doctor_suspended') {
            @let s = data()?.suspension;
            <section class="flex flex-col gap-4 rounded-card border border-alert/30 bg-white p-5 shadow-card sm:p-6" aria-labelledby="why-title">
              <div class="flex items-start gap-3">
                <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-alert/10 text-alert-ink">
                  <sd-icon name="ban" [size]="22" />
                </span>
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="why-title" class="font-heading text-body-lg text-ink">Why your account is suspended</h2>
                  <p class="font-sans text-body-sm text-slate">
                    {{ s?.suspended_at ? 'Since ' + date(s?.suspended_at) + '.' : '' }} Patients can't find or book you while it is suspended.
                  </p>
                </div>
              </div>
              <dl class="flex flex-col divide-y divide-cloud rounded-field border border-cloud">
                <div class="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
                  <dt class="w-32 shrink-0 font-sans text-caption font-semibold text-slate">Reason</dt>
                  <dd class="font-sans text-body-sm text-ink">{{ s?.code_label || 'Suspended by VideoMed' }}</dd>
                </div>
                @if (s?.reason) {
                  <div class="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
                    <dt class="w-32 shrink-0 font-sans text-caption font-semibold text-slate">Details</dt>
                    <dd class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ s?.reason }}</dd>
                  </div>
                }
              </dl>
            </section>

            <section class="flex flex-col gap-3 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6" aria-labelledby="means-title">
              <h2 id="means-title" class="font-heading text-body-lg text-ink">What this means</h2>
              <ul class="flex flex-col gap-2 font-sans text-body-sm text-ink">
                <li class="flex items-start gap-2"><sd-icon name="calendar-off" [size]="18" class="mt-0.5 shrink-0 text-slate" />Your upcoming consultations were cancelled and the patients refunded and told.</li>
                <li class="flex items-start gap-2"><sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0 text-slate" />Consultations, calls, patient records, prescriptions and availability are closed.</li>
                <li class="flex items-start gap-2"><sd-icon name="wallet" [size]="18" class="mt-0.5 shrink-0 text-slate" />New payout requests are paused. Your earnings and payout history stay here.</li>
              </ul>
            </section>

            <section class="flex flex-col gap-4 rounded-card bg-frost/60 p-5 sm:p-6" aria-labelledby="next-title">
              <h2 id="next-title" class="font-heading text-body-lg text-ink">What to do next</h2>
              @if (s?.code === 'licence_expired') {
                <p class="font-sans text-body-sm text-ink">
                  Upload your renewed annual practising licence. Once a reviewer has verified it, they can reinstate your account.
                  Consultations that were cancelled are not restored — patients can book you again once you're reinstated.
                </p>
                <div class="flex flex-wrap gap-3">
                  <a routerLink="/onboarding/credentials" class="${LINK_PRIMARY}"><sd-icon name="upload" [size]="18" />Upload renewed licence</a>
                  <a routerLink="/earnings" class="${LINK_OUTLINE}"><sd-icon name="banknote" [size]="18" />Earnings</a>
                </div>
              } @else {
                <p class="font-sans text-body-sm text-ink">
                  If you believe this is a mistake, or to discuss reinstatement, contact VideoMed support. Reinstatement needs a current,
                  verified practising licence, so keep your documents up to date.
                </p>
                <div class="flex flex-wrap gap-3">
                  <a routerLink="/onboarding/credentials" class="${LINK_PRIMARY}"><sd-icon name="file-check" [size]="18" />Your documents</a>
                  <a routerLink="/earnings" class="${LINK_OUTLINE}"><sd-icon name="banknote" [size]="18" />Earnings</a>
                  <a routerLink="/payouts" class="${LINK_OUTLINE}"><sd-icon name="wallet" [size]="18" />Payout history</a>
                </div>
              }
            </section>
          }

          @case ('doctor_not_approved') {
            @let d = data();
            <section class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6" aria-labelledby="setup-title">
              <div class="flex items-start gap-3">
                <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean-dark">
                  <sd-icon [name]="d?.status === 'pending_review' ? 'hourglass' : 'list-checks'" [size]="22" />
                </span>
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="setup-title" class="font-heading text-body-lg text-ink">{{ setupTitle() }}</h2>
                  <p class="font-sans text-body-sm text-slate">{{ setupText() }}</p>
                </div>
              </div>
              @if (d?.status === 'rejected' && d?.rejection_reason) {
                <sd-alert tone="warning">
                  <span class="block font-semibold">What to change</span>
                  <span class="mt-1 block whitespace-pre-line break-words text-ink">{{ d?.rejection_reason }}</span>
                </sd-alert>
              }
              <p class="font-sans text-body-sm text-slate">
                Meanwhile you can set up your profile, signature, availability, payout account and documents.
              </p>
              <div class="flex flex-wrap gap-3">
                <a routerLink="/onboarding" class="${LINK_PRIMARY}"><sd-icon name="list-checks" [size]="18" />{{ d?.status === 'pending_review' ? 'View your checklist' : 'Continue setup' }}</a>
              </div>
            </section>
          }

          @case ('terms_required') {
            <section class="flex flex-col gap-4 rounded-card border border-warning/30 bg-white p-5 shadow-card sm:p-6" aria-labelledby="terms-title">
              <div class="flex items-start gap-3">
                <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning-ink">
                  <sd-icon name="scroll-text" [size]="22" />
                </span>
                <div class="flex min-w-0 flex-col gap-1">
                  <h2 id="terms-title" class="font-heading text-body-lg text-ink">Practitioner terms to accept</h2>
                  <p class="font-sans text-body-sm text-slate">
                    You can read your schedule and records, but you can't join calls or write clinical records until you accept
                    version {{ data()?.terms?.current_version }}.
                  </p>
                </div>
              </div>
              <div class="flex flex-wrap gap-3">
                <a routerLink="/onboarding/terms" class="${LINK_PRIMARY}"><sd-icon name="scroll-text" [size]="18" />Read and accept</a>
              </div>
            </section>
          }

          @default {
            @if (!failed()) {
              <section class="flex flex-col items-start gap-4 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6">
                <p class="flex items-start gap-2 font-sans text-body-sm text-ink">
                  <sd-icon name="circle-check" [size]="20" class="mt-0.5 shrink-0 text-sage" />
                  Your account is in good standing — every part of the portal is open to you.
                </p>
                <a routerLink="/dashboard" class="${LINK_PRIMARY}">Go to your dashboard</a>
              </section>
            }
          }
        }
      }
    </div>
  `,
})
export class DoctorAccountStatus implements OnInit {
  private readonly store = inject(DoctorStandingStore);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  private readonly headingEl = viewChild<ElementRef<HTMLElement>>('headingEl');

  protected readonly loading = signal(true);
  /** The fresh read failed (network / 5xx): the standing shown, if any, may be stale. */
  protected readonly failed = signal(false);
  protected readonly data = this.store.onboarding;
  protected readonly code = this.store.code;
  /** `?page=` — live, as a second redirect here can name another page. */
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private readonly page = computed(() => this.query().get('page') ?? '');

  /** The closed page they tried to open, e.g. "your schedule" ('' when none, or it is open to them). */
  protected readonly blockedPage = computed(() => (this.store.blocked() ? (SECTION_LABELS[this.page()] ?? '') : ''));
  protected readonly heading = computed(() => {
    switch (this.code()) {
      case 'doctor_suspended':
        return 'Your account is suspended';
      case 'doctor_not_approved':
        return 'Clinical tools open once you are approved';
      case 'terms_required':
        return this.data()?.terms?.accepted_version ? 'Accept the updated practitioner terms' : 'Accept the practitioner terms';
      default:
        return 'Account status';
    }
  });
  protected readonly setupTitle = computed(() => {
    switch (this.data()?.status) {
      case 'pending_review':
        return 'Your profile is being reviewed';
      case 'rejected':
        return 'Your profile needs a few changes';
      default:
        return 'Finish setting up your profile';
    }
  });
  protected readonly setupText = computed(() => {
    const d = this.data();
    switch (d?.status) {
      case 'pending_review':
        return "Our team is checking your profile and documents. We'll email you as soon as it's approved.";
      case 'rejected':
        return 'A reviewer sent your profile back. Make the changes below, then submit it again.';
      default:
        return d
          ? `${d.completed} of ${d.total} steps done. Complete your checklist, then submit it for review.`
          : 'Complete your checklist, then submit it for review.';
    }
  });

  ngOnInit(): void {
    this.reload();
  }

  /** Always fresh here: the doctor may just have been reinstated (or suspended). */
  protected reload(): void {
    this.loading.set(true);
    this.failed.set(false);
    void this.store.load(true).then((data) => {
      this.failed.set(data === null);
      this.loading.set(false);
      afterNextRender(() => this.headingEl()?.nativeElement.focus(), { injector: this.injector });
    });
  }

  protected date(iso: string | null | undefined): string {
    if (!iso) return '';
    return iso.length === 10
      ? ymdLabel(iso)
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }
}
