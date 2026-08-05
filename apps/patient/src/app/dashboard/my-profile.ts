import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  ButtonComponent,
  IconComponent,
  InputComponent,
  PhoneInputComponent,
} from '@supadoc/ui';

type View =
  | 'home'
  | 'personal'
  | 'personal-edit'
  | 'medical'
  | 'medical-add'
  | 'insurance'
  | 'emergency';

interface SectionCard {
  readonly key: View | 'insurance' | 'emergency';
  readonly icon: string;
  readonly tint: string;
  readonly title: string;
}

/**
 * My Profile (Figma 740:11873) with its Personal Information view (681:9123) /
 * edit (686:10572) and Medical Information view (701:9969) / add (763:12524).
 * All sub-views and the success toasts live in this one component (they are not
 * separate pages), toggled by the `view` signal.
 */
@Component({
  selector: 'pat-my-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    ButtonComponent,
    IconComponent,
    InputComponent,
    PhoneInputComponent,
  ],
  host: { class: 'block' },
  template: `
    <!-- Success toast (image upload / profile update) -->
    @if (toast()) {
      <div
        class="fixed right-6 top-6 z-50 flex items-center gap-3 rounded-card border border-sage/30 bg-white px-4 py-3 shadow-lg"
        role="status"
      >
        <sd-icon name="circle-check" [size]="20" class="text-sage" />
        <span class="font-sans text-body-sm font-medium text-ink">{{
          toast()
        }}</span>
      </div>
    }

    <div class="flex flex-col gap-6 py-2">
      @switch (view()) {
        @case ('home') {
          <div class="flex flex-col gap-1">
            <h1 class="font-heading text-h3 text-ink">My Profile</h1>
            <p class="font-sans text-body text-slate">
              Manage your personal, medical, and insurance information.
            </p>
          </div>
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ng-container [ngTemplateOutlet]="profileCard" />
            <ng-container [ngTemplateOutlet]="privacyCard" />
          </div>
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            @for (c of sections; track c.key) {
              <button
                type="button"
                class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6 text-left transition-colors hover:border-cerulean/50"
                (click)="openSection(c.key)"
              >
                <div class="flex items-center justify-between">
                  <span
                    class="flex size-11 items-center justify-center rounded-full"
                    [class]="c.tint"
                  >
                    <sd-icon [name]="c.icon" [size]="22" />
                  </span>
                  <sd-icon
                    name="chevron-right"
                    [size]="20"
                    class="text-slate"
                  />
                </div>
                <p class="font-heading text-h5" [class]="titleColor(c)">
                  {{ c.title }}
                </p>
                <p class="font-sans text-body-sm text-slate">
                  Manage your personal details and contact information
                </p>
                <p class="font-sans text-caption text-slate">
                  Last updated: 20th of June, 2026
                </p>
              </button>
            }
          </div>
        }

        @case ('personal') {
          <ng-container
            [ngTemplateOutlet]="subHeader"
            [ngTemplateOutletContext]="{
              title: 'Personal Information',
              subtitle: 'Manage your personal information and account details.',
            }"
          />
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ng-container [ngTemplateOutlet]="profileCard" />
            <ng-container [ngTemplateOutlet]="privacyCard" />
          </div>
          <div class="flex justify-end">
            <sd-button (click)="view.set('personal-edit')">
              <sd-icon name="pencil" [size]="18" />
              Edit
            </sd-button>
          </div>
          <div
            class="grid grid-cols-1 gap-x-6 gap-y-5 rounded-card border border-cloud bg-white p-6 md:grid-cols-2"
          >
            <ng-container
              [ngTemplateOutlet]="readField"
              [ngTemplateOutletContext]="{
                label: 'Full name',
                value: 'Sarah Jonshon',
              }"
            />
            <ng-container
              [ngTemplateOutlet]="readField"
              [ngTemplateOutletContext]="{
                label: 'Phone',
                value: '+234  9060080034',
              }"
            />
            <ng-container
              [ngTemplateOutlet]="readField"
              [ngTemplateOutletContext]="{
                label: 'Date of Birth',
                value: '12 / 05 / 1988',
              }"
            />
            <ng-container
              [ngTemplateOutlet]="readField"
              [ngTemplateOutletContext]="{
                label: 'Gender',
                value: 'Female',
              }"
            />
            <div class="md:col-span-2">
              <ng-container
                [ngTemplateOutlet]="readField"
                [ngTemplateOutletContext]="{
                  label: 'Residential Address',
                  value: '14, Freedom Way, Lekki Phase 1, Lagos, Nigeria.',
                }"
              />
            </div>
          </div>
        }

        @case ('personal-edit') {
          <ng-container
            [ngTemplateOutlet]="subHeader"
            [ngTemplateOutletContext]="{
              title: 'Personal Information',
              subtitle: 'Manage your personal information and account details.',
            }"
          />
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ng-container [ngTemplateOutlet]="profileCard" />
            <ng-container [ngTemplateOutlet]="privacyCard" />
          </div>
          <form
            class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6"
            [formGroup]="form"
            (ngSubmit)="saveProfile()"
          >
            <div class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              <sd-input
                label="Full name"
                [required]="true"
                formControlName="fullName"
              />
              <sd-phone-input
                label="Phone"
                [required]="true"
                formControlName="phone"
              />
              <sd-input
                label="Date of Birth"
                [required]="true"
                type="date"
                formControlName="dob"
              />
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-body font-semibold text-ink"
                  >Gender <span class="text-alert">*</span></span
                >
                <select
                  formControlName="gender"
                  class="rounded-field border border-[#d7e0e8] bg-white px-4 py-4 font-sans text-body text-ink focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
                >
                  <option value="Female">Female</option>
                  <option value="Male">Male</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <div class="md:col-span-2">
                <label class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink"
                    >Residential Address <span class="text-alert">*</span></span
                  >
                  <textarea
                    formControlName="address"
                    rows="3"
                    class="rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body text-ink focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
                  ></textarea>
                </label>
              </div>
            </div>
            <p
              class="flex items-center gap-1.5 font-sans text-caption text-slate"
            >
              <sd-icon name="info" [size]="16" />
              Your email address can't be changed from here
            </p>
            <div class="flex gap-3">
              <sd-button
                variant="outline"
                type="button"
                (click)="view.set('personal')"
                >Cancel</sd-button
              >
              <sd-button type="submit">Save changes</sd-button>
            </div>
          </form>
        }

        @case ('medical') {
          <ng-container
            [ngTemplateOutlet]="subHeader"
            [ngTemplateOutletContext]="{
              title: 'Medical Information',
              subtitle: 'Your information is private and securely encrypted',
            }"
          />
          <ng-container [ngTemplateOutlet]="tipsBanner" />
          <div class="flex flex-col items-center gap-5 py-20 text-center">
            <span
              class="flex size-24 items-center justify-center rounded-full bg-cloud text-slate"
            >
              <sd-icon name="clipboard-list" [size]="40" />
            </span>
            <div class="flex max-w-md flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">
                No Medical Information yet
              </h2>
              <p class="font-sans text-body-sm text-slate">
                Add your medical details to help your doctor understand your
                health better and provide personalised care.
              </p>
            </div>
            <sd-button (click)="view.set('medical-add')">
              <sd-icon name="plus" [size]="18" />
              Add Medical details
            </sd-button>
          </div>
        }

        @case ('medical-add') {
          <ng-container
            [ngTemplateOutlet]="subHeader"
            [ngTemplateOutletContext]="{
              title: 'Medical Information',
              subtitle:
                'Update your medical history, allergies, medications, and existing conditions.',
            }"
          />
          <ng-container [ngTemplateOutlet]="tipsBanner" />
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Medical History -->
            <section
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="clipboard-list" [size]="20" />Medical History
                </h3>
                <div class="flex items-center gap-3">
                  <sd-button variant="outline" size="sm">
                    <sd-icon name="plus" [size]="16" />Add Another
                  </sd-button>
                  <sd-icon name="x" [size]="18" class="text-slate" />
                </div>
              </div>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{
                    label: 'Condition/Proceedure',
                    ph: 'e.g Appendectomy',
                  }"
                />
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{ label: 'Year', ph: 'e.g 2016' }"
                />
              </div>
              <ng-container
                [ngTemplateOutlet]="field"
                [ngTemplateOutletContext]="{ label: 'Note (Optional)', ph: '' }"
              />
            </section>

            <!-- Allergies -->
            <section
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="triangle-alert" [size]="20" />Allergies
                </h3>
                <div class="flex items-center gap-3">
                  <sd-button variant="outline" size="sm">
                    <sd-icon name="plus" [size]="16" />Add Another
                  </sd-button>
                  <sd-icon name="x" [size]="18" class="text-slate" />
                </div>
              </div>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{
                    label: 'Condition/Proceedure',
                    ph: 'e.g Penicillin',
                  }"
                />
                <ng-container
                  [ngTemplateOutlet]="selectField"
                  [ngTemplateOutletContext]="{ label: 'Severity' }"
                />
              </div>
              <ng-container
                [ngTemplateOutlet]="field"
                [ngTemplateOutletContext]="{
                  label: 'Reaction',
                  ph: 'e.g Hives, Anaphylaxis',
                }"
              />
            </section>

            <!-- Current Medications -->
            <section
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="pill" [size]="20" />Current Medications
                </h3>
                <div class="flex items-center gap-3">
                  <sd-button variant="outline" size="sm">
                    <sd-icon name="plus" [size]="16" />Add Another
                  </sd-button>
                  <sd-icon name="x" [size]="18" class="text-slate" />
                </div>
              </div>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{
                    label: 'Medication name',
                    ph: 'e.g Penicillin',
                  }"
                />
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{
                    label: 'Dosage',
                    ph: 'e.g 500mg',
                  }"
                />
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{
                    label: 'Frequency',
                    ph: 'e.g Twice daily',
                  }"
                />
              </div>
            </section>

            <!-- Existing Conditions -->
            <section
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="activity" [size]="20" />Existing Conditions
                </h3>
                <div class="flex items-center gap-3">
                  <sd-button variant="outline" size="sm">
                    <sd-icon name="plus" [size]="16" />Add Another
                  </sd-button>
                  <sd-icon name="x" [size]="18" class="text-slate" />
                </div>
              </div>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{
                    label: 'Condition',
                    ph: 'e.g Diabetess',
                  }"
                />
                <ng-container
                  [ngTemplateOutlet]="selectField"
                  [ngTemplateOutletContext]="{ label: 'Status' }"
                />
                <ng-container
                  [ngTemplateOutlet]="field"
                  [ngTemplateOutletContext]="{ label: 'Since', ph: 'e.g 2018' }"
                />
              </div>
            </section>
          </div>
          <div class="flex gap-3">
            <sd-button variant="outline" (click)="view.set('medical')"
              >Cancel</sd-button
            >
            <sd-button (click)="saveMedical()">Save</sd-button>
          </div>
        }

        @case ('insurance') {
          <ng-container
            [ngTemplateOutlet]="subHeader"
            [ngTemplateOutletContext]="{
              title: 'Insurance Information',
              subtitle: 'View and manage your insurance details',
            }"
          />
          <ng-container
            [ngTemplateOutlet]="tipsBanner"
            [ngTemplateOutletContext]="{ tips: insuranceTips }"
          />
          <div class="rounded-card border border-cloud bg-white p-6">
            <div class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Insurance Provider <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <sd-icon name="building-2" [size]="18" class="text-slate" />
                  <select [class]="fieldControl">
                    <option>BlueShield Health Partners</option>
                    <option>Aetna</option>
                    <option>Cigna</option>
                  </select>
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Insurance Plan <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <sd-icon name="list" [size]="18" class="text-slate" />
                  <select [class]="fieldControl">
                    <option>PPO Silver 250</option>
                    <option>HMO Gold 500</option>
                  </select>
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Policy Number/ Membership ID
                  <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <sd-icon name="hash" [size]="18" class="text-slate" />
                  <input
                    type="text"
                    value="BH-2291-8834"
                    [class]="fieldControl"
                  />
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Coverage Status <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <span class="size-2 shrink-0 rounded-full bg-sage"></span>
                  <select [class]="fieldControl">
                    <option>Active</option>
                    <option>Inactive</option>
                    <option>Expired</option>
                  </select>
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Expiry Date <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <sd-icon
                    name="calendar-days"
                    [size]="18"
                    class="text-slate"
                  />
                  <input
                    type="date"
                    value="2027-04-11"
                    [class]="fieldControl"
                  />
                </span>
              </label>
            </div>
            <div class="mt-6 flex gap-3">
              <sd-button variant="outline" (click)="view.set('home')"
                >Cancel</sd-button
              >
              <sd-button (click)="saveInsurance()">Save</sd-button>
            </div>
          </div>
        }

        @case ('emergency') {
          <ng-container
            [ngTemplateOutlet]="subHeader"
            [ngTemplateOutletContext]="{
              title: 'Emergency Contact',
              subtitle: 'Your information is private and securely encrypted',
            }"
          />
          <ng-container
            [ngTemplateOutlet]="tipsBanner"
            [ngTemplateOutletContext]="{ tips: emergencyTips }"
          />
          <div class="rounded-card border border-cloud bg-white p-6">
            <div class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Full Name <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <input
                    type="text"
                    value="David Johnson"
                    [class]="fieldControl"
                  />
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Relationship <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <select [class]="fieldControl">
                    <option>Select</option>
                    <option>Spouse</option>
                    <option>Parent</option>
                    <option>Sibling</option>
                    <option>Friend</option>
                  </select>
                </span>
              </label>
              <div class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Phone <span class="text-alert">*</span></span
                >
                <sd-phone-input />
              </div>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Email (optional)</span
                >
                <span [class]="fieldWrap">
                  <input
                    type="email"
                    placeholder="example@email.com"
                    [class]="fieldControl"
                  />
                </span>
              </label>
            </div>
            <div class="mt-6 flex gap-3">
              <sd-button variant="outline" (click)="view.set('home')"
                >Cancel</sd-button
              >
              <sd-button (click)="saveEmergency()">Save changes</sd-button>
            </div>
          </div>
        }
      }
    </div>

    <!-- ===== Shared templates ===== -->
    <ng-template #subHeader let-title="title" let-subtitle="subtitle">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">{{ title }}</h1>
          <p class="font-sans text-body text-slate">{{ subtitle }}</p>
        </div>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean"
          (click)="back()"
        >
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </button>
      </div>
    </ng-template>

    <ng-template #profileCard>
      <div class="flex items-center gap-4 rounded-card bg-frost/50 p-5">
        <div class="relative shrink-0">
          <img
            src="/dashboard/avatar-sarah.png"
            alt=""
            width="88"
            height="88"
            class="size-22 rounded-full object-cover"
          />
          <button
            type="button"
            class="absolute bottom-0 right-0 flex size-8 items-center justify-center rounded-full bg-cerulean text-white ring-2 ring-frost/50"
            aria-label="Change photo"
            (click)="uploadPhoto()"
          >
            <sd-icon name="camera" [size]="16" />
          </button>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <p class="font-heading text-h5 text-ink">Sarah Johnson</p>
          <p class="truncate font-sans text-caption text-slate">
            sarahjohnson&#64;gmail.com
          </p>
          <div
            class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-caption text-slate"
          >
            <span class="flex items-center gap-1">
              <sd-icon name="map-pin" [size]="14" />Abuja, Nigeria.
            </span>
            <span class="flex items-center gap-1">
              <sd-icon name="calendar-days" [size]="14" />May 12, 1988
            </span>
          </div>
          <div class="mt-1 flex flex-col gap-1">
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/70">
              <div
                class="h-full rounded-full bg-cerulean"
                style="width:75%"
              ></div>
            </div>
            <div class="flex items-center justify-between">
              <span class="font-sans text-caption text-slate"
                >Profile complete</span
              >
              <span class="font-sans text-body-sm font-semibold text-sage"
                >75%</span
              >
            </div>
          </div>
        </div>
      </div>
    </ng-template>

    <ng-template #privacyCard>
      <div
        class="flex items-center justify-between gap-4 rounded-card bg-gradient-to-r from-frost to-mist p-6"
      >
        <div class="flex flex-col gap-1">
          <p class="font-sans text-body font-semibold text-abyss">
            Your information is private and secure
          </p>
          <p class="font-sans text-body-sm text-ink/70">
            We use industry standard encryption to protect your personal
            information.
          </p>
        </div>
        <sd-icon name="shield-check" [size]="40" class="shrink-0 text-white" />
      </div>
    </ng-template>

    <ng-template #tipsBanner let-tips="tips">
      <div
        class="flex items-start justify-between gap-4 rounded-card bg-gradient-to-r from-frost to-mist p-5"
      >
        <div class="flex flex-col gap-2">
          <p class="font-sans text-body font-semibold text-abyss">Tips</p>
          <ul class="flex flex-col gap-1.5 font-sans text-body-sm text-ink/80">
            @for (tip of tips ?? medicalTips; track tip) {
              <li class="flex items-center gap-2">
                <sd-icon name="check" [size]="16" class="text-teal" />
                {{ tip }}
              </li>
            }
          </ul>
        </div>
        <sd-icon name="lightbulb" [size]="36" class="shrink-0 text-warning" />
      </div>
    </ng-template>

    <ng-template #readField let-label="label" let-value="value">
      <div class="flex w-full flex-col gap-2">
        <span class="font-sans text-caption text-slate">{{ label }}</span>
        <span
          class="rounded-field border border-cloud bg-white px-4 py-3.5 font-sans text-body text-ink"
          >{{ value }}</span
        >
      </div>
    </ng-template>

    <ng-template #field let-label="label" let-ph="ph">
      <label class="flex w-full flex-col gap-2">
        <span class="font-sans text-caption text-slate">{{ label }}</span>
        <input
          type="text"
          [placeholder]="ph"
          class="rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
        />
      </label>
    </ng-template>

    <ng-template #selectField let-label="label">
      <label class="flex w-full flex-col gap-2">
        <span class="font-sans text-caption text-slate">{{ label }}</span>
        <select
          class="rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body-sm text-slate focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
        >
          <option>Select</option>
        </select>
      </label>
    </ng-template>
  `,
})
export class MyProfile {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly view = signal<View>('home');
  protected readonly toast = signal('');

  protected readonly sections: SectionCard[] = [
    {
      key: 'personal',
      icon: 'user',
      tint: 'bg-cerulean/10 text-cerulean',
      title: 'Personal Information',
    },
    {
      key: 'medical',
      icon: 'heart-pulse',
      tint: 'bg-teal/10 text-teal',
      title: 'Medical Information',
    },
    {
      key: 'insurance',
      icon: 'shield-check',
      tint: 'bg-sage/15 text-sage',
      title: 'Insurance Information',
    },
    {
      key: 'emergency',
      icon: 'id-card',
      tint: 'bg-sky/10 text-sky',
      title: 'Emergency Contact',
    },
  ];

  protected readonly form = this.fb.nonNullable.group({
    fullName: ['Sarah Jonshon', [Validators.required]],
    phone: ['+2349060080034', [Validators.required]],
    dob: ['1988-05-12', [Validators.required]],
    gender: ['Female', [Validators.required]],
    address: [
      '14, Freedom Way, Lekki Phase 1, Lagos, Nigeria.',
      [Validators.required],
    ],
  });

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.toastTimer));
  }

  protected titleColor(c: SectionCard): string {
    const map: Record<string, string> = {
      personal: 'text-cerulean',
      medical: 'text-teal',
      insurance: 'text-sage',
      emergency: 'text-sky',
    };
    return map[c.key] ?? 'text-ink';
  }

  // Field styling shared by the Insurance / Emergency forms.
  protected readonly fieldWrap =
    'flex items-center gap-2 rounded-field border border-[#d7e0e8] bg-white px-4 transition-colors focus-within:border-teal focus-within:ring-2 focus-within:ring-teal/15';
  protected readonly fieldControl =
    'w-full bg-transparent py-3.5 font-sans text-body text-ink placeholder:text-slate/60 focus:outline-none';

  protected readonly medicalTips = [
    'Help your doctor to make better diagnoses and treatment decision',
    'Skip repeating your medical history during every consultation',
  ];
  protected readonly insuranceTips = [
    'Ensure your policy number is entered correctly.',
    'Keep your insurance information up to date to avoid claim issue',
  ];
  protected readonly emergencyTips = [
    'Ensure your emergency number is entered correctly.',
    'Your emergency contact will only be contacted in urgent medical situation.',
  ];

  protected openSection(key: SectionCard['key']): void {
    if (key === 'personal') this.view.set('personal');
    else if (key === 'medical') this.view.set('medical');
    else if (key === 'insurance') this.view.set('insurance');
    else if (key === 'emergency') this.view.set('emergency');
  }

  protected back(): void {
    if (this.view() === 'personal-edit') this.view.set('personal');
    else if (this.view() === 'medical-add') this.view.set('medical');
    else this.view.set('home');
  }

  protected uploadPhoto(): void {
    this.showToast('Profile photo updated successfully');
  }

  protected saveProfile(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.view.set('personal');
    this.showToast('Profile information updated successfully');
  }

  protected saveMedical(): void {
    this.view.set('medical');
    this.showToast('Medical information saved successfully');
  }

  protected saveInsurance(): void {
    this.view.set('home');
    this.showToast('Insurance information saved successfully');
  }

  protected saveEmergency(): void {
    this.view.set('home');
    this.showToast('Emergency contact saved successfully');
  }

  private showToast(message: string): void {
    this.toast.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3000);
  }
}
