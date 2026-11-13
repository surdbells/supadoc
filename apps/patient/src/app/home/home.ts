import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '@supadoc/auth';
import {
  isPlainClick,
  portalFrom,
  type PortalKind,
  readPortalHints,
  withoutPortalFrom,
} from '@supadoc/auth/portal';
import {
  ButtonComponent,
  buttonClass,
  IconComponent,
  LogoComponent,
} from '@supadoc/ui';
import { HomeDiscovery } from './home-discovery';
import { ThemeService } from '../theme.service';

interface DashboardLink {
  readonly href: string;
  /** Accessible name (says which portal for staff). */
  readonly label: string;
  /** The patient dashboard (this app) rather than a staff portal (another site). */
  readonly inApp: boolean;
  /** Visible name when the menu lists more than one portal. */
  readonly name?: string;
}

const STAFF_PORTALS: Record<PortalKind, { label: string; name: string }> = {
  doctor: { label: 'Go to Dashboard (doctor portal)', name: 'Doctor portal' },
  admin: { label: 'Go to Dashboard (admin console)', name: 'Admin console' },
};
interface Feature {
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
}
interface Step {
  readonly icon: string;
  readonly n: string;
  readonly title: string;
  readonly desc: string;
}
interface Stat {
  readonly icon: string;
  readonly value: string;
  readonly label: string;
}
interface Doctor {
  readonly photo: string;
  readonly name: string;
  readonly specialty: string;
  readonly location: string;
  readonly rating: string;
  readonly reviews: string;
}

/**
 * VideoMed marketing landing page (Figma 35:285) — the public entry point.
 * Fully responsive: sections stack to a single column on mobile and expand to
 * the designed multi-column layouts from `md`/`lg` up. Photos and partner logos
 * are the licensed assets exported from the VideoMed design, served from
 * `public/home/` (the hero and doctor headshots are exported renders/crops).
 */
@Component({
  selector: 'pat-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, LogoComponent, HomeDiscovery],
  template: `
    <div class="min-h-screen bg-white font-sans text-ink">
      <!-- ===== Header ===== -->
      <header
        class="sticky top-0 z-30 border-b border-cloud/70 bg-white/90 backdrop-blur"
      >
        <div
          class="mx-auto flex h-16 w-[90%] max-w-[1800px] items-center justify-between gap-4 md:h-20"
        >
          <sd-logo [size]="32" />

          <nav class="hidden items-center gap-8 lg:flex">
            @for (link of navLinks; track link.label) {
              <a
                [href]="link.href"
                class="font-sans text-body text-ink transition-colors hover:text-cerulean"
                >{{ link.label }}</a
              >
            }
          </nav>

          <div class="hidden items-center gap-3 lg:flex">
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full text-ink transition-colors hover:bg-glacier hover:text-cerulean"
              [attr.aria-label]="isDark() ? 'Switch to light mode' : 'Switch to dark mode'"
              [attr.title]="isDark() ? 'Light mode' : 'Dark mode'"
              (click)="toggleTheme()"
            >
              <sd-icon [name]="isDark() ? 'sun' : 'moon'" [size]="20" />
            </button>
            @if (loggedIn()) {
              <a
                href="/dashboard"
                [class]="dashboardClass"
                aria-label="Go to Dashboard"
                (click)="openDashboard($event, patientDashboard)"
              >
                <sd-icon name="layout-dashboard" [size]="16" />
                Go to Dashboard
              </a>
            } @else {
              <!-- A staff portal signed in on this browser: offered beside, never
                   instead of, the patient's own Sign in / Register. -->
              @if (staffDashboards()[0]; as d) {
                <a
                  [href]="d.href"
                  [class]="staffDashboardClass"
                  [attr.aria-label]="d.label"
                >
                  <sd-icon name="layout-dashboard" [size]="16" />
                  Go to Dashboard
                </a>
              }
              <sd-button variant="outline" size="sm" (click)="go('/auth/login')"
                >Sign in</sd-button
              >
              <sd-button size="sm" (click)="go('/auth/register')"
                >Register</sd-button
              >
            }
          </div>

          <div class="flex items-center gap-1 lg:hidden">
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full text-ink transition-colors hover:bg-glacier hover:text-cerulean"
              [attr.aria-label]="isDark() ? 'Switch to light mode' : 'Switch to dark mode'"
              (click)="toggleTheme()"
            >
              <sd-icon [name]="isDark() ? 'sun' : 'moon'" [size]="22" />
            </button>
            @if (!menuOpen() && dashboard(); as d) {
              <a
                [href]="d.href"
                class="flex size-9 items-center justify-center rounded-full text-ink transition-colors hover:bg-glacier hover:text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                [attr.aria-label]="d.label"
                title="Go to Dashboard"
                (click)="openDashboard($event, d)"
              >
                <sd-icon name="layout-dashboard" [size]="22" />
              </a>
            }
            <button
              type="button"
              class="text-ink"
              [attr.aria-expanded]="menuOpen()"
              aria-label="Toggle menu"
              (click)="menuOpen.set(!menuOpen())"
            >
              <sd-icon [name]="menuOpen() ? 'x' : 'menu'" [size]="24" />
            </button>
          </div>
        </div>

        @if (menuOpen()) {
          <nav
            class="flex flex-col gap-1 border-t border-cloud/70 px-5 py-4 lg:hidden"
          >
            @for (link of navLinks; track link.label) {
              <a
                [href]="link.href"
                class="rounded-lg px-3 py-2 font-sans text-body text-ink hover:bg-glacier"
                (click)="menuOpen.set(false)"
                >{{ link.label }}</a
              >
            }
            @if (!loggedIn() && staffDashboards().length) {
              <div class="mt-2 flex flex-col gap-2">
                @for (d of staffDashboards(); track d.href) {
                  <a
                    [href]="d.href"
                    [class]="staffDashboardFullClass"
                    [attr.aria-label]="d.label"
                  >
                    <sd-icon name="layout-dashboard" [size]="16" />
                    {{
                      staffDashboards().length > 1 ? d.name : 'Go to Dashboard'
                    }}
                  </a>
                }
              </div>
            }
            <div class="mt-2 flex gap-3">
              @if (loggedIn()) {
                <a
                  href="/dashboard"
                  [class]="dashboardFullClass"
                  aria-label="Go to Dashboard"
                  (click)="openDashboard($event, patientDashboard)"
                >
                  <sd-icon name="layout-dashboard" [size]="16" />
                  Go to Dashboard
                </a>
              } @else {
                <sd-button
                  variant="outline"
                  size="sm"
                  [full]="true"
                  (click)="go('/auth/login')"
                  >Sign in</sd-button
                >
                <sd-button size="sm" [full]="true" (click)="go('/auth/register')"
                  >Register</sd-button
                >
              }
            </div>
          </nav>
        }
      </header>

      <!-- ===== Hero ===== -->
      <!-- The search, filter chips and "popular right now" links live inside the
           hero (Figma 1939:34380) via the compact <pat-home-discovery> variant;
           the doctor photo sits to the right with the design's soft corners. -->
      <section class="bg-gradient-to-b from-white via-white to-glacier">
        <div
          class="mx-auto grid w-[90%] max-w-[1800px] items-center gap-x-12 gap-y-8 py-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:py-12"
        >
          <div class="flex min-w-0 flex-col gap-5">
            <span
              class="sd-chip sd-tag mx-auto w-fit bg-frost/60 text-cerulean-dark lg:mx-0"
            >
              <sd-icon name="shield-check" [size]="14" />
              Trusted by thousands of clients
            </span>
            <h1
              class="font-heading text-h1 leading-tight text-abyss break-words text-center lg:text-left"
            >
              Healthcare made
              <span class="text-cerulean">Simple, Personal, &amp; Accessible</span>
            </h1>
            <p class="mx-auto max-w-xl font-sans text-body-lg text-slate text-center lg:mx-0 lg:text-left">
              Experience modern healthcare with secure virtual consultations,
              easy appointment scheduling, digital prescriptions, and continuous
              support — all in one place.
            </p>

            <!-- Hero photo on mobile sits between the copy and the search (Figma);
                 on desktop it moves to the right column below (lg:hidden here). -->
            <img
              src="/home/hero-doctor.webp"
              alt="A VideoMed doctor smiling during a secure online consultation on her laptop"
              width="1160"
              height="1200"
              class="mx-auto mt-1 w-full max-w-md rounded-[28px] object-cover shadow-[0_24px_60px_rgba(10,22,40,0.14)] lg:hidden"
            />

            <!-- Search + filters + popular (compact hero variant) -->
            <pat-home-discovery variant="hero" />

            <div
              class="flex flex-col gap-3 pt-1 sm:flex-row sm:flex-wrap sm:gap-4 [&_button]:w-full sm:[&_button]:w-auto"
            >
              <sd-button (click)="book()">
                <sd-icon name="calendar-days" [size]="18" />
                Book a Consultation
              </sd-button>
              <sd-button variant="outline" (click)="scrollTo('how')">
                <sd-icon name="circle-play" [size]="18" />
                How it Works
              </sd-button>
            </div>
            <ul class="grid grid-cols-2 gap-x-4 gap-y-3 pt-1 sm:flex sm:flex-wrap sm:gap-x-8">
              @for (t of heroTrust; track t.label) {
                <li
                  class="flex items-center gap-2 font-sans text-body-sm text-slate"
                >
                  <sd-icon [name]="t.icon" [size]="16" class="text-teal" />
                  {{ t.label }}
                </li>
              }
            </ul>
          </div>

          <!-- Desktop visual: licensed VideoMed hero photo with the design's
               soft, asymmetric corners (hidden on mobile — shown inline above). -->
          <div class="hidden w-full min-w-0 lg:block">
            <img
              src="/home/hero-doctor.webp"
              alt=""
              aria-hidden="true"
              width="1160"
              height="1200"
              class="aspect-[29/30] w-full rounded-[32px] rounded-tl-[120px] rounded-br-[120px] object-cover shadow-[0_24px_60px_rgba(10,22,40,0.14)]"
            />
          </div>
        </div>
      </section>

      <!-- ===== Trusted by ===== -->
      <section class="border-y border-cloud/60 bg-white">
        <div class="mx-auto w-[90%] max-w-[1800px] py-10">
          <p class="text-center font-sans text-body text-slate">
            Trusted by patients, Partnered with leading organizations.
          </p>
          <div class="mt-6 overflow-x-auto">
            <img
              src="/home/partners-strip.png"
              alt="Trusted partners: Aetna, UnitedHealthcare, BlueCross BlueShield, Cigna, Humana"
              width="1280"
              height="51"
              class="mx-auto h-8 w-auto max-w-none opacity-80 md:h-10"
            />
          </div>
        </div>
      </section>

      <!-- ===== About ===== -->
      <section id="about" class="scroll-mt-20 overflow-hidden bg-frost/40">
        <div
          class="relative mx-auto w-[90%] max-w-[1800px] py-16 lg:py-24"
        >
          <!-- Decorative globe, connectors and photos (lg+) -->
          <div
            class="pointer-events-none absolute inset-0 hidden lg:block"
            aria-hidden="true"
          >
            <svg
              class="absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 text-cerulean/20"
              viewBox="0 0 100 100"
              fill="none"
              stroke="currentColor"
              stroke-width="0.4"
            >
              <circle cx="50" cy="50" r="46" />
              <ellipse cx="50" cy="50" rx="46" ry="18" />
              <ellipse cx="50" cy="50" rx="18" ry="46" />
              <line x1="4" y1="50" x2="96" y2="50" />
            </svg>
            <svg
              class="absolute inset-0 h-full w-full text-slate/40"
              viewBox="0 0 1000 500"
              preserveAspectRatio="none"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-dasharray="3 9"
              stroke-linecap="round"
            >
              <path d="M 230 150 C 350 70, 520 70, 660 130" />
              <path d="M 250 380 C 430 460, 640 460, 830 360" />
            </svg>
            <img
              src="/home/about-thumb1.png"
              alt=""
              class="absolute left-[21%] top-[7%] w-28 rounded-xl shadow-md"
            />
            <img
              src="/home/about-thumb2.png"
              alt=""
              class="absolute right-[21%] top-[9%] w-28 rounded-xl shadow-md"
            />
            <img
              src="/home/about-left.png"
              alt=""
              class="absolute left-[2%] top-[30%] w-44 rounded-2xl shadow-lg"
            />
            <img
              src="/home/about-right.png"
              alt=""
              class="absolute bottom-[8%] right-[2%] w-44 rounded-2xl shadow-lg"
            />
          </div>

          <!-- Centered text -->
          <div
            class="relative mx-auto flex max-w-[600px] flex-col items-center gap-4 text-center"
          >
            <h2 class="font-heading text-h3">
              <span class="text-ink">About </span
              ><span class="text-cerulean">Video</span
              ><span class="text-teal">Med</span>
            </h2>
            <p class="font-heading text-h4 text-abyss">
              Healthcare designed around your life
            </p>
            <p class="font-sans text-body text-slate">
              VideoMed makes it easier to connect with experienced healthcare
              professionals through secure virtual consultation. Whether you
              need a routine check-up, a specialist opinion or on-going care,
              our platform provides convenient access to quality healthcare
              without unnecessary travel.
            </p>
            <sd-button class="mt-2" (click)="scrollTo('how')">
              Learn More About Us
              <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
          </div>
        </div>

        <!-- Photos on mobile (the decorative layer is hidden below lg) -->
        <div class="flex justify-center gap-3 px-5 pb-12 lg:hidden">
          <img
            src="/home/about-left.png"
            alt="Patient consulting a VideoMed doctor from home"
            class="h-28 w-24 rounded-xl object-cover shadow"
          />
          <img
            src="/home/about-thumb1.png"
            alt=""
            class="h-28 w-24 rounded-xl object-cover shadow"
          />
          <img
            src="/home/about-right.png"
            alt="Doctor providing a VideoMed video consultation"
            class="h-28 w-24 rounded-xl object-cover shadow"
          />
        </div>
      </section>

      <!-- ===== Features / Services ===== -->
      <section id="services" class="scroll-mt-20 bg-white">
        <div class="mx-auto w-[90%] max-w-[1800px] py-16">
          <div class="mb-10 flex flex-col items-center gap-2 text-center">
            <h2 class="font-heading text-h3 text-abyss">
              Healthcare that works for you
            </h2>
            <p class="font-sans text-body-lg text-slate">
              Everything you need for a seamless telehealth experience
            </p>
          </div>
          <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            @for (f of features; track f.title) {
              <article
                class="flex flex-col gap-4 rounded-card border-[0.5px] border-ash p-6 transition-shadow hover:shadow-md"
              >
                <span
                  class="flex size-12 items-center justify-center rounded-full bg-cerulean/10 text-cerulean"
                >
                  <sd-icon [name]="f.icon" [size]="24" />
                </span>
                <h3 class="font-sans text-body font-semibold text-ink">
                  {{ f.title }}
                </h3>
                <p class="font-sans text-body-sm text-slate">{{ f.desc }}</p>
              </article>
            }
          </div>
        </div>
      </section>

      <!-- ===== Counter (measurable impact) ===== -->
      <section class="bg-abyss">
        <div
          class="mx-auto grid w-[90%] max-w-[1800px] items-center gap-10 py-16 lg:grid-cols-2"
        >
          <img
            src="/home/counter-photo.png"
            alt="Patient using VideoMed on a mobile phone"
            width="612"
            height="408"
            class="aspect-[4/3] w-full rounded-[24px] object-cover"
          />
          <div class="flex flex-col gap-6 text-white">
            <h2 class="font-heading text-h3">
              Trusted healthcare, measurable impact
            </h2>
            <p class="font-sans text-body-lg text-frost">
              Every consultation is backed when needed by:
            </p>
            <ul class="flex flex-col gap-3">
              @for (c of impactChecks; track c) {
                <li class="flex items-center gap-3 font-sans text-body">
                  <sd-icon name="check" [size]="20" class="text-teal" />
                  {{ c }}
                </li>
              }
            </ul>
            <div class="mt-2 grid grid-cols-2 gap-6 sm:grid-cols-4">
              @for (s of stats; track s.label) {
                <div class="flex flex-col gap-1">
                  <sd-icon [name]="s.icon" [size]="24" class="text-mist" />
                  <span class="font-heading text-h4 text-white">{{
                    s.value
                  }}</span>
                  <span class="font-sans text-caption text-frost">{{
                    s.label
                  }}</span>
                </div>
              }
            </div>
          </div>
        </div>
      </section>

      <!-- ===== How it works ===== -->
      <section id="how" class="scroll-mt-20 bg-glacier">
        <div class="mx-auto w-[90%] max-w-[1800px] py-16">
          <div class="mb-12 flex flex-col items-center gap-2 text-center">
            <h2 class="font-heading text-h3 text-abyss">How VideoMed Works</h2>
            <p class="font-sans text-body-lg text-slate">
              Simple steps to better health
            </p>
          </div>
          <ol class="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            @for (step of steps; track step.n) {
              <li class="flex flex-col items-center gap-4 text-center">
                <span
                  class="flex size-14 items-center justify-center rounded-full bg-cerulean text-white"
                >
                  <sd-icon [name]="step.icon" [size]="28" />
                </span>
                <span
                  class="font-heading text-h4 text-cerulean/30"
                  aria-hidden="true"
                  >{{ step.n }}</span
                >
                <h3 class="font-sans text-body font-semibold text-ink">
                  {{ step.title }}
                </h3>
                <p class="font-sans text-body-sm text-slate">{{ step.desc }}</p>
              </li>
            }
          </ol>
        </div>
      </section>

      <!-- ===== Featured specialists ===== -->
      <section class="bg-white">
        <div class="mx-auto w-[90%] max-w-[1800px] py-16">
          <div class="mb-10 flex flex-col items-center gap-2 text-center">
            <span
              class="inline-flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
            >
              <sd-icon name="shield-check" [size]="18" />
              Featured Specialist
            </span>
            <h2 class="font-heading text-h3 text-abyss">
              Connect with US board-certified Specialists
            </h2>
            <p class="max-w-2xl font-sans text-body-lg text-slate">
              Our network of experienced doctors and healthcare specialists in
              the US is here to provide you with the best care.
            </p>
          </div>
          <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            @for (d of doctors; track d.name) {
              <article
                class="flex flex-col overflow-hidden rounded-card border-[0.5px] border-ash"
              >
                <div class="relative">
                  <img
                    [src]="d.photo"
                    [alt]="d.name + ', ' + d.specialty"
                    width="230"
                    height="176"
                    class="aspect-[230/176] w-full object-cover"
                  />
                  <span
                    class="sd-chip absolute left-3 top-3 bg-white/95 text-sage-ink shadow-sm"
                  >
                    <span class="size-1.5 rounded-full bg-sage"></span>Available
                  </span>
                </div>
                <div class="flex flex-col gap-1.5 p-4">
                  <h3
                    class="flex items-center gap-1 font-sans text-body font-semibold text-ink"
                  >
                    {{ d.name }}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="#0b62e4"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 2l2.4 1.8 3 .1 1 2.8 2.4 1.8-1 2.8 1 2.8-2.4 1.8-1 2.8-3 .1L12 22l-2.4-1.8-3-.1-1-2.8L3.2 15.4l1-2.8-1-2.8 2.4-1.8 1-2.8 3-.1L12 2z"
                      />
                      <path
                        d="M10.6 14.6l-2.1-2.1 1.1-1.1 1 1 2.9-2.9 1.1 1.1-4 4z"
                        fill="#fff"
                      />
                    </svg>
                  </h3>
                  <p class="font-sans text-caption font-medium text-cerulean">
                    {{ d.specialty }}
                  </p>
                  <p
                    class="flex items-center gap-1 font-sans text-caption text-slate"
                  >
                    <sd-icon name="map-pin" [size]="14" />
                    {{ d.location }}
                  </p>
                  <p
                    class="flex items-center gap-1 font-sans text-caption text-slate"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="#f2a900"
                    >
                      <path
                        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                      />
                    </svg>
                    {{ d.rating }} ({{ d.reviews }})
                  </p>
                </div>
              </article>
            }
          </div>
          <div class="mt-10 flex justify-center">
            <sd-button (click)="book()">Book a Consultation</sd-button>
          </div>
        </div>
      </section>

      <!-- ===== Ready / Stay connected ===== -->
      <section class="overflow-hidden bg-frost/40">
        <div
          class="mx-auto grid w-[90%] max-w-[1800px] items-center gap-10 py-16 lg:grid-cols-[1fr_360px_1fr]"
        >
          <!-- Left CTA -->
          <div class="flex flex-col gap-5">
            <h2 class="font-heading text-h3 text-abyss">
              Ready to take charge of your health?
            </h2>
            <p class="max-w-xs font-sans text-body-lg text-slate">
              Join thousands of patients who trust VideoMed for quality
              healthcare.
            </p>
            <sd-button class="w-fit" (click)="book()"
              >Book a Consultation</sd-button
            >
          </div>

          <!-- Center image with floating credential cards -->
          <div class="relative mx-auto w-full max-w-[360px]">
            <img
              src="/home/ready-person.png"
              alt="Patient greeting a VideoMed doctor on a video consultation"
              width="612"
              height="408"
              class="w-full"
            />
            <div
              class="absolute left-0 top-4 flex items-center gap-2 rounded-2xl bg-white p-2.5 shadow-lg ring-1 ring-cloud/60"
            >
              <span
                class="flex size-7 items-center justify-center rounded-full bg-ocean font-sans text-[10px] font-semibold text-white"
                >SC</span
              >
              <div class="flex flex-col">
                <span class="font-sans text-caption font-semibold text-ink"
                  >Dr. Sarah Charles, MD</span
                >
                <span class="font-sans text-[10px] text-slate"
                  >Family Medicine</span
                >
              </div>
            </div>
            <div
              class="absolute bottom-6 right-0 flex items-center gap-2 rounded-2xl bg-white/90 p-2.5 shadow-lg ring-1 ring-cloud/60 backdrop-blur"
            >
              <sd-icon name="shield-check" [size]="20" class="text-cerulean" />
              <div class="flex flex-col">
                <span class="font-sans text-caption font-semibold text-ink"
                  >HIPAA Compliant</span
                >
                <span class="font-sans text-[10px] text-slate"
                  >Your privacy is our Priority</span
                >
              </div>
            </div>
          </div>

          <!-- Right newsletter -->
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-1">
              <h2 class="font-heading text-h3 text-abyss">Stay Connected</h2>
              <p class="font-sans text-body text-slate">
                Get health tips and updates
              </p>
            </div>
            <form class="flex max-w-sm flex-col gap-3" (ngSubmit)="subscribe()">
              <input
                type="email"
                [value]="email()"
                (input)="email.set($any($event.target).value)"
                placeholder="Enter your email"
                autocomplete="email"
                class="w-full rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
              />
              <sd-button type="submit" class="w-fit">Subscribe</sd-button>
            </form>
            @if (subscribed()) {
              <p class="font-sans text-caption text-sage">
                Thanks — we'll keep you posted.
              </p>
            }
          </div>
        </div>
      </section>

      <!-- ===== Footer ===== -->
      <footer id="contact" class="scroll-mt-20 bg-abyss text-frost">
        <div
          class="mx-auto grid w-[90%] max-w-[1800px] gap-10 py-14 md:grid-cols-4"
        >
          <div class="flex flex-col gap-4">
            <sd-logo [size]="32" [wordmark]="false" />
            <span class="font-heading text-h5 text-white">VideoMed</span>
            <p class="font-sans text-body-sm text-frost/80">
              Trusted healthcare, wherever you are.
            </p>
          </div>
          @for (col of footerCols; track col.title) {
            <div class="flex flex-col gap-3">
              <h4 class="font-sans text-body font-semibold text-white">
                {{ col.title }}
              </h4>
              @for (item of col.items; track item) {
                <a
                  href="#"
                  class="font-sans text-body-sm text-frost/80 transition-colors hover:text-white"
                  >{{ item }}</a
                >
              }
            </div>
          }
        </div>
        <div class="border-t border-white/10">
          <div
            class="mx-auto flex w-[90%] max-w-[1800px] flex-col items-center justify-between gap-3 py-5 md:flex-row"
          >
            <p class="font-sans text-caption text-frost/70">
              © 2026 VideoMed. All rights reserved.
            </p>
            <div class="flex items-center gap-4">
              @for (s of socials; track s.label) {
                <a
                  href="#"
                  [attr.aria-label]="s.label"
                  class="text-frost/70 transition-colors hover:text-white"
                >
                  <sd-icon [name]="s.icon" [size]="18" />
                </a>
              }
            </div>
          </div>
        </div>
      </footer>
    </div>
  `,
})
export class Home {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly themeSvc = inject(ThemeService);
  /** Reflects the header/CTAs to the signed-in state (no logout needed to browse home). */
  protected readonly loggedIn = computed(() => this.auth.isAuthenticated());
  /** Staff portals signed in on this browser (non-secret hint cookies, re-read on return to the tab). */
  private readonly portalHints = signal(readPortalHints());
  /** The portal this tab came from (the staff logo's `?from=`): its dashboard is offered first. */
  private readonly cameFrom = portalFrom(location.search);
  protected readonly patientDashboard: DashboardLink = {
    href: '/dashboard',
    label: 'Go to Dashboard',
    inApp: true,
  };
  /**
   * The staff portals to offer (the one just left first, else the doctor
   * portal). Shown beside Sign in / Register, which a patient on the same
   * browser still needs; a patient session replaces them all.
   */
  protected readonly staffDashboards = computed<DashboardLink[]>(() => {
    const hints = this.portalHints();
    const order: PortalKind[] =
      this.cameFrom === 'admin' ? ['admin', 'doctor'] : ['doctor', 'admin'];
    return order.flatMap((kind) => {
      const href = hints[kind];
      return href ? [{ href, inApp: false, ...STAFF_PORTALS[kind] }] : [];
    });
  });
  /**
   * The mobile bar's dashboard icon: the patient's own dashboard, else the
   * first staff portal; null when neither. Known synchronously at first render
   * (token + cookie), so nothing flashes.
   */
  protected readonly dashboard = computed<DashboardLink | null>(() =>
    this.loggedIn()
      ? this.patientDashboard
      : (this.staffDashboards()[0] ?? null),
  );
  protected readonly dashboardClass = buttonClass('primary', 'sm');
  protected readonly dashboardFullClass = buttonClass('primary', 'sm', true);
  protected readonly staffDashboardClass = buttonClass('ghost', 'sm');
  protected readonly staffDashboardFullClass = buttonClass(
    'outline',
    'sm',
    true,
  );

  constructor() {
    // The staff logo's `?from=` has done its job (kept for the tab): tidy the address.
    const rest = withoutPortalFrom(location.search);
    if (rest !== location.search)
      inject(Location).replaceState(location.pathname, rest.slice(1));

    // Signed in or out of a portal in another tab (or this one, then Back): follow it.
    const onVisible = () => {
      if (document.visibilityState === 'visible')
        this.portalHints.set(readPortalHints());
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    });
  }
  protected readonly isDark = computed(() => this.themeSvc.theme() === 'dark');
  protected readonly menuOpen = signal(false);

  protected toggleTheme(): void {
    this.themeSvc.toggle();
  }
  protected readonly email = signal('');
  protected readonly subscribed = signal(false);

  protected readonly navLinks = [
    { label: 'Home', href: '#' },
    { label: 'About Us', href: '#about' },
    { label: 'Services', href: '#services' },
    { label: 'Contact Us', href: '#contact' },
  ];

  protected readonly heroTrust = [
    { icon: 'user-round', label: 'US Licensed Doctors' },
    { icon: 'shield-check', label: 'Secure & Private' },
    { icon: 'map-pin', label: 'No Travel Needed' },
  ];

  protected readonly features: Feature[] = [
    {
      icon: 'user-round',
      title: 'US Board-certified Doctors',
      desc: 'Consult experienced, licensed physicians vetted for quality care.',
    },
    {
      icon: 'shield-check',
      title: 'Secure & Private',
      desc: 'HIPAA-compliant consultations keep your health data protected.',
    },
    {
      icon: 'calendar-clock',
      title: 'Book Anytime',
      desc: 'Schedule appointments that fit around your day, any time.',
    },
    {
      icon: 'map-pin',
      title: 'No Travel Needed',
      desc: 'Connect securely from home, work, or anywhere you are.',
    },
    {
      icon: 'file-text',
      title: 'E-Prescription',
      desc: 'Receive digital prescriptions ready for pickup or delivery.',
    },
    {
      icon: 'heart-pulse',
      title: 'Follow-Up Care',
      desc: 'Ongoing support and follow-ups for continuous, connected care.',
    },
  ];

  protected readonly impactChecks = [
    'Experienced medical professionals',
    'Secured technology',
    'Delivering quality care',
  ];

  protected readonly stats: Stat[] = [
    { icon: 'stethoscope', value: '50+', label: 'US Specialist' },
    { icon: 'users', value: '10,000+', label: 'Patients Served' },
    { icon: 'user-round', value: '25+', label: 'Medical Specialist' },
    { icon: 'heart-pulse', value: '98%', label: 'Satisfaction' },
  ];

  protected readonly steps: Step[] = [
    {
      icon: 'user',
      n: '1',
      title: 'Create Account',
      desc: 'Sign up in minutes and complete your health profile.',
    },
    {
      icon: 'calendar-days',
      n: '2',
      title: 'Book Appointment',
      desc: 'Choose a specialist and time that works for you.',
    },
    {
      icon: 'video',
      n: '3',
      title: 'Consult Online',
      desc: 'Join your secure video consultation from anywhere.',
    },
    {
      icon: 'clipboard-list',
      n: '4',
      title: 'Receive Care',
      desc: 'Receive your treatment plan and follow up as needed.',
    },
  ];

  protected readonly doctors: Doctor[] = [
    {
      photo: '/home/doc1.png',
      name: 'Dr Johnson Micheal',
      specialty: 'Internal Medicine',
      location: 'California, USA',
      rating: '4.9',
      reviews: '100 reviews',
    },
    {
      photo: '/home/doc2.png',
      name: 'Dr David Thompson',
      specialty: 'Cardiology',
      location: 'New York, USA',
      rating: '3.0',
      reviews: '90 reviews',
    },
    {
      photo: '/home/doc3.png',
      name: 'Dr James Lee',
      specialty: 'Psychiatry',
      location: 'Illinois, USA',
      rating: '4.9',
      reviews: '100 reviews',
    },
    {
      photo: '/home/doc4.png',
      name: 'Dr Aisha Brown',
      specialty: 'Dermatology',
      location: 'Florida, USA',
      rating: '4.0',
      reviews: '120 reviews',
    },
  ];

  protected readonly footerCols = [
    { title: 'Navigation', items: ['Home', 'Doctors', 'About', 'Contact us'] },
    { title: 'Resources', items: ['Blog', 'Help Center', 'FAQs', 'Support'] },
    {
      title: 'Legal',
      items: ['Privacy Policy', 'Terms of Service', 'Cookies'],
    },
  ];

  protected readonly socials = [
    { icon: 'mail', label: 'Email' },
    { icon: 'message-square', label: 'Chat' },
    { icon: 'phone', label: 'Phone' },
  ];

  protected go(url: string): void {
    this.menuOpen.set(false);
    void this.router.navigateByUrl(url);
  }

  /** The patient dashboard opens in-app; a staff portal is another site (the link itself). */
  protected openDashboard(e: MouseEvent, d: DashboardLink): void {
    if (!d.inApp || !isPlainClick(e)) return;
    e.preventDefault();
    this.go(d.href);
  }

  /** Book CTA: signed-in users go straight to the specialist directory. */
  protected book(): void {
    this.go(this.loggedIn() ? '/dashboard/specialists' : '/auth/register');
  }

  protected scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }

  protected subscribe(): void {
    if (this.email().includes('@')) this.subscribed.set(true);
  }
}
