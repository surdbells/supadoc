import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  distinctUntilChanged,
  map,
  type Observable,
  Subscription,
  tap,
} from 'rxjs';
import {
  apiErrorMessage,
  DocumentsApi,
  LabRequestsApi,
  viewerTimeZone,
} from '@supadoc/data-access';
import type {
  LabRequestLinkDto,
  LabResultUploadedDto,
  PatientLabRequestDto,
  PatientLabResultDto,
} from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  DialogService,
  EmptyStateComponent,
  IconComponent,
  type ConfirmOptions,
} from '@supadoc/ui';
import {
  DocumentViewerService,
  safeFilename,
  saveSignedLink,
} from '@supadoc/viewer';
import { LabAcceptDialog } from './lab-accept-dialog';
import {
  LabResultUploadDialog,
  type LabUploadRefused,
} from './lab-result-upload-dialog';
import {
  calendarDate,
  coversLabel,
  itemCaption,
  itemGroups,
  labChip,
  labDay,
  labDoctor,
  labDoctorCap,
  labTimeline,
  numberParts,
  priorityDetail,
  resultCaption,
  uploadOutcomeMessage,
} from './lab-ui';
import {
  httpStatus,
  myLabRequestPdfSource,
  statusChanged,
} from './lab-viewer-sources';
import { myLabResultSource, openerOf } from './viewer-sources';

/** The PDF couldn't be fetched (the page's error line). */
export const LAB_PDF_ERROR = "Couldn't open the PDF. Please try again.";
export const LAB_ACCEPTED =
  'Request accepted. You can now download your request.';
/** Under "Your request PDF" once a result is in (other tests may still be outstanding). */
export const LAB_READY_PDF_CAPTION =
  'Still need other tests from this request? Any lab or imaging centre can use it.';
/** STAT, until the sample is given (spec §4.4 item 1; clinical sign-off pending). */
export const LAB_STAT_ALERT =
  'Your doctor marked this request STAT (most urgent). Go to a lab as soon as you can. If you feel very unwell, go to the nearest emergency department now.';
/** STAT once the sample is given: "go to a lab" no longer applies, the emergency sentence still does. */
export const LAB_STAT_ALERT_IN_LAB =
  'Your doctor marked this request STAT (most urgent). If you feel very unwell, go to the nearest emergency department now.';

/**
 * One lab request (spec §4.4) — what the doctor asked for, how to get ready,
 * the next step (accept or decline, take it to a lab, say the sample was
 * given, add the result), the results with the doctor's note once reviewed,
 * and what happened when. The patient never sees a review outcome: a reviewed
 * result reads "Reviewed by your doctor" with the note, and the Results card
 * always says how to get help without waiting. The request PDF and every
 * result open in the shared document viewer (never a tab).
 */
@Component({
  selector: 'pat-lab-request-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AlertComponent,
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    LabAcceptDialog,
    LabResultUploadDialog,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Lab request</h1>
          <p class="font-sans text-body text-slate">
            Review the request, get ready, and add your results.
          </p>
        </div>
        <a
          routerLink="/dashboard/lab-requests"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div
            class="flex flex-col gap-6"
            aria-busy="true"
            aria-label="Loading lab request"
          >
            <div class="h-44 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-28 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-56 animate-pulse rounded-card bg-cloud"></div>
          </div>
        }
        @case ('not-found') {
          <sd-empty-state
            tone="error"
            icon="flask-conical"
            title="Lab request not found"
            [message]="loadError()"
          >
            <a
              routerLink="/dashboard/lab-requests"
              class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark"
              >Back to lab tests</a
            >
          </sd-empty-state>
        }
        @case ('error') {
          <sd-empty-state
            tone="error"
            icon="wifi-off"
            title="Couldn't load this lab request"
            [message]="loadError()"
          >
            <div class="flex flex-wrap items-center justify-center gap-3">
              <sd-button variant="outline" (click)="reload()">
                <sd-icon name="refresh-cw" [size]="18" />
                Try again
              </sd-button>
              <a
                routerLink="/dashboard/lab-requests"
                class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                >Back to lab tests</a
              >
            </div>
          </sd-empty-state>
        }
        @default {
          @if (req(); as r) {
            <!-- What just happened (accepted, a result added, a refusal), focused when it appears -->
            <div
              #notice
              tabindex="-1"
              class="flex flex-col gap-3 outline-none empty:hidden"
            >
              <!-- Error text in alert-ink: the alert's own text-alert is < 4.5:1 on its tint in light mode -->
              @if (pageError()) {
                <sd-alert tone="error"
                  ><span class="text-alert-ink">{{
                    pageError()
                  }}</span></sd-alert
                >
              }
              @if (success()) {
                <sd-alert tone="success"
                  ><span class="text-ink">{{ success() }}</span></sd-alert
                >
              }
            </div>

            <!-- 1. Summary -->
            <section
              class="flex flex-col gap-5 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6"
              aria-labelledby="lab-number"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <span
                    class="flex size-12 shrink-0 items-center justify-center rounded-full bg-teal/10 text-teal-ink"
                    aria-hidden="true"
                  >
                    <sd-icon name="flask-conical" [size]="22" />
                  </span>
                  <div class="flex min-w-0 flex-col">
                    <span class="font-sans text-caption text-slate"
                      >Request number</span
                    >
                    <!-- A break point after each hyphen: never "…-0 / 0001" on a phone. -->
                    <p
                      id="lab-number"
                      class="font-heading text-h5 text-ink [overflow-wrap:anywhere]"
                    >
                      @for (p of numberParts(r.number); track $index) {
                        <span>{{ p }}</span><wbr />
                      }
                    </p>
                  </div>
                </div>
                <span
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1 font-sans text-body-sm font-medium inset-ring inset-ring-current/20"
                  [class]="chip().cls"
                >
                  <sd-icon [name]="chip().icon" [size]="16" />
                  {{ chip().label }}
                </span>
              </div>

              <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div class="flex flex-col gap-1">
                  <dt
                    class="flex items-center gap-1.5 font-sans text-caption text-slate"
                  >
                    <sd-icon name="stethoscope" [size]="14" />Doctor
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">
                    {{ doctorCap() }}
                  </dd>
                  @if (r.doctor.specialty) {
                    <dd class="font-sans text-caption text-slate">
                      {{ r.doctor.specialty }}
                    </dd>
                  }
                </div>
                <div class="flex flex-col gap-1">
                  <dt
                    class="flex items-center gap-1.5 font-sans text-caption text-slate"
                  >
                    <sd-icon name="send" [size]="14" />Date sent
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">
                    {{ day(r.sent_at) }}
                  </dd>
                </div>
                <div class="flex flex-col gap-1">
                  <dt
                    class="flex items-center gap-1.5 font-sans text-caption text-slate"
                  >
                    <sd-icon name="clock" [size]="14" />Priority
                  </dt>
                  <dd class="font-sans text-body font-semibold text-ink">
                    {{ priority() }}
                  </dd>
                </div>
                @if (r.status === 'awaiting_consent' || r.status === 'booked') {
                  <div class="flex flex-col gap-1">
                    <dt
                      class="flex items-center gap-1.5 font-sans text-caption text-slate"
                    >
                      <sd-icon name="calendar-days" [size]="14" />Valid until
                    </dt>
                    <dd class="font-sans text-body font-semibold text-ink">
                      {{ validUntil() }}
                    </dd>
                  </div>
                }
              </dl>

              @if (statAlert(); as stat) {
                <sd-alert tone="warning">
                  <span class="text-ink">{{ stat }}</span>
                </sd-alert>
              } @else if (
                r.priority === 'urgent' &&
                (r.status === 'awaiting_consent' || r.status === 'booked')
              ) {
                <sd-alert tone="info"
                  >Your doctor marked this request urgent. Try to go to a lab
                  today.</sd-alert
                >
              }
            </section>

            <!-- 2. Next step -->
            <section
              #nextStep
              tabindex="-1"
              class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card outline-none sm:p-6"
              aria-labelledby="lab-next-heading"
            >
              @switch (r.status) {
                @case ('awaiting_consent') {
                  <h2
                    id="lab-next-heading"
                    class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                  >
                    <sd-icon name="circle-alert" [size]="20" />Review and accept
                  </h2>
                  <p class="font-sans text-body-sm text-ink">
                    Read what's requested below, then accept to get your request
                    PDF. You choose the lab and pay it directly.
                  </p>
                  <!-- Card CTAs: equal columns where both fit, stacked full width otherwise. -->
                  <div class="sd-cta-row empty:hidden [--sd-cta-min:11rem]">
                    @if (r.can.accept) {
                      <sd-button [full]="true" (click)="openAccept()">
                        <sd-icon
                          name="circle-check"
                          [size]="18"
                          class="inline-flex"
                        />
                        Accept request
                      </sd-button>
                    }
                    @if (r.can.decline) {
                      <sd-button variant="outline" [full]="true" (click)="decline()"
                        >Decline</sd-button
                      >
                    }
                  </div>
                }
                @case ('booked') {
                  <h2
                    id="lab-next-heading"
                    class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                  >
                    <sd-icon name="building-2" [size]="20" />Take this request
                    to a lab
                  </h2>
                  <p class="font-sans text-body-sm text-ink">
                    Any lab or imaging centre can use it. Show the PDF on your
                    phone or print it.
                  </p>
                  @if (plan(); as p) {
                    <p
                      class="flex items-start gap-2 font-sans text-body-sm text-ink"
                    >
                      <sd-icon
                        name="calendar-days"
                        [size]="16"
                        class="mt-0.5 shrink-0 text-slate"
                      />You said: {{ p }}
                    </p>
                  }
                  <div
                    class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-2xl"
                  >
                    @if (r.can.pdf) {
                      <ng-container [ngTemplateOutlet]="pdfButtons" />
                    }
                    @if (r.can.sample) {
                      <sd-button
                        variant="outline"
                        [full]="true"
                        (click)="sampleGiven()"
                      >
                        <sd-icon
                          name="circle-check"
                          [size]="18"
                          class="inline-flex"
                        />
                        I've given my sample
                      </sd-button>
                    }
                    @if (r.can.upload) {
                      <sd-button
                        variant="outline"
                        [full]="true"
                        (click)="openUpload()"
                      >
                        <sd-icon
                          name="upload"
                          [size]="18"
                          class="inline-flex"
                        />
                        Upload result
                      </sd-button>
                    }
                  </div>
                }
                @case ('in_lab') {
                  <h2
                    id="lab-next-heading"
                    class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                  >
                    <sd-icon name="hourglass" [size]="20" />Waiting for your
                    results
                  </h2>
                  <p class="font-sans text-body-sm text-ink">
                    When the lab gives you your result, add it here so
                    {{ doctor() }} can review it.
                  </p>
                  <div
                    class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-2xl"
                  >
                    @if (r.can.upload) {
                      <sd-button [full]="true" (click)="openUpload()">
                        <sd-icon
                          name="upload"
                          [size]="18"
                          class="inline-flex"
                        />
                        Upload result
                      </sd-button>
                    }
                    @if (r.can.pdf) {
                      <sd-button
                        variant="outline"
                        [full]="true"
                        [disabled]="downloading()"
                        (click)="downloadPdf()"
                      >
                        <sd-icon
                          [name]="downloading() ? 'loader-circle' : 'download'"
                          [size]="18"
                          class="inline-flex"
                          [class.animate-spin]="downloading()"
                        />
                        Download PDF
                      </sd-button>
                    }
                  </div>
                }
                @case ('result_ready') {
                  <h2
                    id="lab-next-heading"
                    class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                  >
                    <sd-icon name="file-text" [size]="20" />Your results
                  </h2>
                  <ng-container [ngTemplateOutlet]="results" />
                  @if (r.can.pdf) {
                    <ng-container
                      [ngTemplateOutlet]="laterPdf"
                      [ngTemplateOutletContext]="{ caption: readyPdfCaption }"
                    />
                  }
                }
                @case ('declined') {
                  <h2 id="lab-next-heading" class="sr-only">
                    What happens now
                  </h2>
                  <sd-alert tone="info">
                    You declined this request on {{ day(r.declined_at) }}.
                    @if (r.decline_reason) {
                      <span class="mt-1 block text-ink"
                        >Your reason: {{ r.decline_reason }}</span
                      >
                    }
                    <span class="mt-1 block"
                      >If you change your mind, ask your doctor for a new
                      request.</span
                    >
                  </sd-alert>
                }
                @case ('cancelled') {
                  <h2 id="lab-next-heading" class="sr-only">
                    What happens now
                  </h2>
                  <sd-alert tone="info">
                    {{ doctorCap() }} cancelled this request on
                    {{ day(r.cancelled_at) }}.
                    @if (r.cancel_reason) {
                      <span class="mt-1 block text-ink"
                        >Reason: {{ r.cancel_reason }}</span
                      >
                    }
                  </sd-alert>
                  @if (r.sample_at) {
                    <p class="font-sans text-body-sm text-ink">
                      Already gave your sample? You can still add the result.
                    </p>
                    @if (r.can.upload) {
                      <sd-button class="w-full whitespace-nowrap" [full]="true" (click)="openUpload()">
                        <sd-icon
                          name="upload"
                          [size]="18"
                          class="inline-flex"
                        />
                        Upload result
                      </sd-button>
                    }
                  }
                }
                @case ('expired') {
                  <h2 id="lab-next-heading" class="sr-only">
                    What happens now
                  </h2>
                  <sd-alert tone="info"
                    >This request has expired. It was valid until
                    {{ validUntil() }}.</sd-alert
                  >
                  @if (r.consent) {
                    <p class="font-sans text-body-sm text-ink">
                      Got your result anyway? You can still add it.
                    </p>
                    @if (r.can.upload) {
                      <sd-button class="w-full whitespace-nowrap" [full]="true" (click)="openUpload()">
                        <sd-icon
                          name="upload"
                          [size]="18"
                          class="inline-flex"
                        />
                        Upload result
                      </sd-button>
                    }
                  }
                  <!-- E12: an accepted request keeps its PDF after it expires (marked EXPIRED) -->
                  @if (r.can.pdf) {
                    <ng-container
                      [ngTemplateOutlet]="laterPdf"
                      [ngTemplateOutletContext]="{ caption: '' }"
                    />
                  }
                }
              }
              <div aria-live="polite" class="flex flex-col gap-3 empty:hidden">
                @if (actionError()) {
                  <sd-alert tone="error"
                    ><span class="text-alert-ink">{{
                      actionError()
                    }}</span></sd-alert
                  >
                }
                @if (actionNote()) {
                  <sd-alert tone="info">{{ actionNote() }}</sd-alert>
                }
              </div>
            </section>

            <!-- 3. Tests requested -->
            <section
              class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6"
              aria-labelledby="lab-tests-heading"
            >
              <div class="flex flex-col gap-1">
                <h2
                  id="lab-tests-heading"
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="flask-conical" [size]="20" />Tests requested
                </h2>
                <p class="font-sans text-caption text-slate">
                  Your request PDF also includes clinical details from your
                  doctor for the lab.
                </p>
              </div>
              @if (r.clinical_question) {
                <div class="flex flex-col gap-1">
                  <h3 class="font-sans text-caption text-slate">
                    Reason for the tests
                  </h3>
                  <p
                    class="whitespace-pre-line break-words font-sans text-body-sm text-ink"
                  >
                    {{ r.clinical_question }}
                  </p>
                </div>
              }
              @for (g of groups(); track g.kind) {
                <div class="flex flex-col gap-2">
                  <h3 class="font-sans text-body-sm font-semibold text-ink">
                    {{ g.title }} ({{ g.items.length }})
                  </h3>
                  <ul class="flex flex-col gap-2">
                    @for (item of g.items; track item.id) {
                      <li
                        class="flex flex-col gap-0.5 rounded-field border border-cloud px-3 py-2"
                      >
                        <span
                          class="break-words font-sans text-body-sm text-ink"
                          >{{ item.label }}</span
                        >
                        @if (caption(item); as c) {
                          <span class="font-sans text-caption text-slate">{{
                            c
                          }}</span>
                        }
                      </li>
                    }
                  </ul>
                </div>
              }
            </section>

            <!-- 4. How to prepare -->
            @if (r.instructions.length > 0) {
              <section
                class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6"
                aria-labelledby="lab-prepare-heading"
              >
                <h2
                  id="lab-prepare-heading"
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="clipboard-list" [size]="20" />How to prepare
                </h2>
                <ul class="flex flex-col gap-3">
                  @for (ins of r.instructions; track ins.key) {
                    <li class="flex flex-col gap-0.5">
                      <span
                        class="font-sans text-body-sm font-semibold text-ink"
                        >{{ ins.title }}</span
                      >
                      <span class="font-sans text-body-sm text-ink">{{
                        ins.text
                      }}</span>
                    </li>
                  }
                </ul>
              </section>
            }

            <!-- 5. Results (in the next-step card while the request is result-ready) -->
            @if (r.status !== 'result_ready' && r.results.length > 0) {
              <section
                class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6"
                aria-labelledby="lab-results-heading"
              >
                <h2
                  id="lab-results-heading"
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="file-text" [size]="20" />Results
                </h2>
                <ng-container [ngTemplateOutlet]="results" />
              </section>
            }

            <!-- 6. Timeline -->
            <section
              class="flex flex-col gap-4 rounded-card border border-haze bg-white p-5 shadow-card sm:p-6"
              aria-labelledby="lab-timeline-heading"
            >
              <h2
                id="lab-timeline-heading"
                class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
              >
                <sd-icon name="history" [size]="20" />Timeline
              </h2>
              <ol class="flex flex-col gap-3">
                @for (s of timeline(); track s.key) {
                  <li class="flex items-start gap-3">
                    <sd-icon
                      [name]="s.done ? 'circle-check' : 'circle'"
                      [size]="18"
                      class="mt-0.5 shrink-0"
                      [class]="s.done ? 'text-teal-ink' : 'text-slate'"
                    />
                    <span class="flex min-w-0 flex-col">
                      <span
                        class="font-sans text-body-sm"
                        [class]="
                          s.done ? 'font-semibold text-ink' : 'text-slate'
                        "
                      >
                        @if (!s.done) {
                          <span class="sr-only">Not yet: </span>
                        }
                        {{ s.label }}
                      </span>
                      @if (s.at) {
                        <span class="font-sans text-caption text-slate">{{
                          s.at
                        }}</span>
                      }
                      @if (s.note) {
                        <span class="font-sans text-caption text-slate">{{
                          s.note
                        }}</span>
                      }
                    </span>
                  </li>
                }
              </ol>
            </section>

            <!-- The PDF buttons (booked: Download is the primary action; quiet: both secondary) -->
            <ng-template #pdfButtons let-quiet="quiet">
              <sd-button
                [variant]="quiet ? 'outline' : 'primary'"
                [full]="true"
                [disabled]="downloading()"
                (click)="downloadPdf()"
              >
                <sd-icon
                  [name]="downloading() ? 'loader-circle' : 'download'"
                  [size]="18"
                  class="inline-flex"
                  [class.animate-spin]="downloading()"
                />
                Download PDF
              </sd-button>
              <sd-button
                variant="secondary"
                [full]="true"
                (click)="viewPdf($event)"
              >
                <sd-icon name="eye" [size]="18" class="inline-flex" />
                View PDF
              </sd-button>
            </ng-template>

            <!-- The request PDF once the main step has moved on (result ready, expired):
                 with several tests a lab may still need it (E12, U1) -->
            <ng-template #laterPdf let-caption="caption">
              <div
                class="flex flex-col gap-3 border-t border-haze pt-4"
                role="group"
                aria-labelledby="lab-pdf-heading"
              >
                <div class="flex flex-col gap-1">
                  <h3
                    id="lab-pdf-heading"
                    class="font-sans text-body-sm font-semibold text-ink"
                  >
                    Your request PDF
                  </h3>
                  @if (caption) {
                    <p class="font-sans text-caption text-slate">
                      {{ caption }}
                    </p>
                  }
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-2xl">
                  <ng-container
                    [ngTemplateOutlet]="pdfButtons"
                    [ngTemplateOutletContext]="{ quiet: true }"
                  />
                </div>
              </div>
            </ng-template>

            <!-- The results list (help line, availability, rows, review) -->
            <ng-template #results>
              <div
                class="flex flex-col gap-3 rounded-field bg-glacier p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <p
                  class="flex items-start gap-2 font-sans text-body-sm text-ink"
                >
                  <sd-icon
                    name="circle-alert"
                    [size]="18"
                    class="mt-0.5 shrink-0 text-cerulean"
                  />
                  Worried about a result or feeling unwell? Don't wait for the
                  review — book a consultation, or go to the nearest emergency
                  department if it's urgent.
                </p>
                @if (r.doctor_available) {
                  <a
                    [routerLink]="['/dashboard/appointments/book', r.doctor.id]"
                    class="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-field bg-cerulean px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark sm:w-fit"
                  >
                    <sd-icon name="calendar-plus" [size]="16" />
                    Book a follow-up
                  </a>
                } @else {
                  <a
                    routerLink="/dashboard/specialists"
                    class="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-field bg-cerulean px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark sm:w-fit"
                  >
                    <sd-icon name="calendar-plus" [size]="16" />
                    Book a consultation
                  </a>
                }
              </div>
              @if (!r.doctor_available) {
                <sd-alert tone="warning">
                  <span class="text-ink">
                    {{ doctorCap() }} isn't available on VideoMed right now, so
                    they can't review this result. Book another doctor to go
                    through it.
                  </span>
                  <a
                    routerLink="/dashboard/specialists"
                    class="mt-2 flex w-fit items-center gap-1 font-semibold text-cerulean hover:underline"
                  >
                    <sd-icon name="stethoscope" [size]="16" />
                    Book another doctor
                  </a>
                </sd-alert>
              }
              <ul class="flex flex-col gap-3" aria-label="Result files">
                @for (res of r.results; track res.id; let i = $index) {
                  <li
                    class="flex flex-col gap-3 rounded-field border border-cloud p-3 sm:p-4"
                  >
                    <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <div class="flex min-w-0 flex-1 items-start gap-3">
                        <span
                          class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal-ink"
                          aria-hidden="true"
                        >
                          <sd-icon name="file-text" [size]="18" />
                        </span>
                        <span class="flex min-w-0 flex-col gap-0.5">
                          <span
                            class="break-words font-sans text-body-sm font-semibold text-ink"
                            >{{ res.document.title }}</span
                          >
                          <span class="font-sans text-caption text-slate">{{
                            resultMeta(res)
                          }}</span>
                          @if (covers(res); as c) {
                            <span class="font-sans text-caption text-slate">{{
                              c
                            }}</span>
                          }
                          @if (rowCaption(res); as c) {
                            <span class="font-sans text-caption text-ink">{{
                              c
                            }}</span>
                          }
                        </span>
                      </div>
                      <div class="flex shrink-0 pl-12 sm:pl-0">
                        <button
                          type="button"
                          class="sd-pill sd-pill-c border border-haze bg-white text-cerulean shadow-control hover:border-cerulean active:shadow-none"
                          [attr.aria-label]="'View ' + res.document.title"
                          (click)="viewResult(i, $event)"
                        >
                          <sd-icon name="eye" [size]="14" />View
                        </button>
                      </div>
                    </div>
                    @if (res.review; as review) {
                      <div
                        class="flex flex-col gap-1 rounded-field bg-glacier p-3"
                      >
                        <p
                          class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink"
                        >
                          <sd-icon
                            name="stethoscope"
                            [size]="16"
                            class="shrink-0 text-cerulean"
                          />Reviewed by your doctor
                        </p>
                        <p class="font-sans text-caption text-slate">
                          {{ day(review.reviewed_at) }}
                        </p>
                        @if (review.comment) {
                          <p
                            class="whitespace-pre-line break-words font-sans text-body-sm text-ink"
                          >
                            {{ review.comment }}
                          </p>
                        }
                      </div>
                    } @else if (res.reviewable) {
                      <p class="font-sans text-caption text-slate">
                        Waiting for {{ doctor() }} to review
                      </p>
                    }
                  </li>
                }
              </ul>
              @if (r.status === 'result_ready' && r.can.upload) {
                <sd-button
                  variant="outline"
                  class="w-full whitespace-nowrap"
                  [full]="true"
                  (click)="openUpload()"
                >
                  <sd-icon name="upload" [size]="18" class="inline-flex" />
                  Upload another result
                </sd-button>
              }
            </ng-template>

            @if (acceptOpen()) {
              <pat-lab-accept-dialog
                [request]="r"
                (accepted)="onAccepted($event)"
                (stale)="reload(true)"
                (refused)="onRefused({ message: $event })"
                (closed)="acceptClosed()"
              />
            }
            @if (uploadOpen()) {
              <pat-lab-result-upload-dialog
                [request]="r"
                (uploaded)="onUploaded($event)"
                (refused)="onRefused($event)"
                (closed)="uploadClosed()"
              />
            }
          }
        }
      }
    </div>
  `,
})
export class LabRequestDetails {
  protected readonly readyPdfCaption = LAB_READY_PDF_CAPTION;
  protected readonly numberParts = numberParts;
  private readonly api = inject(LabRequestsApi);
  private readonly documents = inject(DocumentsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialogs = inject(DialogService);
  private readonly viewer = inject(DocumentViewerService);
  private readonly zone = viewerTimeZone();
  private readonly noticeEl = viewChild<ElementRef<HTMLElement>>('notice');
  private readonly nextStepEl = viewChild<ElementRef<HTMLElement>>('nextStep');
  private readonly uploadDialog = viewChild(LabResultUploadDialog);

  protected readonly req = signal<PatientLabRequestDto | null>(null);
  private readonly loading = signal(true);
  private readonly notFound = signal(false);
  /** The API's reason the request failed to load ('' when it hasn't). */
  protected readonly loadError = signal('');

  protected readonly downloading = signal(false);
  protected readonly actionError = signal('');
  protected readonly actionNote = signal('');
  /** Page-level outcome (accepted, a result added) — focused when it appears. */
  protected readonly success = signal('');
  protected readonly pageError = signal('');
  protected readonly acceptOpen = signal(false);
  protected readonly uploadOpen = signal(false);

  private id = '';
  private loadSub: Subscription | null = null;
  private downloadSub: Subscription | null = null;
  /** After the dialog closes, focus this (the outcome notice). */
  private focusNoticeOnClose = false;

  protected readonly viewState = computed<
    'loading' | 'not-found' | 'error' | 'ready'
  >(() => {
    if (this.loading() && !this.req()) return 'loading';
    if (this.loadError()) return this.notFound() ? 'not-found' : 'error';
    return 'ready';
  });

  protected readonly chip = computed(() =>
    labChip(
      this.req() ?? {
        status: 'awaiting_consent',
        reviewed: false,
        awaiting_review: false,
        results_count: 0,
      },
    ),
  );
  protected readonly doctor = computed(() => {
    const r = this.req();
    return r ? labDoctor(r) : 'your doctor';
  });
  protected readonly doctorCap = computed(() => {
    const r = this.req();
    return r ? labDoctorCap(r) : 'Your doctor';
  });
  protected readonly priority = computed(() =>
    priorityDetail(this.req()?.priority),
  );
  protected readonly validUntil = computed(() =>
    calendarDate(this.req()?.valid_until),
  );
  /**
   * The STAT safety line ('' when none): the full alert while the patient still
   * has to go to a lab, then only the emergency sentence until a result is in
   * (the Results card's help line takes over from there).
   */
  protected readonly statAlert = computed(() => {
    const r = this.req();
    if (r?.priority !== 'stat') return '';
    if (r.status === 'awaiting_consent' || r.status === 'booked') {
      return LAB_STAT_ALERT;
    }
    return r.status === 'in_lab' ? LAB_STAT_ALERT_IN_LAB : '';
  });
  protected readonly groups = computed(() =>
    itemGroups(this.req()?.items ?? []),
  );
  protected readonly timeline = computed(() => {
    const r = this.req();
    return r ? labTimeline(r, this.zone) : [];
  });
  /** "Synlab Ikeja · 6 Nov 2026" — what the patient said at acceptance ('' when nothing). */
  protected readonly plan = computed(() => {
    const r = this.req();
    if (!r) return '';
    return [r.lab_name?.trim() ?? '', calendarDate(r.lab_date)]
      .filter(Boolean)
      .join(' · ');
  });

  constructor() {
    this.route.paramMap
      .pipe(
        map((p) => p.get('id') ?? ''),
        distinctUntilChanged(),
        takeUntilDestroyed(),
      )
      .subscribe((id) => {
        this.id = id;
        this.req.set(null);
        this.clearNotes();
        this.load();
      });
  }

  // ----- leaving -----

  /** The route guard: leaving while a result is uploading asks first. */
  canLeave(): boolean | Promise<boolean> {
    const dialog = this.uploadDialog();
    if (!dialog?.uploading()) return true;
    return this.dialogs.confirmLeave(dialog.leaveCopy());
  }

  // ----- display helpers -----

  protected day(iso: string | null | undefined): string {
    return labDay(iso, this.zone) || '—';
  }

  protected caption(item: PatientLabRequestDto['items'][number]): string {
    return itemCaption(item);
  }

  protected covers(res: PatientLabResultDto): string {
    return coversLabel(res, this.req()?.items ?? []);
  }

  protected rowCaption(res: PatientLabResultDto): string | null {
    const r = this.req();
    return r ? resultCaption(r, res) : null;
  }

  protected resultMeta(res: PatientLabResultDto): string {
    const added = labDay(res.uploaded_at, this.zone);
    return [
      res.document.type_label,
      res.document.size_label,
      added ? `Added ${added}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // ----- loading -----

  /** `keepNotes`: a reload after a refusal keeps the message that explains it. */
  reload(keepNotes = false): void {
    if (!keepNotes) this.clearNotes();
    this.load();
  }

  private clearNotes(): void {
    this.actionError.set('');
    this.actionNote.set('');
    this.success.set('');
    this.pageError.set('');
  }

  private load(after?: () => void): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    this.notFound.set(false);
    if (!this.id) {
      this.req.set(null);
      this.notFound.set(true);
      this.loadError.set("We couldn't find this lab request.");
      this.loading.set(false);
      return;
    }
    this.loadSub = this.api
      .mineOne(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.req.set(res.data);
          this.loading.set(false);
          after?.();
        },
        error: (err: unknown) => {
          const code = httpStatus(err);
          const missing = code === 404 || code === 403;
          this.req.set(null);
          this.notFound.set(missing);
          this.loadError.set(
            apiErrorMessage(
              err,
              missing
                ? "We couldn't find this lab request. It may belong to another account, or the link may be wrong."
                : "We couldn't load this lab request. Check your connection and try again.",
            ),
          );
          this.loading.set(false);
        },
      });
  }

  // ----- accept / decline / sample -----

  protected openAccept(): void {
    this.clearNotes();
    this.acceptOpen.set(true);
  }

  protected onAccepted(dto: PatientLabRequestDto): void {
    this.req.set(dto);
    this.success.set(LAB_ACCEPTED);
    this.focusNoticeOnClose = true;
  }

  protected acceptClosed(): void {
    this.acceptOpen.set(false);
    this.focusAfterDialog();
  }

  protected async decline(): Promise<void> {
    const r = this.req();
    if (!r) return;
    this.clearNotes();
    await this.confirmThenReload(
      {
        title: 'Decline this lab request?',
        message: `${labDoctorCap(r)} will be told you declined. To do these tests later, you'd need a new request.`,
        tone: 'warning',
        reason: { label: 'Reason', required: false, maxLength: 500 },
        confirmLabel: 'Decline request',
        cancelLabel: 'Keep request',
      },
      (reason) => this.api.decline(r.id, reason),
    );
  }

  protected async sampleGiven(): Promise<void> {
    const r = this.req();
    if (!r) return;
    this.clearNotes();
    await this.confirmThenReload(
      {
        title: 'Mark your sample as given?',
        message: `Do this after the lab has taken your sample or done your scan. ${labDoctorCap(r)} will see that you have been to the lab.`,
        confirmLabel: "Yes, I've given my sample",
        cancelLabel: 'Not yet',
      },
      () => this.api.sampleGiven(r.id),
    );
  }

  /**
   * Ask, run the step, then reload the request (`mineOne`). Also reloads when
   * the dialog showed a 409 refusal and the patient closed it (cancelled or
   * expired meanwhile, or already done): the page must not keep offering a
   * step that no longer applies. Other failures (offline, a 5xx) keep the page.
   */
  private async confirmThenReload(
    options: Omit<ConfirmOptions, 'action'>,
    step: (reason?: string) => Observable<unknown>,
  ): Promise<void> {
    let changed = false;
    const { confirmed } = await this.dialogs.confirm({
      ...options,
      action: (reason) =>
        step(reason).pipe(
          tap({
            error: (err: unknown) => {
              if (httpStatus(err) === 409) changed = true;
            },
          }),
        ),
    });
    if (confirmed || changed) this.load(() => this.focusNextStep());
  }

  // ----- the PDF -----

  /** View: the request PDF in the shared document viewer (print and download from there). */
  protected viewPdf(event?: Event): void {
    const r = this.req();
    if (!r) return;
    this.actionError.set('');
    this.actionNote.set('');
    this.viewer.open(
      myLabRequestPdfSource(this.api, r, () => this.reload(true), this.zone),
      { opener: openerOf(event) },
    );
  }

  /**
   * Download: mint a download link (one `lab_request.downloaded` row), fetch
   * it with HttpClient and save it from a same-origin object URL — never a
   * cross-origin `<a href download>`, which would navigate on an error body.
   */
  protected downloadPdf(): void {
    const r = this.req();
    if (!r || this.downloading()) return;
    this.downloading.set(true);
    this.actionError.set('');
    this.actionNote.set('');
    let filename = '';
    this.downloadSub?.unsubscribe();
    this.downloadSub = saveSignedLink(
      this.api.myLink(r.id, true).pipe(
        map((res) => {
          filename =
            res.data.filename || safeFilename(`Lab request ${r.number}`, 'pdf');
          return { url: res.data.url, filename };
        }),
      ),
      (url) => this.api.fileBlob({ url } as LabRequestLinkDto),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.downloading.set(false);
          this.actionNote.set(`Your download has started (${filename}).`);
        },
        error: (err: unknown) => {
          this.downloading.set(false);
          if (statusChanged(err)) {
            this.actionError.set(apiErrorMessage(err, LAB_PDF_ERROR));
            this.reload(true);
            return;
          }
          this.actionError.set(LAB_PDF_ERROR);
        },
      });
  }

  // ----- results -----

  /** A result's View: the viewer over every result of the request, at this one. */
  protected viewResult(index: number, event?: Event): void {
    const r = this.req();
    if (!r) return;
    const sources = r.results.map((res) =>
      myLabResultSource(this.documents, res, this.zone),
    );
    this.viewer.open(sources, {
      index,
      opener: openerOf(event),
      listLabel: "this request's results",
    });
  }

  protected openUpload(): void {
    this.clearNotes();
    this.uploadOpen.set(true);
  }

  protected onUploaded(done: LabResultUploadedDto): void {
    const r = done.request ?? this.req();
    if (done.request) this.req.set(done.request);
    this.success.set(
      uploadOutcomeMessage(done.result.share_outcome, r?.doctor?.name),
    );
    this.focusNoticeOnClose = true;
  }

  protected onRefused(refusal: LabUploadRefused): void {
    this.pageError.set(refusal.message);
    this.focusNoticeOnClose = true;
    this.reload(true);
  }

  protected uploadClosed(): void {
    this.uploadOpen.set(false);
    this.focusAfterDialog();
  }

  // ----- focus -----

  /** After a dialog: its outcome when there is one (the control that opened it may be gone). */
  private focusAfterDialog(): void {
    if (!this.focusNoticeOnClose) return;
    this.focusNoticeOnClose = false;
    afterNextRender(() => this.noticeEl()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** After declining or giving the sample: the step that changed (its buttons are gone). */
  private focusNextStep(): void {
    afterNextRender(() => this.nextStepEl()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
