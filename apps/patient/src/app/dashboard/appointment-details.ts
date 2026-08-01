import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

interface SharedDoc {
  readonly name: string;
  readonly size: string;
}

/** Appointment details (Figma 648:9480) — its own route under appointments. */
@Component({
  selector: 'pat-appointment-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <a
            routerLink="/dashboard/appointments"
            class="mb-1 flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean"
          >
            <sd-icon name="chevron-right" [size]="16" class="rotate-180" />
            My Appointments
          </a>
          <h1 class="font-heading text-h3 text-ink">Appointment Details</h1>
          <p class="font-sans text-body text-slate">
            View and manage your scheduled consultations
          </p>
        </div>
        <sd-button size="sm">
          <sd-icon name="plus" [size]="18" />
          Book Consultation
        </sd-button>
      </div>

      <!-- Summary -->
      <section
        class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 md:flex-row md:items-center md:justify-between"
      >
        <div class="flex items-center gap-4">
          <img
            src="/dashboard/avatar-james.png"
            alt=""
            width="64"
            height="64"
            class="size-16 shrink-0 rounded-full object-cover"
          />
          <div class="flex flex-col gap-1">
            <p class="font-sans text-body-lg font-semibold text-ink">
              Dr. Ibrahim Musa
            </p>
            <p class="font-sans text-caption text-slate">Cardiologist</p>
            <p
              class="flex items-center gap-1.5 font-sans text-caption text-slate"
            >
              <sd-icon name="map-pin" [size]="16" />
              Greenwich Medical Center, New York, USA.
            </p>
          </div>
        </div>
        <div class="flex items-start justify-between gap-8 md:items-center">
          <div class="flex flex-col gap-2 font-sans text-caption text-slate">
            <span class="flex items-center gap-2">
              <sd-icon name="calendar-days" [size]="16" />Tue, 21 July 2026
            </span>
            <span class="flex items-center gap-2">
              <sd-icon name="clock" [size]="16" />10:00 AM
            </span>
            <span class="flex items-center gap-2">
              <sd-icon name="video" [size]="16" />Video Consultation
            </span>
          </div>
          <span
            class="shrink-0 rounded-lg bg-warning/15 px-4 py-1.5 font-sans text-body-sm font-medium text-warning"
            >Pending</span
          >
        </div>
      </section>

      <!-- Instructions + actions -->
      <section
        class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 lg:flex-row lg:justify-between"
      >
        <div class="flex flex-col gap-3">
          <h2
            class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
          >
            <sd-icon name="clipboard-list" [size]="20" />
            Consultation Instructions
          </h2>
          <div class="flex flex-col gap-3 font-sans text-body-sm text-slate">
            <p>
              Please ensure you have a stable internet connection.<br />
              Join the consultation 5-10minutes early.
            </p>
            <p>
              Upload any relevant medical reports or tests below, so the doctor
              can review them.
            </p>
          </div>
        </div>
        <div class="flex shrink-0 flex-col gap-3 lg:w-[240px]">
          <sd-button [full]="true">
            <sd-icon name="video" [size]="18" />
            Join Consultation
          </sd-button>
          <sd-button variant="outline" [full]="true"
            >Reschedule Appointment</sd-button
          >
          <button
            type="button"
            class="inline-flex w-full items-center justify-center gap-2 rounded-field border border-alert px-4 py-3 font-sans text-body font-semibold text-alert transition-colors hover:bg-alert/5"
          >
            <sd-icon name="trash-2" [size]="18" />
            Cancel Appointment
          </button>
        </div>
      </section>

      <!-- Documents + payment -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section
          class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
        >
          <h2
            class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
          >
            <sd-icon name="file-text" [size]="20" />
            Shared Documents
          </h2>
          <ul class="flex flex-col gap-3">
            @for (doc of documents; track doc.name) {
              <li class="flex items-center gap-3">
                <sd-icon
                  name="file-text"
                  [size]="20"
                  class="shrink-0 text-slate"
                />
                <span
                  class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink"
                >
                  {{ doc.name }} ({{ doc.size }})
                </span>
                <button
                  type="button"
                  class="flex size-8 items-center justify-center rounded-field border border-cloud text-slate transition-colors hover:bg-glacier"
                  aria-label="Preview document"
                >
                  <sd-icon name="eye" [size]="16" />
                </button>
                <button
                  type="button"
                  class="flex size-8 items-center justify-center rounded-field border border-cloud text-slate transition-colors hover:bg-glacier"
                  aria-label="Download document"
                >
                  <sd-icon name="download" [size]="16" />
                </button>
              </li>
            }
          </ul>
        </section>

        <section
          class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
        >
          <h2
            class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
          >
            <sd-icon name="credit-card" [size]="20" />
            Payment Status
          </h2>
          <div class="flex items-start justify-between gap-4">
            <span
              class="flex items-center gap-2 font-sans text-body-sm text-ink"
            >
              <sd-icon name="credit-card" [size]="20" class="text-slate" />
              Amount: $75.00
            </span>
            <span class="font-sans text-caption text-slate"
              >Paid on: June 12, 2026</span
            >
          </div>
          <span
            class="flex w-fit items-center gap-1.5 self-end rounded-lg bg-sage/15 px-3 py-1 font-sans text-caption font-medium text-sage"
          >
            <sd-icon name="circle-check" [size]="14" />
            Paid
          </span>
        </section>
      </div>
    </div>
  `,
})
export class AppointmentDetails {
  protected readonly documents: SharedDoc[] = [
    { name: "Doctor's_Notes.pdf", size: '212KB' },
    { name: 'CT_scan__Thorax.dcm', size: '212KB' },
  ];
}
