import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { PatientApi } from '@supadoc/data-access';
import type { HealthProfileDto, MedicalDto } from '@supadoc/models';
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
                value: fullName(),
              }"
            />
            <ng-container
              [ngTemplateOutlet]="readField"
              [ngTemplateOutletContext]="{
                label: 'Phone',
                value: phone(),
              }"
            />
            <ng-container
              [ngTemplateOutlet]="readField"
              [ngTemplateOutletContext]="{
                label: 'Date of Birth',
                value: dobDisplay(),
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

          <!-- Phone number verification -->
          <div
            class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <sd-icon name="phone" [size]="18" class="text-slate" />
                <span class="font-sans text-body text-ink">{{ phone() }}</span>
                @if (phoneVerified()) {
                  <span
                    class="flex items-center gap-1 rounded-lg bg-sage/15 px-2.5 py-1 font-sans text-caption font-medium text-sage"
                  >
                    <sd-icon name="circle-check" [size]="14" />
                    Verified
                  </span>
                } @else {
                  <span
                    class="rounded-lg bg-warning/15 px-2.5 py-1 font-sans text-caption font-medium text-warning"
                    >Not verified</span
                  >
                }
              </div>
              @if (!phoneVerified() && phoneVerifyState() === 'idle') {
                <sd-button
                  size="sm"
                  [disabled]="phoneBusy()"
                  (click)="sendPhoneOtp()"
                >
                  {{ phoneBusy() ? 'Sending…' : 'Verify' }}
                </sd-button>
              }
            </div>

            @if (phoneVerifyState() === 'sent') {
              <div class="flex flex-col gap-3 border-t border-cloud pt-4">
                <p class="font-sans text-body-sm text-slate">
                  Enter the 6-digit code we sent to {{ phone() }}.
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputmode="numeric"
                    maxlength="6"
                    placeholder="123456"
                    class="w-36 rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body tracking-[0.3em] text-ink focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15"
                    [value]="otpCode()"
                    (input)="otpCode.set($any($event.target).value)"
                  />
                  <sd-button
                    size="sm"
                    [disabled]="phoneBusy() || otpCode().length < 6"
                    (click)="confirmPhoneOtp()"
                  >
                    {{ phoneBusy() ? 'Verifying…' : 'Confirm' }}
                  </sd-button>
                  <sd-button
                    variant="outline"
                    size="sm"
                    (click)="cancelPhoneVerify()"
                    >Cancel</sd-button
                  >
                </div>
              </div>
            }

            @if (phoneVerifyError()) {
              <p
                class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert"
              >
                {{ phoneVerifyError() }}
              </p>
            }
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
          @if (hasMedical()) {
            <div class="flex flex-col gap-6">
              <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
                @if (medical().history.length) {
                  <section
                    class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6"
                  >
                    <h3
                      class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                    >
                      <sd-icon name="clipboard-list" [size]="20" />Medical History
                    </h3>
                    @for (row of medical().history; track $index) {
                      <div class="flex flex-col rounded-field bg-glacier px-4 py-3">
                        <span class="font-sans text-body-sm font-medium text-ink"
                          >{{ row.condition }}
                          @if (row.year) {
                            <span class="text-slate">· {{ row.year }}</span>
                          }</span
                        >
                        @if (row.note) {
                          <span class="font-sans text-caption text-slate">{{
                            row.note
                          }}</span>
                        }
                      </div>
                    }
                  </section>
                }
                @if (medical().allergies.length) {
                  <section
                    class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6"
                  >
                    <h3
                      class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                    >
                      <sd-icon name="triangle-alert" [size]="20" />Allergies
                    </h3>
                    @for (row of medical().allergies; track $index) {
                      <div class="flex flex-col rounded-field bg-glacier px-4 py-3">
                        <span class="font-sans text-body-sm font-medium text-ink"
                          >{{ row.allergen }}
                          @if (row.severity) {
                            <span class="text-slate">· {{ row.severity }}</span>
                          }</span
                        >
                        @if (row.reaction) {
                          <span class="font-sans text-caption text-slate">{{
                            row.reaction
                          }}</span>
                        }
                      </div>
                    }
                  </section>
                }
                @if (medical().medications.length) {
                  <section
                    class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6"
                  >
                    <h3
                      class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                    >
                      <sd-icon name="pill" [size]="20" />Current Medications
                    </h3>
                    @for (row of medical().medications; track $index) {
                      <div class="flex flex-col rounded-field bg-glacier px-4 py-3">
                        <span class="font-sans text-body-sm font-medium text-ink"
                          >{{ row.name }}
                          @if (row.dosage) {
                            <span class="text-slate">· {{ row.dosage }}</span>
                          }</span
                        >
                        @if (row.frequency) {
                          <span class="font-sans text-caption text-slate">{{
                            row.frequency
                          }}</span>
                        }
                      </div>
                    }
                  </section>
                }
                @if (medical().conditions.length) {
                  <section
                    class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6"
                  >
                    <h3
                      class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                    >
                      <sd-icon name="activity" [size]="20" />Existing Conditions
                    </h3>
                    @for (row of medical().conditions; track $index) {
                      <div class="flex flex-col rounded-field bg-glacier px-4 py-3">
                        <span class="font-sans text-body-sm font-medium text-ink"
                          >{{ row.condition }}
                          @if (row.status) {
                            <span class="text-slate">· {{ row.status }}</span>
                          }</span
                        >
                        @if (row.since) {
                          <span class="font-sans text-caption text-slate"
                            >Since {{ row.since }}</span
                          >
                        }
                      </div>
                    }
                  </section>
                }
              </div>
              <div class="flex justify-end">
                <sd-button (click)="openMedicalAdd()">
                  <sd-icon name="pencil" [size]="18" />
                  Edit medical details
                </sd-button>
              </div>
            </div>
          } @else {
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
              <sd-button (click)="openMedicalAdd()">
                <sd-icon name="plus" [size]="18" />
                Add Medical details
              </sd-button>
            </div>
          }
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
          <div
            [formGroup]="medicalForm"
            class="grid grid-cols-1 gap-6 lg:grid-cols-2"
          >
            <!-- Medical History -->
            <section
              formArrayName="history"
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="clipboard-list" [size]="20" />Medical History
                </h3>
                <sd-button variant="outline" size="sm" (click)="addHistory()">
                  <sd-icon name="plus" [size]="16" />Add Another
                </sd-button>
              </div>
              @for (row of historyRows.controls; track $index) {
                <div
                  [formGroupName]="$index"
                  class="flex flex-col gap-4 border-t border-cloud pt-4 first:border-0 first:pt-0"
                >
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Condition/Procedure</span
                      >
                      <input
                        formControlName="condition"
                        placeholder="e.g Appendectomy"
                        [class]="rowInput"
                      />
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate">Year</span>
                      <input
                        formControlName="year"
                        placeholder="e.g 2016"
                        [class]="rowInput"
                      />
                    </label>
                  </div>
                  <label class="flex w-full flex-col gap-2">
                    <span class="font-sans text-caption text-slate"
                      >Note (Optional)</span
                    >
                    <input formControlName="note" [class]="rowInput" />
                  </label>
                  @if (historyRows.length > 1) {
                    <button
                      type="button"
                      class="self-end font-sans text-caption font-semibold text-alert hover:underline"
                      (click)="removeRow(historyRows, $index)"
                    >
                      Remove
                    </button>
                  }
                </div>
              }
            </section>

            <!-- Allergies -->
            <section
              formArrayName="allergies"
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="triangle-alert" [size]="20" />Allergies
                </h3>
                <sd-button variant="outline" size="sm" (click)="addAllergy()">
                  <sd-icon name="plus" [size]="16" />Add Another
                </sd-button>
              </div>
              @for (row of allergyRows.controls; track $index) {
                <div
                  [formGroupName]="$index"
                  class="flex flex-col gap-4 border-t border-cloud pt-4 first:border-0 first:pt-0"
                >
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Allergen</span
                      >
                      <input
                        formControlName="allergen"
                        placeholder="e.g Penicillin"
                        [class]="rowInput"
                      />
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Severity</span
                      >
                      <select formControlName="severity" [class]="rowInput">
                        <option value="">Select</option>
                        <option value="Low">Low</option>
                        <option value="Medium">Medium</option>
                        <option value="High">High</option>
                      </select>
                    </label>
                  </div>
                  <label class="flex w-full flex-col gap-2">
                    <span class="font-sans text-caption text-slate">Reaction</span>
                    <input
                      formControlName="reaction"
                      placeholder="e.g Hives, Anaphylaxis"
                      [class]="rowInput"
                    />
                  </label>
                  @if (allergyRows.length > 1) {
                    <button
                      type="button"
                      class="self-end font-sans text-caption font-semibold text-alert hover:underline"
                      (click)="removeRow(allergyRows, $index)"
                    >
                      Remove
                    </button>
                  }
                </div>
              }
            </section>

            <!-- Current Medications -->
            <section
              formArrayName="medications"
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="pill" [size]="20" />Current Medications
                </h3>
                <sd-button variant="outline" size="sm" (click)="addMedication()">
                  <sd-icon name="plus" [size]="16" />Add Another
                </sd-button>
              </div>
              @for (row of medicationRows.controls; track $index) {
                <div
                  [formGroupName]="$index"
                  class="flex flex-col gap-4 border-t border-cloud pt-4 first:border-0 first:pt-0"
                >
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Medication name</span
                      >
                      <input
                        formControlName="name"
                        placeholder="e.g Metformin"
                        [class]="rowInput"
                      />
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate">Dosage</span>
                      <input
                        formControlName="dosage"
                        placeholder="e.g 500mg"
                        [class]="rowInput"
                      />
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Frequency</span
                      >
                      <input
                        formControlName="frequency"
                        placeholder="e.g Twice daily"
                        [class]="rowInput"
                      />
                    </label>
                  </div>
                  @if (medicationRows.length > 1) {
                    <button
                      type="button"
                      class="self-end font-sans text-caption font-semibold text-alert hover:underline"
                      (click)="removeRow(medicationRows, $index)"
                    >
                      Remove
                    </button>
                  }
                </div>
              }
            </section>

            <!-- Existing Conditions -->
            <section
              formArrayName="conditions"
              class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6"
            >
              <div class="flex items-center justify-between gap-2">
                <h3
                  class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"
                >
                  <sd-icon name="activity" [size]="20" />Existing Conditions
                </h3>
                <sd-button variant="outline" size="sm" (click)="addCondition()">
                  <sd-icon name="plus" [size]="16" />Add Another
                </sd-button>
              </div>
              @for (row of conditionRows.controls; track $index) {
                <div
                  [formGroupName]="$index"
                  class="flex flex-col gap-4 border-t border-cloud pt-4 first:border-0 first:pt-0"
                >
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Condition</span
                      >
                      <input
                        formControlName="condition"
                        placeholder="e.g Diabetes"
                        [class]="rowInput"
                      />
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate">Status</span>
                      <select formControlName="status" [class]="rowInput">
                        <option value="">Select</option>
                        <option value="Active">Active</option>
                        <option value="Managed">Managed</option>
                        <option value="Resolved">Resolved</option>
                      </select>
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate">Since</span>
                      <input
                        formControlName="since"
                        placeholder="e.g 2018"
                        [class]="rowInput"
                      />
                    </label>
                  </div>
                  @if (conditionRows.length > 1) {
                    <button
                      type="button"
                      class="self-end font-sans text-caption font-semibold text-alert hover:underline"
                      (click)="removeRow(conditionRows, $index)"
                    >
                      Remove
                    </button>
                  }
                </div>
              }
            </section>
          </div>
          <div class="flex gap-3">
            <sd-button variant="outline" (click)="view.set('medical')"
              >Cancel</sd-button
            >
            <sd-button
              (click)="saveMedical()"
              [disabled]="savingSection() === 'medical'"
            >
              {{ savingSection() === 'medical' ? 'Saving…' : 'Save' }}
            </sd-button>
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
          <form
            [formGroup]="insuranceForm"
            (ngSubmit)="saveInsurance()"
            class="rounded-card border border-cloud bg-white p-6"
          >
            <div class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Insurance Provider</span
                >
                <span [class]="fieldWrap">
                  <sd-icon name="building-2" [size]="18" class="text-slate" />
                  <input
                    type="text"
                    formControlName="provider"
                    placeholder="e.g BlueShield Health Partners"
                    [class]="fieldControl"
                  />
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Insurance Plan</span
                >
                <span [class]="fieldWrap">
                  <sd-icon name="list" [size]="18" class="text-slate" />
                  <input
                    type="text"
                    formControlName="plan"
                    placeholder="e.g PPO Silver 250"
                    [class]="fieldControl"
                  />
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Policy Number/ Membership ID</span
                >
                <span [class]="fieldWrap">
                  <sd-icon name="hash" [size]="18" class="text-slate" />
                  <input
                    type="text"
                    formControlName="policy_number"
                    placeholder="e.g BH-2291-8834"
                    [class]="fieldControl"
                  />
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Coverage Status</span
                >
                <span [class]="fieldWrap">
                  <span class="size-2 shrink-0 rounded-full bg-sage"></span>
                  <select formControlName="coverage_status" [class]="fieldControl">
                    <option value="">Select</option>
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Expired">Expired</option>
                  </select>
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Expiry Date</span
                >
                <span [class]="fieldWrap">
                  <sd-icon
                    name="calendar-days"
                    [size]="18"
                    class="text-slate"
                  />
                  <input
                    type="date"
                    formControlName="expiry_date"
                    [class]="fieldControl"
                  />
                </span>
              </label>
            </div>
            <div class="mt-6 flex gap-3">
              <sd-button
                variant="outline"
                type="button"
                (click)="view.set('home')"
                >Cancel</sd-button
              >
              <sd-button type="submit" [disabled]="savingSection() === 'insurance'">
                {{ savingSection() === 'insurance' ? 'Saving…' : 'Save' }}
              </sd-button>
            </div>
          </form>
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
          <form
            [formGroup]="emergencyForm"
            (ngSubmit)="saveEmergency()"
            class="rounded-card border border-cloud bg-white p-6"
          >
            <div class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Full Name <span class="text-alert">*</span></span
                >
                <span [class]="fieldWrap">
                  <input
                    type="text"
                    formControlName="full_name"
                    placeholder="e.g David Johnson"
                    [class]="fieldControl"
                  />
                </span>
              </label>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Relationship</span
                >
                <span [class]="fieldWrap">
                  <select formControlName="relationship" [class]="fieldControl">
                    <option value="">Select</option>
                    <option value="Spouse">Spouse</option>
                    <option value="Parent">Parent</option>
                    <option value="Sibling">Sibling</option>
                    <option value="Child">Child</option>
                    <option value="Friend">Friend</option>
                  </select>
                </span>
              </label>
              <div class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate">Phone</span>
                <sd-phone-input formControlName="phone" />
              </div>
              <label class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Email (optional)</span
                >
                <span [class]="fieldWrap">
                  <input
                    type="email"
                    formControlName="email"
                    placeholder="example@email.com"
                    [class]="fieldControl"
                  />
                </span>
              </label>
            </div>
            <div class="mt-6 flex gap-3">
              <sd-button
                variant="outline"
                type="button"
                (click)="view.set('home')"
                >Cancel</sd-button
              >
              <sd-button type="submit" [disabled]="savingSection() === 'emergency'">
                {{ savingSection() === 'emergency' ? 'Saving…' : 'Save changes' }}
              </sd-button>
            </div>
          </form>
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
          <p class="font-heading text-h5 text-ink">{{ fullName() }}</p>
          <p class="truncate font-sans text-caption text-slate">
            {{ email() }}
          </p>
          <div
            class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-caption text-slate"
          >
            <span class="flex items-center gap-1">
              <sd-icon name="map-pin" [size]="14" />Abuja, Nigeria.
            </span>
            <span class="flex items-center gap-1">
              <sd-icon name="calendar-days" [size]="14" />{{ dobLong() }}
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

  `,
})
export class MyProfile {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly patient = inject(PatientApi);
  private readonly auth = inject(AuthService);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  // Phone verification (inline in Personal Information).
  protected readonly phoneVerified = signal(false);
  protected readonly phoneVerifyState = signal<'idle' | 'sent'>('idle');
  protected readonly phoneBusy = signal(false);
  protected readonly phoneVerifyError = signal('');
  protected readonly otpCode = signal('');
  private pinId = '';

  protected readonly view = signal<View>('home');
  protected readonly toast = signal('');

  // Profile display — filled from GET /api/portal/me (blank until it resolves).
  protected readonly fullName = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly dobLong = signal('—');
  protected readonly dobDisplay = signal('—');

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
    fullName: ['', [Validators.required]],
    phone: ['', [Validators.required]],
    dob: [''],
    gender: [''],
    address: [''],
  });

  // ----- Health profile (emergency / insurance / medical) -----
  protected readonly emergencyForm = this.fb.nonNullable.group({
    full_name: ['', [Validators.required]],
    relationship: [''],
    phone: [''],
    email: ['', [Validators.email]],
  });

  protected readonly insuranceForm = this.fb.nonNullable.group({
    provider: [''],
    plan: [''],
    policy_number: [''],
    coverage_status: [''],
    expiry_date: [''],
  });

  protected readonly medicalForm = this.fb.group({
    history: this.fb.array<FormGroup>([]),
    allergies: this.fb.array<FormGroup>([]),
    medications: this.fb.array<FormGroup>([]),
    conditions: this.fb.array<FormGroup>([]),
  });

  // Read view of the saved medical record (drives the summary / empty state).
  protected readonly medical = signal<MedicalDto>({
    history: [],
    allergies: [],
    medications: [],
    conditions: [],
  });
  protected readonly savingSection = signal<'' | 'medical' | 'insurance' | 'emergency'>('');

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.toastTimer));

    this.patient
      .me()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.applyProfile(res.data),
        error: () => {
          /* keep the form empty on failure */
        },
      });

    this.patient
      .healthProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.applyHealthProfile(res.data),
        error: () => {
          /* leave the sections empty on failure */
        },
      });
  }

  private applyHealthProfile(h: HealthProfileDto): void {
    this.emergencyForm.patchValue(h.emergency_contact);
    this.insuranceForm.patchValue(h.insurance);
    this.medical.set(h.medical);
    this.loadMedicalForm(h.medical);
  }

  private applyProfile(p: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    phone_verified?: boolean;
    date_of_birth: string | null;
  }): void {
    const full = `${p.first_name} ${p.last_name}`.trim();
    if (full) this.fullName.set(full);
    if (p.email) this.email.set(p.email);
    if (p.phone) this.phone.set(p.phone);
    this.phoneVerified.set(!!p.phone_verified);

    const patch: Record<string, string> = {};
    if (full) patch['fullName'] = full;
    if (p.phone) patch['phone'] = p.phone;

    if (p.date_of_birth) {
      const d = new Date(`${p.date_of_birth}T00:00:00`);
      this.dobLong.set(
        new Intl.DateTimeFormat('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }).format(d),
      );
      this.dobDisplay.set(
        new Intl.DateTimeFormat('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        })
          .format(d)
          .replace(/\//g, ' / '),
      );
      patch['dob'] = p.date_of_birth;
    }

    this.form.patchValue(patch);
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
  // Standalone input styling for the medical FormArray rows.
  protected readonly rowInput =
    'rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/15';

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

  protected async saveProfile(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { fullName, phone, dob } = this.form.getRawValue();
    const [firstName, ...rest] = fullName.trim().split(/\s+/);
    try {
      const res = await firstValueFrom(
        this.patient.updateProfile({
          first_name: firstName,
          last_name: rest.join(' '),
          phone: phone || null,
          date_of_birth: dob || null,
        }),
      );
      this.applyProfile(res.data);
      this.view.set('personal');
      this.showToast('Profile information updated successfully');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.showToast(message ?? 'Could not update your profile.');
    }
  }

  // ----- Medical FormArray plumbing -----
  protected get historyRows(): FormArray<FormGroup> {
    return this.medicalForm.controls.history;
  }
  protected get allergyRows(): FormArray<FormGroup> {
    return this.medicalForm.controls.allergies;
  }
  protected get medicationRows(): FormArray<FormGroup> {
    return this.medicalForm.controls.medications;
  }
  protected get conditionRows(): FormArray<FormGroup> {
    return this.medicalForm.controls.conditions;
  }

  private rowGroup(keys: string[], values: Record<string, string> = {}): FormGroup {
    const cfg: Record<string, string[]> = {};
    for (const k of keys) cfg[k] = [values[k] ?? ''];
    return this.fb.group(cfg);
  }

  private setRows(
    arr: FormArray<FormGroup>,
    keys: string[],
    rows: readonly unknown[],
  ): void {
    arr.clear();
    for (const r of rows) {
      arr.push(this.rowGroup(keys, r as Record<string, string>));
    }
  }

  private loadMedicalForm(m: MedicalDto): void {
    this.setRows(this.historyRows, ['condition', 'year', 'note'], m.history);
    this.setRows(
      this.allergyRows,
      ['allergen', 'severity', 'reaction'],
      m.allergies,
    );
    this.setRows(
      this.medicationRows,
      ['name', 'dosage', 'frequency'],
      m.medications,
    );
    this.setRows(
      this.conditionRows,
      ['condition', 'status', 'since'],
      m.conditions,
    );
  }

  protected addHistory(): void {
    this.historyRows.push(this.rowGroup(['condition', 'year', 'note']));
  }
  protected addAllergy(): void {
    this.allergyRows.push(this.rowGroup(['allergen', 'severity', 'reaction']));
  }
  protected addMedication(): void {
    this.medicationRows.push(this.rowGroup(['name', 'dosage', 'frequency']));
  }
  protected addCondition(): void {
    this.conditionRows.push(this.rowGroup(['condition', 'status', 'since']));
  }
  protected removeRow(arr: FormArray<FormGroup>, i: number): void {
    arr.removeAt(i);
  }

  protected readonly hasMedical = computed(() => {
    const m = this.medical();
    return (
      m.history.length +
        m.allergies.length +
        m.medications.length +
        m.conditions.length >
      0
    );
  });

  /** Open the medical editor, seeding a blank row for any empty section. */
  protected openMedicalAdd(): void {
    if (this.historyRows.length === 0) this.addHistory();
    if (this.allergyRows.length === 0) this.addAllergy();
    if (this.medicationRows.length === 0) this.addMedication();
    if (this.conditionRows.length === 0) this.addCondition();
    this.view.set('medical-add');
  }

  protected async saveMedical(): Promise<void> {
    this.savingSection.set('medical');
    try {
      const res = await firstValueFrom(
        this.patient.updateHealthProfile({
          medical: this.medicalForm.getRawValue() as MedicalDto,
        }),
      );
      this.applyHealthProfile(res.data);
      this.view.set('medical');
      this.showToast('Medical information saved successfully');
    } catch (err) {
      this.showToast(
        (err as { message?: string })?.message ??
          'Could not save your medical information.',
      );
    } finally {
      this.savingSection.set('');
    }
  }

  protected async saveInsurance(): Promise<void> {
    this.savingSection.set('insurance');
    try {
      const res = await firstValueFrom(
        this.patient.updateHealthProfile({
          insurance: this.insuranceForm.getRawValue(),
        }),
      );
      this.applyHealthProfile(res.data);
      this.view.set('home');
      this.showToast('Insurance information saved successfully');
    } catch (err) {
      this.showToast(
        (err as { message?: string })?.message ??
          'Could not save your insurance information.',
      );
    } finally {
      this.savingSection.set('');
    }
  }

  protected async saveEmergency(): Promise<void> {
    if (this.emergencyForm.invalid) {
      this.emergencyForm.markAllAsTouched();
      return;
    }
    this.savingSection.set('emergency');
    try {
      const res = await firstValueFrom(
        this.patient.updateHealthProfile({
          emergency_contact: this.emergencyForm.getRawValue(),
        }),
      );
      this.applyHealthProfile(res.data);
      this.view.set('home');
      this.showToast('Emergency contact saved successfully');
    } catch (err) {
      this.showToast(
        (err as { message?: string })?.message ??
          'Could not save your emergency contact.',
      );
    } finally {
      this.savingSection.set('');
    }
  }

  protected async sendPhoneOtp(): Promise<void> {
    const phone = this.phone().replace(/\D/g, '');
    if (!phone) {
      this.phoneVerifyError.set('Add a phone number first.');
      return;
    }
    this.phoneBusy.set(true);
    this.phoneVerifyError.set('');
    try {
      this.pinId = await this.auth.requestPhoneOtp(phone);
      this.phoneVerifyState.set('sent');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.phoneVerifyError.set(message ?? 'Could not send the code.');
    } finally {
      this.phoneBusy.set(false);
    }
  }

  protected async confirmPhoneOtp(): Promise<void> {
    const phone = this.phone().replace(/\D/g, '');
    this.phoneBusy.set(true);
    this.phoneVerifyError.set('');
    try {
      const token = await this.auth.verifyPhoneOtp(this.pinId, this.otpCode(), phone);
      const res = await firstValueFrom(this.patient.verifyPhone(token));
      this.applyProfile(res.data);
      this.phoneVerifyState.set('idle');
      this.otpCode.set('');
      this.showToast('Phone number verified');
    } catch (err) {
      const message = (err as { message?: string })?.message;
      this.phoneVerifyError.set(message ?? 'That code is invalid or expired.');
    } finally {
      this.phoneBusy.set(false);
    }
  }

  protected cancelPhoneVerify(): void {
    this.phoneVerifyState.set('idle');
    this.otpCode.set('');
    this.phoneVerifyError.set('');
  }

  private showToast(message: string): void {
    this.toast.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3000);
  }
}
