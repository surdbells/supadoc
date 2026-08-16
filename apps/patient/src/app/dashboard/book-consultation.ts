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
import type {
  DayAvailability,
  GuestInvite,
  PricingDto,
  SpecialistDto,
} from '@supadoc/models';
import { ButtonComponent, IconComponent } from '@supadoc/ui';

/**
 * Book a Consultation (Figma) — a 7-step wizard: date/time, consultation type,
 * reason, invite guests (up to 3, each adds the guest fee), optional supporting
 * document, a booking summary, and a payment step that creates the appointment
 * (payment is stubbed, so it's created unpaid). Driven by the specialist's real
 * availability and the back-office-configured Naira pricing.
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
      <div class="mx-auto flex max-w-full items-center overflow-x-auto pb-1">
        @for (n of steps; track n; let last = $last) {
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-full font-sans text-body-sm font-semibold transition-colors"
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
              class="h-0.5 w-5 shrink-0 sm:w-9 md:w-12"
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
                  ><sd-icon name="banknote" [size]="14" />Fee</span
                >
                <span class="text-ink">{{ fmt(s.consultation_fee) }}</span>
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

        <!-- Step 4: invite guests -->
        @if (step() === 4) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <div class="mb-1 flex items-center justify-between">
              <h2 class="font-heading text-h5 text-cerulean">
                <span
                  class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                  >4</span
                >Invite Others
                <span class="font-sans text-body-sm font-normal text-slate"
                  >(Optional)</span
                >
              </h2>
              <button
                type="button"
                class="font-sans text-body-sm font-semibold text-cerulean hover:underline"
                (click)="next()"
              >
                Skip
              </button>
            </div>
            <p class="mb-5 font-sans text-body-sm text-slate">
              Invite up to 3 people to join this video consultation. Each guest
              adds <span class="font-semibold text-ink">{{ fmt(guestFee()) }}</span>
              to the total, and everyone gets an email with their own join link.
            </p>

            @for (g of guests(); track $index) {
              <div
                class="mb-3 flex flex-col gap-3 rounded-card border border-cloud bg-glacier/40 p-4 sm:flex-row sm:items-center"
              >
                <input
                  type="text"
                  placeholder="Full name"
                  [value]="g.name"
                  (input)="setGuest($index, 'name', $any($event.target).value)"
                  class="w-full flex-1 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                />
                <input
                  type="email"
                  placeholder="Email address"
                  [value]="g.email"
                  (input)="setGuest($index, 'email', $any($event.target).value)"
                  class="w-full flex-1 rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"
                  [class.border-alert]="g.email.length > 0 && !emailValid(g.email)"
                />
                <button
                  type="button"
                  aria-label="Remove guest"
                  class="flex shrink-0 items-center justify-center rounded-field border border-cloud px-3 py-2 text-slate transition-colors hover:border-alert/50 hover:text-alert"
                  (click)="removeGuest($index)"
                >
                  <sd-icon name="trash-2" [size]="18" />
                </button>
              </div>
            }

            @if (guests().length < 3) {
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-cerulean/40 bg-frost/20 px-4 py-3 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:bg-frost/40"
                (click)="addGuest()"
              >
                <sd-icon name="plus" [size]="18" />Add
                {{ guests().length === 0 ? 'a guest' : 'another guest' }}
              </button>
            }

            @if (validGuests().length > 0) {
              <div
                class="mt-4 flex items-center justify-between rounded-card bg-frost/40 px-4 py-3 font-sans text-body-sm"
              >
                <span class="flex items-center gap-2 text-slate"
                  ><sd-icon name="users" [size]="16" />{{ validGuests().length }}
                  guest{{ validGuests().length > 1 ? 's' : '' }} ×
                  {{ fmt(guestFee()) }}</span
                >
                <span class="font-semibold text-cerulean">{{
                  fmt(guestsTotal())
                }}</span>
              </div>
            }
          </div>
          <ng-container [ngTemplateOutlet]="navRow" />
        }

        <!-- Step 5: document -->
        @if (step() === 5) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <div class="mb-4 flex items-center justify-between">
              <h2 class="font-heading text-h5 text-cerulean">
                <span
                  class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                  >5</span
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

        <!-- Step 6: summary -->
        @if (step() === 6) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >6</span
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
              @if (validGuests().length > 0) {
                <div class="flex justify-between gap-4">
                  <dt class="flex items-center gap-2 text-slate">
                    <sd-icon name="users" [size]="16" />Guests
                  </dt>
                  <dd class="max-w-[60%] text-right text-ink">
                    {{ guestNames() }}
                  </dd>
                </div>
              }
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
              class="mt-5 flex flex-col gap-2 border-t border-cloud pt-4 font-sans text-body-sm"
            >
              <div class="flex justify-between">
                <span class="text-slate">Consultation Fee</span>
                <span class="text-ink">{{ fmt(baseFee()) }}</span>
              </div>
              @if (validGuests().length > 0) {
                <div class="flex justify-between">
                  <span class="text-slate"
                    >Guests ({{ validGuests().length }} ×
                    {{ fmt(guestFee()) }})</span
                  >
                  <span class="text-ink">{{ fmt(guestsTotal()) }}</span>
                </div>
              }
              <div
                class="flex justify-between border-t border-cloud pt-2 font-semibold"
              >
                <span class="text-body text-cerulean">Amount</span>
                <span class="text-h5 text-cerulean">{{ fmt(amount()) }}</span>
              </div>
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

        <!-- Step 7: payment (stub, skippable) -->
        @if (step() === 7) {
          <div class="rounded-card border border-cloud bg-white p-6">
            <h2 class="mb-5 font-heading text-h5 text-cerulean">
              <span
                class="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-cerulean text-caption text-white"
                >7</span
              >Payment Summary
            </h2>
            <div class="flex flex-col gap-3 font-sans text-body-sm">
              <div class="flex justify-between">
                <span class="text-slate">Consultation Fee</span>
                <span class="text-ink">{{ fmt(baseFee()) }}</span>
              </div>
              @if (validGuests().length > 0) {
                <div class="flex justify-between">
                  <span class="text-slate"
                    >Guests ({{ validGuests().length }} ×
                    {{ fmt(guestFee()) }})</span
                  >
                  <span class="text-ink">{{ fmt(guestsTotal()) }}</span>
                </div>
              }
              <div class="flex justify-between">
                <span class="text-slate">Platform Fee</span>
                <span class="text-ink">{{ fmt(platformFee()) }}</span>
              </div>
              <div
                class="flex justify-between border-t border-cloud pt-3 font-semibold"
              >
                <span class="text-ink">Total</span>
                <span class="text-cerulean">{{ fmt(total()) }}</span>
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
                {{ submitting() ? 'Confirming…' : 'Pay ' + fmt(total()) }}
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

  protected readonly steps = [1, 2, 3, 4, 5, 6, 7];
  protected readonly step = signal(1);
  protected readonly paymentMethod = signal<'wallet' | 'paystack'>('paystack');

  protected readonly specialist = signal<SpecialistDto | null>(null);
  protected readonly pricing = signal<PricingDto | null>(null);
  protected readonly loadError = signal(false);
  protected readonly days = signal<DayAvailability[]>([]);
  protected readonly loadingSlots = signal(true);
  protected readonly selectedDate = signal('');
  protected readonly selectedTime = signal('');

  protected readonly reason = signal('');
  protected readonly guests = signal<GuestInvite[]>([]);
  protected readonly docUrl = signal('');
  protected readonly docName = signal('');
  protected readonly uploadingDoc = signal(false);
  protected readonly docError = signal('');

  protected readonly submitting = signal(false);
  protected readonly submitError = signal('');

  private specialistId = '';
  private readonly nf = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

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
      .pricing()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.pricing.set(res.data) });

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

  // ----- Pricing -----

  protected readonly currency = computed(() => {
    const c = this.pricing()?.currency ?? 'NGN';
    return c === 'NGN' ? '₦' : c;
  });
  protected readonly guestFee = computed(() => this.pricing()?.guest_fee ?? 0);
  protected readonly platformFee = computed(
    () => this.pricing()?.platform_fee ?? 0,
  );
  protected readonly baseFee = computed(() =>
    Number(this.specialist()?.consultation_fee ?? 0),
  );
  protected readonly validGuests = computed(() =>
    this.guests().filter((g) => g.name.trim() !== '' && this.emailValid(g.email)),
  );
  protected readonly guestsTotal = computed(
    () => this.validGuests().length * this.guestFee(),
  );
  /** Consultation fee + guest fees — what the backend persists as `amount`. */
  protected readonly amount = computed(() => this.baseFee() + this.guestsTotal());
  /** Amount + platform fee — the checkout total shown at payment. */
  protected readonly total = computed(() => this.amount() + this.platformFee());

  protected readonly guestNames = computed(() =>
    this.validGuests()
      .map((g) => g.name.trim())
      .join(', '),
  );

  protected fmt(value: number | string): string {
    return this.currency() + this.nf.format(Number(value) || 0);
  }

  protected emailValid(email: string): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  }

  // ----- Guests -----

  protected addGuest(): void {
    if (this.guests().length >= 3) return;
    this.guests.update((list) => [...list, { name: '', email: '' }]);
  }

  protected removeGuest(index: number): void {
    this.guests.update((list) => list.filter((_, i) => i !== index));
  }

  protected setGuest(index: number, field: keyof GuestInvite, value: string): void {
    this.guests.update((list) =>
      list.map((g, i) => (i === index ? { ...g, [field]: value } : g)),
    );
  }

  /** Per-step "Continue" gate for the shared nav row (steps 2–5). */
  protected readonly canContinue = computed(() => {
    switch (this.step()) {
      case 2:
        return true; // Online is preselected
      case 3:
        return this.reason().trim().length > 0;
      case 4:
        // Every started guest row must be complete + valid.
        return this.guests().every(
          (g) =>
            (g.name.trim() === '' && g.email.trim() === '') ||
            (g.name.trim() !== '' && this.emailValid(g.email)),
        );
      default:
        return true;
    }
  });

  protected next(): void {
    if (this.step() < 7) this.step.update((s) => s + 1);
  }

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
      const guests = this.validGuests().map((g) => ({
        name: g.name.trim(),
        email: g.email.trim(),
      }));
      await firstValueFrom(
        this.appointments.book({
          specialist_id: this.specialistId,
          scheduled_at: this.selectedTime(),
          type: 'video',
          notes: this.reason().trim() || undefined,
          document_url: this.docUrl() || undefined,
          guests: guests.length > 0 ? guests : undefined,
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
