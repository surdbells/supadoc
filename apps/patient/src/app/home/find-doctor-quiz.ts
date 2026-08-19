import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  model,
  signal,
  WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { SpecialistCard } from '../dashboard/specialist-card';

interface Issue {
  label: string;
  specialties?: string[];
}
interface BodyArea {
  key: string;
  label: string;
  /** Ranked target specialties for this area (first = strongest). */
  specialties: string[];
  issues: Issue[];
}

type ScoredSpecialist = SpecialistDto & { match: number };

/** Body area → likely specialties + the follow-up "main issue" options. */
const BODY_AREAS: BodyArea[] = [
  {
    key: 'head',
    label: 'Head',
    specialties: ['Neurology', 'Ophthalmology', 'Psychiatry'],
    issues: [
      { label: 'Headache', specialties: ['Neurology'] },
      { label: 'Dizziness', specialties: ['Neurology'] },
      { label: 'Migraine', specialties: ['Neurology'] },
      { label: 'Visual problem', specialties: ['Ophthalmology'] },
      { label: 'Sleep Problem', specialties: ['Psychiatry', 'Neurology'] },
      { label: 'Others' },
    ],
  },
  {
    key: 'chest',
    label: 'Chest',
    specialties: ['Cardiology', 'General Practice'],
    issues: [
      { label: 'Chest pain', specialties: ['Cardiology'] },
      { label: 'Palpitations', specialties: ['Cardiology'] },
      { label: 'Shortness of breath', specialties: ['Cardiology'] },
      { label: 'Cough', specialties: ['General Practice'] },
      { label: 'Others' },
    ],
  },
  {
    key: 'stomach',
    label: 'Stomach',
    specialties: ['General Practice'],
    issues: [
      { label: 'Abdominal pain' },
      { label: 'Nausea' },
      { label: 'Indigestion' },
      { label: 'Diarrhea' },
      { label: 'Others' },
    ],
  },
  {
    key: 'skin',
    label: 'Skin',
    specialties: ['Dermatology'],
    issues: [
      { label: 'Rash' },
      { label: 'Acne' },
      { label: 'Itching' },
      { label: 'Hair loss' },
      { label: 'Others' },
    ],
  },
  {
    key: 'joints',
    label: 'Joints',
    specialties: ['Orthopedics'],
    issues: [
      { label: 'Joint pain' },
      { label: 'Back pain' },
      { label: 'Fracture' },
      { label: 'Stiffness' },
      { label: 'Others' },
    ],
  },
  {
    key: 'mental',
    label: 'Mental Health',
    specialties: ['Psychiatry'],
    issues: [
      { label: 'Anxiety' },
      { label: 'Depression' },
      { label: 'Stress' },
      { label: 'Sleep Problem' },
      { label: 'Others' },
    ],
  },
  {
    key: 'whole',
    label: 'Whole Body',
    specialties: ['General Practice', 'Endocrinology'],
    issues: [
      { label: 'Fatigue' },
      { label: 'Fever' },
      { label: 'Weight change', specialties: ['Endocrinology'] },
      { label: 'Diabetes', specialties: ['Endocrinology'] },
      { label: 'Others' },
    ],
  },
  {
    key: 'notsure',
    label: 'Not Sure',
    specialties: ['General Practice'],
    issues: [{ label: 'General checkup' }, { label: 'Not sure' }],
  },
];

const DURATIONS = ['< 24 hours', '2 - 7 days', '1 - 4 weeks', '1+ month', 'Comes and goes'];
const EXTRA_FLAGS = ['Fever', 'Recent Medication'];

/**
 * "Find me a doctor" guided quiz (Figma). A modal that asks 3–4 quick questions
 * — body area, main issue, duration, extras — then matches the answers to a
 * specialty and scores the public specialists client-side, showing the best
 * matches (or a general-practice fallback / no-match state). Booking reuses the
 * shared specialist card, so a visitor is routed through register as usual.
 */
@Component({
  selector: 'pat-find-doctor-quiz',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SpecialistCard],
  template: `
    @if (open()) {
      <div
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-abyss/40 p-4 backdrop-blur-sm sm:items-center"
        (click)="onBackdrop($event)"
      >
        <div
          class="my-auto w-full max-w-2xl rounded-card border border-frost bg-white p-6 shadow-2xl sm:p-8"
          role="dialog"
          aria-modal="true"
        >
          <!-- Header -->
          <div class="flex items-center justify-between gap-4">
            <span class="flex items-center gap-2 font-heading text-h4 text-cerulean">
              <sd-icon name="sparkles" [size]="24" />Find me a doctor
            </span>
            <div class="flex items-center gap-4">
              @if (canSkip()) {
                <button
                  type="button"
                  class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                  (click)="next()"
                >
                  Skip
                </button>
              }
              <button
                type="button"
                aria-label="Close"
                class="text-slate transition-colors hover:text-ink"
                (click)="close()"
              >
                <sd-icon name="x" [size]="24" />
              </button>
            </div>
          </div>

          <!-- Stepper (during the quiz) -->
          @if (phase() === 'quiz') {
            <div class="mt-6 flex items-center justify-center">
              @for (n of [1, 2, 3, 4]; track n; let last = $last) {
                <span
                  class="flex size-9 shrink-0 items-center justify-center rounded-full font-sans text-body-sm font-semibold"
                  [class]="n < step() ? 'bg-sage text-white' : 'bg-cerulean text-white'"
                >
                  @if (n < step()) {
                    <sd-icon name="check" [size]="18" />
                  } @else {
                    {{ n }}
                  }
                </span>
                @if (!last) {
                  <span
                    class="h-0.5 w-8 shrink-0 sm:w-12"
                    [class]="n < step() ? 'bg-sage' : 'bg-cerulean/30'"
                  ></span>
                }
              }
            </div>
          }

          <!-- ===== Intro ===== -->
          @if (phase() === 'intro') {
            <div class="flex flex-col items-center gap-6 py-6 text-center">
              <span
                class="flex size-28 items-center justify-center rounded-full bg-frost/60 text-cerulean"
              >
                <sd-icon name="stethoscope" [size]="52" />
              </span>
              <h2 class="font-heading text-h3 text-abyss">What's going on?</h2>
              <div class="flex flex-col gap-3 font-sans text-body text-slate">
                <p>Answer 3-4 quick questions and we will match you with the right specialist</p>
                <p>Take 60 seconds. Your answers are private</p>
              </div>
              <div class="mt-2 flex w-full flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  class="w-full rounded-field border border-cloud bg-white px-5 py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
                  (click)="close()"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="flex w-full items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean"
                  (click)="start()"
                >
                  Start <sd-icon name="arrow-right" [size]="18" />
                </button>
              </div>
            </div>
          }

          <!-- ===== Quiz ===== -->
          @if (phase() === 'quiz') {
            <div class="flex flex-col items-center gap-2 pt-6 text-center">
              <h2 class="font-heading text-h3 text-abyss">{{ stepTitle() }}</h2>
              <p class="font-sans text-body text-slate">{{ stepHint() }}</p>
            </div>

            <div class="min-h-[220px] py-6">
              <!-- Step 1: body area (multi) -->
              @if (step() === 1) {
                <div class="mx-auto grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-4">
                  @for (a of bodyAreas; track a.key) {
                    <button
                      type="button"
                      [class]="chipClass(selectedAreaKeys().includes(a.key))"
                      (click)="toggleArea(a.key)"
                    >
                      {{ a.label }}
                    </button>
                  }
                </div>
              }

              <!-- Step 2: main issue (multi) -->
              @if (step() === 2) {
                <div class="mx-auto flex max-w-xl flex-wrap justify-center gap-3">
                  @for (i of availableIssues(); track i.label) {
                    <button
                      type="button"
                      [class]="chipClass(mainIssues().includes(i.label))"
                      (click)="toggle(mainIssues, i.label)"
                    >
                      {{ i.label }}
                    </button>
                  } @empty {
                    <p class="font-sans text-body-sm text-slate">
                      Pick a body area first, or skip this step.
                    </p>
                  }
                </div>
              }

              <!-- Step 3: duration (single) -->
              @if (step() === 3) {
                <div class="mx-auto grid max-w-xl gap-3 sm:grid-cols-2">
                  @for (d of durations; track d) {
                    <button
                      type="button"
                      class="flex items-center gap-3 rounded-field border px-5 py-3 text-left font-sans text-body transition-colors"
                      [class]="
                        duration() === d
                          ? 'border-cerulean bg-frost/30 text-ink'
                          : 'border-cloud text-ink hover:border-cerulean/50'
                      "
                      (click)="duration.set(d)"
                    >
                      <span
                        class="flex size-5 shrink-0 items-center justify-center rounded-full border-2"
                        [class]="duration() === d ? 'border-cerulean' : 'border-cloud'"
                      >
                        @if (duration() === d) {
                          <span class="size-2.5 rounded-full bg-cerulean"></span>
                        }
                      </span>
                      {{ d }}
                    </button>
                  }
                </div>
              }

              <!-- Step 4: extras (optional) -->
              @if (step() === 4) {
                <div class="mx-auto flex max-w-xl flex-col gap-5">
                  <div class="flex flex-wrap justify-center gap-3">
                    @for (f of extraFlags; track f) {
                      <button
                        type="button"
                        [class]="chipClass(flags().includes(f))"
                        (click)="toggle(flags, f)"
                      >
                        {{ f }}
                      </button>
                    }
                  </div>
                  <div class="flex flex-col gap-2">
                    <div class="flex items-center justify-between font-sans text-body">
                      <span class="text-slate">Pain level</span>
                      <span class="font-semibold text-ink">{{ painLevel() }}/10</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      step="1"
                      [value]="painLevel()"
                      (input)="painLevel.set(+$any($event.target).value)"
                      class="w-full accent-cerulean"
                    />
                  </div>
                  <div class="flex flex-col gap-2">
                    <div class="flex items-center justify-between font-sans text-body">
                      <span class="text-slate">Describe in your own words</span>
                      <span class="text-slate">(Optional)</span>
                    </div>
                    <textarea
                      rows="4"
                      maxlength="500"
                      [value]="notes()"
                      (input)="notes.set($any($event.target).value)"
                      placeholder="Tell us more…"
                      class="w-full rounded-card border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                    ></textarea>
                  </div>
                </div>
              }
            </div>

            <p class="flex items-center justify-center gap-2 font-sans text-caption text-slate">
              <sd-icon name="info" [size]="16" class="shrink-0" />
              Your answers are private and used only to match you with a doctor
            </p>

            <div class="mt-6 flex gap-3">
              <button
                type="button"
                class="w-full rounded-field border border-cloud bg-white px-5 py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
                (click)="back()"
              >
                Back
              </button>
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-50"
                [disabled]="!canContinue()"
                (click)="next()"
              >
                Continue <sd-icon name="arrow-right" [size]="18" />
              </button>
            </div>
          }

          <!-- ===== Results ===== -->
          @if (phase() === 'results') {
            @switch (resultState()) {
              @case ('loading') {
                <div class="flex flex-col items-center gap-4 py-16 text-center">
                  <span
                    class="size-10 animate-spin rounded-full border-2 border-cloud border-t-cerulean"
                  ></span>
                  <p class="font-sans text-body text-slate">Finding your best matches…</p>
                </div>
              }
              @case ('results') {
                <div class="pt-4">
                  <h2 class="font-heading text-h3 text-cerulean">
                    We recommend these specialist for you
                  </h2>
                  <p class="mt-1 font-sans text-body-sm text-slate">Based on: {{ summary() }}</p>
                  <div class="mt-5 flex flex-col gap-4">
                    @for (s of top(); track s.id) {
                      <pat-specialist-card [specialist]="s" [matchPercent]="s.match" />
                    }
                  </div>
                  <div
                    class="mt-6 flex flex-wrap items-center justify-center gap-6 border-t border-cloud pt-4"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-1.5 font-sans text-body-sm font-semibold text-cerulean hover:underline"
                      (click)="showReasoning.set(!showReasoning())"
                    >
                      <sd-icon name="info" [size]="16" />Why these recommendation?
                    </button>
                    <button
                      type="button"
                      class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                      (click)="retake()"
                    >
                      Retake this quiz
                    </button>
                  </div>
                  @if (showReasoning()) {
                    <p
                      class="mt-3 rounded-card bg-glacier px-4 py-3 text-center font-sans text-caption text-slate"
                    >
                      Matches are ranked by how closely each specialist's field fits
                      your answers ({{ summary() }}), then by availability and rating.
                    </p>
                  }
                </div>
              }
              @case ('weak') {
                <div class="flex flex-col items-center gap-6 py-6 text-center">
                  <span
                    class="flex size-24 items-center justify-center rounded-full bg-frost/60 text-cerulean"
                  >
                    <sd-icon name="stethoscope" [size]="44" />
                  </span>
                  <h2 class="font-heading text-h3 text-cerulean">
                    We couldn't find a strong match right now
                  </h2>
                  <p class="max-w-md font-sans text-body text-slate">
                    A general practice specialist is a good first step. They can
                    evaluate your symptoms and guide you to the right specialist.
                  </p>
                  <div class="mt-2 flex w-full flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      class="w-full rounded-field border border-cloud bg-white px-5 py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
                      (click)="retake()"
                    >
                      Retake quiz
                    </button>
                    <button
                      type="button"
                      class="w-full rounded-field bg-cerulean px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean"
                      (click)="bookGeneralPractice()"
                    >
                      Book a general practice specialist
                    </button>
                  </div>
                </div>
              }
              @case ('none') {
                <div class="flex flex-col items-center gap-6 py-6 text-center">
                  <span
                    class="flex size-24 items-center justify-center rounded-full bg-frost/60 text-cerulean"
                  >
                    <sd-icon name="search" [size]="44" />
                  </span>
                  <h2 class="font-heading text-h3 text-cerulean">No matches found</h2>
                  <p class="max-w-md font-sans text-body text-slate">
                    Try adjust your answers or retake the quiz
                  </p>
                  <div class="mt-2 flex w-full flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      class="w-full rounded-field border border-cloud bg-white px-5 py-3 font-sans text-body font-semibold text-slate transition-colors hover:bg-glacier"
                      (click)="start()"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      class="w-full rounded-field bg-cerulean px-5 py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-ocean"
                      (click)="retake()"
                    >
                      Retake quiz
                    </button>
                  </div>
                </div>
              }
            }
          }
        </div>
      </div>
    }
  `,
})
export class FindDoctorQuiz {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = model(false);

  protected readonly bodyAreas = BODY_AREAS;
  protected readonly durations = DURATIONS;
  protected readonly extraFlags = EXTRA_FLAGS;

  protected readonly phase = signal<'intro' | 'quiz' | 'results'>('intro');
  protected readonly step = signal(1);

  protected readonly selectedAreaKeys = signal<string[]>([]);
  protected readonly mainIssues = signal<string[]>([]);
  protected readonly duration = signal('');
  protected readonly flags = signal<string[]>([]);
  protected readonly painLevel = signal(1);
  protected readonly notes = signal('');

  protected readonly resultState = signal<'loading' | 'results' | 'weak' | 'none'>(
    'loading',
  );
  protected readonly top = signal<ScoredSpecialist[]>([]);
  protected readonly showReasoning = signal(false);

  protected readonly selectedAreas = computed(() =>
    BODY_AREAS.filter((a) => this.selectedAreaKeys().includes(a.key)),
  );

  /** The union of "main issue" options across the chosen body areas. */
  protected readonly availableIssues = computed<Issue[]>(() => {
    const seen = new Set<string>();
    const out: Issue[] = [];
    for (const a of this.selectedAreas()) {
      for (const iss of a.issues) {
        if (!seen.has(iss.label)) {
          seen.add(iss.label);
          out.push(iss);
        }
      }
    }
    return out;
  });

  protected readonly stepTitle = computed(
    () =>
      ({
        1: 'Where are you having symptoms?',
        2: 'What is the main issue?',
        3: 'How long has this been going on?',
        4: 'Anything else we need to know?',
      })[this.step()] ?? '',
  );
  protected readonly stepHint = computed(
    () =>
      ({
        1: 'Select all that apply',
        2: 'Pick what fits best',
        3: 'Select One',
        4: '(Optional) - Help us narrow it down',
      })[this.step()] ?? '',
  );

  /** Steps 2 and 4 are optional and offer a Skip. */
  protected readonly canSkip = computed(
    () => this.phase() === 'quiz' && (this.step() === 2 || this.step() === 4),
  );

  protected readonly canContinue = computed(() => {
    switch (this.step()) {
      case 1:
        return this.selectedAreaKeys().length > 0;
      case 3:
        return this.duration() !== '';
      default:
        return true;
    }
  });

  protected readonly summary = computed(() => {
    const parts = [
      ...this.selectedAreas().map((a) => a.label),
      ...this.mainIssues(),
    ];
    let s = parts.join('. ');
    const d = this.duration();
    if (d) s += `${s ? '. ' : ''}started ${this.durationPhrase(d)}`;
    return s;
  });

  protected chipClass(active: boolean): string {
    const base =
      'rounded-pill border px-5 py-2.5 font-sans text-body-sm transition-colors';
    return active
      ? `${base} border-cerulean bg-cerulean text-white`
      : `${base} border-cloud text-ink hover:border-cerulean/60`;
  }

  protected toggle(sig: WritableSignal<string[]>, value: string): void {
    sig.update((list) =>
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
  }

  protected toggleArea(key: string): void {
    this.selectedAreaKeys.update((list) =>
      list.includes(key) ? list.filter((v) => v !== key) : [...list, key],
    );
    // Drop any picked issues that no longer belong to the selected areas.
    const valid = new Set(this.availableIssues().map((i) => i.label));
    this.mainIssues.update((list) => list.filter((l) => valid.has(l)));
  }

  protected start(): void {
    this.phase.set('quiz');
    this.step.set(1);
  }

  protected next(): void {
    if (this.step() < 4) {
      this.step.update((s) => s + 1);
    } else {
      this.finish();
    }
  }

  protected back(): void {
    if (this.step() > 1) {
      this.step.update((s) => s - 1);
    } else {
      this.phase.set('intro');
    }
  }

  protected retake(): void {
    this.selectedAreaKeys.set([]);
    this.mainIssues.set([]);
    this.duration.set('');
    this.flags.set([]);
    this.painLevel.set(1);
    this.notes.set('');
    this.top.set([]);
    this.showReasoning.set(false);
    this.phase.set('quiz');
    this.step.set(1);
  }

  protected close(): void {
    this.open.set(false);
    // Reset for next time.
    this.phase.set('intro');
    this.step.set(1);
    this.selectedAreaKeys.set([]);
    this.mainIssues.set([]);
    this.duration.set('');
    this.flags.set([]);
    this.painLevel.set(1);
    this.notes.set('');
    this.top.set([]);
    this.showReasoning.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  protected bookGeneralPractice(): void {
    this.open.set(false);
    void this.router.navigate(['/specialists'], {
      queryParams: { specialty: 'General Practice' },
    });
  }

  private finish(): void {
    this.phase.set('results');
    this.resultState.set('loading');
    this.specialistsApi
      .publicSearch({ limit: 24 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.computeResults(res.data ?? []),
        error: () => this.resultState.set('none'),
      });
  }

  private computeResults(all: SpecialistDto[]): void {
    const weights = this.targetWeights();
    const maxW = Math.max(1, ...weights.values());
    const scored: ScoredSpecialist[] = all
      .map((s) => ({ ...s, match: this.score(s, weights, maxW) }))
      .sort((a, b) => b.match - a.match);

    const strong = scored.filter(
      (s) => (weights.get(s.specialty) ?? 0) > 0 && s.match >= 60,
    );

    if (strong.length > 0) {
      this.top.set(scored.slice(0, 3));
      this.resultState.set('results');
    } else if (scored.some((s) => s.specialty === 'General Practice')) {
      this.resultState.set('weak');
    } else {
      this.resultState.set('none');
    }
  }

  /** specialty → weight, from the selected areas (ranked) and refining issues. */
  private targetWeights(): Map<string, number> {
    const weights = new Map<string, number>();
    const add = (sp: string, n: number) =>
      weights.set(sp, (weights.get(sp) ?? 0) + n);
    for (const a of this.selectedAreas()) {
      a.specialties.forEach((sp, i) => add(sp, Math.max(1, 3 - i)));
    }
    const chosen = this.availableIssues().filter((i) =>
      this.mainIssues().includes(i.label),
    );
    for (const iss of chosen) {
      (iss.specialties ?? []).forEach((sp) => add(sp, 4));
    }
    return weights;
  }

  private score(s: SpecialistDto, weights: Map<string, number>, maxW: number): number {
    const w = weights.get(s.specialty) ?? 0;
    const specialtyMatch = w > 0 ? 45 + (w / maxW) * 35 : 8;
    const availability = s.available ? 12 : 0;
    const rating = (Number(s.rating) / 5) * 8;
    return Math.min(98, Math.round(specialtyMatch + availability + rating));
  }

  private durationPhrase(d: string): string {
    switch (d) {
      case '< 24 hours':
        return 'in the last 24 hours';
      case '2 - 7 days':
        return 'in the last week';
      case '1 - 4 weeks':
        return 'in the last few weeks';
      case '1+ month':
        return 'for over a month';
      case 'Comes and goes':
        return 'on and off';
      default:
        return d;
    }
  }
}
