import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';

/** Consultation details (Figma 808:13576) — own route under history. */
@Component({
  selector: 'pat-history-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Consultation Details</h1>
          <p class="font-sans text-body text-slate">
            See your consultation full information.
          </p>
        </div>
        <a
          routerLink="/dashboard/history"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
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
            class="shrink-0 rounded-lg bg-sage/15 px-4 py-1.5 font-sans text-body-sm font-medium text-sage"
            >Completed</span
          >
        </div>
      </section>

      <!-- Summary + Note -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section
          class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
        >
          <h2
            class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
          >
            <sd-icon name="clipboard-list" [size]="20" />
            Consultation Summary
          </h2>
          <div class="flex flex-col gap-3 font-sans text-body-sm text-slate">
            <p>
              You had a follow-up consultation to review your test result and
              discuss your heart health.
            </p>
            <p>
              Your doctor has recommended some lifestyle changes and medication
              adjustment.
            </p>
          </div>
        </section>

        <section
          class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
        >
          <h2
            class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
          >
            <sd-icon name="clipboard-list" [size]="20" />
            Consultation Note
          </h2>
          <ul class="flex flex-col gap-2.5">
            @for (note of notes; track note) {
              <li
                class="flex items-center gap-2 font-sans text-body-sm text-ink"
              >
                <sd-icon name="check" [size]="16" class="shrink-0 text-sage" />
                {{ note }}
              </li>
            }
          </ul>
        </section>
      </div>

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
          <div class="flex items-center gap-3">
            <sd-icon name="file-text" [size]="20" class="shrink-0 text-slate" />
            <span
              class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink"
            >
              Consultation Summary.pdf (212KB)
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
          </div>
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
          <div class="flex items-center justify-between gap-4">
            <span
              class="flex items-center gap-2 font-sans text-body-sm text-ink"
            >
              <sd-icon name="credit-card" [size]="20" class="text-slate" />
              Amount: $75.00
            </span>
            <span class="font-sans text-caption text-slate"
              >Paid on: June 12, 2026</span
            >
            <span
              class="flex shrink-0 items-center gap-1.5 rounded-lg bg-sage/15 px-3 py-1 font-sans text-caption font-medium text-sage"
            >
              <sd-icon name="circle-check" [size]="14" />
              Paid
            </span>
          </div>
        </section>
      </div>
    </div>
  `,
})
export class HistoryDetails {
  protected readonly notes: string[] = [
    'Blood pressure is stable.',
    'Continue current medication.',
    'Recommended 30minutes of daily exercise.',
    'Follow up in three (3) months.',
  ];
}
