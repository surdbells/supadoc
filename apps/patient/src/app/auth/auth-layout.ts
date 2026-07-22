import { Location } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IconComponent, LogoComponent } from '@supadoc/ui';

interface AuthSlide {
  image: string;
  title: string;
  description: string;
}

const SLIDE_INTERVAL_MS = 6000;

/**
 * Boxed split shell for the web auth flow (VideoMed): a sliding onboarding
 * carousel on the left (lg+) and the routed auth screen on the right.
 */
@Component({
  selector: 'pat-auth-layout',
  imports: [RouterOutlet, LogoComponent, IconComponent],
  template: `
    <div
      class="flex min-h-screen items-center justify-center bg-cloud p-4 sm:p-6"
    >
      <div
        class="grid w-full max-w-[1400px] overflow-hidden rounded-[32px] bg-glacier shadow-[0_12px_40px_rgba(10,22,40,0.1)] ring-1 ring-white/60 lg:min-h-[760px] lg:grid-cols-[minmax(0,1fr)_minmax(0,700px)]"
      >
        <aside class="hidden p-5 lg:block">
          <div
            class="relative h-full min-h-[640px] overflow-hidden rounded-[24px] bg-abyss"
          >
            <!-- Sliding track: one viewport-width panel per slide. -->
            <div
              class="flex h-full w-full transition-transform duration-700 ease-out motion-reduce:transition-none"
              [style.transform]="'translateX(-' + current() * 100 + '%)'"
            >
              @for (slide of slides; track $index) {
                <div class="relative h-full w-full shrink-0">
                  <img
                    [src]="slide.image"
                    alt=""
                    class="absolute inset-0 size-full object-cover"
                  />
                  <div
                    class="absolute inset-0 bg-gradient-to-b from-abyss/10 via-abyss/25 to-abyss/95"
                  ></div>
                  <div
                    class="absolute inset-x-8 bottom-14 flex flex-col gap-3 text-white"
                  >
                    <h2 class="font-heading text-h3 max-w-md">
                      {{ slide.title }}
                    </h2>
                    <p class="max-w-md text-body text-white/85">
                      {{ slide.description }}
                    </p>
                  </div>
                </div>
              }
            </div>

            <div class="absolute bottom-4 right-8 z-10 flex items-center gap-2">
              <button
                type="button"
                class="cursor-pointer px-0.5 py-2"
                aria-label="Show slide 1"
                [attr.aria-current]="current() === 0 ? 'true' : null"
                (click)="select(0)"
              >
                <span
                  [class]="dot"
                  [style.width.px]="current() === 0 ? 32 : 24"
                  [style.backgroundColor]="
                    current() === 0 ? '#fcfcfc' : 'rgba(252,252,252,0.4)'
                  "
                ></span>
              </button>
              <button
                type="button"
                class="cursor-pointer px-0.5 py-2"
                aria-label="Show slide 2"
                [attr.aria-current]="current() === 1 ? 'true' : null"
                (click)="select(1)"
              >
                <span
                  [class]="dot"
                  [style.width.px]="current() === 1 ? 32 : 24"
                  [style.backgroundColor]="
                    current() === 1 ? '#fcfcfc' : 'rgba(252,252,252,0.4)'
                  "
                ></span>
              </button>
              <button
                type="button"
                class="cursor-pointer px-0.5 py-2"
                aria-label="Show slide 3"
                [attr.aria-current]="current() === 2 ? 'true' : null"
                (click)="select(2)"
              >
                <span
                  [class]="dot"
                  [style.width.px]="current() === 2 ? 32 : 24"
                  [style.backgroundColor]="
                    current() === 2 ? '#fcfcfc' : 'rgba(252,252,252,0.4)'
                  "
                ></span>
              </button>
              <button
                type="button"
                class="cursor-pointer px-0.5 py-2"
                aria-label="Show slide 4"
                [attr.aria-current]="current() === 3 ? 'true' : null"
                (click)="select(3)"
              >
                <span
                  [class]="dot"
                  [style.width.px]="current() === 3 ? 32 : 24"
                  [style.backgroundColor]="
                    current() === 3 ? '#fcfcfc' : 'rgba(252,252,252,0.4)'
                  "
                ></span>
              </button>
            </div>
          </div>
        </aside>

        <main class="flex flex-col px-6 py-6 sm:px-10">
          <header class="flex items-center justify-between">
            <sd-logo [size]="44" />
            <button
              type="button"
              class="inline-flex items-center gap-2 font-sans text-body text-ink hover:text-cerulean"
              (click)="back()"
            >
              <sd-icon name="arrow-right" [size]="20" class="rotate-180" />
              Back
            </button>
          </header>
          <div class="flex flex-1 items-center justify-center py-10">
            <div class="w-full max-w-[440px]">
              <router-outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  `,
})
export class AuthLayout {
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly dot =
    'block h-1.5 rounded-pill transition-all duration-300 motion-reduce:transition-none';

  /**
   * Onboarding carousel. All slides currently share the exported hero image —
   * drop the remaining artwork into `public/` and point each slide at it.
   */
  protected readonly slides: AuthSlide[] = [
    {
      image: '/auth-hero.png',
      title: "Healthcare shouldn't take your entire day.",
      description:
        'Book an appointment, speak with a licensed doctor online, and receive medical guidance without spending hours in crowded waiting rooms.',
    },
    {
      image: '/auth-hero.png',
      title: 'See a licensed doctor in minutes.',
      description:
        'Connect by secure video with verified specialists, whenever and wherever you need care.',
    },
    {
      image: '/auth-hero.png',
      title: 'Your records, always with you.',
      description:
        'Prescriptions, test results and visit notes stay organised in one private place you control.',
    },
    {
      image: '/auth-hero.png',
      title: 'Care that follows up with you.',
      description:
        'Appointment reminders and follow-ups keep your treatment on track long after the consultation ends.',
    },
  ];

  protected readonly current = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.start();
    this.destroyRef.onDestroy(() => this.stop());
  }

  protected back(): void {
    this.location.back();
  }

  protected select(index: number): void {
    this.current.set(index);
    this.restart();
  }

  private reducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    );
  }

  private start(): void {
    if (this.reducedMotion()) return;
    this.timer = setInterval(
      () => this.current.update((i) => (i + 1) % this.slides.length),
      SLIDE_INTERVAL_MS,
    );
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private restart(): void {
    this.stop();
    this.start();
  }
}
