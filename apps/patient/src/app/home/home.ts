import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { ButtonComponent, IconComponent, LogoComponent } from '@supadoc/ui';

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
  imports: [ButtonComponent, IconComponent, LogoComponent],
  template: `
    <div class="min-h-screen bg-white font-sans text-ink">
      <!-- ===== Header ===== -->
      <header
        class="sticky top-0 z-30 border-b border-cloud/70 bg-white/90 backdrop-blur"
      >
        <div
          class="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-5 md:h-20 md:px-8"
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
            <sd-button variant="ghost" size="sm" (click)="go('/auth/login')"
              >Login</sd-button
            >
            <sd-button size="sm" (click)="go('/auth/register')"
              >Register</sd-button
            >
          </div>

          <button
            type="button"
            class="text-ink lg:hidden"
            [attr.aria-expanded]="menuOpen()"
            aria-label="Toggle menu"
            (click)="menuOpen.set(!menuOpen())"
          >
            <sd-icon [name]="menuOpen() ? 'x' : 'menu'" [size]="24" />
          </button>
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
            <div class="mt-2 flex gap-3">
              <sd-button
                variant="outline"
                size="sm"
                [full]="true"
                (click)="go('/auth/login')"
                >Login</sd-button
              >
              <sd-button size="sm" [full]="true" (click)="go('/auth/register')"
                >Register</sd-button
              >
            </div>
          </nav>
        }
      </header>

      <!-- ===== Hero ===== -->
      <section class="bg-gradient-to-b from-glacier to-white">
        <div
          class="mx-auto grid max-w-[1280px] items-center gap-12 px-5 py-14 md:px-8 lg:grid-cols-2 lg:py-20"
        >
          <div class="flex flex-col gap-6">
            <span
              class="inline-flex w-fit items-center gap-2 rounded-pill bg-frost/60 px-3 py-1 font-sans text-caption font-medium text-cerulean"
            >
              <sd-icon name="shield-check" [size]="14" />
              Trusted by thousands of clients
            </span>
            <h1 class="font-heading text-h1 leading-tight text-abyss">
              Healthcare made Simple, Personal, &amp; Accessible
            </h1>
            <p class="max-w-xl font-sans text-body-lg text-slate">
              Experience modern healthcare with secure virtual consultations,
              easy appointment scheduling, digital prescriptions, and continuous
              support — all in one place.
            </p>
            <div class="flex flex-wrap gap-4">
              <sd-button (click)="go('/auth/register')">
                Book a Consultation
                <sd-icon name="arrow-right" [size]="18" />
              </sd-button>
              <sd-button variant="outline" (click)="scrollTo('about')"
                >Learn More</sd-button
              >
            </div>
            <ul class="flex flex-wrap gap-x-8 gap-y-3 pt-2">
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

          <!-- Visual (exported from the VideoMed design) -->
          <div class="mx-auto w-full max-w-md lg:max-w-none">
            <img
              src="/home/hero-export.png"
              alt="Doctor on a secure VideoMed video consultation, with patient rating and HIPAA-compliant badges"
              width="543"
              height="535"
              class="w-full"
            />
          </div>
        </div>
      </section>

      <!-- ===== Trusted by ===== -->
      <section class="border-y border-cloud/60 bg-white">
        <div class="mx-auto max-w-[1280px] px-5 py-10 md:px-8">
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
      <section id="about" class="bg-glacier">
        <div
          class="mx-auto flex max-w-[860px] flex-col items-center gap-6 px-5 py-16 text-center md:px-8"
        >
          <span
            class="flex size-14 items-center justify-center rounded-full bg-frost/60 text-cerulean"
          >
            <sd-icon name="heart-pulse" [size]="28" />
          </span>
          <div class="flex flex-col gap-2">
            <span
              class="font-sans text-body font-semibold uppercase tracking-wide text-cerulean"
              >About VideoMed</span
            >
            <h2 class="font-heading text-h3 text-abyss">
              Healthcare designed around your life
            </h2>
          </div>
          <p class="font-sans text-body-lg text-slate">
            VideoMed makes it easier to connect with experienced healthcare
            professionals through secure virtual consultation. Whether you need
            a routine check-up, a specialist opinion or on-going care, our
            platform provides convenient access to quality healthcare without
            unnecessary travel.
          </p>
          <sd-button variant="outline" (click)="scrollTo('how')"
            >Learn More</sd-button
          >
        </div>
      </section>

      <!-- ===== Features ===== -->
      <section class="bg-white">
        <div class="mx-auto max-w-[1280px] px-5 py-16 md:px-8">
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
          class="mx-auto grid max-w-[1280px] items-center gap-10 px-5 py-16 md:px-8 lg:grid-cols-2"
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
      <section id="how" class="bg-glacier">
        <div class="mx-auto max-w-[1280px] px-5 py-16 md:px-8">
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
        <div class="mx-auto max-w-[1280px] px-5 py-16 md:px-8">
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
                <img
                  [src]="d.photo"
                  [alt]="d.name + ', ' + d.specialty"
                  width="230"
                  height="176"
                  class="aspect-[230/176] w-full object-cover"
                />
                <div class="flex flex-col gap-1.5 p-4">
                  <h3
                    class="flex items-center gap-1 font-sans text-body font-semibold text-ink"
                  >
                    {{ d.name }}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="#1565c0"
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
            <sd-button (click)="go('/auth/register')"
              >Book a Consultation</sd-button
            >
          </div>
        </div>
      </section>

      <!-- ===== Ready / Stay connected ===== -->
      <section class="bg-glacier">
        <div
          class="mx-auto grid max-w-[1280px] gap-10 px-5 py-16 md:px-8 lg:grid-cols-2"
        >
          <div class="flex flex-col gap-5">
            <h2 class="font-heading text-h3 text-abyss">
              Ready to take charge of your health?
            </h2>
            <p class="max-w-md font-sans text-body-lg text-slate">
              Join thousands of patients who trust VideoMed for quality
              healthcare.
            </p>
            <sd-button class="w-fit" (click)="go('/auth/register')">
              Get Started
              <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
          </div>
          <div
            class="flex flex-col gap-4 rounded-card bg-white p-6 ring-1 ring-cloud/60"
          >
            <div class="flex flex-col gap-1">
              <h3 class="font-heading text-h4 text-abyss">Stay Connected</h3>
              <p class="font-sans text-body-sm text-slate">
                Get health tips and updates
              </p>
            </div>
            <form
              class="flex flex-col gap-3 sm:flex-row"
              (ngSubmit)="subscribe()"
            >
              <input
                type="email"
                [value]="email()"
                (input)="email.set($any($event.target).value)"
                placeholder="Enter your email"
                autocomplete="email"
                class="w-full rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body text-ink placeholder:text-slate/60 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
              />
              <sd-button type="submit">Subscribe</sd-button>
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
      <footer class="bg-abyss text-frost">
        <div
          class="mx-auto grid max-w-[1280px] gap-10 px-5 py-14 md:grid-cols-4 md:px-8"
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
            class="mx-auto flex max-w-[1280px] flex-col items-center justify-between gap-3 px-5 py-5 md:flex-row md:px-8"
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
  protected readonly menuOpen = signal(false);
  protected readonly email = signal('');
  protected readonly subscribed = signal(false);

  protected readonly navLinks = [
    { label: 'Home', href: '#' },
    { label: 'Doctors', href: '#' },
    { label: 'About', href: '#about' },
    { label: 'Contact us', href: '#' },
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

  protected scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }

  protected subscribe(): void {
    if (this.email().includes('@')) this.subscribed.set(true);
  }
}
