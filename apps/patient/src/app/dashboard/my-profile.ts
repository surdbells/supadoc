import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, type Subscription } from 'rxjs';
import { AuthService, type HasUnsavedChanges } from '@supadoc/auth';
import { apiErrorFields, apiErrorMessage, PatientApi } from '@supadoc/data-access';
import type {
  AllergyRow,
  AllergySeverity,
  HealthProfileDto,
  MedicalDto,
  MedicationRow,
  MyVitalsDto,
  ReadingKey,
  RecordVitalsInput,
  VitalFieldDto,
  VitalFlagLevel,
  VitalReadingDto,
} from '@supadoc/models';
import {
  ButtonComponent,
  DialogComponent,
  DialogService,
  IconComponent,
  InputComponent,
  OtpComponent,
  PhoneInputComponent,
  SearchSelectComponent,
  warnBeforeUnload,
} from '@supadoc/ui';
import { afterDialogsClose } from '../dialog-helpers';

/** Allergy severity choices — the stored value is the lower-case key. */
const SEVERITY_OPTIONS: readonly { value: AllergySeverity; label: string }[] = [
  { value: 'mild', label: 'Mild' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
  { value: 'life-threatening', label: 'Life-threatening' },
  { value: 'unknown', label: 'Unknown' },
];

const SEVERITY_LABEL: Record<AllergySeverity, string> = {
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
  'life-threatening': 'Life-threatening',
  unknown: 'Unknown',
};

const SEVERITY_TONE: Record<AllergySeverity, { cls: string; icon: string }> = {
  mild: { cls: 'bg-sage/15 text-sage-ink', icon: 'info' },
  moderate: { cls: 'bg-warning/15 text-warning-ink', icon: 'circle-alert' },
  severe: { cls: 'bg-alert/10 text-alert-ink', icon: 'triangle-alert' },
  'life-threatening': { cls: 'bg-alert text-white', icon: 'shield-alert' },
  unknown: { cls: 'bg-cloud text-slate', icon: 'circle-help' },
};

/** Free-text severities from older saves (Low / Medium / High …) → the fixed list. */
const SEVERITY_ALIASES: Record<string, AllergySeverity> = {
  mild: 'mild',
  low: 'mild',
  minor: 'mild',
  moderate: 'moderate',
  medium: 'moderate',
  severe: 'severe',
  high: 'severe',
  serious: 'severe',
  'life-threatening': 'life-threatening',
  'life threatening': 'life-threatening',
  lifethreatening: 'life-threatening',
  unknown: 'unknown',
  'not sure': 'unknown',
};

/** One of the canonical stored severities (own keys only — never `toString` & co.). */
function isCanonicalSeverity(value: unknown): value is AllergySeverity {
  return typeof value === 'string' && Object.hasOwn(SEVERITY_LABEL, value);
}

function severityAlias(key: string): AllergySeverity | undefined {
  return Object.hasOwn(SEVERITY_ALIASES, key) ? SEVERITY_ALIASES[key] : undefined;
}

/**
 * Map a stored severity onto the canonical lower-case list (case-insensitively;
 * legacy Low / Medium / High → mild / moderate / severe), so a save always
 * sends canonical values. Text that matches nothing is kept as-is (offered as
 * an extra choice) so it isn't silently lost.
 */
function normalizeSeverity(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return '';
  const key = text.toLowerCase().replace(/[\s_]+/g, ' ');
  return severityAlias(key) ?? severityAlias(key.replace(/ /g, '-')) ?? text;
}

/** The API stores herbal as a string flag ('1' when herbal / traditional). */
function isHerbalFlag(flag: string | boolean | undefined | null): boolean {
  if (typeof flag === 'boolean') return flag;
  return /^(1|yes|true)$/i.test((flag ?? '').trim());
}

/**
 * How each health reading looks on Medical Information's cards (Figma
 * 782:15059) and the edit form's labels (763:12524). The catalogue itself —
 * ranges, units, what each reading means — comes from the API.
 */
interface VitalMeta {
  /** Card label, in the design's casing ("Heart Rate"). */
  readonly label: string;
  /** The form's label when it differs ("Oxygen" for "Oxygen Level"). */
  readonly formLabel?: string;
  /** The unit in the form's label ("Heart Rate (Bpm)"). */
  readonly formUnit: string;
  readonly icon: string;
  /** The tinted square behind the card's icon. */
  readonly tint: string;
  /** Unit after the card's value: "102 bpm" — or written straight on ("38.6°C") when `joined`. */
  readonly unit: string;
  readonly joined?: boolean;
  /** The design keeps these units in the value's colour; the rest are muted. */
  readonly inkUnit?: boolean;
}

const VITAL_META: Record<ReadingKey, VitalMeta> = {
  blood_pressure: { label: 'Blood Pressure', formUnit: 'mmHg', icon: 'heart-pulse', tint: 'bg-alert/10 text-alert-ink', unit: 'mmHg', inkUnit: true },
  temperature: { label: 'Temperature', formUnit: '°C', icon: 'thermometer', tint: 'bg-alert/10 text-alert-ink', unit: '°C', joined: true, inkUnit: true },
  heart_rate: { label: 'Heart Rate', formUnit: 'Bpm', icon: 'heart', tint: 'bg-cerulean/10 text-cerulean-dark', unit: 'bpm' },
  oxygen_saturation: { label: 'Oxygen Level', formLabel: 'Oxygen', formUnit: '%', icon: 'droplet', tint: 'bg-sage/10 text-sage-ink', unit: '%' },
  weight: { label: 'Weight', formUnit: 'Kg', icon: 'weight', tint: 'bg-teal/10 text-teal-ink', unit: 'Kg' },
  respiratory_rate: { label: 'Breathing Rate', formUnit: 'breaths/min', icon: 'wind', tint: 'bg-sky/10 text-cerulean-dark', unit: '/min', joined: true },
  blood_sugar: { label: 'Blood Sugar', formUnit: 'mmol/L', icon: 'gauge', tint: 'bg-warning/15 text-warning-ink', unit: 'mmol/L' },
  height: { label: 'Height', formUnit: 'cm', icon: 'ruler', tint: 'bg-sky/10 text-cerulean-dark', unit: 'cm' },
  bmi: { label: 'BMI', formUnit: 'kg/m²', icon: 'scale', tint: 'bg-teal/10 text-teal-ink', unit: 'kg/m²' },
  pain_score: { label: 'Pain Score', formUnit: '0–10', icon: 'circle-alert', tint: 'bg-warning/15 text-warning-ink', unit: '/10', joined: true },
};

/** The five cards Medical Information always shows, recorded or not (design order). */
const VITAL_PRIMARY = [
  'blood_pressure',
  'temperature',
  'heart_rate',
  'oxygen_saturation',
  'weight',
] as const satisfies readonly ReadingKey[];

/** Further cards, shown only once recorded. */
const VITAL_EXTRA = [
  'height',
  'bmi',
  'blood_sugar',
  'respiratory_rate',
  'pain_score',
] as const satisfies readonly ReadingKey[];

/** The edit form's boxes: the design's five first, then the rest. */
const VITAL_EDIT_ORDER: readonly ReadingKey[] = [
  'blood_pressure',
  'heart_rate',
  'temperature',
  'weight',
  'oxygen_saturation',
  'respiratory_rate',
  'blood_sugar',
  'height',
  'bmi',
  'pain_score',
];

/**
 * Status-word colour per flag level. Colour only supplements the word itself;
 * `vt-normal` / `vt-amber` keep teal and amber AA-legible in both themes (see `styles`).
 */
const FLAG_TONE: Record<VitalFlagLevel, string> = {
  normal: 'vt-normal',
  low: 'vt-amber',
  elevated: 'vt-amber',
  high: 'text-alert-ink',
  critical: 'text-alert-ink',
};

/** One card on Medical Information. */
interface VitalCardVm {
  readonly key: ReadingKey;
  readonly label: string;
  readonly icon: string;
  readonly tint: string;
  /** False: no reading of this type yet (the value is a muted "—"). */
  readonly recorded: boolean;
  /** "—" when not recorded. */
  readonly value: string;
  readonly unit: string;
  readonly joined: boolean;
  readonly inkUnit: boolean;
  /** The flag ("Normal", "Very high"), "Not recorded", or when it was taken (no flag). */
  readonly status: string;
  /** The status is "Taken 2 hours ago" (no flag) — `detail` already says it to screen readers. */
  readonly statusIsWhen: boolean;
  readonly statusTone: string;
  /** When an out-of-date reading was taken ("12 Sep"), else ''. */
  readonly staleNote: string;
  /** Who recorded it and when — for screen readers and the hover title. */
  readonly detail: string;
}

/** A high or critical reading, spelled out under the cards. */
interface VitalAlertVm {
  readonly key: ReadingKey;
  readonly text: string;
  /** The API's advice, "update your readings" for an old one, or null (weight / BMI / pain). */
  readonly advice: string | null;
  /** Critical and current — bold, and listed first. */
  readonly critical: boolean;
}

/** "e.g." hints for the vitals boxes. */
const VITAL_PLACEHOLDER: Partial<Record<ReadingKey, string>> = {
  temperature: 'e.g 36.6',
  heart_rate: 'e.g 72',
  respiratory_rate: 'e.g 16',
  oxygen_saturation: 'e.g 98',
  blood_sugar: 'e.g 5.4',
  weight: 'e.g 68',
  height: 'e.g 172',
  pain_score: 'e.g 2',
};

/** "October 28, 2026. - 10:00AM" (local time), as the design writes "Last updated". */
function lastUpdatedText(d: Date): string {
  const date = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    .replace(/\s+/g, '');
  return `${date}. - ${time}`;
}

/** "12 Sep" — when an out-of-date reading was taken ('' when unknown). */
function shortDate(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d)
    : '';
}

/** The single-number readings the patient types (blood pressure is two boxes; BMI is worked out). */
const VITAL_NUMBER_KEYS = [
  'temperature',
  'heart_rate',
  'respiratory_rate',
  'oxygen_saturation',
  'blood_sugar',
  'weight',
  'height',
  'pain_score',
] as const satisfies readonly ReadingKey[];
type VitalNumberKey = (typeof VITAL_NUMBER_KEYS)[number];

function isVitalNumberKey(key: string): key is VitalNumberKey {
  return (VITAL_NUMBER_KEYS as readonly string[]).includes(key);
}

/** A local date-time as an `<input type="datetime-local">` value (YYYY-MM-DDTHH:mm). */
function localDateTimeValue(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** BMI to one decimal from kg and cm (as the API works it out), or null when either is missing. */
function bmiOf(weightKg: number | null, heightCm: number | null): number | null {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null;
  return Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10;
}

/** `medical-add` is the one Medical Information editor: vitals first, then the medical record. */
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
  readonly subtitle: string;
}

/**
 * My Profile (Figma 740:11873) with its Personal Information view (681:9123) /
 * edit (686:10572) and Medical Information view (782:15059; empty 701:9969) /
 * edit (763:12524) — one editor for the vitals and the medical record.
 * All sub-views and the success toasts live in this one component (they are not
 * separate pages), toggled by the `view` signal.
 */
@Component({
  selector: 'pat-my-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /* Status text that stays AA-legible in both themes: amber is the warning
         token darkened for white, the token itself on dark; normal is teal,
         the brighter teal on dark. */
      .vt-amber {
        color: color-mix(in srgb, var(--color-warning, #f2a900) 62%, black);
      }
      :host-context(html[data-theme='dark']) .vt-amber {
        color: var(--color-warning, #f2a900);
      }
      .vt-normal {
        color: var(--color-teal, #00796c);
      }
      :host-context(html[data-theme='dark']) .vt-normal {
        color: var(--color-teal-bright, #00b39a);
      }
    `,
  ],
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    ButtonComponent,
    DialogComponent,
    IconComponent,
    InputComponent,
    OtpComponent,
    PhoneInputComponent,
    SearchSelectComponent,
  ],
  host: { class: 'block' },
  template: `
    <!-- Success toast (image upload / profile update) -->
    @if (toast()) {
      <div
        class="sd-toast-in fixed right-6 top-6 z-50 flex items-center gap-3 rounded-card border border-sage/30 bg-white px-4 py-3 shadow-lg"
        role="status"
      >
        <sd-icon name="circle-check" [size]="20" class="text-sage" />
        <span class="font-sans text-body-sm font-medium text-ink">{{
          toast()
        }}</span>
      </div>
    }

    <div class="flex flex-col gap-6 py-2">
      @if (loadError()) {
        <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert" role="alert">
          {{ loadError() }}
        </p>
      }
      @if (view() === 'home' && healthState() === 'error') {
        <div
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-field bg-alert/10 px-4 py-3"
          role="alert"
        >
          <p class="flex items-start gap-2 font-label text-caption text-alert">
            <sd-icon name="triangle-alert" [size]="16" class="mt-px shrink-0" />
            {{ healthError() }}
          </p>
          <button
            type="button"
            class="flex items-center gap-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean"
            (click)="loadHealthProfile()"
          >
            <sd-icon name="refresh-cw" [size]="14" />
            Try again
          </button>
        </div>
      }
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
                class="flex flex-col gap-3 rounded-card border border-haze bg-white p-6 text-left shadow-card transition hover:border-cerulean/40 hover:shadow-card-hover"
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
                  {{ c.subtitle }}
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
            class="grid grid-cols-1 gap-x-6 gap-y-5 rounded-card border border-haze bg-white p-6 shadow-card md:grid-cols-2"
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
                value: genderText(),
              }"
            />
            <div class="md:col-span-2">
              <ng-container
                [ngTemplateOutlet]="readField"
                [ngTemplateOutletContext]="{
                  label: 'Residential Address',
                  value: addressText(),
                }"
              />
            </div>
          </div>

          <!-- Phone number verification -->
          <div
            class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <sd-icon name="phone" [size]="18" class="text-slate" />
                <span class="font-sans text-body text-ink">{{ phone() }}</span>
                @if (phoneVerified()) {
                  <span
                    class="flex items-center gap-1 rounded-lg bg-sage/15 px-2.5 py-1 font-sans text-caption font-medium text-sage-ink"
                  >
                    <sd-icon name="circle-check" [size]="14" />
                    Verified
                  </span>
                } @else {
                  <span
                    class="rounded-lg bg-warning/15 px-2.5 py-1 font-sans text-caption font-medium text-warning-ink"
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
                    class="w-36 rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body tracking-[0.3em] text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
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
            class="flex flex-col gap-6 rounded-card border border-haze bg-white p-6 shadow-card"
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
                [max]="maxDob"
                [error]="dobError()"
              />
              <div class="flex w-full flex-col gap-2">
                <span class="font-sans text-body font-semibold text-ink"
                  >Gender <span class="text-alert">*</span></span
                >
                <sd-search-select
                  size="lg"
                  placeholder="Select"
                  [options]="genderSelectOptions"
                  [value]="form.controls.gender.value"
                  (valueChange)="form.controls.gender.setValue($event)"
                />
              </div>
              <div class="md:col-span-2">
                <label class="flex w-full flex-col gap-2">
                  <span class="font-sans text-body font-semibold text-ink"
                    >Residential Address <span class="text-alert">*</span></span
                  >
                  <textarea
                    formControlName="address"
                    rows="3"
                    class="rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body text-ink focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
                  ></textarea>
                </label>
              </div>
            </div>
            <div
              class="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-caption text-slate"
            >
              <span class="flex items-center gap-1.5">
                <sd-icon name="mail" [size]="16" />
                {{ email() }}
              </span>
              <button
                type="button"
                class="font-semibold text-cerulean transition-colors hover:text-ocean"
                (click)="openEmailChange()"
              >
                Change email address
              </button>
            </div>
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
              subtitle:
                'Update your medical history, allergies, medications, and existing conditions.',
            }"
          />
          <ng-container [ngTemplateOutlet]="tipsBanner" />
          <div class="mb-2 flex justify-end">
            <sd-button class="w-[167px]" [full]="true" (click)="openEdit()">
              <sd-icon name="square-pen" [size]="20" />
              Edit
            </sd-button>
          </div>

          <!-- Vitals: the latest reading of each type, flagged by the API -->
          <section class="flex flex-col gap-4" aria-labelledby="vitals-heading">
            <h2
              id="vitals-heading"
              class="flex items-center gap-2 font-sans text-body-lg text-ink"
            >
              <sd-icon name="activity" [size]="20" />Vitals
            </h2>
            @if (vitalsState() !== 'ready') {
              <ng-container [ngTemplateOutlet]="vitalsUnavailable" />
            } @else {
              <!-- Five across from 1440px, where "128/88 mmHg" fits on one line; in rem so it sorts after md: -->
              <ul class="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 min-[90rem]:grid-cols-5">
                @for (c of vitalCards(); track c.key) {
                  <li
                    class="flex min-w-0 items-start justify-between gap-2 rounded-lg border border-frost bg-white p-3 shadow-[0_4px_5px_rgba(21,101,192,0.05)] sm:items-center sm:p-4"
                    [attr.title]="c.detail || null"
                  >
                    <div class="flex min-w-0 flex-col gap-2">
                      <span class="font-sans text-caption text-ink">{{ c.label }}</span>
                      <!-- Not recorded: a muted dash (the status says it in words) -->
                      <span
                        class="font-sans text-[18px] font-semibold leading-[22px] tracking-[0.4px] sm:text-[20px]"
                        [class]="c.recorded ? 'text-ink' : 'text-slate'"
                        [attr.aria-hidden]="c.recorded ? null : 'true'"
                        >{{ c.value
                        }}@if (c.unit) {<span [class.text-slate]="!c.inkUnit">{{ c.joined ? '' : ' ' }}{{ c.unit }}</span>}</span
                      >
                      <!-- No flag: the status is when it was taken, which the sr-only detail already says -->
                      <span
                        class="font-sans text-[10px] font-medium leading-[14px] tracking-[0.3px]"
                        [class]="c.statusTone"
                        [attr.aria-hidden]="c.statusIsWhen ? 'true' : null"
                        >{{ c.status
                        }}@if (c.staleNote) {<span class="font-normal text-slate"> · {{ c.staleNote }}</span>}</span
                      >
                      @if (c.detail) {
                        <span class="sr-only">{{ c.detail }}</span>
                      }
                    </div>
                    <span
                      class="flex shrink-0 items-center rounded-lg p-2"
                      [class]="c.tint"
                      aria-hidden="true"
                    >
                      <sd-icon [name]="c.icon" [size]="16" />
                    </span>
                  </li>
                }
              </ul>
              <div
                class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6"
              >
                @if (vitalAlerts().length) {
                  <ul class="flex flex-col gap-1.5">
                    @for (a of vitalAlerts(); track a.key) {
                      <li class="flex items-start gap-2 font-sans text-caption">
                        <sd-icon
                          [name]="a.critical ? 'triangle-alert' : 'info'"
                          [size]="16"
                          class="mt-px shrink-0 text-alert"
                        />
                        <!-- The space before "(" is inside the span: Angular drops whitespace-only text between elements -->
                        <span
                          ><span class="text-alert" [class.font-semibold]="a.critical">{{
                            a.text
                          }}</span
                          >@if (a.advice) {<span class="text-slate"> ({{ a.advice }})</span>}</span
                        >
                      </li>
                    }
                  </ul>
                }
                <p
                  class="flex items-start gap-1.5 font-sans text-caption md:ml-auto md:text-right"
                  [class]="vitalsCue() ? 'vt-amber' : 'text-slate'"
                >
                  @if (vitalsCue()) {
                    <sd-icon name="clock" [size]="14" class="mt-0.5 shrink-0" />
                  }
                  <span
                    >@if (lastUpdated(); as at) {
                      Last updated: {{ at }}
                    } @else {
                      No readings yet
                    }
                    @if (vitalsCue()) {
                      <span class="font-medium"> · {{ vitalsCue() }}</span>
                    }</span
                  >
                </p>
              </div>
              <p class="font-sans text-caption font-light text-slate">
                Based on typical adult ranges — your doctor will interpret your readings.
              </p>
            }
          </section>

          @if (!healthLoaded()) {
            <ng-container [ngTemplateOutlet]="healthUnavailable" />
          } @else if (hasMedical()) {
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
              <!-- Medical History -->
              <section [class]="viewCard" aria-labelledby="history-heading">
                <h2 id="history-heading" [class]="cardTitle">
                  <sd-icon name="clipboard-list" [size]="20" />Medical History
                </h2>
                <div class="flex flex-col">
                  @for (row of medical().history; track $index) {
                    <dl class="grid grid-cols-1 gap-4 @xs:grid-cols-2 @xs:gap-x-6" [class]="entryClass">
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Condition/Procedure', value: row.condition }"
                      />
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Year', value: row.year }"
                      />
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{
                          label: 'Note (Optional)',
                          value: row.note,
                          empty: 'No note',
                          span: 'col-span-full',
                        }"
                      />
                    </dl>
                  } @empty {
                    <p class="font-sans text-body-sm text-slate">No past conditions or procedures added.</p>
                  }
                </div>
              </section>

              <!-- Allergies -->
              <section [class]="viewCard" aria-labelledby="allergies-heading">
                <h2 id="allergies-heading" [class]="cardTitle">
                  <sd-icon name="triangle-alert" [size]="20" />Allergies
                </h2>
                <div class="flex flex-col">
                  @for (row of medical().allergies; track $index) {
                    <dl class="grid grid-cols-1 gap-4 @xs:grid-cols-2 @xs:gap-x-6" [class]="entryClass">
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Allergen', value: row.allergen }"
                      />
                      <div class="flex min-w-0 flex-col gap-1">
                        <dt class="font-sans text-body-sm text-slate">Severity</dt>
                        <dd class="flex items-center gap-2" [class]="readBoxClass">
                          @if (row.severity) {
                            <span
                              class="flex size-6 shrink-0 items-center justify-center rounded-md"
                              [class]="severityTone(row.severity).cls"
                              aria-hidden="true"
                            >
                              <sd-icon [name]="severityTone(row.severity).icon" [size]="14" />
                            </span>
                            <span class="min-w-0 font-semibold text-ink">{{
                              severityLabel(row.severity)
                            }}</span>
                          } @else {
                            <span class="text-slate">—</span>
                          }
                        </dd>
                      </div>
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Reaction', value: row.reaction, span: 'col-span-full' }"
                      />
                    </dl>
                  } @empty {
                    <p class="font-sans text-body-sm text-slate">No allergies added.</p>
                  }
                </div>
              </section>

              <!-- Current Medications -->
              <section [class]="viewCard" aria-labelledby="medications-heading">
                <h2 id="medications-heading" [class]="cardTitle">
                  <sd-icon name="pill" [size]="20" />Current Medications
                </h2>
                <div class="flex flex-col">
                  @for (row of medical().medications; track $index) {
                    <dl class="grid grid-cols-1 gap-4 @xs:grid-cols-2 @xs:gap-x-6 @min-[30rem]:grid-cols-3" [class]="entryClass">
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Medication name', value: row.name }"
                      />
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Dosage', value: row.dosage }"
                      />
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Frequency', value: row.frequency }"
                      />
                      @if (row.reason) {
                        <ng-container
                          [ngTemplateOutlet]="readBox"
                          [ngTemplateOutletContext]="{ label: 'What it’s for', value: row.reason, span: 'col-span-full' }"
                        />
                      }
                      @if (isHerbal(row.herbal)) {
                        <div class="col-span-full">
                          <dt class="sr-only">Type</dt>
                          <dd
                            class="inline-flex items-center gap-1 rounded-pill bg-sage/15 px-2.5 py-1 font-sans text-caption font-medium text-sage-ink"
                          >
                            <sd-icon name="leaf" [size]="14" />Herbal or traditional medicine
                          </dd>
                        </div>
                      }
                    </dl>
                  } @empty {
                    <p class="font-sans text-body-sm text-slate">No current medications added.</p>
                  }
                </div>
              </section>

              <!-- Existing Conditions -->
              <section [class]="viewCard" aria-labelledby="conditions-heading">
                <h2 id="conditions-heading" [class]="cardTitle">
                  <sd-icon name="activity" [size]="20" />Existing Conditions
                </h2>
                <div class="flex flex-col">
                  @for (row of medical().conditions; track $index) {
                    <dl class="grid grid-cols-1 gap-4 @xs:grid-cols-2 @xs:gap-x-6 @min-[30rem]:grid-cols-3" [class]="entryClass">
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Condition', value: row.condition }"
                      />
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Status', value: row.status }"
                      />
                      <ng-container
                        [ngTemplateOutlet]="readBox"
                        [ngTemplateOutletContext]="{ label: 'Since', value: row.since }"
                      />
                    </dl>
                  } @empty {
                    <p class="font-sans text-body-sm text-slate">No existing conditions added.</p>
                  }
                </div>
              </section>
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
              <sd-button (click)="openEdit('medical')">
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

          <!-- Vitals (Figma 763:12524): saved only when at least one box is filled -->
          <section [class]="editCard" aria-labelledby="vitals-edit-heading">
            <div class="flex flex-col gap-1">
              <h2
                id="vitals-edit-heading"
                tabindex="-1"
                class="flex items-center gap-2 font-sans text-body-lg text-ink outline-none"
              >
                <sd-icon name="activity" [size]="20" />Vitals
              </h2>
              <p class="font-sans text-caption text-slate">
                Add the readings you have and leave the rest blank. Your doctor sees them
                before and during your visits.
              </p>
            </div>
            @if (vitalsState() !== 'ready') {
              <ng-container [ngTemplateOutlet]="vitalsUnavailable" />
            } @else {
              <div [formGroup]="vitalsForm" class="flex flex-col gap-5">
                <div class="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  @for (f of editFields(); track f.key) {
                    @if (f.key === 'blood_pressure') {
                      <div class="flex w-full min-w-0 flex-col gap-1" role="group" aria-labelledby="bp-label">
                        <span id="bp-label" [class]="vitalLabel">
                          <sd-icon [name]="meta(f.key).icon" [size]="16" class="shrink-0" />{{
                            formLabel(f.key)
                          }}
                        </span>
                        <div
                          class="flex items-center gap-1 rounded-field border bg-white px-4 transition-colors focus-within:border-cerulean focus-within:ring-2 focus-within:ring-cerulean/20"
                          [class]="bpError(f) ? 'border-alert' : 'border-ash'"
                        >
                          <input
                            type="number"
                            inputmode="numeric"
                            formControlName="systolic"
                            (input)="noteBadInput('systolic', $event)"
                            placeholder="e.g 118"
                            aria-label="Systolic (top number)"
                            aria-describedby="vt-hint-blood_pressure"
                            [attr.aria-invalid]="bpError(f) ? true : null"
                            [min]="f.systolic?.min ?? null"
                            [max]="f.systolic?.max ?? null"
                            step="1"
                            [class]="bpInput"
                          />
                          <span class="font-sans text-body text-slate" aria-hidden="true">/</span>
                          <input
                            type="number"
                            inputmode="numeric"
                            formControlName="diastolic"
                            (input)="noteBadInput('diastolic', $event)"
                            placeholder="78"
                            aria-label="Diastolic (bottom number)"
                            aria-describedby="vt-hint-blood_pressure"
                            [attr.aria-invalid]="bpError(f) ? true : null"
                            [min]="f.diastolic?.min ?? null"
                            [max]="f.diastolic?.max ?? null"
                            step="1"
                            [class]="bpInput"
                          />
                        </div>
                        @if (bpError(f); as e) {
                          <span id="vt-hint-blood_pressure" class="font-sans text-caption text-alert" role="alert">{{ e }}</span>
                        } @else {
                          <span id="vt-hint-blood_pressure" [class]="vitalHintClass">Format: Systolic/diastolic</span>
                        }
                      </div>
                    } @else if (f.derived) {
                      <div class="flex w-full min-w-0 flex-col gap-1">
                        <span [class]="vitalLabel">
                          <sd-icon [name]="meta(f.key).icon" [size]="16" class="shrink-0" />{{
                            formLabel(f.key)
                          }}
                        </span>
                        <span
                          class="rounded-field border border-dashed border-ash bg-glacier px-4 py-[13px] font-sans text-body"
                          [class]="bmiPreview() !== null ? 'font-semibold text-ink' : 'text-slate'"
                          aria-live="polite"
                          >{{ bmiPreview() ?? '—' }}</span
                        >
                        <span [class]="vitalHintClass">{{ bmiHint() }}</span>
                      </div>
                    } @else if (isNumberKey(f.key)) {
                      <div class="flex w-full min-w-0 flex-col gap-1">
                        <label [for]="'vt-' + f.key" [class]="vitalLabel">
                          <sd-icon [name]="meta(f.key).icon" [size]="16" class="shrink-0" />{{
                            formLabel(f.key)
                          }}
                        </label>
                        <input
                          [id]="'vt-' + f.key"
                          type="number"
                          [attr.inputmode]="(f.step ?? 1) < 1 ? 'decimal' : 'numeric'"
                          [formControlName]="f.key"
                          (input)="noteBadInput(f.key, $event)"
                          [placeholder]="placeholder(f.key)"
                          [min]="f.min"
                          [max]="f.max"
                          [attr.step]="f.step ?? 'any'"
                          [attr.aria-invalid]="vitalFieldError(f) ? true : null"
                          [attr.aria-describedby]="vitalFieldError(f) || vitalHint(f) ? 'vt-hint-' + f.key : null"
                          [class]="vitalFieldError(f) ? vitalInputInvalid : vitalInput"
                        />
                        @if (vitalFieldError(f); as e) {
                          <span [id]="'vt-hint-' + f.key" class="font-sans text-caption text-alert" role="alert">{{ e }}</span>
                        } @else if (vitalHint(f); as hint) {
                          <span [id]="'vt-hint-' + f.key" [class]="vitalHintClass">{{ hint }}</span>
                        }
                      </div>
                    }
                  }
                </div>

                <div class="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-cloud pt-5 sm:grid-cols-2">
                  <div class="flex w-full min-w-0 flex-col gap-1">
                    <label for="vt-taken-at" [class]="vitalLabel">
                      <sd-icon name="clock" [size]="16" class="shrink-0" />When were these taken?
                    </label>
                    <input
                      id="vt-taken-at"
                      type="datetime-local"
                      formControlName="takenAt"
                      [attr.max]="takenAtMax()"
                      [attr.min]="takenAtMin()"
                      [attr.aria-invalid]="takenAtError() ? true : null"
                      [attr.aria-describedby]="takenAtError() ? 'vt-taken-at-error' : null"
                      [class]="takenAtError() ? vitalInputInvalid : vitalInput"
                    />
                    @if (takenAtError(); as e) {
                      <span id="vt-taken-at-error" class="font-sans text-caption text-alert" role="alert">{{ e }}</span>
                    }
                  </div>
                  <label class="flex min-h-11 w-fit cursor-pointer items-center gap-3 sm:mt-6">
                    <input
                      type="checkbox"
                      formControlName="device"
                      class="size-5 shrink-0 cursor-pointer rounded border-ash accent-cerulean"
                    />
                    <span class="flex flex-col gap-0.5 font-sans text-body-sm text-ink">
                      Measured with my own device
                      <span class="text-caption text-slate"
                        >e.g. a blood-pressure monitor, thermometer or smart scale</span
                      >
                    </span>
                  </label>
                </div>

                @if (vitalsFormError()) {
                  <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert" role="alert">
                    {{ vitalsFormError() }}
                  </p>
                }
              </div>
            }
          </section>

          @if (!healthLoaded()) {
            <ng-container [ngTemplateOutlet]="healthUnavailable" />
          } @else {
          <div
            [formGroup]="medicalForm"
            class="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8"
          >
            <!-- Medical History -->
            <section
              formArrayName="history"
              [class]="editCard"
            >
              <div class="flex items-center justify-between gap-2">
                <h2 id="medical-edit-start" tabindex="-1" class="outline-none" [class]="cardTitle">
                  <sd-icon name="clipboard-list" [size]="20" />Medical History
                </h2>
                <sd-button size="sm" (click)="addHistory()">
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
                      [class]="removeButton"
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
              [class]="editCard"
            >
              <div class="flex items-center justify-between gap-2">
                <h2 [class]="cardTitle">
                  <sd-icon name="triangle-alert" [size]="20" />Allergies
                </h2>
                <sd-button size="sm" (click)="addAllergy()">
                  <sd-icon name="plus" [size]="16" />Add Another
                </sd-button>
              </div>
              <p
                id="allergies-hint"
                class="-mt-1 flex items-start gap-2 font-sans text-caption text-slate"
              >
                <sd-icon name="info" [size]="16" class="mt-px shrink-0 text-cerulean" />
                Your doctor sees this before prescribing. If you have no allergies,
                leave this empty.
              </p>
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
                        aria-describedby="allergies-hint"
                        [class]="rowInput"
                      />
                    </label>
                    <label class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate"
                        >Severity</span
                      >
                      <span class="relative flex">
                        <select
                          formControlName="severity"
                          [class]="rowInput + ' w-full cursor-pointer appearance-none pr-10'"
                        >
                          <option value="">Select</option>
                          @for (opt of severityOptions; track opt.value) {
                            <option [value]="opt.value">{{ opt.label }}</option>
                          }
                          @if (isLegacySeverity(row.get('severity')?.value)) {
                            <option [value]="row.get('severity')?.value">
                              {{ row.get('severity')?.value }}
                            </option>
                          }
                        </select>
                        <sd-icon
                          name="chevron-down"
                          [size]="18"
                          class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate"
                        />
                      </span>
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
                      [class]="removeButton"
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
              [class]="editCard"
            >
              <div class="flex items-center justify-between gap-2">
                <h2 [class]="cardTitle">
                  <sd-icon name="pill" [size]="20" />Current Medications
                </h2>
                <sd-button size="sm" (click)="addMedication()">
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
                  <label class="flex w-full flex-col gap-2">
                    <span class="font-sans text-caption text-slate"
                      >What it’s for</span
                    >
                    <input
                      formControlName="reason"
                      placeholder="e.g Diabetes"
                      [class]="rowInput"
                    />
                  </label>
                  <label class="flex min-h-11 w-fit cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      formControlName="herbal"
                      class="size-4 shrink-0 cursor-pointer rounded border-ash accent-cerulean"
                    />
                    <span
                      class="flex items-center gap-1.5 font-sans text-body-sm text-ink"
                    >
                      <sd-icon name="leaf" [size]="16" class="text-sage" />
                      Herbal or traditional medicine
                    </span>
                  </label>
                  @if (medicationRows.length > 1) {
                    <button
                      type="button"
                      [class]="removeButton"
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
              [class]="editCard"
            >
              <div class="flex items-center justify-between gap-2">
                <h2 [class]="cardTitle">
                  <sd-icon name="activity" [size]="20" />Existing Conditions
                </h2>
                <sd-button size="sm" (click)="addCondition()">
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
                    <div class="flex w-full flex-col gap-2">
                      <span class="font-sans text-caption text-slate">Status</span>
                      <sd-search-select
                        placeholder="Select"
                        [options]="statusOptions"
                        [value]="row.get('status')?.value"
                        (valueChange)="row.get('status')?.setValue($event)"
                      />
                    </div>
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
                      [class]="removeButton"
                      (click)="removeRow(conditionRows, $index)"
                    >
                      Remove
                    </button>
                  }
                </div>
              }
            </section>
          </div>
          }

          @if (editError()) {
            <p
              id="medical-edit-error"
              tabindex="-1"
              class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert outline-none"
              role="alert"
            >
              {{ editError() }}
            </p>
          }
          <div class="flex flex-wrap gap-3">
            <sd-button
              variant="outline"
              [disabled]="savingSection() === 'medical'"
              (click)="cancelEdit()"
              >Cancel</sd-button
            >
            <sd-button
              (click)="saveEdit()"
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
          @if (!healthLoaded()) {
            <ng-container [ngTemplateOutlet]="healthUnavailable" />
          } @else {
          <form
            [formGroup]="insuranceForm"
            (ngSubmit)="saveInsurance()"
            class="rounded-card border border-haze bg-white p-6 shadow-card"
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
              <div class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Coverage Status</span
                >
                <sd-search-select
                  placeholder="Select"
                  [options]="coverageOptions"
                  [value]="insuranceForm.controls.coverage_status.value"
                  (valueChange)="
                    insuranceForm.controls.coverage_status.setValue($event)
                  "
                />
              </div>
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
          @if (!healthLoaded()) {
            <ng-container [ngTemplateOutlet]="healthUnavailable" />
          } @else {
          <form
            [formGroup]="emergencyForm"
            (ngSubmit)="saveEmergency()"
            class="rounded-card border border-haze bg-white p-6 shadow-card"
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
              <div class="flex w-full flex-col gap-2">
                <span class="font-sans text-caption text-slate"
                  >Relationship</span
                >
                <sd-search-select
                  placeholder="Select"
                  [options]="relationshipOptions"
                  [value]="emergencyForm.controls.relationship.value"
                  (valueChange)="
                    emergencyForm.controls.relationship.setValue($event)
                  "
                />
              </div>
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
      }
    </div>

    <!-- Health profile not loaded (yet): no editor, so nothing stored can be overwritten -->
    <ng-template #healthUnavailable>
      @if (healthState() === 'error') {
        <div
          class="flex flex-col items-center gap-4 rounded-card border border-haze bg-white px-6 py-14 text-center shadow-card"
          role="alert"
        >
          <span
            class="flex size-16 items-center justify-center rounded-full bg-alert/10 text-alert-ink"
          >
            <sd-icon name="wifi-off" [size]="28" />
          </span>
          <div class="flex max-w-md flex-col gap-1">
            <h2 class="font-heading text-h5 text-ink">
              Couldn't load your health information
            </h2>
            <p class="font-sans text-body-sm text-slate">{{ healthError() }}</p>
            <p class="font-sans text-body-sm text-slate">
              Your saved details haven't changed. Try again to view or edit them.
            </p>
          </div>
          <sd-button variant="outline" (click)="loadHealthProfile()">
            <sd-icon name="refresh-cw" [size]="18" />
            Try again
          </sd-button>
        </div>
      } @else {
        <div
          class="flex flex-col gap-4"
          aria-busy="true"
          aria-label="Loading your health information"
        >
          <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
          <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
        </div>
      }
    </ng-template>

    <ng-template #vitalsUnavailable>
      @if (vitalsState() === 'error') {
        <div
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-field bg-alert/10 px-4 py-3"
          role="alert"
        >
          <p class="flex items-start gap-2 font-label text-caption text-alert">
            <sd-icon name="triangle-alert" [size]="16" class="mt-px shrink-0" />
            {{ vitalsError() }}
          </p>
          <button
            type="button"
            class="flex min-h-11 items-center gap-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean"
            (click)="loadVitals()"
          >
            <sd-icon name="refresh-cw" [size]="14" />
            Try again
          </button>
        </div>
      } @else {
        <div
          class="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 min-[90rem]:grid-cols-5"
          aria-busy="true"
          aria-label="Loading your vitals"
        >
          <div class="h-24 animate-pulse rounded-lg bg-cloud"></div>
          <div class="h-24 animate-pulse rounded-lg bg-cloud"></div>
          <div class="hidden h-24 animate-pulse rounded-lg bg-cloud md:block"></div>
          <div class="hidden h-24 animate-pulse rounded-lg bg-cloud min-[90rem]:block"></div>
          <div class="hidden h-24 animate-pulse rounded-lg bg-cloud min-[90rem]:block"></div>
        </div>
      }
    </ng-template>

    <!-- A read-only "field" on Medical Information: label over a boxed value (inside a <dl>) -->
    <ng-template #readBox let-label="label" let-value="value" let-empty="empty" let-span="span">
      <div class="flex min-w-0 flex-col gap-1" [class]="span ?? ''">
        <dt class="font-sans text-body-sm text-slate">{{ label }}</dt>
        <dd [class]="readBoxClass">
          @if (value) {
            <span class="font-semibold text-ink">{{ value }}</span>
          } @else {
            <span class="text-slate">{{ empty ?? '—' }}</span>
          }
        </dd>
      </div>
    </ng-template>

    <!-- ===== Shared templates ===== -->
    <ng-template #subHeader let-title="title" let-subtitle="subtitle">
      <!-- Back sits level with the title on phones (the subtitle wraps), centred on title + subtitle from sm -->
      <div class="flex items-start justify-between gap-4 sm:items-center">
        <div class="flex flex-col gap-1">
          <h1 id="profile-view-title" class="scroll-mt-24 font-heading text-h3 text-ink">{{ title }}</h1>
          <p class="font-sans text-body text-slate">{{ subtitle }}</p>
        </div>
        <!-- Not while the Medical Information editor saves: a failure must land on the editor that shows it -->
        <button
          type="button"
          class="flex min-h-11 shrink-0 items-center gap-2 font-sans text-body-lg font-normal text-slate transition-colors hover:text-cerulean disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-slate"
          [disabled]="savingSection() === 'medical'"
          (click)="back()"
        >
          <sd-icon name="arrow-left" [size]="22" />
          Back
        </button>
      </div>
    </ng-template>

    <ng-template #profileCard>
      <div class="flex items-center gap-4 rounded-card bg-frost/50 p-5">
        <div class="relative shrink-0">
          @if (avatarSrc()) {
            <img
              [src]="avatarSrc()"
              alt="Profile photo"
              width="88"
              height="88"
              class="size-22 rounded-full object-cover"
            />
          } @else {
            <span
              class="flex size-22 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h3 text-cerulean-dark"
            >
              @if (initials()) {
                {{ initials() }}
              } @else {
                <sd-icon name="user" [size]="32" />
              }
            </span>
          }
          <button
            #changePhotoBtn
            type="button"
            class="absolute bottom-0 right-0 flex size-8 items-center justify-center rounded-full bg-cerulean text-white ring-2 ring-frost/50 transition-opacity disabled:opacity-60"
            [attr.aria-label]="uploadingAvatar() ? 'Uploading' : 'Change photo'"
            [disabled]="uploadingAvatar()"
            (click)="avatarModalOpen.set(true)"
          >
            @if (uploadingAvatar()) {
              <span
                class="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              ></span>
            } @else {
              <sd-icon name="camera" [size]="16" />
            }
          </button>
          <sd-dialog
            [open]="avatarModalOpen()"
            title="Update profile photo"
            subtitle="Drag an image here, or choose a file."
            size="sm"
            [busy]="uploadingAvatar()"
            (closed)="avatarModalOpen.set(false)"
          >
            <!-- Inside the dialog: the page behind a modal dialog is inert. -->
            <input
              #avatarInput
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              class="hidden"
              (change)="onAvatarSelected($event)"
            />
            <div
              class="flex flex-col items-center gap-3 rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors"
              [class]="avatarDragging() ? 'border-cerulean bg-frost/40' : 'border-cloud bg-glacier/40'"
              (dragover)="$event.preventDefault(); avatarDragging.set(true)"
              (dragleave)="avatarDragging.set(false)"
              (drop)="onAvatarDrop($event)"
            >
              @if (uploadingAvatar()) {
                <span class="size-7 animate-spin rounded-full border-2 border-cloud border-t-cerulean"></span>
                <span class="font-sans text-body-sm text-slate" role="status">Uploading…</span>
              } @else {
                <span class="flex size-12 items-center justify-center rounded-full bg-frost text-cerulean-dark"><sd-icon name="upload" [size]="24" /></span>
                <p class="font-sans text-body font-semibold text-ink">Drag &amp; drop your photo</p>
                <p class="font-sans text-caption text-slate">PNG, JPG, WEBP or GIF · up to 2MB</p>
                <button
                  type="button"
                  data-autofocus
                  class="mt-1 min-h-11 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
                  (click)="avatarInput.click()"
                >
                  Choose from file
                </button>
              }
            </div>
          </sd-dialog>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <p class="font-heading text-h5 text-ink">{{ fullName() }}</p>
          <div class="flex items-center gap-2">
            <p class="truncate font-sans text-caption text-slate">
              {{ email() }}
            </p>
            <button
              type="button"
              class="shrink-0 font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean"
              (click)="openEmailChange()"
            >
              Change
            </button>
          </div>
          @if (avatarSrc()) {
            <button
              type="button"
              class="w-fit font-sans text-caption font-semibold text-alert transition-colors hover:underline disabled:opacity-60"
              [disabled]="uploadingAvatar()"
              (click)="removeAvatar(changePhotoBtn)"
            >
              Remove photo
            </button>
          }
          <div
            class="flex flex-wrap gap-x-4 gap-y-1 font-sans text-caption text-slate"
          >
            <span class="flex min-w-0 items-center gap-1">
              <sd-icon name="map-pin" [size]="14" class="shrink-0" />
              <span class="truncate">{{ addressText() }}</span>
            </span>
            <span class="flex items-center gap-1">
              <sd-icon name="calendar-days" [size]="14" />{{ dobLong() }}
            </span>
          </div>
          <div class="mt-1 flex flex-col gap-1">
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/70">
              <div
                class="h-full rounded-full bg-cerulean transition-all"
                [style.width.%]="profileComplete()"
              ></div>
            </div>
            <div class="flex items-center justify-between">
              <span class="font-sans text-caption text-slate"
                >Profile complete</span
              >
              <span class="font-sans text-body-sm font-semibold text-sage"
                >{{ profileComplete() }}%</span
              >
            </div>
          </div>
        </div>
      </div>
    </ng-template>

    <ng-template #privacyCard>
      <div class="flex flex-col gap-3 rounded-card border border-haze bg-white p-5 shadow-card">
        <div class="flex items-center gap-2">
          <sd-icon name="shield-check" [size]="20" class="text-sage" />
          <p class="font-sans text-body font-semibold text-ink">
            Account security
          </p>
        </div>
        <ul class="flex flex-col gap-2 font-sans text-body-sm">
          <li class="flex items-center gap-2 text-ink">
            <sd-icon name="circle-check" [size]="18" class="shrink-0 text-sage" />
            Data encrypted in transit &amp; at rest
          </li>
          <li
            class="flex items-center gap-2"
            [class]="phoneVerified() ? 'text-ink' : 'text-slate'"
          >
            <sd-icon
              [name]="phoneVerified() ? 'circle-check' : 'info'"
              [size]="18"
              class="shrink-0"
              [class]="phoneVerified() ? 'text-sage' : 'text-slate'"
            />
            {{ phoneVerified() ? 'Phone number verified' : 'Phone not verified yet' }}
          </li>
          <li class="flex items-center gap-2 text-ink">
            <sd-icon
              name="circle-check"
              [size]="18"
              class="shrink-0"
              [class]="profileComplete() === 100 ? 'text-sage' : 'text-slate'"
            />
            Profile {{ profileComplete() }}% complete
          </li>
        </ul>
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

    <!-- Change-email modal (two steps: new address → OTP sent to it) -->
    <sd-dialog
      #emailDialog
      [open]="emailModalOpen()"
      title="Change email address"
      size="md"
      [busy]="emailBusy()"
      (closed)="closeEmailChange()"
    >
      <div class="flex flex-col gap-6">

          @if (emailStep() === 'email') {
            <form class="flex flex-col gap-6" [formGroup]="emailForm" (ngSubmit)="sendEmailOtp()">
              <p class="font-sans text-body-sm text-slate">
                Enter your new email address. We'll send a 6-digit code to it to
                confirm it's yours. Your current email is
                <span class="font-semibold text-ink">{{ email() }}</span>.
              </p>
              <sd-input
                label="New email"
                type="email"
                placeholder="you@example.com"
                autocomplete="email"
                formControlName="email"
                [error]="emailFieldError()"
              />
              @if (emailError()) {
                <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert">
                  {{ emailError() }}
                </p>
              }
              <sd-button type="submit" [full]="true" [disabled]="emailBusy()">
                {{ emailBusy() ? 'Sending…' : 'Send code' }}
              </sd-button>
            </form>
          } @else {
            <form class="flex flex-col gap-6" [formGroup]="emailForm" (ngSubmit)="confirmEmailChange()">
              <p class="font-sans text-body-sm text-slate">
                Enter the 6-digit code we sent to
                <span class="font-semibold text-ink">{{ emailForm.controls.email.value }}</span>.
              </p>
              <sd-otp formControlName="otp" />
              @if (emailDevCode()) {
                <p class="font-sans text-caption text-slate">
                  Dev code: <span class="font-semibold text-ink">{{ emailDevCode() }}</span>
                </p>
              }
              @if (emailError()) {
                <p class="rounded-field bg-alert/10 px-4 py-3 font-label text-caption text-alert">
                  {{ emailError() }}
                </p>
              }
              <sd-button type="submit" [full]="true" [disabled]="emailBusy()">
                {{ emailBusy() ? 'Updating…' : 'Confirm & change email' }}
              </sd-button>
              <div class="flex items-center justify-between font-sans text-caption">
                <button
                  type="button"
                  class="font-semibold text-slate transition-colors hover:text-ink"
                  (click)="emailStep.set('email'); emailDialog.refocus()"
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  class="font-semibold text-cerulean transition-colors hover:text-ocean disabled:opacity-60"
                  [disabled]="emailBusy()"
                  (click)="resendEmailOtp()"
                >
                  Resend code
                </button>
              </div>
            </form>
          }
        </div>
    </sd-dialog>
  `,
})
export class MyProfile implements HasUnsavedChanges {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly patient = inject(PatientApi);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly dialogs = inject(DialogService);
  private readonly emailDialog = viewChild<DialogComponent>('emailDialog');
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  // Phone verification (inline in Personal Information).
  protected readonly phoneVerified = signal(false);
  protected readonly phoneVerifyState = signal<'idle' | 'sent'>('idle');
  protected readonly phoneBusy = signal(false);
  protected readonly phoneVerifyError = signal('');
  protected readonly otpCode = signal('');
  private pinId = '';

  // Email change (modal: enter new email → confirm code sent to it).
  protected readonly emailModalOpen = signal(false);
  protected readonly emailStep = signal<'email' | 'otp'>('email');
  protected readonly emailBusy = signal(false);
  protected readonly emailError = signal('');
  protected readonly emailDevCode = signal('');
  protected readonly emailForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    otp: ['', [Validators.required, Validators.minLength(6)]],
  });
  /** Inline field error under the email input (invalid/touched only). */
  protected emailFieldError(): string {
    const c = this.emailForm.controls.email;
    if (!c.touched || c.valid) return '';
    return c.errors?.['required'] ? 'This field is required' : 'Enter a valid email address';
  }

  protected readonly view = signal<View>('home');
  protected readonly toast = signal('');
  /** Why the profile failed to load ('' when it didn't). */
  protected readonly loadError = signal('');

  // Profile display — filled from GET /api/portal/me (blank until it resolves).
  protected readonly fullName = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly dobLong = signal('—');
  protected readonly dobDisplay = signal('—');
  protected readonly genderText = signal('—');
  protected readonly addressText = signal('—');
  protected readonly avatarPath = signal<string | null>(null);
  protected readonly avatarSrc = computed(() =>
    this.patient.assetUrl(this.avatarPath()),
  );
  protected readonly uploadingAvatar = signal(false);
  protected readonly avatarModalOpen = signal(false);
  protected readonly avatarDragging = signal(false);

  protected readonly initials = computed(() =>
    this.fullName()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  /** Rough completeness across the core profile fields (name/phone/dob/gender/address). */
  protected readonly profileComplete = computed(() => {
    const filled = [
      this.fullName() !== '',
      this.phone() !== '',
      this.dobDisplay() !== '—',
      this.genderText() !== '—',
      this.addressText() !== '—',
    ].filter(Boolean).length;
    return Math.round((filled / 5) * 100);
  });

  protected readonly sections: SectionCard[] = [
    {
      key: 'personal',
      icon: 'user',
      tint: 'bg-cerulean/10 text-cerulean-dark',
      title: 'Personal Information',
      subtitle: 'Your name, contact details and address',
    },
    {
      key: 'medical',
      icon: 'heart-pulse',
      tint: 'bg-teal/10 text-teal-ink',
      title: 'Medical Information',
      subtitle: 'Vitals, history, allergies, medications and conditions',
    },
    {
      key: 'insurance',
      icon: 'shield-check',
      tint: 'bg-sage/15 text-sage-ink',
      title: 'Insurance Information',
      subtitle: 'Provider, plan and coverage details',
    },
    {
      key: 'emergency',
      icon: 'id-card',
      tint: 'bg-sky/10 text-cerulean-dark',
      title: 'Emergency Contact',
      subtitle: 'Who we should contact in an emergency',
    },
  ];

  protected readonly form = this.fb.nonNullable.group({
    fullName: ['', [Validators.required]],
    phone: ['', [Validators.required]],
    dob: ['', [adultDobValidator]],
    gender: [''],
    address: [''],
  });

  /** Latest date of birth that still makes the patient 18+ (YYYY-MM-DD). */
  protected readonly maxDob = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 18);
    return d.toISOString().slice(0, 10);
  })();

  protected dobError(): string {
    const c = this.form.controls.dob;
    if (!c.errors || (!c.touched && !c.dirty)) return '';
    if (c.errors['future']) return 'Date of birth cannot be in the future.';
    if (c.errors['underage']) return 'You must be at least 18 years old to use VideoMed.';
    return '';
  }

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

  /**
   * Whether the stored health profile has loaded. A save replaces a whole
   * section (all allergies, medicines, history and conditions; the whole
   * contact; the whole policy), so editing is only offered once the stored
   * values are in the forms — never on top of an empty editor after a failed
   * or pending load.
   */
  protected readonly healthState = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly healthLoaded = computed(() => this.healthState() === 'ready');
  /** Why the health profile failed to load ('' when it didn't). */
  protected readonly healthError = signal('');
  private healthSub?: Subscription;

  // ----- Vitals (GET/POST /api/portal/me/vitals) -----
  protected readonly vitalsState = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly vitalsError = signal('');
  private readonly vitalsData = signal<MyVitalsDto | null>(null);
  private vitalsSub?: Subscription;
  protected readonly latestVitals = computed<VitalReadingDto[]>(() => this.vitalsData()?.latest ?? []);
  protected readonly vitalsReminder = computed(() => this.vitalsData()?.reminder ?? null);
  /** The form's boxes, in the API's catalogue order (only the ones this form knows how to show). */
  protected readonly vitalFields = computed<VitalFieldDto[]>(() =>
    (this.vitalsData()?.fields ?? []).filter(
      (f) => f.key === 'blood_pressure' || !!f.derived || isVitalNumberKey(f.key),
    ),
  );
  /** The same boxes in the edit form's order (the design's five first). */
  protected readonly editFields = computed<VitalFieldDto[]>(() => {
    const byKey = new Map(this.vitalFields().map((f) => [f.key, f]));
    return VITAL_EDIT_ORDER.flatMap((k) => byKey.get(k) ?? []);
  });

  /** Medical Information's cards: the five always (recorded or not), then any other recorded reading. */
  protected readonly vitalCards = computed<VitalCardVm[]>(() => {
    const byKey = new Map(this.latestVitals().map((v) => [v.key, v]));
    const extra = VITAL_EXTRA.filter((k) => byKey.has(k));
    return [...VITAL_PRIMARY, ...extra].map((k) => this.vitalCard(k, byKey.get(k)));
  });

  /**
   * Every high or critical reading, the urgent ones first. The advice is the
   * API's (none for weight, BMI or pain). An out-of-date reading is told in the
   * past tense with its date — never a present-tense "seek urgent attention"
   * about a fever from months ago.
   */
  protected readonly vitalAlerts = computed<VitalAlertVm[]>(() =>
    this.latestVitals()
      .flatMap((v): VitalAlertVm[] => {
        const f = v.flag;
        if (!f || (f.level !== 'high' && f.level !== 'critical')) return [];
        const name = VITAL_META[v.key]?.label ?? v.label;
        if (v.stale) {
          const on = shortDate(v.taken_at);
          return [
            {
              key: v.key,
              text: `${name} was ${f.label}${on ? ` on ${on}` : ''}`,
              advice: 'update your readings',
              critical: false,
            },
          ];
        }
        return [{ key: v.key, text: `${name} is ${f.label}`, advice: f.advice, critical: f.level === 'critical' }];
      })
      .sort((a, b) => Number(b.critical) - Number(a.critical)),
  );

  /** When the newest reading of any type was taken, as the design writes it (or null: none yet). */
  protected readonly lastUpdated = computed<string | null>(() => {
    let newest: number | null = null;
    for (const v of this.latestVitals()) {
      const at = v.taken_at ? Date.parse(v.taken_at) : NaN;
      if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
    }
    return newest === null ? null : lastUpdatedText(new Date(newest));
  });

  /** A nudge beside "Last updated" when the reminder is due ('' when it isn't). */
  protected readonly vitalsCue = computed<string>(() => {
    const r = this.vitalsReminder();
    if (!r?.due) return '';
    if (r.reason === 'upcoming') {
      const at = r.appointment ? new Date(r.appointment.scheduled_at) : null;
      return at && !Number.isNaN(at.getTime())
        ? `Update before your consultation on ${new Intl.DateTimeFormat('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }).format(at)}`
        : 'Update before your consultation';
    }
    return r.reason === 'never' ? 'Add them before your next consultation' : 'Update before your next consultation';
  });

  /** Set on the first save attempt, so empty boxes aren't flagged before then. */
  private readonly vitalsSubmitted = signal(false);
  /** Field errors from the API (`readings.<key>`, `taken_at`, `readings`). */
  private readonly vitalsFieldErrors = signal<Record<string, string>>({});
  /** Boxes whose text the browser can't read as a number ("37,5", "1e") — they reach the form as null. */
  private readonly vitalsBadInput = signal<Record<string, boolean>>({});
  protected readonly vitalsFormError = signal('');
  protected readonly takenAtMax = signal('');
  protected readonly takenAtMin = signal('');

  // ----- The one Medical Information editor (vitals + the medical record) -----
  /** What a save could not do, said plainly (e.g. "vitals saved, medical details weren't"). */
  protected readonly editError = signal('');
  /** The medical rows as the editor opened them — only a changed record is saved. */
  private medicalSnapshot = '';

  protected readonly vitalsForm = this.fb.group({
    temperature: this.fb.control<number | null>(null),
    heart_rate: this.fb.control<number | null>(null),
    systolic: this.fb.control<number | null>(null),
    diastolic: this.fb.control<number | null>(null),
    respiratory_rate: this.fb.control<number | null>(null),
    oxygen_saturation: this.fb.control<number | null>(null),
    blood_sugar: this.fb.control<number | null>(null),
    weight: this.fb.control<number | null>(null),
    height: this.fb.control<number | null>(null),
    pain_score: this.fb.control<number | null>(null),
    takenAt: this.fb.nonNullable.control(''),
    device: this.fb.nonNullable.control(false),
  });

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.toastTimer));
    // Closing or reloading the tab mid-edit loses the medical editor's changes.
    warnBeforeUnload(() => this.hasUnsavedChanges());

    this.patient
      .me()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.applyProfile(res.data),
        error: (err: unknown) =>
          this.loadError.set(apiErrorMessage(err, 'Could not load your profile.')),
      });

    this.loadHealthProfile();
    this.loadVitals();
    // An API error describes what was sent — drop it once the patient edits.
    this.vitalsForm.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (Object.keys(this.vitalsFieldErrors()).length) this.vitalsFieldErrors.set({});
        this.vitalsFormError.set('');
      });

    // Deep links from the dashboard: ?section=medical (Medical Information) or
    // ?section=vitals (the editor, scrolled to and focused on its vitals).
    // Consumed once, then dropped from the URL so Back / a refresh doesn't keep
    // reopening it.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const section = params.get('section');
        if (section !== 'medical' && section !== 'vitals') return;
        if (section === 'vitals') this.openEdit('vitals');
        else this.view.set('medical');
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { section: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      });
  }

  /** GET the patient's vitals (latest readings + the form's catalogue). */
  protected loadVitals(): void {
    this.vitalsSub?.unsubscribe();
    this.vitalsState.set('loading');
    this.vitalsError.set('');
    this.vitalsSub = this.patient
      .vitals()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.vitalsData.set(res.data);
          this.vitalsState.set('ready');
        },
        error: (err: unknown) => {
          this.vitalsError.set(apiErrorMessage(err, "We couldn't load your vitals."));
          this.vitalsState.set('error');
        },
      });
  }

  /** GET the health profile; until it arrives those sections stay read-only. */
  protected loadHealthProfile(): void {
    this.healthSub?.unsubscribe();
    this.healthState.set('loading');
    this.healthError.set('');
    this.healthSub = this.patient
      .healthProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.applyHealthProfile(res.data),
        error: (err: unknown) => {
          this.healthError.set(
            apiErrorMessage(err, "We couldn't load your health information."),
          );
          this.healthState.set('error');
        },
      });
  }

  private applyHealthProfile(h: HealthProfileDto): void {
    this.emergencyForm.patchValue(h.emergency_contact);
    this.insuranceForm.patchValue(h.insurance);
    this.medical.set(h.medical);
    this.loadMedicalForm(h.medical);
    this.healthState.set('ready');
    // The editor is open (a deep link that beat the load, or a save that kept
    // it open): give it its blank rows and a fresh "unchanged" baseline.
    if (this.view() === 'medical-add') this.prepareMedicalRows();
  }

  private applyProfile(p: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string | null;
    phone_verified?: boolean;
    date_of_birth: string | null;
    gender?: string | null;
    address?: string | null;
    avatar_url?: string | null;
  }): void {
    const full = `${p.first_name} ${p.last_name}`.trim();
    if (full) this.fullName.set(full);
    if (p.email) this.email.set(p.email);
    if (p.phone) this.phone.set(p.phone);
    this.phoneVerified.set(!!p.phone_verified);
    this.genderText.set(p.gender || '—');
    this.addressText.set(p.address || '—');
    this.avatarPath.set(p.avatar_url ?? null);

    const patch: Record<string, string> = {
      gender: p.gender ?? '',
      address: p.address ?? '',
    };
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
      // Ink shades: 20px / 500 titles need 4.5 (sage was 3.22, sky 3.15).
      insurance: 'text-sage-ink',
      emergency: 'text-cerulean-dark',
    };
    return map[c.key] ?? 'text-ink';
  }

  // Field styling shared by the Insurance / Emergency forms.
  protected readonly fieldWrap =
    'flex items-center gap-2 rounded-field border border-[#d7e0e8] bg-white px-4 transition-colors focus-within:border-cerulean focus-within:ring-2 focus-within:ring-cerulean/20';
  protected readonly fieldControl =
    'w-full bg-transparent py-3.5 font-sans text-body text-ink placeholder:text-slate/60 focus:outline-none';
  // Standalone input styling for the medical FormArray rows.
  protected readonly rowInput =
    'rounded-field border border-[#d7e0e8] bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';
  protected readonly removeButton =
    'min-h-11 self-end px-2 font-sans text-caption font-semibold text-alert hover:underline';

  // Medical Information (Figma 782:15059 / 763:12524): 24px cards on a hairline slate border.
  // A size container: the field boxes inside go 2- or 3-across by the card's
  // own width (the cards sit two-across from lg, so the viewport says little).
  protected readonly viewCard =
    '@container flex flex-col gap-6 rounded-[24px] border-[0.5px] border-slate bg-white p-4 sm:p-6';
  protected readonly editCard =
    'flex flex-col gap-4 rounded-[24px] border-[0.5px] border-slate bg-white p-4 sm:p-6';
  protected readonly cardTitle = 'flex items-center gap-2 font-sans text-body-lg text-ink';
  /** One history / allergy / medicine / condition on the read view; a hairline between entries. */
  protected readonly entryClass =
    'mt-4 border-t border-cloud pt-4 first:mt-0 first:border-t-0 first:pt-0';
  /** The boxed value of a read-only field. */
  protected readonly readBoxClass =
    'min-h-[50px] break-words rounded-field border border-ash px-4 py-[13px] font-sans text-body';
  // The vitals boxes (label with icon, 50px box, light hint underneath).
  protected readonly vitalLabel = 'flex items-center gap-1 font-sans text-body-sm text-slate';
  protected readonly vitalInput =
    'w-full min-w-0 rounded-field border border-ash bg-white px-4 py-[13px] font-sans text-body text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';
  protected readonly vitalInputInvalid =
    'w-full min-w-0 rounded-field border border-alert bg-white px-4 py-[13px] font-sans text-body text-ink placeholder:text-slate/60 focus:border-alert focus:outline-none focus:ring-2 focus:ring-alert/20';
  /** The two numbers inside the one blood-pressure box. */
  protected readonly bpInput =
    'w-full min-w-0 bg-transparent py-[13px] font-sans text-body text-ink placeholder:text-slate/60 [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';
  protected readonly vitalHintClass = 'font-sans text-caption font-light text-slate';

  // Options for the searchable dropdowns (sd-search-select).
  protected readonly genderSelectOptions = ['Female', 'Male', 'Other'];
  protected readonly relationshipOptions = [
    'Spouse',
    'Parent',
    'Sibling',
    'Child',
    'Friend',
  ];
  protected readonly coverageOptions = ['Active', 'Inactive', 'Expired'];
  /** Allergy severities, stored lower-case (the doctor's panel sorts by these). */
  protected readonly severityOptions = SEVERITY_OPTIONS;
  protected readonly statusOptions = ['Active', 'Managed', 'Resolved'];

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
    // Leaving the editor mid-save would hide a failure and drop what was typed.
    if (this.savingSection() === 'medical') return;
    if (this.view() === 'personal-edit') this.view.set('personal');
    else if (this.view() === 'medical-add') void this.cancelEdit(); // asks about unsaved edits
    else this.view.set('home');
  }

  protected onAvatarSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the user re-pick the same file later
    if (file) void this.processAvatar(file);
  }

  protected onAvatarDrop(event: DragEvent): void {
    event.preventDefault();
    this.avatarDragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.processAvatar(file);
  }

  private async processAvatar(file: File): Promise<void> {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      this.showToast('Use a PNG, JPG, WEBP or GIF image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.showToast('Image must be 2MB or smaller.');
      return;
    }
    this.uploadingAvatar.set(true);
    try {
      const res = await firstValueFrom(this.patient.uploadAvatar(file));
      this.applyProfile(res.data);
      this.avatarModalOpen.set(false);
      this.showToast('Profile photo updated successfully');
    } catch (err) {
      this.showToast(
        apiErrorMessage(err, 'Could not upload your photo.'),
      );
    } finally {
      this.uploadingAvatar.set(false);
    }
  }

  /**
   * Asked first; the dialog shows the request's progress and any failure. Once
   * removed, the "Remove photo" button is gone: focus lands on the photo's
   * Change button (`focusAfter`) instead of `<body>`.
   */
  protected async removeAvatar(focusAfter?: HTMLElement): Promise<void> {
    if (this.uploadingAvatar()) return;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'image-off',
      title: 'Remove your profile photo?',
      message: 'Your doctors will see your initials instead.',
      confirmLabel: 'Remove photo',
      cancelLabel: 'Keep it',
      busyLabel: 'Removing…',
      action: async () => {
        this.uploadingAvatar.set(true);
        try {
          const res = await firstValueFrom(this.patient.removeAvatar());
          this.applyProfile(res.data);
        } finally {
          this.uploadingAvatar.set(false);
        }
      },
      errorMessage: (err) => apiErrorMessage(err, 'Could not remove your photo.'),
    });
    if (!confirmed) return;
    this.showToast('Profile photo removed');
    if (focusAfter) afterDialogsClose(this.dialogs, this.injector, () => focusAfter.focus());
  }

  protected async saveProfile(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { fullName, phone, dob, gender, address } = this.form.getRawValue();
    const [firstName, ...rest] = fullName.trim().split(/\s+/);
    try {
      const res = await firstValueFrom(
        this.patient.updateProfile({
          first_name: firstName,
          last_name: rest.join(' '),
          phone: phone || null,
          date_of_birth: dob || null,
          gender,
          address,
        }),
      );
      this.applyProfile(res.data);
      this.view.set('personal');
      this.showToast('Profile information updated successfully');
    } catch (err) {
      this.showToast(apiErrorMessage(err, 'Could not update your profile.'));
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

  /** An allergy row; free-text severities from older saves map onto the fixed list. */
  private allergyGroup(v: Partial<AllergyRow> = {}): FormGroup {
    return this.fb.nonNullable.group({
      allergen: [v.allergen ?? ''],
      severity: [normalizeSeverity(v.severity ?? '')],
      reaction: [v.reaction ?? ''],
    });
  }

  /** A medication row; `herbal` is a checkbox here and a '1'/'' string in the API. */
  private medicationGroup(v: Partial<MedicationRow> = {}): FormGroup {
    return this.fb.nonNullable.group({
      name: [v.name ?? ''],
      dosage: [v.dosage ?? ''],
      frequency: [v.frequency ?? ''],
      reason: [v.reason ?? ''],
      herbal: [isHerbalFlag(v.herbal)],
    });
  }

  private loadMedicalForm(m: MedicalDto): void {
    this.setRows(this.historyRows, ['condition', 'year', 'note'], m.history);
    this.allergyRows.clear();
    for (const a of m.allergies) this.allergyRows.push(this.allergyGroup(a));
    this.medicationRows.clear();
    for (const r of m.medications) this.medicationRows.push(this.medicationGroup(r));
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
    this.allergyRows.push(this.allergyGroup());
  }
  protected addMedication(): void {
    this.medicationRows.push(this.medicationGroup());
  }
  protected addCondition(): void {
    this.conditionRows.push(this.rowGroup(['condition', 'status', 'since']));
  }
  protected removeRow(arr: FormArray<FormGroup>, i: number): void {
    arr.removeAt(i);
  }

  // ----- Medical display helpers -----
  protected isHerbal(flag: string | undefined): boolean {
    return isHerbalFlag(flag);
  }

  /** A saved value outside the fixed list (kept selectable so it isn't lost). */
  protected isLegacySeverity(value: unknown): boolean {
    return typeof value === 'string' && value !== '' && !isCanonicalSeverity(value);
  }

  protected severityLabel(value: string): string {
    const key = normalizeSeverity(value);
    return isCanonicalSeverity(key) ? SEVERITY_LABEL[key] : value;
  }

  /** Severity reads as text first; the tone and icon only supplement it. */
  protected severityTone(value: string): { cls: string; icon: string } {
    const key = normalizeSeverity(value);
    return isCanonicalSeverity(key) ? SEVERITY_TONE[key] : SEVERITY_TONE.unknown;
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

  /**
   * Open the one Medical Information editor: the vitals boxes blank (taken
   * "now") above the saved medical record. Each half shows its own loading /
   * error state, so a deep link can open it before either has loaded.
   * `vitals` (the ?section=vitals deep link) scrolls to and focuses the vitals.
   */
  protected openEdit(focus: 'vitals' | 'medical' | null = null): void {
    this.resetVitalsForm();
    this.editError.set('');
    if (this.healthLoaded()) {
      this.loadMedicalForm(this.medical()); // drop edits from a cancelled visit
      this.prepareMedicalRows();
    }
    this.view.set('medical-add');
    afterNextRender(
      () => {
        const id = focus === 'medical' ? 'medical-edit-start' : 'vitals-edit-heading';
        const target = this.document.getElementById(id) ?? this.document.getElementById('vitals-edit-heading');
        if (focus) {
          target?.scrollIntoView({ block: 'start' });
          target?.focus({ preventScroll: true });
        } else {
          // From the Edit button: back to the top, with focus at the editor's start.
          this.document.getElementById('profile-view-title')?.scrollIntoView({ block: 'start' });
          target?.focus({ preventScroll: true });
        }
      },
      { injector: this.injector },
    );
  }

  /**
   * Discard the editor's changes and go back to the read view (never mid-save
   * — see back()). Unsaved edits are asked about first.
   */
  protected async cancelEdit(): Promise<void> {
    if (this.savingSection() === 'medical') return;
    if (this.hasUnsavedChanges()) {
      const { confirmed } = await this.dialogs.confirm({ ...this.leaveCopy, tone: 'warning', icon: 'undo-2' });
      if (!confirmed || this.view() !== 'medical-add') return;
    }
    this.discardEdit();
  }

  /** Back to the read view, dropping what was typed. */
  private discardEdit(): void {
    if (this.healthLoaded()) this.loadMedicalForm(this.medical());
    this.resetVitalsForm();
    this.editError.set('');
    this.view.set('medical');
  }

  /**
   * The medical editor holds edits not saved yet: the medical record changed,
   * or a reading was typed in. `unsavedChangesGuard` asks before the page is
   * left (and the tab-close prompt before it is closed).
   */
  hasUnsavedChanges(): boolean {
    if (this.view() !== 'medical-add') return false;
    const medical = this.healthLoaded() && this.medicalChanged();
    const vitals = Object.keys(this.vitalsPayload().readings).length > 0;
    return medical || vitals;
  }

  /** The guard's (and Cancel's) question. */
  readonly leaveCopy = {
    title: 'Discard your changes?',
    message: "Edits to your vitals, medical history, allergies or medications won't be saved.",
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
  };

  /** A blank row for any empty medical section, and the "unchanged" baseline. */
  private prepareMedicalRows(): void {
    if (this.historyRows.length === 0) this.addHistory();
    if (this.allergyRows.length === 0) this.addAllergy();
    if (this.medicationRows.length === 0) this.addMedication();
    if (this.conditionRows.length === 0) this.addCondition();
    this.medicalSnapshot = JSON.stringify(this.medicalPayload());
  }

  private medicalChanged(): boolean {
    return JSON.stringify(this.medicalPayload()) !== this.medicalSnapshot;
  }

  /** The form's rows as the API stores them (herbal checkbox → '1' / ''). */
  private medicalPayload(): MedicalDto {
    const raw = this.medicalForm.getRawValue() as {
      history: MedicalDto['history'];
      allergies: AllergyRow[];
      medications: (Omit<MedicationRow, 'herbal'> & { herbal: boolean })[];
      conditions: MedicalDto['conditions'];
    };
    return {
      history: raw.history,
      allergies: raw.allergies.map((a) => ({
        allergen: a.allergen,
        // Canonical lower-case ('mild' … 'life-threatening', 'unknown').
        severity: normalizeSeverity(a.severity),
        reaction: a.reaction,
      })),
      medications: raw.medications.map((m) => ({
        name: m.name,
        dosage: m.dosage,
        frequency: m.frequency,
        reason: m.reason ?? '',
        herbal: m.herbal ? '1' : '',
      })),
      conditions: raw.conditions,
    };
  }

  /**
   * Save the editor. Vitals are recorded only when at least one box was filled
   * (POST /me/vitals); the medical record only when it changed (it replaces
   * the whole section, so never over records we never loaded). The two go in
   * parallel; if one fails, say exactly which, keep what the patient typed for
   * it, and stay here — the half that was saved is not sent again.
   */
  protected async saveEdit(): Promise<void> {
    if (this.savingSection()) return;
    this.editError.set('');
    const vitalsReady = this.vitalsState() === 'ready';
    const readings = vitalsReady ? this.vitalsPayload() : null;
    const withVitals = !!readings && Object.keys(readings.readings).length > 0;
    if (vitalsReady && this.vitalsInvalid(withVitals)) {
      this.vitalsFormError.set('Check the readings marked in red.');
      this.focusById('vitals-edit-heading');
      return;
    }
    const withMedical = this.healthLoaded() && this.medicalChanged();
    if (!withVitals && !withMedical) {
      this.discardEdit();
      this.showToast('No changes to save');
      return;
    }

    this.savingSection.set('medical');
    const [vitals, medical] = await Promise.allSettled([
      withVitals && readings ? firstValueFrom(this.patient.recordVitals(readings)) : Promise.resolve(null),
      withMedical
        ? firstValueFrom(this.patient.updateHealthProfile({ medical: this.medicalPayload() }))
        : Promise.resolve(null),
    ]);
    this.savingSection.set('');

    if (vitals.status === 'fulfilled' && vitals.value) {
      this.vitalsData.set(vitals.value.data);
      this.vitalsState.set('ready');
      this.resetVitalsForm(); // recorded — a retry must not record them twice
    }
    if (medical.status === 'fulfilled' && medical.value) this.applyHealthProfile(medical.value.data);

    const vitalsFailed = vitals.status === 'rejected';
    const medicalFailed = medical.status === 'rejected';
    if (!vitalsFailed && !medicalFailed) {
      this.view.set('medical');
      this.showToast(
        withVitals && withMedical
          ? 'Vitals and medical information saved'
          : withVitals
            ? 'Vitals saved successfully'
            : 'Medical information saved successfully',
      );
      return;
    }

    const vitalsWhy = vitals.status === 'rejected' ? apiErrorMessage(vitals.reason, 'Could not save your readings.') : '';
    const medicalWhy =
      medical.status === 'rejected' ? apiErrorMessage(medical.reason, 'Could not save your medical information.') : '';
    if (vitals.status === 'rejected') {
      this.vitalsFieldErrors.set(apiErrorFields(vitals.reason));
      this.vitalsFormError.set(vitalsWhy);
    }
    this.editError.set(
      vitalsFailed && medicalFailed
        ? `Nothing was saved. Vitals: ${vitalsWhy} Medical details: ${medicalWhy}`
        : vitalsFailed
          ? withMedical
            ? `Your medical details were saved, but your vitals weren't: ${vitalsWhy}`
            : `Your vitals weren't saved: ${vitalsWhy}`
          : withVitals
            ? `Your vitals were saved, but your medical details weren't: ${medicalWhy}`
            : `Your medical details weren't saved: ${medicalWhy}`,
    );
    this.focusById(vitalsFailed ? 'vitals-edit-heading' : 'medical-edit-error');
  }

  /** After the next render, move focus to (and show) an element of the editor. */
  private focusById(id: string): void {
    afterNextRender(
      () => {
        const el = this.document.getElementById(id);
        el?.scrollIntoView({ block: 'center' });
        el?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  // ----- Vitals -----

  protected meta(key: ReadingKey): VitalMeta {
    return VITAL_META[key];
  }

  /** "Heart Rate (Bpm)", as the edit design labels its boxes. */
  protected formLabel(key: ReadingKey): string {
    const m = VITAL_META[key];
    return `${m.formLabel ?? m.label} (${m.formUnit})`;
  }

  /** The light line under a box: the API's normal range, or what the box is for. */
  protected vitalHint(f: VitalFieldDto): string {
    if (f.key === 'weight') return 'Used with your height to work out your BMI';
    if (f.key === 'height') return 'Used to work out your BMI';
    if (f.key === 'pain_score') return '0 = no pain, 10 = the worst pain';
    if (!f.normal_range) return '';
    const m = VITAL_META[f.key];
    return `Normal range: ${f.normal_range}${m.joined || m.unit === '%' ? '' : ' '}${m.unit}`;
  }

  /** One card: the value and the API's flag, or "Not recorded". */
  private vitalCard(key: ReadingKey, v: VitalReadingDto | undefined): VitalCardVm {
    const m = VITAL_META[key];
    const base = { key, label: m.label, icon: m.icon, tint: m.tint, joined: !!m.joined, inkUnit: !!m.inkUnit };
    if (!v) {
      return {
        ...base,
        recorded: false,
        value: '—',
        unit: '',
        status: 'Not recorded',
        statusIsWhen: false,
        statusTone: 'text-slate',
        staleNote: '',
        detail: '',
      };
    }
    const on = v.flag && v.stale ? shortDate(v.taken_at) : '';
    return {
      ...base,
      recorded: true,
      value: v.value,
      unit: m.unit,
      // No flag (height, or a weight / BMI with no height on file): say when it was taken instead.
      status: v.flag ? v.flag.label : this.takenAgo(v.taken_at),
      statusIsWhen: !v.flag,
      statusTone: v.flag ? FLAG_TONE[v.flag.level] : 'text-slate',
      staleNote: on ? `from ${on}` : '',
      detail: `${this.takenAgo(v.taken_at)} · ${v.recorded_by === 'patient' ? 'Self-reported' : 'From your doctor'}${
        v.stale ? ' · may be out of date' : ''
      }`,
    };
  }

  protected placeholder(key: ReadingKey): string {
    return VITAL_PLACEHOLDER[key] ?? '';
  }

  protected isNumberKey(key: string): key is VitalNumberKey {
    return isVitalNumberKey(key);
  }

  /** "Taken 3 days ago" / "Taken on 2 Sep 2026" (older than a month). */
  protected takenAgo(iso: string | null): string {
    if (!iso) return 'When it was taken is not recorded';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const min = Math.max(0, Math.round((Date.now() - at.getTime()) / 60000));
    if (min < 1) return 'Taken just now';
    if (min < 60) return `Taken ${min} minute${min === 1 ? '' : 's'} ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `Taken ${hr} hour${hr === 1 ? '' : 's'} ago`;
    const days = Math.round(hr / 24);
    if (days === 1) return 'Taken yesterday';
    if (days < 31) return `Taken ${days} days ago`;
    return `Taken on ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(at)}`;
  }

  /** The vitals boxes back to blank, taken "now". */
  private resetVitalsForm(): void {
    const now = new Date();
    const yearAgo = new Date(now);
    yearAgo.setFullYear(now.getFullYear() - 1);
    this.takenAtMax.set(localDateTimeValue(now));
    this.takenAtMin.set(localDateTimeValue(yearAgo));
    this.vitalsForm.reset({ takenAt: localDateTimeValue(now), device: false });
    this.vitalsSubmitted.set(false);
    this.vitalsFieldErrors.set({});
    this.vitalsBadInput.set({});
    this.vitalsFormError.set('');
  }

  /** Track a number box the browser couldn't read, so it is flagged instead of silently left out. */
  protected noteBadInput(key: string, event: Event): void {
    const bad = (event.target as HTMLInputElement | null)?.validity?.badInput === true;
    if ((this.vitalsBadInput()[key] ?? false) !== bad) {
      this.vitalsBadInput.update((m) => ({ ...m, [key]: bad }));
    }
  }

  /** An API error for this box first, else the box's own range check (after a save attempt or edit). */
  protected vitalFieldError(f: VitalFieldDto): string {
    const server = this.vitalsFieldErrors()[`readings.${f.key}`];
    if (server) return server;
    if (!isVitalNumberKey(f.key)) return '';
    if (this.vitalsBadInput()[f.key]) return `Enter a number for ${f.label.toLowerCase()}`;
    const c = this.vitalsForm.controls[f.key];
    if (!c.errors || (!c.dirty && !this.vitalsSubmitted())) return '';
    if (c.errors['min'] || c.errors['max']) {
      return `${f.label} must be between ${f.min} and ${f.max} ${f.unit}`;
    }
    return `Enter a number for ${f.label.toLowerCase()}`;
  }

  /** Blood pressure needs both numbers, each in range, the bottom one lower. */
  protected bpError(f: VitalFieldDto): string {
    const server = this.vitalsFieldErrors()['readings.blood_pressure'];
    if (server) return server;
    const bad = this.vitalsBadInput();
    if (bad['systolic'] || bad['diastolic']) return 'Enter blood pressure as two numbers, e.g. 120 / 80';
    const { systolic: sc, diastolic: dc } = this.vitalsForm.controls;
    if (!this.vitalsSubmitted() && !(sc.dirty && dc.dirty)) return '';
    const sys = sc.value;
    const dia = dc.value;
    if (sys === null && dia === null) return sc.errors || dc.errors ? 'Enter blood pressure as two numbers, e.g. 120 / 80' : '';
    if (sys === null || dia === null) return 'Enter both numbers, e.g. 120 / 80';
    const s = f.systolic;
    const d = f.diastolic;
    if (sc.errors || (s && (sys < s.min || sys > s.max))) {
      return `The top number must be between ${s?.min ?? 50} and ${s?.max ?? 260}`;
    }
    if (dc.errors || (d && (dia < d.min || dia > d.max))) {
      return `The bottom number must be between ${d?.min ?? 30} and ${d?.max ?? 160}`;
    }
    if (dia >= sys) return 'The bottom number must be lower than the top number';
    return '';
  }

  /** BMI from the weight typed here and the height typed here — or the height already on file. */
  protected bmiPreview(): string | null {
    const { weight, height } = this.vitalsForm.controls;
    if (weight.invalid || height.invalid) return null;
    const bmi = bmiOf(weight.value, height.value ?? this.heightOnFile());
    const range = this.vitalFields().find((f) => f.key === 'bmi');
    if (bmi === null || (range?.min != null && bmi < range.min) || (range?.max != null && bmi > range.max)) {
      return null;
    }
    return bmi.toFixed(1);
  }

  protected bmiHint(): string {
    if (this.bmiPreview() === null) return 'Add your weight and height to see it.';
    return this.vitalsForm.controls.height.value === null
      ? `Worked out from your weight and your height on file (${this.heightOnFile()} cm).`
      : 'Worked out from your weight and height.';
  }

  private heightOnFile(): number | null {
    const h = this.latestVitals().find((v) => v.key === 'height');
    const n = h ? Number(h.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  protected takenAtError(): string {
    const server = this.vitalsFieldErrors()['taken_at'];
    if (server) return server;
    const raw = this.vitalsForm.controls.takenAt.value;
    // Only needed when there is something to record.
    if (!raw) {
      return this.vitalsSubmitted() && Object.keys(this.vitalsPayload().readings).length
        ? 'Enter when the readings were taken'
        : '';
    }
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return 'Enter a valid date and time';
    if (at.getTime() > Date.now() + 60_000) return 'This can’t be in the future';
    const min = this.takenAtMin() ? new Date(this.takenAtMin()) : null;
    if (min && at.getTime() < min.getTime()) return 'Enter a time within the last year';
    return '';
  }

  /** The form as the API expects it: only the boxes that were filled in. */
  private vitalsPayload(): RecordVitalsInput {
    const v = this.vitalsForm.getRawValue();
    const readings: Partial<Record<ReadingKey, string>> = {};
    for (const key of VITAL_NUMBER_KEYS) {
      const n = v[key];
      if (n !== null && Number.isFinite(n)) readings[key] = String(n);
    }
    if (v.systolic !== null && v.diastolic !== null) {
      readings.blood_pressure = `${v.systolic}/${v.diastolic}`;
    }
    const at = v.takenAt ? new Date(v.takenAt) : null;
    return {
      readings,
      taken_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined,
      source: v.device ? 'patient_device' : 'self_reported',
    };
  }

  /**
   * Run the boxes' own checks on a save attempt (flagging them from now on).
   * Blank boxes are fine — the vitals are optional in this editor — but a box
   * the browser couldn't read, an out-of-range number or half a blood pressure
   * stops the save; when it will be recorded, so does a bad "taken" time.
   */
  private vitalsInvalid(withReadings: boolean): boolean {
    this.vitalsSubmitted.set(true);
    this.vitalsFieldErrors.set({});
    this.vitalsFormError.set('');
    return (
      this.vitalFields().some((f) => (f.key === 'blood_pressure' ? this.bpError(f) : this.vitalFieldError(f))) ||
      (withReadings && !!this.takenAtError())
    );
  }

  protected async saveInsurance(): Promise<void> {
    if (!this.healthLoaded() || this.savingSection()) return;
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
        apiErrorMessage(err, 'Could not save your insurance information.'),
      );
    } finally {
      this.savingSection.set('');
    }
  }

  protected async saveEmergency(): Promise<void> {
    if (!this.healthLoaded() || this.savingSection()) return;
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
        apiErrorMessage(err, 'Could not save your emergency contact.'),
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
      this.phoneVerifyError.set(apiErrorMessage(err, 'Could not send the code.'));
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
      this.phoneVerifyError.set(apiErrorMessage(err, 'That code is invalid or expired.'));
    } finally {
      this.phoneBusy.set(false);
    }
  }

  protected cancelPhoneVerify(): void {
    this.phoneVerifyState.set('idle');
    this.otpCode.set('');
    this.phoneVerifyError.set('');
  }

  // ----- Change email -----

  protected openEmailChange(): void {
    this.emailForm.reset({ email: '', otp: '' });
    this.emailStep.set('email');
    this.emailError.set('');
    this.emailDevCode.set('');
    this.emailModalOpen.set(true);
  }

  protected closeEmailChange(): void {
    this.emailModalOpen.set(false);
    this.emailBusy.set(false);
  }

  /** Step 1 — email a code to the requested new address. */
  protected async sendEmailOtp(): Promise<void> {
    const control = this.emailForm.controls.email;
    if (control.invalid) {
      control.markAsTouched();
      return;
    }
    this.emailBusy.set(true);
    this.emailError.set('');
    try {
      const res = await firstValueFrom(
        this.patient.requestEmailChangeOtp(control.value.trim().toLowerCase()),
      );
      this.emailDevCode.set(res.data.dev_code ?? '');
      this.emailForm.controls.otp.reset('');
      this.emailStep.set('otp');
      this.emailDialog()?.refocus(); // the code step replaced the focused button
    } catch (err) {
      this.emailError.set(apiErrorMessage(err, 'Could not send the code. Please try again.'));
    } finally {
      this.emailBusy.set(false);
    }
  }

  protected resendEmailOtp(): void {
    void this.sendEmailOtp();
  }

  /** Step 2 — confirm the code and swap the account email. */
  protected async confirmEmailChange(): Promise<void> {
    if (this.emailForm.invalid) {
      this.emailForm.markAllAsTouched();
      return;
    }
    const { email, otp } = this.emailForm.getRawValue();
    this.emailBusy.set(true);
    this.emailError.set('');
    try {
      const res = await firstValueFrom(
        this.patient.changeEmail(email.trim().toLowerCase(), otp),
      );
      this.applyProfile(res.data);
      this.closeEmailChange();
      this.showToast('Email updated successfully');
    } catch (err) {
      this.emailError.set(apiErrorMessage(err, 'That code is invalid or expired.'));
    } finally {
      this.emailBusy.set(false);
    }
  }

  private showToast(message: string): void {
    this.toast.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3000);
  }
}

/**
 * Date of birth must be a real past date that makes the patient at least 18.
 * Empty is allowed (requiredness is handled separately); a future date or an
 * under-18 date is rejected.
 */
function adultDobValidator(control: AbstractControl): ValidationErrors | null {
  const raw = typeof control.value === 'string' ? control.value.trim() : '';
  if (raw === '') return null;
  const dob = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return null;

  const now = new Date();
  if (dob.getTime() > now.getTime()) return { future: true };

  const eighteenthBirthday = new Date(dob.getFullYear() + 18, dob.getMonth(), dob.getDate());
  return eighteenthBirthday.getTime() > now.getTime() ? { underage: true } : null;
}
