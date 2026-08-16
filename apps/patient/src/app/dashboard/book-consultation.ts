import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AppointmentsApi, SpecialistsApi } from '@supadoc/data-access';
import type { DayAvailability, SpecialistDto } from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/**
 * Book a Consultation (Figma) — a 5-step wizard: date/time, consultation type,
 * reason, optional supporting document, and a booking summary that creates the
 * appointment (payment is a later step, so it's created unpaid). Driven by the
 * specialist's real availability.
 */
@Component({
  selector: 'pat-book-consultation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-8 py-2">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Book a Consultation</h1>
          <p class="font-sans text-body text-slate">
            Schedule an appointment with your preferred specialist
          </p>
        </div>
        <a
          routerLink="/dashboard/specialists"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
        >
          <sd-icon name="arrow-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      <!-- Stepper -->
      <div class="mx-auto flex items-center">
        @for (n of steps; track n; let last = $last) {
          <span
            class="flex size-9 items-center justify-center rounded-full font-sans text-body-sm font-semibold transition-colors"
            [class]="
              n < step()
                ? 'bg-sage text-white'
                : n === step()
                  ? 'bg-cerulean text-white'
                  : 'bg-cerulean/20 text-cerulean'
            "
          >
            @if (n < step()) {
              <sd-icon name="check" [size]="18" />
            } @else {
              {{ n }}
            }
          </span>
          @if (!last) {
            <span
              class="h-0.5 w-10 md:w-16"
              [class]="n < step() ? 'bg-sage' : 'bg-cerulean/20'"
            ></span>
          }
        }
      </div>

      @if (loadError()) {
        <div class="flex flex-col items-center gap-4 py-16 text-center">
          <sd-icon name="wifi-off" [size]="36" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">
            Could not load this specialist.
          </p>
          <a routerLink="/dashboard/specialists"
            ><sd-button size="sm">Back to specialists</sd-button></a
          >
        </div>
      } @else if (specialist(); as s) {
        <!-- Step 1: date & time -->
        @if (step() === 1) {
          <div
            class="rounded-card border border-cloud bg-white p-6 shadow-[0_1px_3px_rgba(10,22,40,0.06)]"
          >
            <div class="flex flex-wrap items-start gap-4">
              <span
                class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h4 text-cerulean"
                >{{ initials() }}</span
              >
              <div class="flex min-w-0 flex-col gap-1">
                <span
                  class="flex items-center gap-1.5 font-heading text-h5 text-ink"
                >
                  {{ s.name }}
                  @if (s.verified) {
                    <sd-icon
                      name="circle-check"
                      [size]="18"
                      class="text-cerulean"
                    />
                  }
                </span>
                <span class="font-sans text-body-sm text-cerulean">{{
                  s.specialty
                }}</span>
                <span
                  class="flex items-center gap-1 font-sans text-caption text-slate"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#f2a900">
                    <path
                      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                    />
                  </svg>
                  {{ rating() }} ({{ s.reviews_count }} reviews)
                </span>
              </div>
            </div>
            <div
              class="mt-5 grid grid-cols-2 gap-4 border-t border-cloud pt-5 font-sans text-caption md:grid-cols-4"
            >
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="languages" [size]="14" />Languages</span
                >
                <span class="text-ink">{{ s.languages ?? '—' }}</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="map-pin" [size]="14" />Location</span
                >
                <span class="text-ink">{{ s.location ?? '—' }}</span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="briefcase" [size]="14" />Experience</span
                >
                <span class="text-ink"
                  >{{ s.years_experience ?? '—' }} years</span
                >
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="flex items-center gap-1.5 text-slate"
                  ><sd-icon name="user" [size]="14" />Gender</span
                >
                <span class="text-ink capitalize">{{ s.gender ?? '—' }}</span>
              </div>
            </div>
          </div>

          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-4 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >1</span
              >Choose Date &amp; Time
            </h2>
            @if (loadingSlots()) {
              <div
                class="h-28 animate-pulse rounded-card border border-cloud bg-cloud/40"
              ></div>
            } @else if (days().length === 0) {
              <div
                class="flex items-center gap-2 rounded-card border border-cloud bg-glacier/60 px-4 py-3 font-sans text-caption text-slate"
              >
                <sd-icon name="calendar-off" [size]="16" />No open slots in the
                next two weeks.
              </div>
            } @else {
              <div class="rounded-card border border-cloud bg-glacier/50 p-4">
                <div class="mb-3 flex items-center justify-between gap-2">
                  <span
                    class="flex items-center gap-1.5 font-sans text-caption font-semibold text-cerulean"
                    ><sd-icon name="calendar-clock" [size]="16" />Next
                    Available</span
                  >
                  <span class="font-sans text-caption font-medium text-ink">{{
                    selectedSummary()
                  }}</span>
                </div>
                <div class="flex gap-2 overflow-x-auto pb-1">
                  @for (d of days(); track d.date) {
                    <button
                      type="button"
                      class="flex shrink-0 flex-col items-center rounded-field border px-4 py-2 transition-colors"
                      [class]="
                        selectedDate() === d.date
                          ? 'border-cerulean bg-cerulean text-white'
                          : 'border-cloud bg-white text-slate hover:border-cerulean/50'
                      "
                      (click)="pickDate(d)"
                    >
                      <span class="font-sans text-[10px] uppercase">{{
                        d.weekday
                      }}</span>
                      <span class="font-sans text-body-sm font-semibold">{{
                        d.day
                      }}</span>
                    </button>
                  }
                </div>
                <div class="mt-3 flex flex-wrap gap-2">
                  @for (t of selectedDaySlots(); track t.iso) {
                    <button
                      type="button"
                      class="rounded-field border px-3 py-1 font-sans text-caption transition-colors"
                      [class]="
                        selectedTime() === t.iso
                          ? 'border-cerulean bg-cerulean text-white'
                          : 'border-cloud bg-white text-slate hover:border-cerulean/50'
                      "
                      (click)="selectedTime.set(t.iso)"
                    >
                      {{ t.label }}
                    </button>
                  }
                </div>
              </div>
            }
          </div>

          <div class="flex justify-end">
            <sd-button [disabled]="!selectedTime()" (click)="next()">
              Continue <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
          </div>
        }

        <!-- Step 2: consultation type -->
        @if (step() === 2) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-4 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >2</span
              >Select Consultation Type
            </h2>
            <button
              type="button"
              class="flex w-full items-start gap-4 rounded-card border-2 border-cerulean bg-frost/30 p-5 text-left"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-field bg-frost text-cerulean"
                ><sd-icon name="video" [size]="22" /></span
              >
              <span class="flex flex-1 flex-col gap-1">
                <span class="flex items-center gap-2">
                  <span class="font-sans text-body font-semibold text-ink"
                    >Online</span
                  >
                  <span
                    class="rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-[10px] font-medium text-sage"
                    >Recommended</span
                  >
                </span>
                <span class="font-sans text-body-sm text-slate"
                  >Meet with the doctor online via secure video call</span
                >
              </span>
              <sd-icon name="circle-check" [size]="22" class="text-cerulean" />
            </button>
            <div
              class="mt-4 flex w-full items-start gap-4 rounded-card border border-cloud bg-cloud/20 p-5 opacity-70"
            >
              <span
                class="flex size-11 shrink-0 items-center justify-center rounded-field bg-cloud text-slate"
                ><sd-icon name="building-2" [size]="22" /></span
              >
              <span class="flex flex-1 flex-col gap-1">
                <span class="flex items-center gap-2">
                  <span class="font-sans text-body font-semibold text-slate"
                    >In-person</span
                  >
                  <span
                    class="rounded-pill bg-frost px-2.5 py-0.5 font-sans text-[10px] font-medium text-cerulean"
                    >Coming soon</span
                  >
                </span>
                <span class="font-sans text-body-sm text-slate"
                  >Visit the doctor at their clinic or hospital</span
                >
              </span>
            </div>
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 3: reason -->
        @if (step() === 3) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-4 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >3</span
              >Reasons for Consultation
            </h2>
            <textarea
              rows="6"
              maxlength="500"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
              placeholder="Briefly describe your symptoms or reason for the visit…"
              class="w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
            ></textarea>
            <div class="mt-1 text-right font-sans text-caption text-slate">
              {{ reason().length }}/500
            </div>
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 4: document -->
        @if (step() === 4) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <div class="mb-4 flex items-center justify-between">
              <h2 class="font-heading text-h5 text-cerulean">
                <span
                  class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                  >4</span
                >Upload Supporting Document
                <span class="font-sans text-body-sm font-normal text-slate"
                  >(Optional)</span
                >
              </h2>
              <button
                type="button"
                class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                (click)="skipDocument()"
              >
                Skip
              </button>
            </div>

            @if (docUrl()) {
              <div
                class="flex items-center gap-3 rounded-card border border-sage/40 bg-sage/5 px-4 py-3"
              >
                <sd-icon name="circle-check" [size]="20" class="text-sage" />
                <span class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink"
                  >{{ docName() }}</span
                >
                <button
                  type="button"
                  class="shrink-0 font-sans text-caption font-semibold text-alert hover:underline"
                  (click)="removeDocument()"
                >
                  Remove
                </button>
              </div>
            } @else {
              <button
                type="button"
                class="flex w-full flex-col items-center gap-2 rounded-card border border-dashed border-cloud bg-glacier/40 px-4 py-10 text-center transition-colors hover:border-cerulean/50 disabled:opacity-60"
                [disabled]="uploadingDoc()"
                (click)="docInput.click()"
              >
                @if (uploadingDoc()) {
                  <span
                    class="size-6 animate-spin rounded-full border-2 border-cloud border-t-cerulean"
                  ></span>
                  <span class="font-sans text-body-sm text-slate">Uploading…</span>
                } @else {
                  <sd-icon name="upload" [size]="26" class="text-slate" />
                  <span class="font-sans text-body font-semibold text-ink"
                    >Click to upload or drag and drop</span
                  >
                  <span class="font-sans text-caption text-slate"
                    >Supported format: PNG or JPG, up to 5MB</span
                  >
                }
              </button>
            }
            @if (docError()) {
              <p
                class="mt-2 rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert"
              >
                {{ docError() }}
              </p>
            }
            <input
              #docInput
              type="file"
              accept="image/png,image/jpeg"
              class="hidden"
              (change)="onDocumentSelected($event)"
            />
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 5: summary -->
        @if (step() === 5) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >5</span
              >Booking Summary
            </h2>
            <div class="flex items-center gap-4">
              <span
                class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 text-cerulean"
                >{{ initials() }}</span
              >
              <div class="flex flex-col">
                <span
                  class="flex items-center gap-1.5 font-heading text-body font-semibold text-ink"
                  >{{ s.name }}
                  @if (s.verified) {
                    <sd-icon
                      name="circle-check"
                      [size]="16"
                      class="text-cerulean"
                    />
                  }</span
                >
                <span class="font-sans text-caption text-cerulean">{{
                  s.specialty
                }}</span>
              </div>
            </div>
            <dl
              class="mt-5 flex flex-col gap-3 border-t border-cloud pt-5 font-sans text-body-sm"
            >
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="calendar-days" [size]="16" />Date
                </dt>
                <dd class="text-right text-ink">{{ summaryDate() }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="clock" [size]="16" />Time
                </dt>
                <dd class="text-right text-ink">{{ summaryTime() }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="video" [size]="16" />Consultation Type
                </dt>
                <dd class="text-right text-ink">Online Video Consultation</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="clipboard-list" [size]="16" />Reason
                </dt>
                <dd class="max-w-[60%] text-right text-ink">
                  {{ reason() || '—' }}
                </dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="flex items-center gap-2 text-slate">
                  <sd-icon name="file-text" [size]="16" />Supporting Document
                </dt>
                <dd class="text-right text-ink">
                  {{ docUrl() ? '1 document uploaded' : 'None' }}
                </dd>
              </div>
            </dl>
            <div
              class="mt-5 flex items-center justify-between border-t border-cloud pt-4"
            >
              <span class="font-sans text-body font-semibold text-cerulean"
                >Consultation Fee</span
              >
              <span class="font-sans text-h5 font-semibold text-cerulean"
                >\${{ s.consultation_fee }}</span
              >
            </div>
          </div>

          <div class="flex flex-wrap justify-between gap-3">
            <sd-button variant="outline" (click)="back()"
              >Back to previous</sd-button
            >
            <sd-button (click)="next()">
              Continue to payment <sd-icon name="arrow-right" [size]="18" />
            </sd-button>
          </div>
          <p
            class="flex items-center justify-center gap-1.5 font-sans text-caption text-slate"
          >
            <sd-icon name="lock" [size]="14" />Secure payment will be processed
            next
          </p>
        }

        <!-- Step 6: payment (stub, skippable) -->
        @if (step() === 6) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >6</span
              >Payment Summary
            </h2>
            <div class="flex flex-col gap-3 font-sans text-body-sm">
              <div class="flex justify-between">
                <span class="text-slate">Consultation Fee</span>
                <span class="text-ink">\${{ s.consultation_fee }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-slate">Platform Fee</span>
                <span class="text-ink"
                  >\${{ platformFee.toFixed(2) }}</span
                >
              </div>
              <div
                class="flex justify-between border-t border-cloud pt-3 font-semibold"
              >
                <span class="text-ink">Total</span>
                <span class="text-cerulean">\${{ total().toFixed(2) }}</span>
              </div>
            </div>

            <h3 class="mb-3 mt-6 font-heading text-body font-semibold text-cerulean">
              Select Payment Method
            </h3>
            <div class="flex flex-col gap-3">
              <button
                type="button"
                class="flex items-center gap-3 rounded-card border p-4 text-left transition-colors"
                [class]="
                  paymentMethod() === 'wallet'
                    ? 'border-cerulean bg-frost/30'
                    : 'border-cloud hover:border-cerulean/50'
                "
                (click)="paymentMethod.set('wallet')"
              >
                <span
                  class="flex size-5 shrink-0 items-center justify-center rounded-full border-2"
                  [class]="
                    paymentMethod() === 'wallet'
                      ? 'border-cerulean'
                      : 'border-cloud'
                  "
                >
                  @if (paymentMethod() === 'wallet') {
                    <span class="size-2.5 rounded-full bg-cerulean"></span>
                  }
                </span>
                <span class="flex-1 font-sans text-body font-semibold text-ink"
                  >Wallet Balance</span
                >
                <span class="font-sans text-caption text-slate"
                  >Coming soon</span
                >
              </button>
              <button
                type="button"
                class="flex items-center gap-3 rounded-card border p-4 text-left transition-colors"
                [class]="
                  paymentMethod() === 'paystack'
                    ? 'border-cerulean bg-frost/30'
                    : 'border-cloud hover:border-cerulean/50'
                "
                (click)="paymentMethod.set('paystack')"
              >
                <span
                  class="flex size-5 shrink-0 items-center justify-center rounded-full border-2"
                  [class]="
                    paymentMethod() === 'paystack'
                      ? 'border-cerulean'
                      : 'border-cloud'
                  "
                >
                  @if (paymentMethod() === 'paystack') {
                    <span class="size-2.5 rounded-full bg-cerulean"></span>
                  }
                </span>
                <span class="flex-1 font-sans text-body font-semibold text-ink"
                  >Paystack</span
                >
                <span class="font-heading text-body font-bold text-[#00c3f7]"
                  >pay<span class="text-[#011b33]">stack</span></span
                >
              </button>
            </div>

            <p
              class="mt-4 flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate"
            >
              <sd-icon
                name="info"
                [size]="16"
                class="mt-0.5 shrink-0 text-cerulean"
              />
              Online payment isn't enabled yet. Confirm now to book — your
              appointment is created as <span class="font-medium">unpaid</span>
              and you can pay once payments go live.
            </p>
          </div>

          @if (submitError()) {
            <p
              class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert"
            >
              {{ submitError() }}
            </p>
          }

          <div class="flex flex-wrap items-center justify-between gap-3">
            <sd-button variant="outline" (click)="back()"
              >Back to previous</sd-button
            >
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink disabled:opacity-50"
                [disabled]="submitting()"
                (click)="confirm()"
              >
                Skip for now
              </button>
              <sd-button [disabled]="submitting()" (click)="confirm()">
                {{ submitting() ? 'Confirming…' : 'Pay $' + total().toFixed(2) }}
              </sd-button>
            </div>
          </div>
        }
      } @else {
        <div
          class="h-64 animate-pulse rounded-card border border-cloud bg-cloud/40"
        ></div>
      }
    </div>

    <ng-template #navRow>
      <div class="flex flex-wrap justify-between gap-3">
        <sd-button variant="outline" (click)="back()">Back to previous</sd-button>
        <sd-button [disabled]="!canContinue()" (click)="next()">
          Continue <sd-icon name="arrow-right" [size]="18" />
        </sd-button>
      </div>
    </ng-template>
  `,
})
export class BookConsultation implements OnInit {
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly appointments = inject(AppointmentsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly steps = [1, 2, 3, 4, 5, 6];
  protected readonly step = signal(1);
  protected readonly platformFee = 2;
  protected readonly paymentMethod = signal<'wallet' | 'paystack'>('paystack');

  protected readonly specialist = signal<SpecialistDto | null>(null);
  protected readonly loadError = signal(false);
  protected readonly days = signal<DayAvailability[]>([]);
  protected readonly loadingSlots = signal(true);
  protected readonly selectedDate = signal('');
  protected readonly selectedTime = signal('');

  protected readonly reason = signal('');
  protected readonly docUrl = signal('');
  protected readonly docName = signal('');
  protected readonly uploadingDoc = signal(false);
  protected readonly docError = signal('');

  protected readonly submitting = signal(false);
  protected readonly submitError = signal('');

  private specialistId = '';

  ngOnInit(): void {
    this.specialistId = this.route.snapshot.paramMap.get('id') ?? '';
    const preslot = this.route.snapshot.queryParamMap.get('slot');

    this.specialistsApi
      .getPublic(this.specialistId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.specialist.set(res.data),
        error: () => this.loadError.set(true),
      });

    this.specialistsApi
      .slots(this.specialistId, 7)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.days.set(res.data);
          const preDay = preslot
            ? res.data.find((d) => d.slots.some((s) => s.iso === preslot))
            : undefined;
          const day = preDay ?? res.data[0];
          if (day) {
            this.selectedDate.set(day.date);
            this.selectedTime.set(
              preslot && day.slots.some((s) => s.iso === preslot)
                ? preslot
                : (day.slots[0]?.iso ?? ''),
            );
          }
          this.loadingSlots.set(false);
        },
        error: () => this.loadingSlots.set(false),
      });
  }

  protected readonly selectedDaySlots = computed(
    () => this.days().find((d) => d.date === this.selectedDate())?.slots ?? [],
  );

  protected pickDate(d: DayAvailability): void {
    this.selectedDate.set(d.date);
    this.selectedTime.set(d.slots[0]?.iso ?? '');
  }

  protected readonly initials = computed(() =>
    (this.specialist()?.name ?? '')
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected readonly rating = computed(() =>
    Number(this.specialist()?.rating ?? 0).toFixed(1),
  );

  protected readonly selectedSummary = computed(() => {
    const day = this.days().find((d) => d.date === this.selectedDate());
    const slot = day?.slots.find((s) => s.iso === this.selectedTime());
    return day && slot ? `${day.weekday} ${day.day}, ${slot.label}` : '';
  });

  protected readonly summaryDate = computed(() => {
    const day = this.days().find((d) => d.date === this.selectedDate());
    if (!day) return '—';
    // Use midday to avoid the plain date shifting across the tz boundary.
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(`${day.date}T12:00:00`));
  });

  // The slot's server-formatted label, so the summary matches the picked pill.
  protected readonly summaryTime = computed(
    () =>
      this.selectedDaySlots().find((s) => s.iso === this.selectedTime())
        ?.label ?? '—',
  );

  /** Per-step "Continue" gate for the shared nav row (steps 2–4). */
  protected readonly canContinue = computed(() => {
    switch (this.step()) {
      case 2:
        return true; // Online is preselected
      case 3:
        return this.reason().trim().length > 0;
      default:
        return true;
    }
  });

  protected next(): void {
    if (this.step() < 6) this.step.update((s) => s + 1);
  }

  /** Consultation fee + platform fee (display total for the payment step). */
  protected readonly total = computed(
    () => Number(this.specialist()?.consultation_fee ?? 0) + this.platformFee,
  );

  protected back(): void {
    if (this.step() > 1) this.step.update((s) => s - 1);
  }

  protected async onDocumentSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.docError.set('');
    if (!/^image\/(png|jpe?g)$/.test(file.type)) {
      this.docError.set('Only PNG or JPG images are allowed.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.docError.set('File must be 5MB or smaller.');
      return;
    }
    this.uploadingDoc.set(true);
    try {
      const res = await firstValueFrom(this.appointments.uploadDocument(file));
      this.docUrl.set(res.data.url);
      this.docName.set(file.name);
    } catch (err) {
      this.docError.set(
        (err as { message?: string })?.message ?? 'Could not upload the file.',
      );
    } finally {
      this.uploadingDoc.set(false);
    }
  }

  protected removeDocument(): void {
    this.docUrl.set('');
    this.docName.set('');
  }

  protected skipDocument(): void {
    this.removeDocument();
    this.next();
  }

  protected async confirm(): Promise<void> {
    if (!this.selectedTime()) {
      this.step.set(1);
      return;
    }
    this.submitting.set(true);
    this.submitError.set('');
    try {
      await firstValueFrom(
        this.appointments.book({
          specialist_id: this.specialistId,
          scheduled_at: this.selectedTime(),
          type: 'video',
          notes: this.reason().trim() || undefined,
          document_url: this.docUrl() || undefined,
        }),
      );
      await this.router.navigate(['/dashboard/appointments'], {
        queryParams: { booked: '1' },
      });
    } catch (err) {
      this.submitError.set(
        (err as { message?: string })?.message ??
          'Could not complete your booking. Please try again.',
      );
    } finally {
      this.submitting.set(false);
    }
  }
}
