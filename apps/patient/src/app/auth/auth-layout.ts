import { Location } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { IconComponent, LogoComponent } from '@supadoc/ui';

interface AuthSlide {
  image: string;
  title: string;
  description: string;
}

const SLIDE_INTERVAL_MS = 6000;

/**
 * Boxed split shell for the web auth flow (VideoMed): the onboarding carousel on
 * the left (lg+) and the routed auth screen on the right.
 *
 * The slide artwork is exported from Figma with the headline, copy and progress
 * indicator already composited in, so each image is shown whole (the panel keeps
 * the artwork's aspect ratio so nothing is cropped). Transparent buttons sit over
 * the painted indicator so it stays clickable, and each image carries its copy as
 * alt text for screen readers.
 */
@Component({
  selector: 'pat-auth-layout',
  imports: [RouterOutlet, RouterLink, LogoComponent, IconComponent],
  template: `
    <div
      class="flex min-h-screen items-center justify-center bg-cloud p-4 sm:p-6"
    >
      <div
        class="grid w-full max-w-[1240px] overflow-hidden rounded-[32px] bg-glacier shadow-[0_12px_40px_rgba(10,22,40,0.1)] ring-1 ring-white/60 lg:min-h-[766px] lg:grid-cols-[minmax(0,540px)_minmax(0,700px)]"
      >
        <aside class="hidden p-5 lg:block">
          <div
            class="relative aspect-[1400/2033] w-full overflow-hidden rounded-[24px]"
          >
            <!-- Sliding track: one panel-width slide each. -->
            <div
              class="flex size-full transition-transform duration-700 ease-out motion-reduce:transition-none"
              [style.transform]="'translateX(-' + current() * 100 + '%)'"
            >
              @for (slide of slides; track $index) {
                <img
                  [src]="slide.image"
                  [alt]="slide.title + ' ' + slide.description"
                  class="size-full shrink-0 object-cover"
                />
              }
            </div>

            <!-- Hit areas over the indicator painted into the artwork. -->
            <div
              class="absolute bottom-[2.6%] left-[65%] right-[4.2%] flex h-[2.4%] items-center gap-[2.5%]"
            >
              <button
                type="button"
                class="h-full flex-1 cursor-pointer"
                aria-label="Show slide 1"
                [attr.aria-current]="current() === 0 ? 'true' : null"
                (click)="select(0)"
              ></button>
              <button
                type="button"
                class="h-full flex-1 cursor-pointer"
                aria-label="Show slide 2"
                [attr.aria-current]="current() === 1 ? 'true' : null"
                (click)="select(1)"
              ></button>
              <button
                type="button"
                class="h-full flex-1 cursor-pointer"
                aria-label="Show slide 3"
                [attr.aria-current]="current() === 2 ? 'true' : null"
                (click)="select(2)"
              ></button>
              <button
                type="button"
                class="h-full flex-1 cursor-pointer"
                aria-label="Show slide 4"
                [attr.aria-current]="current() === 3 ? 'true' : null"
                (click)="select(3)"
              ></button>
            </div>
          </div>
        </aside>

        <main class="flex flex-col px-6 py-6 sm:px-10">
          <header class="flex items-center justify-between">
            <a routerLink="/" aria-label="Go to VideoMed home">
              <sd-logo [size]="44" />
            </a>
            <button
              type="button"
              class="inline-flex items-center gap-2 font-sans text-body text-ink transition-colors hover:text-cerulean"
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
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * In-app navigations since this shell mounted. `location.back()` is only safe
   * when there's an in-app entry to return to; otherwise (fresh deep-link into
   * an auth page, or a guard redirect) we fall back to Home so Back never dead-ends.
   */
  private navigations = 0;

  /** Artwork exported from the VideoMed Figma (headline + copy composited in). */
  protected readonly slides: AuthSlide[] = [
    {
      image: '/auth-slide-1.webp',
      title: "Healthcare shouldn't take your entire day.",
      description:
        'Book an appointment, speak with a licensed doctor online, and receive medical guidance without spending hours in crowded waiting rooms.',
    },
    {
      image: '/auth-slide-2.webp',
      title: 'Get expert care, wherever you are.',
      description:
        "Distance, traffic, or a busy schedule shouldn't stop you from seeing a doctor. Connect securely from home, work, or while traveling.",
    },
    {
      image: '/auth-slide-3.webp',
      title: 'Your healthcare, all in one place.',
      description:
        'Keep track of appointments, prescriptions, consultation history, and follow up care without juggling paperwork or multiple clinics.',
    },
    {
      image: '/auth-slide-4.webp',
      title: 'Trusted care when it matters most.',
      description:
        'Connect with qualified healthcare professionals who are ready to listen, guide, and support you through every stage of your healthcare journey.',
    },
  ];

  protected readonly current = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.start();
    this.destroyRef.onDestroy(() => this.stop());

    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.navigations++);
  }

  protected back(): void {
    // Go back only when we've moved within the app while on the auth screens;
    // otherwise land on Home rather than leaving the site or dead-ending.
    if (this.navigations > 1) {
      this.location.back();
    } else {
      void this.router.navigateByUrl('/');
    }
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
