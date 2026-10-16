import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { apiErrorFields, apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { PractitionerTermsDto, TermsBlock } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { DoctorStandingStore } from '../standing/doctor-standing.store';

/**
 * The terms text as render-ready parts: a heading or paragraph (`text`), or
 * consecutive list items gathered into one list (`items`).
 */
export interface TermsPart {
  kind: 'h2' | 'h3' | 'p' | 'ul' | 'ol';
  text: string;
  items: string[];
}

/** Group the API's plain blocks for rendering (the h1 is the page title, so it is left out). */
export function termsParts(blocks: readonly TermsBlock[]): TermsPart[] {
  const parts: TermsPart[] = [];
  for (const b of blocks) {
    if (b.type === 'h1') continue;
    if (b.type === 'ul' || b.type === 'ol') {
      const last = parts[parts.length - 1];
      if (last && last.kind === b.type) last.items.push(b.text);
      else parts.push({ kind: b.type, text: '', items: [b.text] });
      continue;
    }
    parts.push({ kind: b.type === 'h2' || b.type === 'h3' ? b.type : 'p', text: b.text, items: [] });
  }
  return parts;
}

/**
 * The practitioner terms (route `/onboarding/terms`): the version in force,
 * read in full (plain text — no HTML is injected), then "I have read and
 * agree" + Accept. Acceptance is recorded with the time and IP. When a new
 * version comes into force the page says so and asks again: until then the
 * doctor starts no new clinical work. Open whatever the doctor's standing.
 */
@Component({
  selector: 'doc-practitioner-terms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AlertComponent, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex max-w-3xl flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <header class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">{{ terms()?.title || 'Practitioner terms' }}</h1>
          @if (terms(); as t) {
            <p class="font-sans text-body text-slate">Version {{ t.version }}</p>
          }
        </header>
        <a [routerLink]="backLink()" class="flex min-h-11 shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="chevron-left" [size]="18" />Back
        </a>
      </div>

      @if (loading()) {
        <div class="sd-shimmer h-[28rem] rounded-card" aria-hidden="true"></div>
        <span class="sr-only" role="status">Loading the practitioner terms…</span>
      } @else if (loadError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-5 py-16 text-center shadow-card">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ loadError() }}</p>
          <sd-button variant="outline" size="sm" (click)="load()"><sd-icon name="refresh-cw" [size]="16" />Try again</sd-button>
        </div>
      } @else if (terms(); as t) {
        <div aria-live="polite">
          @if (t.accepted) {
            <p #statusEl tabindex="-1" class="flex items-start gap-2 rounded-field bg-sage/10 px-4 py-3 font-sans text-body-sm text-sage outline-none">
              <sd-icon name="circle-check" [size]="18" class="mt-0.5 shrink-0" />
              <span><span class="font-semibold">You accepted version {{ t.version }}</span>{{ t.accepted_at ? ' on ' + when(t.accepted_at) : '' }}.</span>
            </p>
          } @else if (t.accepted_version) {
            <sd-alert tone="warning">
              <span class="block font-semibold">The practitioner terms have been updated.</span>
              You accepted version {{ t.accepted_version }}. Read version {{ t.version }} below and accept it to keep consulting — until then you can't join calls or write clinical records.
            </sd-alert>
          } @else {
            <sd-alert tone="info">
              Read the terms below and accept them. You need to accept them before your profile can be approved, and before you start clinical work.
            </sd-alert>
          }
        </div>

        <article
          class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-card border border-haze bg-white p-5 shadow-card sm:p-6"
          tabindex="0"
          [attr.aria-label]="'Practitioner terms, version ' + t.version"
        >
          @for (part of parts(); track $index) {
            @switch (part.kind) {
              @case ('h2') { <h2 class="mt-3 font-heading text-body-lg text-ink first:mt-0">{{ part.text }}</h2> }
              @case ('h3') { <h3 class="mt-2 font-heading text-body font-semibold text-ink">{{ part.text }}</h3> }
              @case ('ul') {
                <ul class="list-disc space-y-1.5 pl-5 font-sans text-body-sm leading-relaxed text-ink">
                  @for (item of part.items; track $index) { <li>{{ item }}</li> }
                </ul>
              }
              @case ('ol') {
                <ol class="list-decimal space-y-1.5 pl-5 font-sans text-body-sm leading-relaxed text-ink">
                  @for (item of part.items; track $index) { <li>{{ item }}</li> }
                </ol>
              }
              @default { <p class="font-sans text-body-sm leading-relaxed text-ink">{{ part.text }}</p> }
            }
          }
        </article>

        @if (!t.accepted) {
          <section class="flex flex-col gap-4 rounded-card bg-frost/60 p-5 sm:p-6" aria-labelledby="accept-title">
            <h2 id="accept-title" class="font-heading text-body-lg text-ink">Accept version {{ t.version }}</h2>
            <label class="flex min-h-11 cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                class="mt-0.5 size-5 shrink-0 cursor-pointer accent-cerulean"
                [checked]="agree()"
                [attr.aria-invalid]="agreeError() ? 'true' : null"
                [attr.aria-describedby]="agreeError() ? 'agree-error' : null"
                (change)="setAgree($any($event.target).checked)"
              />
              <span class="font-sans text-body-sm text-ink">
                I have read and agree to the VideoMed practitioner terms (version {{ t.version }}), and I will keep my MDCN registration and annual practising licence current.
              </span>
            </label>
            @if (agreeError()) {
              <p id="agree-error" class="font-sans text-caption text-alert">{{ agreeError() }}</p>
            }
            @if (acceptError()) {
              <sd-alert tone="error">{{ acceptError() }}</sd-alert>
            }
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p class="font-sans text-caption text-slate">Your acceptance is recorded with the date, time and your IP address.</p>
              <sd-button class="shrink-0" [disabled]="accepting()" (click)="accept()">
                @if (accepting()) {
                  <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Saving…
                } @else {
                  <sd-icon name="check" [size]="18" />Accept terms
                }
              </sd-button>
            </div>
          </section>
        } @else if (justAccepted()) {
          <div class="flex flex-wrap gap-3">
            <a [routerLink]="nextLink()" class="inline-flex min-h-11 items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white shadow-btn inset-shadow-rim transition hover:bg-ocean hover:shadow-btn-hover disabled:shadow-none">
              {{ nextLabel() }}<sd-icon name="arrow-right" [size]="18" />
            </a>
          </div>
        }
      }
    </div>
  `,
})
export class DoctorPractitionerTerms implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly standing = inject(DoctorStandingStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly statusEl = viewChild<ElementRef<HTMLElement>>('statusEl');

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly terms = signal<PractitionerTermsDto | null>(null);
  protected readonly parts = computed(() => termsParts(this.terms()?.blocks ?? []));

  protected readonly agree = signal(false);
  protected readonly agreeError = signal('');
  protected readonly acceptError = signal('');
  protected readonly accepting = signal(false);
  protected readonly justAccepted = signal(false);

  private readonly approved = computed(() => {
    const s = this.standing.onboarding()?.status;
    return s === 'approved' || s === 'suspended';
  });
  protected readonly backLink = computed(() => (this.approved() ? '/dashboard' : '/onboarding'));
  protected readonly nextLink = computed(() => (this.approved() ? '/dashboard' : '/onboarding'));
  protected readonly nextLabel = computed(() => (this.approved() ? 'Go to your dashboard' : 'Back to your checklist'));

  ngOnInit(): void {
    void this.standing.load();
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.api
      .terms()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.terms.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load the practitioner terms.'));
          this.loading.set(false);
        },
      });
  }

  protected setAgree(checked: boolean): void {
    this.agree.set(checked);
    if (checked) this.agreeError.set('');
  }

  protected accept(): void {
    const t = this.terms();
    if (!t || this.accepting()) return;
    this.acceptError.set('');
    if (!this.agree()) {
      this.agreeError.set('Tick the box to confirm you accept the practitioner terms.');
      return;
    }
    this.accepting.set(true);
    this.api
      .acceptTerms(t.version)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.accepting.set(false);
          this.terms.set(res.data);
          this.justAccepted.set(true);
          void this.standing.load(true); // the checklist, the banners and the guard catch up
          afterNextRender(() => this.statusEl()?.nativeElement.focus(), { injector: this.injector });
        },
        error: (err: unknown) => {
          this.accepting.set(false);
          const fields = apiErrorFields(err);
          if (fields['agree']) this.agreeError.set(fields['agree']);
          else this.acceptError.set(apiErrorMessage(err, 'Could not record your acceptance. Please try again.'));
          // A new version came into force while this page was open: show it (the box is unticked again).
          if (fields['version']) {
            this.agree.set(false);
            this.load();
          }
        },
      });
  }

  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }
}
