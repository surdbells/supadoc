import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

interface QuickAction {
  readonly icon: string;
  readonly title: string;
  readonly subtitle: string;
  readonly tint: string;
}

interface Notification {
  readonly icon: string;
  readonly tint: string;
  readonly title: string;
  readonly body: string;
  readonly time: string;
}

/** Patient dashboard home (Figma 666:9342). */
@Component({
  selector: 'pat-dashboard-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ButtonComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Welcome banner -->
      <section
        class="relative flex items-center justify-between overflow-hidden rounded-card bg-sky/10 px-6 py-4"
      >
        <div class="flex flex-col gap-2.5">
          <h1 class="font-heading text-h2 text-ocean">
            Good morning, {{ firstName }} 👋
          </h1>
          <p class="font-sans text-h5 text-ink">
            Here's your health summary for today.
          </p>
        </div>
        <div class="hidden shrink-0 sm:block" aria-hidden="true">
          <img
            src="/dashboard/hero-main.svg"
            alt=""
            width="209"
            height="149"
            class="h-[149px] w-[209px] object-contain"
          />
        </div>
        <div
          class="absolute bottom-0 left-6 rounded-t-card bg-sky px-4 py-1 font-sans text-caption text-white"
        >
          Stay on top of your health. You're doing great!
        </div>
      </section>

      <!-- Widgets -->
      <section class="flex flex-col gap-4">
        <h2 class="font-sans text-h5 text-ink">Widgets</h2>
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <!-- Profile Summary -->
          <article
            class="flex flex-col gap-6 rounded-card border-[0.5px] border-ash px-6 py-4"
          >
            <header class="flex items-center gap-2">
              <sd-icon name="user" [size]="20" class="text-ink" />
              <h3 class="font-sans text-body font-semibold text-ink">
                Profile Summary
              </h3>
            </header>
            <div class="flex items-center gap-2">
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-ocean font-sans text-body-sm font-semibold text-white"
                aria-hidden="true"
                >{{ initials }}</span
              >
              <div class="flex min-w-0 flex-col">
                <p class="truncate font-sans text-body font-semibold text-ink">
                  {{ fullName }}
                </p>
                <p class="truncate font-sans text-caption text-slate">
                  {{ email }}
                </p>
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <div
                class="h-1.5 w-full overflow-hidden rounded-full bg-frost"
                role="progressbar"
                aria-label="Profile completion"
                [attr.aria-valuenow]="profileComplete"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="h-full rounded-full bg-cerulean"
                  [style.width.%]="profileComplete"
                ></div>
              </div>
              <div class="flex items-center justify-between">
                <span class="font-sans text-caption text-slate"
                  >Profile complete</span
                >
                <span class="font-sans text-body font-semibold text-sage"
                  >{{ profileComplete }}%</span
                >
              </div>
            </div>
            <sd-button variant="outline" size="sm" [full]="true"
              >Complete Profile</sd-button
            >
          </article>

          <!-- Upcoming Appointment -->
          <article
            class="flex flex-col gap-6 rounded-card border-[0.5px] border-ash px-6 py-4"
          >
            <header class="flex items-center gap-2">
              <sd-icon name="calendar-days" [size]="20" class="text-ink" />
              <h3 class="font-sans text-body font-semibold text-ink">
                Upcoming Appointment
              </h3>
            </header>
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-full bg-ocean font-sans text-body-sm font-semibold text-white"
                  aria-hidden="true"
                  >JS</span
                >
                <div class="flex flex-col">
                  <p class="font-sans text-body font-semibold text-ink">
                    Dr James Smith
                  </p>
                  <p class="font-sans text-caption text-slate">Cardiologist</p>
                </div>
              </div>
              <span
                class="rounded-lg bg-sage px-4 py-1 font-sans text-[10px] font-medium leading-4 text-white"
                >Confirmed</span
              >
            </div>
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <span class="flex items-center gap-2 text-slate">
                  <sd-icon name="calendar-days" [size]="16" />
                  <span class="font-sans text-caption">Mon, Jul 20, 2026</span>
                </span>
                <span class="flex items-center gap-2 text-slate">
                  <sd-icon name="map-pin" [size]="16" />
                  <span class="font-sans text-caption">Video Consultation</span>
                </span>
              </div>
              <span class="flex items-center gap-2 text-slate">
                <sd-icon name="clock" [size]="16" />
                <span class="font-sans text-caption">10:00 AM</span>
              </span>
            </div>
            <div class="flex gap-6">
              <sd-button variant="outline" size="sm" [full]="true"
                >View All</sd-button
              >
              <sd-button size="sm" [full]="true">
                <sd-icon name="video" [size]="18" />
                Join Call
              </sd-button>
            </div>
          </article>

          <!-- Wallet -->
          <article
            class="flex flex-col gap-4 rounded-card border-[0.5px] border-ash px-6 py-4"
          >
            <header class="flex items-center gap-2">
              <sd-icon name="wallet" [size]="20" class="text-ink" />
              <h3 class="font-sans text-body font-semibold text-ink">Wallet</h3>
            </header>
            <div class="flex items-center justify-between gap-4">
              <div class="flex flex-col gap-1">
                <span class="font-sans text-caption text-slate"
                  >Current Balance</span
                >
                <span class="font-sans text-body font-semibold text-ink">{{
                  balance
                }}</span>
              </div>
              <sd-button size="sm">
                <sd-icon name="plus" [size]="18" />
                Add Funds
              </sd-button>
            </div>
            <div class="flex flex-col gap-2">
              <span class="font-sans text-caption text-slate"
                >Recent Transaction</span
              >
              <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between">
                  <span class="font-sans text-caption text-slate"
                    >20 Jul, 2026</span
                  >
                  <span class="font-sans text-caption font-medium text-alert"
                    >-$60.00</span
                  >
                </div>
                <p class="font-sans text-body-sm text-ink">
                  Consultation with Dr James Smith
                </p>
              </div>
            </div>
            <sd-button variant="outline" size="sm" [full]="true"
              >View All Transactions</sd-button
            >
          </article>
        </div>
      </section>

      <!-- Notifications + Quick Actions -->
      <section class="flex flex-col gap-6 xl:flex-row">
        <!-- Notifications -->
        <article
          class="flex shrink-0 flex-col gap-6 rounded-card border-[0.5px] border-ash px-6 py-4 xl:w-[360px]"
        >
          <header class="flex items-center gap-2">
            <sd-icon name="bell" [size]="20" class="text-ink" />
            <h3 class="flex-1 font-sans text-body font-semibold text-ink">
              Notifications
            </h3>
            <a
              href="#"
              class="font-sans text-caption text-cerulean hover:underline"
              >View all</a
            >
          </header>
          <ul class="flex flex-col gap-6">
            @for (n of notifications; track n.title) {
              <li class="flex items-start gap-2">
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full"
                  [class]="n.tint"
                >
                  <sd-icon [name]="n.icon" [size]="16" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex items-center justify-between gap-2">
                    <p class="font-sans text-body-sm font-medium text-ink">
                      {{ n.title }}
                    </p>
                    <span class="shrink-0 font-sans text-caption text-slate">{{
                      n.time
                    }}</span>
                  </div>
                  <p class="font-sans text-caption text-slate">{{ n.body }}</p>
                </div>
              </li>
            }
          </ul>
        </article>

        <!-- Quick Actions -->
        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <h2 class="font-sans text-h5 text-ink">Quick Actions</h2>
          <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
            @for (a of quickActions; track a.title) {
              <button
                type="button"
                class="flex flex-col items-center gap-4 rounded-card border-[0.5px] border-ash bg-glacier px-2 py-4 text-center transition-colors hover:border-cerulean"
              >
                <span
                  class="flex items-center justify-center rounded-full p-2"
                  [class]="a.tint"
                >
                  <sd-icon [name]="a.icon" [size]="24" />
                </span>
                <span class="flex flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink">{{
                    a.title
                  }}</span>
                  <span class="font-sans text-caption text-slate">{{
                    a.subtitle
                  }}</span>
                </span>
                <sd-icon name="arrow-right" [size]="16" class="text-ink" />
              </button>
            }
          </div>
        </div>
      </section>

      <!-- Health Tip -->
      <section
        class="flex items-center justify-between gap-6 rounded-card bg-gradient-to-r from-frost to-mist p-6"
      >
        <div class="flex items-center gap-6">
          <sd-icon name="shield-check" [size]="32" class="shrink-0 text-teal" />
          <div class="flex flex-col gap-2">
            <h3 class="font-sans text-body font-semibold text-abyss">
              Health Tip of the day
            </h3>
            <p class="font-sans text-body-sm text-slate">
              Stay hydrated and get enough sleep to keep your heart healthy
            </p>
          </div>
        </div>
        <sd-button size="sm" class="shrink-0">Learn more</sd-button>
      </section>
    </div>
  `,
})
export class DashboardHome {
  // TODO: source from GetProfile / wallet / appointments APIs once available.
  protected readonly firstName = 'Sarah';
  protected readonly fullName = 'Sarah Johnson';
  protected readonly initials = 'SJ';
  protected readonly email = 'sarahjohnson@gmail.com';
  protected readonly profileComplete = 75;
  protected readonly balance = '$120.50';

  protected readonly notifications: Notification[] = [
    {
      icon: 'user-round',
      tint: 'bg-frost text-cerulean',
      title: 'Appointment confirmed',
      body: 'Your appointment with Dr. James is confirm',
      time: '2mins ago',
    },
    {
      icon: 'pill',
      tint: 'bg-teal/10 text-teal',
      title: 'Prescription ready',
      body: 'Your prescription is ready for pickup',
      time: '1hr ago',
    },
    {
      icon: 'banknote',
      tint: 'bg-sage/10 text-sage',
      title: 'Payment successful',
      body: 'Your payment of $60.00 was successful',
      time: '2hrs ago',
    },
  ];

  protected readonly quickActions: QuickAction[] = [
    {
      icon: 'stethoscope',
      title: 'Find a Specialist',
      subtitle: 'Search and connect with trusted specialist',
      tint: 'bg-cerulean/10 text-cerulean',
    },
    {
      icon: 'calendar-clock',
      title: 'Book Consultation',
      subtitle: 'Book an appointment with a doctor',
      tint: 'bg-teal/10 text-teal',
    },
    {
      icon: 'calendar-days',
      title: 'My Appointments',
      subtitle: 'View and manage your appointments',
      tint: 'bg-sky/10 text-sky',
    },
    {
      icon: 'history',
      title: 'History',
      subtitle: 'View your past consultation',
      tint: 'bg-sage/10 text-sage',
    },
  ];
}
