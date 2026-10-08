import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { apiErrorFields, apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type {
  ClinicalSummaryDto,
  CreatePrescriptionInput,
  DrugDto,
  FollowUpMode,
  PregnancyStatus,
  PrescriptionDto,
  PrescriptionFormInput,
  PrescriptionItem,
  PrescriptionOptionsDto,
  PrescriptionReadingField,
  PrescriptionReadings,
  ReadingKey,
  ReadingSource,
  SendPrescriptionInput,
} from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  ConfirmDialogComponent,
  IconComponent,
} from '@supadoc/ui';
import { forkJoin, map, Observable, of, Subscription, switchMap } from 'rxjs';
import { RxDrugSearch } from './rx-drug-search';
import { RxFiles, RxOpenOptions } from './rx-files';
import {
  isoToLocalInput,
  localInputToIso,
  nowLocalInput,
  RX_BAD,
  RX_FIELD,
  RX_FOLLOW_UP_LABELS,
  RX_OK,
  RX_PREGNANCY_LABELS,
  RX_SOURCE_LABELS,
  RxStatusBadge,
  todayYmd,
} from './rx-shared';
import { RxSidePanel } from './rx-side-panel';
import { SignaturePad } from './signature-pad';

/** One medicine row in the composer (field names match the API's error keys). */
interface RowState {
  key: number;
  rxcui: string | null;
  name: string;
  generic_name: string;
  branded: boolean;
  dose_form: string | null;
  /** Typed search text — never a medicine on its own. */
  query: string;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  quantity: string;
  repeats: string;
  no_substitute: boolean;
  instructions: string;
}

type RowField =
  | 'dose'
  | 'route'
  | 'frequency'
  | 'duration'
  | 'quantity'
  | 'repeats'
  | 'no_substitute'
  | 'instructions';

type Busy = '' | 'save' | 'preview' | 'send' | 'pdf';

const FREQUENCIES = [
  'Once daily',
  'Twice daily',
  'Three times daily',
  'Every 8 hours',
  'Every 6 hours',
  'At night',
  'When needed',
];
const DURATIONS = ['3 days', '5 days', '7 days', '14 days', '1 month'];

const DEFAULT_LIMITS: PrescriptionOptionsDto['limits'] = {
  reason: 220,
  current_medications: 110,
  advice: 220,
  tests_referrals: 110,
  instructions: 110,
};

const ICD_URL = 'https://icd.who.int/browse/2024-01/mms/en';

/** Shown as soon as the clinical summary says the patient has no date of birth on file. */
const DOB_MISSING =
  "This patient's date of birth is not on file. You can save a draft, but you can't send it until the patient adds their date of birth (pharmacists need it to check the prescription).";

/**
 * API error keys that are not a box on the form (e.g. "this consultation was
 * cancelled", "you have not seen this patient") — shown as a message instead.
 */
const GENERAL_ERROR_KEYS = ['appointment_id', 'patient_id'];

/** The send-time "patient's date of birth is not on file" error (422, key `patient`). */
function isPatientKey(key: string): boolean {
  return key === 'patient' || key.startsWith('patient.');
}

/** Keys of errors that belong to the send dialog itself (checklist, signature). */
function isDialogKey(key: string): boolean {
  return ['confirm', 'signature'].some((d) => key === d || key.startsWith(`${d}.`));
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const LABEL = 'font-sans text-caption font-semibold text-ink';
const HINT = 'font-sans text-caption text-slate';
const ERR = 'font-sans text-caption text-alert';
const SECTION = 'flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 @lg:p-5';
const H3 = 'flex items-center gap-2 font-heading text-body-lg text-ink';
const RADIO_CARD =
  'flex cursor-pointer items-center gap-2 rounded-field border border-cloud bg-white px-3 py-2.5 font-sans text-body-sm text-ink has-[:checked]:border-cerulean has-[:checked]:bg-frost/30';

let nextUid = 0;

function isFilled(r: RowState): boolean {
  return (
    !!r.rxcui ||
    [r.dose, r.route, r.frequency, r.duration, r.quantity, r.instructions].some(
      (v) => v.trim() !== '',
    )
  );
}

/** Anything entered in the add-medicine form (typed search text included). */
function hasRowContent(r: RowState): boolean {
  return isFilled(r) || r.query.trim() !== '' || r.no_substitute || toRepeats(r.repeats) > 0;
}

/** A row's medicine details, for "has this changed?" (ignores the search box). */
function rowJson(r: RowState): string {
  const { key: _key, query: _query, ...rest } = r;
  return JSON.stringify({ ...rest, repeats: String(toRepeats(r.repeats)) });
}

function toRepeats(v: string): number {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) ? 0 : n;
}

function nullIfBlank(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * The GVM-F-RX-01 prescription form: health readings, consultation, up to ten
 * medicines (RxNorm), advice + follow-up, validity, then the send dialog
 * (checklist + signature). Saves drafts; never names medicines to the patient.
 *
 * Usage:
 * `<doc-rx-composer [patientId]="pid" [appointmentId]="aid" [prescriptionId]="draftId"
 *    [compact]="true" (saved)="…" (sent)="…" (closed)="…" />`
 *
 * The form lives only in this component: a host must ask before destroying it
 * while `hasUnsavedChanges()` is true (route guard, tab switch, ending a call).
 */
@Component({
  selector: 'doc-rx-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    IconComponent,
    RxDrugSearch,
    RxSidePanel,
    RxStatusBadge,
    SignaturePad,
  ],
  host: {
    class: 'block',
    '(window:beforeunload)': 'onBeforeUnload($event)',
  },
  template: `
    <!-- Container queries live on this wrapper; the fixed dialogs stay outside it. -->
    <div class="@container">
    @if (loading()) {
      <div class="flex flex-col gap-4" aria-busy="true">
        <span class="sr-only">Loading the prescription form…</span>
        <div class="sd-shimmer h-20 rounded-card"></div>
        <div class="sd-shimmer h-48 rounded-card"></div>
        <div class="sd-shimmer h-64 rounded-card"></div>
      </div>
    } @else if (loadError()) {
      <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-4 py-12 text-center">
        <sd-icon name="circle-alert" [size]="32" class="text-alert" />
        <p class="max-w-sm font-sans text-body-sm text-slate">{{ loadError() }}</p>
        <div class="flex flex-wrap justify-center gap-2">
          <sd-button variant="secondary" size="sm" [disabled]="disabled()" (click)="retry()">
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </sd-button>
          <sd-button variant="ghost" size="sm" (click)="closed.emit()">Close</sd-button>
        </div>
      </div>
    } @else {
      <div class="flex flex-col gap-5">
        <!-- a. Header -->
        <header class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 @lg:flex-row @lg:items-start @lg:justify-between @lg:p-5">
          <div class="flex min-w-0 flex-col gap-1">
            <span class="${HINT}">Prescription</span>
            <h2 class="break-all font-heading text-h5 text-ink">{{ rx()?.number ?? 'New prescription' }}</h2>
            <p class="flex items-center gap-1.5 ${HINT}">
              <sd-icon name="file-text" [size]="14" class="shrink-0" /> {{ pageHint() }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            @if (rx(); as r) {
              <doc-rx-status-badge [status]="r.status" />
            } @else {
              <span class="inline-flex items-center gap-1 rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-semibold text-slate">
                <sd-icon name="save" [size]="13" /> Not saved yet
              </span>
            }
          </div>
        </header>

        @if (showMdcn()) {
          <div class="flex items-start gap-2.5 rounded-field bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink" role="alert">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0 text-warning" />
            <span class="min-w-0 flex-1">
              Add your MDCN number in your profile — it is printed on your prescriptions.
              <a routerLink="/profile" target="_blank" rel="noopener" class="font-semibold text-cerulean underline">Open my profile</a>
            </span>
            <button type="button" class="shrink-0 text-slate transition-colors hover:text-ink" aria-label="Dismiss" (click)="mdcnDismissed.set(true)">
              <sd-icon name="x" [size]="18" />
            </button>
          </div>
        }

        @if (dobMissing() && !locked()) {
          <div class="flex items-start gap-2.5 rounded-field border border-warning/60 bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink" role="note">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0 text-warning" />
            <span class="min-w-0 flex-1">{{ dobMissingText }}</span>
          </div>
        }

        @if (locked()) {
          <sd-alert tone="info">
            This prescription has been sent and is locked. To change it, cancel and replace it.
          </sd-alert>
        }

        <div class="grid grid-cols-1 gap-5" [class]="compact() ? '' : '@4xl:grid-cols-[minmax(0,1fr)_20rem] @4xl:items-start'">
          <!-- b. Side panel / accordion -->
          <aside [class]="compact() ? '' : '@4xl:sticky @4xl:top-4 @4xl:col-start-2 @4xl:row-start-1'">
            <button
              type="button"
              class="w-full items-center justify-between gap-2 rounded-card border border-cloud bg-white px-4 py-3 font-sans text-body-sm font-semibold text-ink"
              [class]="compact() ? 'flex' : 'flex @4xl:hidden'"
              [attr.aria-expanded]="infoOpen()"
              [attr.aria-controls]="id('info')"
              (click)="infoOpen.set(!infoOpen())"
            >
              <span class="flex items-center gap-2"><sd-icon name="user" [size]="18" class="text-cerulean" /> Patient information</span>
              <sd-icon name="chevron-down" [size]="18" class="text-slate transition-transform" [class.rotate-180]="infoOpen()" />
            </button>
            <div [id]="id('info')" [class]="infoBodyClass()">
              <doc-rx-side-panel [patientId]="patientId()" (loaded)="onSummary($event)" />
            </div>
          </aside>

          <!-- Form -->
          <fieldset class="m-0 min-w-0 border-0 p-0" [disabled]="locked()">
            <legend class="sr-only">Prescription form</legend>
            <div class="@container flex min-w-0 flex-col gap-5">

            <!-- c. Health readings -->
            <section class="${SECTION}" [attr.aria-labelledby]="id('h-readings')">
              <div class="flex flex-col gap-0.5">
                <h3 class="${H3}" [id]="id('h-readings')"><sd-icon name="heart-pulse" [size]="18" class="text-cerulean" /> Health readings</h3>
                <p class="${HINT}">All optional. Fill in what you know.</p>
              </div>
              <!-- Subgrid: labels, boxes and messages line up row by row even when labels wrap. -->
              <div class="grid grid-cols-1 gap-x-3 gap-y-1.5 @xs:grid-cols-2 @3xl:grid-cols-3">
                @for (f of readingFields(); track f.key) {
                  <div class="row-span-3 grid grid-rows-subgrid">
                    <label class="self-end ${LABEL}" [for]="id('r-' + f.key)">{{ readingLabel(f) }}</label>
                    <input
                      type="text"
                      autocomplete="off"
                      class="${RX_FIELD}"
                      [class]="fc('readings.' + f.key)"
                      [id]="id('r-' + f.key)"
                      [attr.inputmode]="f.key === 'blood_pressure' ? 'text' : 'decimal'"
                      [placeholder]="readingPlaceholder(f)"
                      [value]="reading(f.key)"
                      [attr.aria-invalid]="fe('readings.' + f.key) ? 'true' : null"
                      [attr.aria-describedby]="fe('readings.' + f.key) ? id('r-' + f.key + '-err') : null"
                      (input)="setReading(f.key, $any($event.target).value)"
                    />
                    <div class="pb-1.5">
                      @if (fe('readings.' + f.key); as m) {
                        <p class="${ERR}" [id]="id('r-' + f.key + '-err')" data-rx-error>{{ m }}</p>
                      } @else if (f.key === 'bmi' && bmiAuto() && reading('bmi')) {
                        <span class="${HINT}">Worked out from weight and height</span>
                      }
                    </div>
                  </div>
                }
              </div>
              <div class="grid grid-cols-1 gap-3 @md:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" [for]="id('r-source')">Where the readings came from</label>
                  <select
                    class="${RX_FIELD}"
                    [class]="fc('readings.source')"
                    [id]="id('r-source')"
                    [attr.aria-invalid]="fe('readings.source') ? 'true' : null"
                    (change)="setSource($any($event.target).value)"
                  >
                    <option value="" [selected]="readingSource() === ''">Not stated</option>
                    @for (o of sourceOptions(); track o.value) {
                      <option [value]="o.value" [selected]="readingSource() === o.value">{{ o.label }}</option>
                    }
                  </select>
                  @if (fe('readings.source'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  }
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" [for]="id('r-taken')">Time taken</label>
                  <input
                    type="datetime-local"
                    class="${RX_FIELD}"
                    [class]="fc('readings.taken_at')"
                    [id]="id('r-taken')"
                    [max]="nowLocal"
                    [value]="takenAt()"
                    [attr.aria-invalid]="fe('readings.taken_at') ? 'true' : null"
                    (input)="setTakenAt($any($event.target).value)"
                  />
                  @if (fe('readings.taken_at'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  }
                </div>
              </div>
            </section>

            <!-- d. Consultation -->
            <section class="${SECTION}" [attr.aria-labelledby]="id('h-consult')">
              <h3 class="${H3}" [id]="id('h-consult')"><sd-icon name="stethoscope" [size]="18" class="text-cerulean" /> Consultation</h3>

              <div class="flex flex-col gap-1.5">
                <label class="${LABEL}" [for]="id('reason')">
                  Reason for the prescription <span class="text-alert">*</span>
                  <span class="ml-1 font-normal text-slate">(needed to send)</span>
                </label>
                <textarea
                  rows="3"
                  class="${RX_FIELD}"
                  [class]="fc('reason')"
                  [id]="id('reason')"
                  [attr.maxlength]="limits().reason"
                  [attr.aria-invalid]="fe('reason') ? 'true' : null"
                  [attr.aria-describedby]="id('reason-help')"
                  placeholder="What you are treating, in a few words"
                  [value]="reason()"
                  (input)="setText('reason', $any($event.target).value)"
                ></textarea>
                <div class="flex items-start justify-between gap-3" [id]="id('reason-help')">
                  @if (fe('reason'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  } @else {
                    <span></span>
                  }
                  <span class="shrink-0 font-sans text-caption" [class]="counterClass(reason(), limits().reason)">{{ reason().length }}/{{ limits().reason }}</span>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" [for]="id('icd')">Illness code (ICD) <span class="font-normal text-slate">(optional)</span></label>
                  <input
                    type="text"
                    autocomplete="off"
                    class="${RX_FIELD}"
                    [class]="fc('icd_code')"
                    [id]="id('icd')"
                    maxlength="20"
                    placeholder="e.g. 1F40 or J45.9"
                    [value]="icd()"
                    [attr.aria-invalid]="fe('icd_code') ? 'true' : null"
                    (input)="setText('icd_code', $any($event.target).value)"
                  />
                  <a
                    class="inline-flex w-fit items-center gap-1 font-sans text-caption font-semibold text-cerulean hover:underline"
                    [href]="icdUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Look up illness codes <sd-icon name="external-link" [size]="12" />
                  </a>
                  @if (fe('icd_code'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  }
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" [for]="id('curmeds')">Medicines already taken</label>
                  <input
                    type="text"
                    autocomplete="off"
                    class="${RX_FIELD}"
                    [class]="fc('current_medications')"
                    [id]="id('curmeds')"
                    [attr.maxlength]="limits().current_medications"
                    placeholder="Anything the patient already takes"
                    [value]="currentMeds()"
                    [attr.aria-invalid]="fe('current_medications') ? 'true' : null"
                    (input)="setText('current_medications', $any($event.target).value)"
                  />
                  <div class="flex items-start justify-between gap-3">
                    @if (fe('current_medications'); as m) {
                      <p class="${ERR}" data-rx-error>{{ m }}</p>
                    } @else {
                      <span></span>
                    }
                    <span class="shrink-0 font-sans text-caption" [class]="counterClass(currentMeds(), limits().current_medications)">{{ currentMeds().length }}/{{ limits().current_medications }}</span>
                  </div>
                </div>
              </div>

              @if (isMale()) {
                <!-- Not a question for a male patient: recorded as "Not applicable". -->
                <div class="flex flex-col gap-1.5">
                  <span class="${LABEL}">Pregnant or breastfeeding?</span>
                  <p class="flex items-center gap-2 rounded-field border border-cloud bg-cloud/40 px-3 py-2.5 font-sans text-body-sm text-slate">
                    <sd-icon name="info" [size]="15" class="shrink-0" /> Not applicable — male patient
                  </p>
                </div>
              } @else {
              <div
                class="flex flex-col gap-1.5"
                [class]="askPregnancy() ? 'rounded-field border border-warning/60 bg-warning/10 p-3' : ''"
              >
                <label class="${LABEL}" [for]="id('preg')">
                  Pregnant or breastfeeding?
                  @if (askPregnancy()) {
                    <span class="text-alert">*</span><span class="ml-1 font-normal text-slate">(needed for this patient)</span>
                  } @else {
                    <span class="font-normal text-slate">(optional)</span>
                  }
                </label>
                <select
                  class="${RX_FIELD}"
                  [class]="fc('pregnancy_status')"
                  [id]="id('preg')"
                  [attr.aria-invalid]="fe('pregnancy_status') ? 'true' : null"
                  [attr.aria-required]="askPregnancy()"
                  (change)="setPregnancy($any($event.target).value)"
                >
                  <option value="" [selected]="pregnancy() === ''">Choose an answer</option>
                  @for (o of pregnancyOptions(); track o.value) {
                    <option [value]="o.value" [selected]="pregnancy() === o.value">{{ o.label }}</option>
                  }
                </select>
                @if (fe('pregnancy_status'); as m) {
                  <p class="${ERR}" data-rx-error>{{ m }}</p>
                }
              </div>
              }
            </section>

            <!-- e. Medicines -->
            <section class="${SECTION}" [attr.aria-labelledby]="id('h-meds')">
              <h3 class="flex items-start gap-2 font-heading text-body-lg text-ink" [id]="id('h-meds')">
                <sd-icon name="pill" [size]="18" class="mt-1 shrink-0 text-cerulean" />
                <span>Medicines <span class="font-sans text-body-sm font-normal text-slate">— use the common (generic) name. Tick “No substitute” only when the pharmacy must give exactly that brand.</span></span>
              </h3>
              @if (fe('items'); as m) {
                <p class="flex items-center gap-1.5 ${ERR}" data-rx-error><sd-icon name="circle-alert" [size]="14" /> {{ m }}</p>
              }

              <!-- Added medicines: a compact list — view, edit, remove (with undo). -->
              @if (rows().length > 0) {
                <ol class="flex flex-col gap-2" [attr.aria-label]="'Medicines on this prescription (' + rows().length + ')'">
                  @for (row of rows(); track row.key; let i = $index) {
                    @if (i === perPage()) {
                      <li class="flex items-center gap-3 py-1" role="separator" aria-label="Extra page (Page 2 of 2)">
                        <span class="h-px flex-1 bg-ash"></span>
                        <span class="flex items-center gap-1.5 font-sans text-caption font-semibold text-slate">
                          <sd-icon name="file-text" [size]="14" /> Extra page (Page 2 of 2)
                        </span>
                        <span class="h-px flex-1 bg-ash"></span>
                      </li>
                    }
                    <li
                      class="flex items-start gap-3 rounded-card border p-3 transition-colors"
                      [class]="editingKey() === row.key ? 'border-cerulean bg-frost/40' : rowErrors(row.key).length ? 'border-alert/60 bg-alert/5' : 'border-cloud bg-white'"
                      [attr.aria-label]="'Medicine ' + (i + 1) + ': ' + (row.name || 'not chosen')"
                    >
                      <span class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-cerulean font-sans text-caption font-semibold text-white" aria-hidden="true">{{ i + 1 }}</span>
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-body-sm font-semibold text-ink">
                          <span class="min-w-0 break-words">{{ row.name || 'Medicine not chosen' }}</span>
                          @if (row.no_substitute) {
                            <span class="rounded-pill bg-warning/15 px-2 py-0.5 font-sans text-[10px] font-semibold text-ink">No substitute</span>
                          }
                        </p>
                        @if (row.branded && row.generic_name) {
                          <p class="${HINT}">{{ row.generic_name }}</p>
                        }
                        <p class="font-sans text-caption text-slate">{{ rowSummary(row) }}</p>
                        @if (row.instructions) {
                          <p class="font-sans text-caption italic text-slate">{{ row.instructions }}</p>
                        }
                        @for (m of rowErrors(row.key); track m) {
                          <p class="flex items-center gap-1.5 ${ERR}" data-rx-error><sd-icon name="circle-alert" [size]="13" class="shrink-0" /> {{ m }}</p>
                        }
                      </div>
                      @if (!locked()) {
                        <div class="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-field px-2 py-1.5 font-sans text-caption font-semibold text-cerulean transition-colors hover:bg-frost disabled:opacity-50"
                            [attr.aria-label]="'Edit medicine ' + (i + 1)"
                            [attr.title]="draftDirty() && editingKey() !== row.key ? 'Finish or cancel the medicine in the form first' : null"
                            [disabled]="editingKey() === row.key || draftDirty()"
                            (click)="startEdit(row.key)"
                          >
                            <sd-icon name="pencil" [size]="14" /> <span class="hidden @md:inline">Edit</span>
                          </button>
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 rounded-field px-2 py-1.5 font-sans text-caption font-semibold text-alert transition-colors hover:bg-alert/10"
                            [attr.aria-label]="'Remove medicine ' + (i + 1)"
                            (click)="removeRow(row.key)"
                          >
                            <sd-icon name="trash-2" [size]="14" /> <span class="hidden @md:inline">Remove</span>
                          </button>
                        </div>
                      }
                    </li>
                  }
                </ol>
              }

              @if (removed(); as r) {
                <p class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-field bg-cloud/60 px-3 py-2 font-sans text-body-sm text-ink" role="status">
                  <sd-icon name="trash-2" [size]="14" class="shrink-0 text-slate" />
                  <span class="min-w-0">Removed {{ r.row.name || 'a medicine' }}.</span>
                  <button type="button" class="font-semibold text-cerulean underline transition-colors hover:text-ocean disabled:opacity-50" [id]="id('undo')" [disabled]="!canUndo()" (click)="undoRemove()">Undo</button>
                </p>
              }

              <!-- Add / edit form — separate from the list; the list only takes complete medicines. -->
              @if (draft(); as d) {
                <div class="flex flex-col gap-3 rounded-card border border-cerulean/40 bg-frost/30 p-3 @lg:p-4" role="group" [attr.aria-labelledby]="id('ed-title')">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink" [id]="id('ed-title')">
                      <sd-icon [name]="editingKey() !== null ? 'pencil' : 'plus'" [size]="16" class="text-cerulean" />
                      {{ editingKey() !== null ? 'Edit medicine ' + (editingIndex() + 1) : rows().length ? 'Add another medicine' : 'Add a medicine' }}
                    </h4>
                    <span class="${HINT}">{{ rows().length }} of {{ maxItems() }}</span>
                  </div>

                  <div class="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
                    <div class="col-span-full flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-drug')">Medicine</label>
                      @for (k of [d.key]; track k) {
                      <doc-rx-drug-search
                        [inputId]="id('ed-drug')"
                        [chosen]="d.rxcui ? { name: d.name, branded: d.branded, dose_form: d.dose_form, generic_name: d.generic_name } : null"
                        [invalid]="!!fe('row:' + d.key + '.rxcui')"
                        [describedBy]="fe('row:' + d.key + '.rxcui') ? id('ed-drug-err') : null"
                        [disabled]="locked() || disabled()"
                        (picked)="pickDraftDrug($event)"
                        (cleared)="clearDraftDrug()"
                        (queryChange)="setDraftQuery($event)"
                      />
                      }
                      @if (fe('row:' + d.key + '.rxcui'); as m) {
                        <p class="${ERR}" [id]="id('ed-drug-err')" data-rx-error>{{ m }}</p>
                      }
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-dose')">How much to take</label>
                      <input type="text" autocomplete="off" maxlength="40" class="${RX_FIELD}" [class]="fc('row:' + d.key + '.dose')"
                        [id]="id('ed-dose')" placeholder="e.g. 1 tablet" [value]="d.dose"
                        [attr.aria-invalid]="fe('row:' + d.key + '.dose') ? 'true' : null"
                        (input)="setDraft('dose', $any($event.target).value)" (keydown.enter)="commitDraft()" />
                      @if (fe('row:' + d.key + '.dose'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> }
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-route')">How to take it</label>
                      <select class="${RX_FIELD}" [class]="fc('row:' + d.key + '.route')" [id]="id('ed-route')"
                        [attr.aria-invalid]="fe('row:' + d.key + '.route') ? 'true' : null"
                        (change)="setDraft('route', $any($event.target).value)">
                        <option value="" [selected]="d.route === ''">Choose…</option>
                        @for (r of routes(); track r) {
                          <option [value]="r" [selected]="d.route === r">{{ r }}</option>
                        }
                      </select>
                      @if (fe('row:' + d.key + '.route'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> }
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-freq')">How often</label>
                      <input type="text" autocomplete="off" maxlength="40" class="${RX_FIELD}" [class]="fc('row:' + d.key + '.frequency')"
                        [id]="id('ed-freq')" [attr.list]="id('freq')" placeholder="e.g. Twice daily" [value]="d.frequency"
                        [attr.aria-invalid]="fe('row:' + d.key + '.frequency') ? 'true' : null"
                        (input)="setDraft('frequency', $any($event.target).value)" (keydown.enter)="commitDraft()" />
                      @if (fe('row:' + d.key + '.frequency'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> }
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-dur')">For how long</label>
                      <input type="text" autocomplete="off" maxlength="30" class="${RX_FIELD}" [class]="fc('row:' + d.key + '.duration')"
                        [id]="id('ed-dur')" [attr.list]="id('dur')" placeholder="e.g. 7 days" [value]="d.duration"
                        [attr.aria-invalid]="fe('row:' + d.key + '.duration') ? 'true' : null"
                        (input)="setDraft('duration', $any($event.target).value)" (keydown.enter)="commitDraft()" />
                      @if (fe('row:' + d.key + '.duration'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> }
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-qty')">Quantity to give</label>
                      <input type="text" autocomplete="off" maxlength="30" class="${RX_FIELD}" [class]="fc('row:' + d.key + '.quantity')"
                        [id]="id('ed-qty')" placeholder="e.g. 14 tablets" [value]="d.quantity"
                        [attr.aria-invalid]="fe('row:' + d.key + '.quantity') ? 'true' : null"
                        (input)="setDraft('quantity', $any($event.target).value)" (keydown.enter)="commitDraft()" />
                      @if (fe('row:' + d.key + '.quantity'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> }
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-rep')">Repeats</label>
                      <input type="number" inputmode="numeric" min="0" step="1" [max]="maxRepeats()" class="${RX_FIELD}" [class]="fc('row:' + d.key + '.repeats')"
                        [id]="id('ed-rep')" [value]="d.repeats"
                        [attr.aria-invalid]="fe('row:' + d.key + '.repeats') ? 'true' : null"
                        (input)="setDraft('repeats', $any($event.target).value)" (keydown.enter)="commitDraft()" />
                      @if (fe('row:' + d.key + '.repeats'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> }
                    </div>

                    <label class="flex cursor-pointer items-center gap-2.5 self-end rounded-field border border-cloud bg-white px-3 py-3 font-sans text-body-sm text-ink">
                      <input type="checkbox" class="size-4 accent-cerulean" [checked]="d.no_substitute"
                        (change)="setDraft('no_substitute', $any($event.target).checked)" />
                      No substitute
                    </label>

                    <div class="col-span-full flex flex-col gap-1.5">
                      <label class="${LABEL}" [for]="id('ed-ins')">Instructions</label>
                      <input type="text" autocomplete="off" class="${RX_FIELD}" [class]="fc('row:' + d.key + '.instructions')"
                        [id]="id('ed-ins')" [attr.maxlength]="limits().instructions" placeholder="e.g. Take after food"
                        [value]="d.instructions"
                        [attr.aria-invalid]="fe('row:' + d.key + '.instructions') ? 'true' : null"
                        (input)="setDraft('instructions', $any($event.target).value)" (keydown.enter)="commitDraft()" />
                      <div class="flex items-start justify-between gap-3">
                        @if (fe('row:' + d.key + '.instructions'); as m) { <p class="${ERR}" data-rx-error>{{ m }}</p> } @else { <span></span> }
                        <span class="shrink-0 font-sans text-caption" [class]="counterClass(d.instructions, limits().instructions)">{{ d.instructions.length }}/{{ limits().instructions }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center justify-end gap-2">
                    @if (editingKey() !== null || rows().length > 0) {
                      <sd-button variant="ghost" size="sm" (click)="cancelDraft()">Cancel</sd-button>
                    } @else if (draftDirty()) {
                      <sd-button variant="ghost" size="sm" (click)="cancelDraft()">Clear</sd-button>
                    }
                    <sd-button variant="primary" size="sm" [disabled]="disabled()" (click)="commitDraft()">
                      <sd-icon [name]="editingKey() !== null ? 'check' : 'plus'" [size]="16" />
                      {{ editingKey() !== null ? 'Save changes' : 'Add to prescription' }}
                    </sd-button>
                  </div>
                </div>
              } @else if (!locked()) {
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <sd-button variant="outline" size="sm" [id]="id('ed-add')" [disabled]="rows().length >= maxItems()" (click)="startAdd()">
                    <sd-icon name="plus" [size]="16" /> {{ rows().length ? 'Add another medicine' : 'Add a medicine' }}
                  </sd-button>
                  <span class="${HINT}">{{ rows().length }} of {{ maxItems() }} medicines</span>
                </div>
              }

              <datalist [id]="id('freq')">
                @for (f of frequencies; track f) { <option [value]="f"></option> }
              </datalist>
              <datalist [id]="id('dur')">
                @for (d of durations; track d) { <option [value]="d"></option> }
              </datalist>
              <p class="font-sans text-caption text-slate/80">
                Medicine names from RxNorm, courtesy of the U.S. National Library of Medicine.
              </p>
            </section>

            <!-- f. Advice and follow-up -->
            <section class="${SECTION}" [attr.aria-labelledby]="id('h-advice')">
              <h3 class="${H3}" [id]="id('h-advice')"><sd-icon name="clipboard-list" [size]="18" class="text-cerulean" /> Advice and follow-up</h3>
              <div class="flex flex-col gap-1.5">
                <label class="${LABEL}" [for]="id('advice')">Advice to the patient</label>
                <textarea
                  rows="3"
                  class="${RX_FIELD}"
                  [class]="fc('advice')"
                  [id]="id('advice')"
                  [attr.maxlength]="limits().advice"
                  [attr.aria-invalid]="fe('advice') ? 'true' : null"
                  [attr.aria-describedby]="id('advice-help')"
                  [value]="advice()"
                  (input)="setText('advice', $any($event.target).value)"
                ></textarea>
                <div class="flex items-start justify-between gap-3" [id]="id('advice-help')">
                  @if (fe('advice'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  } @else {
                    <span class="${HINT}">If you need more space, add the rest to the consultation summary.</span>
                  }
                  <span class="shrink-0 font-sans text-caption" [class]="counterClass(advice(), limits().advice)">{{ advice().length }}/{{ limits().advice }}</span>
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" [for]="id('fu-date')">Follow-up date <span class="font-normal text-slate">(optional)</span></label>
                  <input
                    type="date"
                    class="${RX_FIELD}"
                    [class]="fc('follow_up_date')"
                    [id]="id('fu-date')"
                    [min]="today"
                    [value]="followUpDate()"
                    [attr.aria-invalid]="fe('follow_up_date') ? 'true' : null"
                    (input)="setFollowUpDate($any($event.target).value)"
                  />
                  @if (fe('follow_up_date'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  }
                </div>
                <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" [attr.aria-invalid]="fe('follow_up_mode') ? 'true' : null">
                  <legend class="mb-1.5 ${LABEL}">
                    Follow-up by
                    @if (followUpDate()) { <span class="text-alert">*</span> }
                  </legend>
                  <div class="flex flex-wrap gap-2">
                    @for (o of followUpModes(); track o.value) {
                      <label class="${RADIO_CARD}" [class.opacity-60]="!followUpDate()">
                        <input type="radio" class="size-4 accent-cerulean" [name]="id('fu-mode')" [value]="o.value"
                          [checked]="followUpMode() === o.value" [disabled]="!followUpDate()"
                          (change)="setFollowUpMode(o.value)" />
                        {{ o.label }}
                      </label>
                    }
                  </div>
                  @if (fe('follow_up_mode'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  } @else if (!followUpDate()) {
                    <span class="${HINT}">Choose a date first.</span>
                  }
                </fieldset>
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="${LABEL}" [for]="id('tests')">Tests or referrals</label>
                <input
                  type="text"
                  autocomplete="off"
                  class="${RX_FIELD}"
                  [class]="fc('tests_referrals')"
                  [id]="id('tests')"
                  [attr.maxlength]="limits().tests_referrals"
                  [value]="tests()"
                  [attr.aria-invalid]="fe('tests_referrals') ? 'true' : null"
                  (input)="setText('tests_referrals', $any($event.target).value)"
                />
                <div class="flex items-start justify-between gap-3">
                  @if (fe('tests_referrals'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  } @else {
                    <span></span>
                  }
                  <span class="shrink-0 font-sans text-caption" [class]="counterClass(tests(), limits().tests_referrals)">{{ tests().length }}/{{ limits().tests_referrals }}</span>
                </div>
              </div>
            </section>

            <!-- g. Validity -->
            <section class="${SECTION}" [attr.aria-labelledby]="id('h-valid')">
              <h3 class="${H3}" [id]="id('h-valid')"><sd-icon name="calendar-days" [size]="18" class="text-cerulean" /> Validity</h3>
              <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                <div class="flex flex-col gap-1.5">
                  <label class="${LABEL}" [for]="id('valid')">Valid until <span class="text-alert">*</span></label>
                  <input
                    type="date"
                    class="${RX_FIELD}"
                    [class]="fc('valid_until')"
                    [id]="id('valid')"
                    [min]="today"
                    [value]="validUntil()"
                    [attr.aria-invalid]="fe('valid_until') ? 'true' : null"
                    (input)="setText('valid_until', $any($event.target).value)"
                  />
                  @if (fe('valid_until'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  }
                </div>
                <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" [attr.aria-invalid]="fe('allows_repeats') ? 'true' : null">
                  <legend class="mb-1.5 ${LABEL}">Does this prescription allow repeats? <span class="text-alert">*</span></legend>
                  <div class="flex flex-wrap gap-2">
                    <label class="${RADIO_CARD}">
                      <input type="radio" class="size-4 accent-cerulean" [name]="id('repeats')" [checked]="allowsRepeats() === true" (change)="setAllowsRepeats(true)" />
                      Yes
                    </label>
                    <label class="${RADIO_CARD}">
                      <input type="radio" class="size-4 accent-cerulean" [name]="id('repeats')" [checked]="allowsRepeats() === false" (change)="setAllowsRepeats(false)" />
                      No
                    </label>
                  </div>
                  @if (fe('allows_repeats'); as m) {
                    <p class="${ERR}" data-rx-error>{{ m }}</p>
                  }
                </fieldset>
              </div>
              @if (repeatsConflict()) {
                <sd-alert tone="warning">
                  Some medicines have repeats, but you answered “No”. Answer “Yes”, or set their repeats to 0.
                </sd-alert>
              }
            </section>
            </div>
          </fieldset>
        </div>

        <!-- h. Footer actions — kept slim (one row where the form is wide) so it
             never crowds the form, e.g. in the call's scrolling tools panel. -->
        <div class="sticky bottom-0 z-10 flex flex-col gap-2 rounded-card border border-cloud bg-white/95 px-3 py-2.5 shadow-[0_-4px_16px_rgba(10,22,40,0.06)] backdrop-blur @lg:px-4">
          @if (disabled() && !locked()) {
            <p class="flex items-start gap-2 rounded-field bg-warning/10 px-3 py-2.5 font-sans text-body-sm text-ink" role="status">
              <sd-icon name="lock" [size]="16" class="mt-0.5 shrink-0 text-warning" />
              <span>You are signed out. Your changes are kept here — sign in again to save, preview or send.</span>
            </p>
          }
          @if (patientError() && !locked()) {
            <!-- Send was refused because of the patient's record (date of birth not on file). -->
            <sd-alert tone="error">{{ patientError() }}</sd-alert>
          }
          @if (formError()) {
            <sd-alert tone="error">{{ formError() }}</sd-alert>
          } @else if (notice()) {
            <sd-alert tone="success">{{ notice() }}</sd-alert>
          }
          @if (blockedUrl() && !sendOpen()) {
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-field bg-frost/50 px-3 py-2.5 font-sans text-body-sm text-ink" role="status">
              <sd-icon name="info" [size]="16" class="shrink-0 text-cerulean" />
              <span>Your browser blocked the new tab.</span>
              <a class="inline-flex items-center gap-1 font-semibold text-cerulean underline" [href]="blockedUrl()" target="_blank" rel="noopener noreferrer" (click)="blockedUrl.set(null)">
                Open the prescription <sd-icon name="external-link" [size]="13" />
              </a>
            </p>
          }
          <!-- One row from a 32rem-wide form (short labels), full labels from 48rem;
               narrower: the status + Close line, then one row of actions. -->
          <div class="flex flex-col gap-2 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-3">
            <div class="flex min-h-6 min-w-0 items-center justify-between gap-3">
              <span class="flex min-w-0 items-center gap-1.5 whitespace-nowrap ${HINT}" aria-live="polite">
                @if (locked()) {
                  <sd-icon name="lock" [size]="14" class="shrink-0" /> <span class="@3xl:hidden">Locked</span><span class="hidden @3xl:inline">Sent and locked</span>
                } @else if (busy() === 'save') {
                  <sd-icon name="loader-circle" [size]="14" class="shrink-0 animate-spin" /> Saving…
                } @else if (dirty()) {
                  <span class="size-2 shrink-0 rounded-full bg-warning" aria-hidden="true"></span> <span>Unsaved<span class="hidden @3xl:inline"> changes</span></span>
                } @else if (rx()) {
                  <sd-icon name="check" [size]="14" class="shrink-0 text-sage" /> <span class="@3xl:hidden">Saved</span><span class="hidden @3xl:inline">Draft saved</span>
                } @else {
                  <span>Not saved<span class="hidden @3xl:inline"> yet</span></span>
                }
              </span>
              <!-- Narrow form: Close sits on the status line, leaving one row of actions. -->
              <button
                type="button"
                class="shrink-0 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:text-ocean disabled:opacity-50 @lg:hidden"
                [disabled]="busy() !== ''"
                (click)="requestClose()"
              >
                Close
              </button>
            </div>
            <div class="grid shrink-0 gap-2 @lg:flex @lg:items-center @lg:justify-end" [class.grid-cols-3]="!locked()">
              <div class="hidden @lg:block">
                <sd-button variant="ghost" size="sm" [disabled]="busy() !== ''" (click)="requestClose()">Close</sd-button>
              </div>
              @if (locked()) {
                <sd-button variant="secondary" size="sm" [full]="true" [disabled]="busy() !== '' || disabled()" (click)="viewPdf()">
                  <sd-icon name="file-text" [size]="16" /> View PDF
                </sd-button>
              } @else {
                <sd-button variant="secondary" size="sm" [full]="true" [disabled]="busy() !== '' || disabled()" (click)="saveDraft()">
                  <sd-icon name="save" [size]="16" class="hidden shrink-0 @sm:inline" />
                  <span class="truncate">{{ busy() === 'save' ? 'Saving…' : 'Save' }}<span class="hidden @3xl:inline">{{ busy() === 'save' ? '' : ' draft' }}</span></span>
                </sd-button>
                <sd-button variant="outline" size="sm" [full]="true" [disabled]="busy() !== '' || disabled()" (click)="preview()">
                  <sd-icon name="eye" [size]="16" class="hidden shrink-0 @sm:inline" />
                  <span class="truncate">{{ busy() === 'preview' ? 'Opening…' : 'Preview' }}<span class="hidden @3xl:inline">{{ busy() === 'preview' ? '' : ' PDF' }}</span></span>
                </sd-button>
                <sd-button variant="primary" size="sm" [full]="true" [disabled]="busy() !== '' || disabled()" (click)="openSend()" title="Send to patient">
                  <sd-icon name="send" [size]="16" class="hidden shrink-0 @sm:inline" />
                  <span class="truncate">Send<span class="hidden @3xl:inline"> to patient…</span></span>
                </sd-button>
              }
            </div>
          </div>
        </div>
      </div>
    }
    </div>

    <!-- Send dialog -->
    @if (sendOpen()) {
      <div class="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
        <button type="button" tabindex="-1" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="dismissSend()"></button>
        <div
          #sendDialog
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          class="relative z-10 flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-[16px] bg-white shadow-[0_8px_40px_rgba(10,22,40,0.2)] sm:rounded-[16px]"
          [attr.aria-labelledby]="id('send-title')"
          [attr.aria-describedby]="id('send-sub')"
          (keydown)="dialogKeydown($event)"
        >
          <header class="flex items-start justify-between gap-3 border-b border-cloud px-5 py-4">
            <div class="flex min-w-0 flex-col">
              <h2 class="font-heading text-h5 text-ink" [id]="id('send-title')">{{ sendDone() ? 'Prescription sent' : 'Send to patient' }}</h2>
              <p class="break-all ${HINT}" [id]="id('send-sub')">{{ rx()?.number ?? 'New prescription' }}</p>
            </div>
            <button type="button" class="shrink-0 rounded-field p-1 text-slate transition-colors hover:text-ink disabled:opacity-50" aria-label="Close" [disabled]="busy() === 'send'" (click)="dismissSend()">
              <sd-icon name="x" [size]="20" />
            </button>
          </header>

          <div class="flex-1 overflow-y-auto px-5 py-4" data-dialog-body>
            @if (sendDone()) {
              <div class="flex flex-col items-center gap-3 py-6 text-center" role="status">
                <span class="flex size-16 items-center justify-center rounded-full bg-sage/15 text-sage">
                  <sd-icon name="circle-check" [size]="32" />
                </span>
                <p class="font-heading text-body-lg text-ink">Sent — the patient has been notified</p>
                <p class="max-w-xs font-sans text-body-sm text-slate">
                  It is now locked. To change it later, cancel and replace it.
                </p>
                @if (sendError()) {
                  <sd-alert tone="error" class="w-full text-left">{{ sendError() }}</sd-alert>
                }
                @if (blockedUrl()) {
                  <p class="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-field bg-frost/50 px-3 py-2.5 font-sans text-body-sm text-ink">
                    <span>Your browser blocked the new tab.</span>
                    <a class="inline-flex items-center gap-1 font-semibold text-cerulean underline" [href]="blockedUrl()" target="_blank" rel="noopener noreferrer" (click)="blockedUrl.set(null)">
                      Open the prescription <sd-icon name="external-link" [size]="13" />
                    </a>
                  </p>
                }
              </div>
            } @else {
              <div class="flex flex-col gap-5">
                <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                  <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">1. Before you send, confirm:</legend>
                  <label class="flex cursor-pointer items-start gap-3 rounded-field border border-cloud px-3 py-2.5 has-[:checked]:border-cerulean/50 has-[:checked]:bg-frost/30">
                    <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-cerulean" [checked]="checkAllergies()" (change)="checkAllergies.set($any($event.target).checked)" />
                    <span class="font-sans text-body-sm text-ink">I have checked the patient’s allergies</span>
                  </label>
                  <label class="flex cursor-pointer items-start gap-3 rounded-field border border-cloud px-3 py-2.5 has-[:checked]:border-cerulean/50 has-[:checked]:bg-frost/30">
                    <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-cerulean" [checked]="checkDoses()" (change)="checkDoses.set($any($event.target).checked)" />
                    <span class="font-sans text-body-sm text-ink">I have checked each medicine’s dose and directions</span>
                  </label>
                  <label class="flex cursor-pointer items-start gap-3 rounded-field border border-cloud px-3 py-2.5 has-[:checked]:border-cerulean/50 has-[:checked]:bg-frost/30">
                    <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-cerulean" [checked]="checkPatient()" (change)="checkPatient.set($any($event.target).checked)" />
                    <span class="font-sans text-body-sm text-ink">The patient’s details are correct</span>
                  </label>
                  @if (sendFieldError('confirm'); as m) {
                    <p class="${ERR}">{{ m }}</p>
                  }
                </fieldset>

                <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                  <legend class="mb-2 font-sans text-body-sm font-semibold text-ink">2. Sign the prescription</legend>
                  @if (savedSigAvailable()) {
                    <label class="flex cursor-pointer items-center gap-3 rounded-field border border-cloud px-3 py-2.5 has-[:checked]:border-cerulean/50 has-[:checked]:bg-frost/30">
                      <input type="radio" class="size-4 accent-cerulean" [name]="id('sig')" [checked]="sigMode() === 'saved'" (change)="setSigMode('saved')" />
                      <span class="font-sans text-body-sm text-ink">Use my saved signature</span>
                    </label>
                    @if (sigMode() === 'saved') {
                      <div class="flex min-h-20 items-center justify-center rounded-field border border-dashed border-ash bg-white p-3">
                        @if (sigPreviewState() === 'loading') {
                          <span class="flex items-center gap-2 ${HINT}"><sd-icon name="loader-circle" [size]="14" class="animate-spin" /> Loading your signature…</span>
                        } @else if (sigPreview()) {
                          <img [src]="sigPreview()" alt="Your saved signature" class="max-h-24 max-w-full object-contain" />
                        } @else {
                          <span class="${HINT}">Could not show a preview. Your saved signature will still be used.</span>
                        }
                      </div>
                    }
                    <label class="flex cursor-pointer items-center gap-3 rounded-field border border-cloud px-3 py-2.5 has-[:checked]:border-cerulean/50 has-[:checked]:bg-frost/30">
                      <input type="radio" class="size-4 accent-cerulean" [name]="id('sig')" [checked]="sigMode() === 'drawn'" (change)="setSigMode('drawn')" />
                      <span class="font-sans text-body-sm text-ink">Sign by hand now</span>
                    </label>
                  } @else {
                    <p class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="signature" [size]="16" class="text-cerulean" /> Sign by hand now</p>
                    <p class="${HINT}">Save a signature in your profile to sign faster next time.</p>
                  }
                  @if (sigMode() === 'drawn') {
                    <doc-signature-pad [height]="170" (changed)="drawn.set($event)" />
                    <label class="flex cursor-pointer items-center gap-2.5 font-sans text-body-sm text-ink">
                      <input type="checkbox" class="size-4 accent-cerulean" [checked]="saveDrawn()" (change)="saveDrawn.set($any($event.target).checked)" />
                      Also save this as my signature
                    </label>
                  }
                  @if (sendFieldError('signature'); as m) {
                    <p class="${ERR}">{{ m }}</p>
                  }
                </fieldset>

                <p class="flex items-start gap-2 rounded-field bg-glacier px-3 py-2.5 font-sans text-body-sm text-ink">
                  <sd-icon name="lock" [size]="16" class="mt-0.5 shrink-0 text-cerulean" />
                  Once sent, the prescription is locked. To change it later, cancel and replace it.
                </p>

                @if (patientError()) {
                  <!-- The API refused to send: the patient's date of birth is not on file. -->
                  <sd-alert tone="error">{{ patientError() }}</sd-alert>
                } @else if (dobMissing()) {
                  <div class="flex items-start gap-2.5 rounded-field border border-warning/60 bg-warning/10 px-3 py-2.5 font-sans text-body-sm text-ink" role="note">
                    <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0 text-warning" />
                    <span class="min-w-0 flex-1">{{ dobMissingText }}</span>
                  </div>
                }
                @if (disabled()) {
                  <p class="flex items-start gap-2 rounded-field bg-warning/10 px-3 py-2.5 font-sans text-body-sm text-ink" role="status">
                    <sd-icon name="lock" [size]="16" class="mt-0.5 shrink-0 text-warning" />
                    You are signed out. Sign in again to send — your changes are kept here.
                  </p>
                }
                @if (sendError()) {
                  <sd-alert tone="error">{{ sendError() }}</sd-alert>
                }
              </div>
            }
          </div>

          <footer class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end">
            @if (sendDone()) {
              <sd-button variant="secondary" [full]="true" [disabled]="busy() === 'pdf' || disabled()" (click)="viewPdf()">
                <sd-icon name="file-text" [size]="18" /> {{ busy() === 'pdf' ? 'Opening…' : 'View PDF' }}
              </sd-button>
              <sd-button variant="primary" [full]="true" (click)="finishSent()">Done</sd-button>
            } @else {
              <sd-button variant="secondary" [full]="true" [disabled]="busy() === 'send'" (click)="dismissSend()">Back to the form</sd-button>
              <sd-button variant="primary" [full]="true" [disabled]="busy() === 'send' || disabled()" (click)="confirmSend()">
                <sd-icon name="send" [size]="18" /> {{ busy() === 'send' ? 'Sending…' : 'Send to patient' }}
              </sd-button>
            }
          </footer>
        </div>
      </div>
    }

    <sd-confirm-dialog
      [open]="confirmClose()"
      title="Close without saving?"
      message="Your latest changes have not been saved."
      confirmLabel="Close without saving"
      cancelLabel="Keep editing"
      icon="triangle-alert"
      [danger]="true"
      (confirm)="confirmClose.set(false); closed.emit()"
      (cancel)="confirmClose.set(false)"
    />
  `,
})
export class RxComposer {
  private readonly api = inject(DoctorApi);
  private readonly files = inject(RxFiles);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The patient being prescribed for. */
  readonly patientId = input.required<string>();
  /** The consultation (null = standalone prescription for a patient seen before). */
  readonly appointmentId = input<string | null>(null);
  /** An existing DRAFT to edit; null starts a new prescription. */
  readonly prescriptionId = input<string | null>(null);
  /** Narrow single-column layout for the in-call side panel (~380px). */
  readonly compact = input(false);
  /**
   * Shown during a live video call: a blocked PDF tab never falls back to this
   * tab (that would end the call) — a link to open it is offered instead.
   */
  readonly inCall = input(false);
  /**
   * Pause everything that talks to the server (e.g. while the portal session is
   * signed out). The form stays as it is so nothing is lost.
   */
  readonly disabled = input(false);

  /** A draft was created or saved (also fires when "Preview PDF" saves first). */
  readonly saved = output<PrescriptionDto>();
  /** Sent and locked — fires when the doctor dismisses the success screen. */
  readonly sent = output<PrescriptionDto>();
  /** The doctor closed the composer (after confirming if there were unsaved changes). */
  readonly closed = output<void>();

  private readonly uid = `rx${++nextUid}`;
  protected readonly frequencies = FREQUENCIES;
  protected readonly durations = DURATIONS;
  protected readonly icdUrl = ICD_URL;
  protected readonly dobMissingText = DOB_MISSING;
  protected readonly today = todayYmd();
  protected readonly nowLocal = nowLocalInput();

  // ----- load state -----
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly options = signal<PrescriptionOptionsDto | null>(null);
  protected readonly rx = signal<PrescriptionDto | null>(null);
  protected readonly summary = signal<ClinicalSummaryDto | null>(null);

  // ----- form state -----
  protected readonly readings = signal<Partial<Record<ReadingKey, string>>>({});
  protected readonly readingSource = signal<ReadingSource | ''>('');
  protected readonly takenAt = signal('');
  protected readonly bmiAuto = signal(true);
  protected readonly reason = signal('');
  protected readonly icd = signal('');
  protected readonly currentMeds = signal('');
  protected readonly pregnancy = signal<PregnancyStatus | ''>('');
  /** The medicines on the prescription (each one complete — added through the form below). */
  protected readonly rows = signal<RowState[]>([]);
  /** The add / edit form's medicine, separate from the list; null while it is closed. */
  protected readonly draft = signal<RowState | null>(null);
  /** The listed medicine being edited (null: adding a new one). */
  protected readonly editingKey = signal<number | null>(null);
  protected readonly editingIndex = computed(() =>
    this.rows().findIndex((r) => r.key === this.editingKey()),
  );
  /** Just removed — offered back for a moment ("Undo"). */
  protected readonly removed = signal<{ row: RowState; index: number } | null>(null);
  private removedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Undo still fits under the limit (a medicine being added in the form counts). */
  protected readonly canUndo = computed(() => {
    const pending = this.editingKey() === null && this.draftDirty() ? 1 : 0;
    return !!this.removed() && this.rows().length + pending < this.maxItems();
  });
  /** The add / edit form holds something not on the list yet. */
  protected readonly draftDirty = computed(() => {
    const d = this.draft();
    if (!d) return false;
    const key = this.editingKey();
    if (key === null) return hasRowContent(d);
    const original = this.rows().find((r) => r.key === key);
    return !original || rowJson(original) !== rowJson(d);
  });
  protected readonly advice = signal('');
  protected readonly followUpDate = signal('');
  protected readonly followUpMode = signal<FollowUpMode | ''>('');
  protected readonly tests = signal('');
  protected readonly validUntil = signal('');
  protected readonly allowsRepeats = signal<boolean | null>(null);
  private rowSeq = 0;

  // ----- UI state -----
  protected readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly formError = signal('');
  /** The API refused to send because of the patient's record (date of birth not on file). */
  protected readonly patientError = signal('');
  /** A PDF whose new tab was blocked during a call — offered as a link instead. */
  protected readonly blockedUrl = signal<string | null>(null);
  protected readonly notice = signal('');
  protected readonly busy = signal<Busy>('');
  protected readonly infoOpen = signal(false);
  protected readonly mdcnDismissed = signal(false);
  protected readonly confirmClose = signal(false);
  private readonly savedJson = signal('');
  /** Row keys (in payload order) of the last request — maps `items.N.*` errors back to rows. */
  private lastRowKeys: number[] = [];

  // ----- send dialog -----
  protected readonly sendOpen = signal(false);
  protected readonly sendDone = signal(false);
  protected readonly sendError = signal('');
  private readonly sendFields = signal<Record<string, string>>({});
  protected readonly checkAllergies = signal(false);
  protected readonly checkDoses = signal(false);
  protected readonly checkPatient = signal(false);
  protected readonly savedSigAvailable = signal(false);
  protected readonly sigMode = signal<'saved' | 'drawn'>('saved');
  protected readonly drawn = signal<string | null>(null);
  protected readonly saveDrawn = signal(false);
  protected readonly sigPreview = signal<string | null>(null);
  protected readonly sigPreviewState = signal<'idle' | 'loading' | 'error'>('idle');
  private readonly sendDialog = viewChild<ElementRef<HTMLElement>>('sendDialog');
  private lastFocus: HTMLElement | null = null;
  private sentEmitted = false;
  private loadSub: Subscription | null = null;

  // ----- derived -----
  protected readonly readingFields = computed(() => this.options()?.readings ?? []);
  protected readonly maxItems = computed(() => this.options()?.max_items ?? 10);
  protected readonly perPage = computed(() => this.options()?.rows_per_page ?? 5);
  protected readonly maxRepeats = computed(() => this.options()?.max_repeats ?? 11);
  protected readonly limits = computed(() => this.options()?.limits ?? DEFAULT_LIMITS);
  protected readonly routes = computed(() => this.options()?.routes ?? []);
  protected readonly askPregnancy = computed(() => this.summary()?.ask_pregnancy ?? false);
  /** Pregnancy does not apply to a male patient: the question is shown as "Not applicable". */
  protected readonly isMale = computed(() =>
    ['male', 'm', 'man'].includes((this.summary()?.patient.gender ?? '').trim().toLowerCase()),
  );
  /** The clinical summary loaded and says there is no date of birth on file. */
  protected readonly dobMissing = computed(() => {
    const s = this.summary();
    return !!s && !s.patient.date_of_birth;
  });
  protected readonly locked = computed(() => {
    const s = this.rx()?.status;
    return !!s && s !== 'draft';
  });
  protected readonly sourceOptions = computed(() => {
    const map = this.options()?.reading_sources ?? RX_SOURCE_LABELS;
    return (Object.keys(map) as ReadingSource[]).map((value) => ({ value, label: map[value] }));
  });
  protected readonly pregnancyOptions = computed(() => {
    const map = this.options()?.pregnancy ?? RX_PREGNANCY_LABELS;
    const ask = this.askPregnancy();
    return (Object.keys(map) as PregnancyStatus[])
      .filter((value) => !(ask && value === 'not_applicable'))
      .map((value) => ({ value, label: map[value] }));
  });
  protected readonly followUpModes = computed(() => {
    const map = this.options()?.follow_up_modes ?? RX_FOLLOW_UP_LABELS;
    return (Object.keys(map) as FollowUpMode[]).map((value) => ({ value, label: map[value] }));
  });
  private readonly formJson = computed(() => JSON.stringify(this.buildForm().form));
  /**
   * Edits not saved yet. Never true while loading or after a failed load: the
   * form was never shown, so there is nothing to lose (and the leave / close
   * prompts must not fire for it).
   */
  protected readonly dirty = computed(
    () =>
      !this.loading() &&
      !this.loadError() &&
      !this.locked() &&
      (this.formJson() !== this.savedJson() || this.draftDirty()),
  );
  protected readonly pageHint = computed(() => {
    const n = this.rows().length;
    const per = this.perPage();
    if (n <= per) return `Prints on one page (up to ${per} medicines).`;
    return `Medicines ${per + 1}–${n} print on an extra page — Page 2 of 2`;
  });
  protected readonly repeatsConflict = computed(
    () => this.allowsRepeats() === false && this.rows().some((r) => toRepeats(r.repeats) > 0),
  );
  protected readonly showMdcn = computed(() => {
    const o = this.options();
    return !!o && !o.mdcn_number && !this.mdcnDismissed() && !this.locked();
  });
  protected readonly infoBodyClass = computed(() => {
    if (this.infoOpen()) return 'mt-3 block';
    return this.compact() ? 'hidden' : 'hidden @4xl:block';
  });

  constructor() {
    effect(() => {
      this.patientId();
      const id = this.prescriptionId();
      untracked(() => {
        // Our own first save already shows this draft — don't reload over edits.
        if (id && this.rx()?.id === id) return;
        this.load(id);
      });
    });
    // "Not applicable" is not an answer for a patient who must be asked (a
    // woman aged 12–55). It can already be set — chosen before the patient
    // information loaded, or restored from a draft / replacement — and once
    // the option is hidden the box would read "Choose an answer" while still
    // holding it. Clear it and ask for a real answer.
    effect(() => {
      if (!this.askPregnancy() || this.pregnancy() !== 'not_applicable') return;
      untracked(() => {
        if (this.locked()) return;
        this.pregnancy.set('');
        this.fieldErrors.update((e) => ({
          ...e,
          pregnancy_status: 'Answer the pregnant or breastfeeding question for this patient',
        }));
      });
    });
    this.destroyRef.onDestroy(() => this.loadSub?.unsubscribe());
  }

  /** True when there are edits that have not been saved yet. */
  hasUnsavedChanges(): boolean {
    return this.dirty();
  }

  // ----- loading -----

  protected retry(): void {
    this.load(this.prescriptionId());
  }

  private load(id: string | null): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    const known = this.options();
    const options$ = known
      ? of(known)
      : this.api.prescriptionOptions().pipe(map((r) => r.data));
    const rx$ = id ? this.api.getPrescription(id).pipe(map((r) => r.data)) : of(null);
    this.loadSub = forkJoin([options$, rx$]).subscribe({
      next: ([opts, rx]) => {
        this.options.set(opts);
        this.hydrate(opts, rx);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loadError.set(
          apiErrorMessage(
            err,
            id ? 'Could not load this prescription.' : 'Could not load the prescription form.',
          ),
        );
        this.loading.set(false);
      },
    });
  }

  private hydrate(opts: PrescriptionOptionsDto, rx: PrescriptionDto | null): void {
    this.rx.set(rx);
    this.sentEmitted = false;
    const r: PrescriptionReadings = rx?.readings ?? {};
    const readings: Partial<Record<ReadingKey, string>> = {};
    for (const f of opts.readings) {
      const v = r[f.key];
      if (v !== undefined && v !== null && String(v) !== '') readings[f.key] = String(v);
    }
    this.readings.set(readings);
    this.bmiAuto.set(
      !readings.bmi || readings.bmi === this.computeBmi(readings.weight, readings.height),
    );
    this.readingSource.set(r.source ?? '');
    this.takenAt.set(isoToLocalInput(r.taken_at));
    this.reason.set(rx?.reason ?? '');
    this.icd.set(rx?.icd_code ?? '');
    this.currentMeds.set(rx?.current_medications ?? '');
    this.pregnancy.set(rx?.pregnancy_status ?? '');
    const rows = rx ? rx.items.map((it) => this.rowFrom(it)) : [];
    this.rows.set(rows);
    this.editingKey.set(null);
    this.clearRemoved();
    this.draft.set(rows.length === 0 && (!rx || rx.status === 'draft') ? this.emptyRow() : null);
    this.advice.set(rx?.advice ?? '');
    this.followUpDate.set(rx?.follow_up_date ?? '');
    this.followUpMode.set(rx?.follow_up_mode ?? '');
    this.tests.set(rx?.tests_referrals ?? '');
    this.validUntil.set(rx?.valid_until ?? opts.default_valid_until ?? '');
    this.allowsRepeats.set(rx ? rx.allows_repeats : null);
    this.fieldErrors.set({});
    this.formError.set('');
    this.patientError.set('');
    this.blockedUrl.set(null);
    this.notice.set('');
    this.savedJson.set(JSON.stringify(this.buildForm().form));
  }

  private emptyRow(): RowState {
    return {
      key: ++this.rowSeq,
      rxcui: null,
      name: '',
      generic_name: '',
      branded: false,
      dose_form: null,
      query: '',
      dose: '',
      route: '',
      frequency: '',
      duration: '',
      quantity: '',
      repeats: '0',
      no_substitute: false,
      instructions: '',
    };
  }

  private rowFrom(it: PrescriptionItem): RowState {
    return {
      key: ++this.rowSeq,
      rxcui: it.rxcui,
      name: it.name ?? '',
      generic_name: it.generic_name ?? '',
      branded: !!it.branded,
      dose_form: it.dose_form ?? null,
      query: '',
      dose: it.dose ?? '',
      route: it.route ?? '',
      frequency: it.frequency ?? '',
      duration: it.duration ?? '',
      quantity: it.quantity ?? '',
      repeats: String(it.repeats ?? 0),
      no_substitute: !!it.no_substitute,
      instructions: it.instructions ?? '',
    };
  }

  // ----- template helpers -----

  protected id(suffix: string): string {
    return `${this.uid}-${suffix}`;
  }

  /** The field error for a key (`reason`, `readings.weight`, `row:3.dose`, …). */
  protected fe(key: string): string {
    return this.fieldErrors()[key] ?? '';
  }

  /** Border classes for a field — red when it has an error. */
  protected fc(key: string): string {
    return this.fe(key) ? RX_BAD : RX_OK;
  }

  protected sendFieldError(key: string): string {
    return this.sendFields()[key] ?? '';
  }

  protected counterClass(value: string, limit: number): string {
    return value.length >= limit ? 'text-alert' : value.length >= limit * 0.9 ? 'text-ink' : 'text-slate';
  }

  protected reading(key: ReadingKey): string {
    return this.readings()[key] ?? '';
  }

  protected readingLabel(f: PrescriptionReadingField): string {
    return f.unit ? `${f.label} (${f.unit})` : f.label;
  }

  protected readingPlaceholder(f: PrescriptionReadingField): string {
    if (f.key === 'blood_pressure') return '120/80';
    if (f.min !== null && f.max !== null) return `${f.min}–${f.max}`;
    return '';
  }

  // ----- edits -----

  private clearErr(...keys: string[]): void {
    const cur = this.fieldErrors();
    if (!keys.some((k) => k in cur)) return;
    const next = { ...cur };
    for (const k of keys) delete next[k];
    this.fieldErrors.set(next);
  }

  private touched(): void {
    if (this.notice()) this.notice.set('');
  }

  protected setReading(key: ReadingKey, value: string): void {
    this.touched();
    const next = { ...this.readings(), [key]: value };
    if (key === 'bmi') {
      this.bmiAuto.set(value.trim() === '');
    } else if ((key === 'weight' || key === 'height') && this.bmiAuto()) {
      next.bmi = this.computeBmi(next.weight, next.height);
      this.clearErr('readings.bmi');
    }
    this.readings.set(next);
    this.clearErr(`readings.${key}`);
  }

  private computeBmi(weight?: string, height?: string): string {
    const w = Number((weight ?? '').trim());
    const h = Number((height ?? '').trim());
    if (!weight?.trim() || !height?.trim() || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return '';
    }
    const unit = this.readingFields().find((f) => f.key === 'height')?.unit ?? 'cm';
    const metres = unit === 'm' ? h : h / 100;
    const bmi = Math.round((w / (metres * metres)) * 10) / 10;
    return Number.isFinite(bmi) && bmi > 0 && bmi < 1000 ? String(bmi) : '';
  }

  protected setSource(value: string): void {
    this.touched();
    this.readingSource.set(value as ReadingSource | '');
    this.clearErr('readings.source');
  }

  protected setTakenAt(value: string): void {
    this.touched();
    this.takenAt.set(value);
    this.clearErr('readings.taken_at');
  }

  protected setText(
    key: 'reason' | 'icd_code' | 'current_medications' | 'advice' | 'tests_referrals' | 'valid_until',
    value: string,
  ): void {
    this.touched();
    const target = {
      reason: this.reason,
      icd_code: this.icd,
      current_medications: this.currentMeds,
      advice: this.advice,
      tests_referrals: this.tests,
      valid_until: this.validUntil,
    }[key];
    target.set(value);
    this.clearErr(key);
  }

  protected setPregnancy(value: string): void {
    this.touched();
    this.pregnancy.set(value as PregnancyStatus | '');
    this.clearErr('pregnancy_status');
  }

  protected setFollowUpDate(value: string): void {
    this.touched();
    this.followUpDate.set(value);
    if (!value) this.followUpMode.set('');
    this.clearErr('follow_up_date', 'follow_up_mode');
  }

  protected setFollowUpMode(value: FollowUpMode): void {
    this.touched();
    this.followUpMode.set(value);
    this.clearErr('follow_up_mode');
  }

  protected setAllowsRepeats(value: boolean): void {
    this.touched();
    this.allowsRepeats.set(value);
    this.clearErr('allows_repeats');
  }

  private patchRow(key: number, patch: Partial<RowState>): void {
    this.rows.update((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /** A short, readable line for a listed medicine. */
  protected rowSummary(r: RowState): string {
    const reps = toRepeats(r.repeats);
    return [
      r.dose.trim(),
      r.route,
      r.frequency.trim(),
      r.duration.trim(),
      r.quantity.trim() ? 'Give ' + r.quantity.trim() : '',
      reps > 0 ? reps + (reps === 1 ? ' repeat' : ' repeats') : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** The messages for one listed medicine (shown on the list until it is fixed). */
  protected rowErrors(key: number): string[] {
    const prefix = `row:${key}.`;
    return Object.entries(this.fieldErrors())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, m]) => m);
  }

  private clearRowErrors(key: number): void {
    const prefix = `row:${key}.`;
    const cur = this.fieldErrors();
    if (Object.keys(cur).some((k) => k.startsWith(prefix))) {
      this.fieldErrors.set(Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith(prefix))));
    }
  }

  private patchDraft(patch: Partial<RowState>): void {
    this.draft.update((d) => (d ? { ...d, ...patch } : d));
  }

  protected setDraft(field: RowField, value: string | boolean): void {
    const d = this.draft();
    if (!d) return;
    this.touched();
    this.patchDraft({ [field]: value } as Partial<RowState>);
    this.clearErr(`row:${d.key}.${field}`, 'items');
    if (field === 'repeats') this.clearErr('allows_repeats');
  }

  protected setDraftQuery(query: string): void {
    this.patchDraft({ query });
  }

  protected pickDraftDrug(drug: DrugDto): void {
    const d = this.draft();
    if (!d) return;
    this.touched();
    const route = this.matchRoute(drug.route);
    this.patchDraft({
      rxcui: drug.rxcui,
      name: drug.name,
      generic_name: drug.generic_name,
      branded: drug.branded,
      dose_form: drug.dose_form,
      query: '',
      ...(route ? { route } : {}),
    });
    this.clearErr(`row:${d.key}.rxcui`, `row:${d.key}.route`, 'items');
  }

  protected clearDraftDrug(): void {
    this.touched();
    this.patchDraft({ rxcui: null, name: '', generic_name: '', branded: false, dose_form: null, query: '' });
  }

  private matchRoute(route: string | null): string {
    if (!route) return '';
    const list = this.routes();
    return list.find((r) => r.toLowerCase() === route.toLowerCase()) ?? '';
  }

  /** Open the form for a new medicine. */
  protected startAdd(): void {
    if (this.rows().length >= this.maxItems() || this.locked()) return;
    this.discardDraftErrors();
    this.editingKey.set(null);
    this.draft.set(this.emptyRow());
    this.afterRender(() => document.getElementById(this.id('ed-drug'))?.focus());
  }

  /**
   * Open the form on a listed medicine. The form works on a copy with its own
   * key, so what happens there (new errors, Cancel) never touches the listed
   * row — whose own errors are shown in the form while it is edited.
   */
  protected startEdit(key: number): void {
    const row = this.rows().find((r) => r.key === key);
    if (!row || this.locked() || this.draftDirty()) return;
    this.discardDraftErrors();
    const copy: RowState = { ...row, key: ++this.rowSeq, query: '' };
    const prefix = `row:${key}.`;
    const carried = Object.fromEntries(
      Object.entries(this.fieldErrors())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, m]) => [`row:${copy.key}.${k.slice(prefix.length)}`, m]),
    );
    if (Object.keys(carried).length > 0) this.fieldErrors.update((e) => ({ ...e, ...carried }));
    this.editingKey.set(key);
    this.draft.set(copy);
    this.afterRender(() => {
      const el = document.getElementById(this.id(row.rxcui ? 'ed-dose' : 'ed-drug'));
      el?.scrollIntoView({ block: 'nearest' });
      el?.focus({ preventScroll: true });
    });
  }

  /** Close the form without changing the list (with no medicines yet, just empty it). */
  protected cancelDraft(): void {
    this.discardDraftErrors();
    this.editingKey.set(null);
    this.draft.set(this.rows().length === 0 && !this.locked() ? this.emptyRow() : null);
  }

  /** The form's own errors go with it (a listed row keeps its own). */
  private discardDraftErrors(): void {
    const d = this.draft();
    if (d) this.clearRowErrors(d.key);
  }

  /** What the form's medicine still needs before it can go on the list. */
  private draftErrors(d: RowState): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!d.rxcui) errs[`row:${d.key}.rxcui`] = 'Choose the medicine from the list';
    const labels: [keyof RowState, string][] = [
      ['dose', 'Enter how much to take'],
      ['route', 'Choose how to take it'],
      ['frequency', 'Enter how often'],
      ['duration', 'Enter for how long'],
      ['quantity', 'Enter the quantity to give'],
    ];
    for (const [field, msg] of labels) {
      if (String(d[field]).trim() === '') errs[`row:${d.key}.${field}`] = msg;
    }
    const reps = Number(d.repeats === '' ? 0 : d.repeats);
    if (!Number.isInteger(reps) || reps < 0 || reps > this.maxRepeats()) {
      errs[`row:${d.key}.repeats`] = `Repeats must be a whole number from 0 to ${this.maxRepeats()}`;
    }
    if (d.instructions.length > this.limits().instructions) {
      errs[`row:${d.key}.instructions`] = `Keep the instructions to ${this.limits().instructions} characters`;
    }
    return errs;
  }

  /** Put the form's medicine on the list (or update the one being edited). */
  protected commitDraft(moveFocus = true): boolean {
    const d = this.draft();
    if (!d || this.locked()) return false;
    const key = this.editingKey();
    if (key === null && this.rows().length >= this.maxItems()) {
      this.fieldErrors.update((e) => ({ ...e, items: `A prescription can hold up to ${this.maxItems()} medicines` }));
      return false;
    }
    this.clearRowErrors(d.key);
    const errs = this.draftErrors(d);
    if (Object.keys(errs).length > 0) {
      this.fieldErrors.update((e) => ({ ...e, ...errs }));
      this.scrollToFirstError();
      return false;
    }
    this.touched();
    // An edited medicine keeps its place (and key) on the list.
    const row: RowState = { ...d, key: key ?? d.key, query: '', repeats: String(toRepeats(d.repeats)) };
    this.rows.update((list) => (key === null ? [...list, row] : list.map((r) => (r.key === key ? row : r))));
    if (key !== null) this.clearRowErrors(key);
    this.clearErr('items');
    this.editingKey.set(null);
    this.draft.set(null);
    if (moveFocus) {
      // "Add another medicine" — or, once the list is full, that medicine's Edit.
      const index = this.rows().findIndex((r) => r.key === row.key);
      this.afterRender(() => {
        const add = document.getElementById(this.id('ed-add'))?.querySelector('button');
        if (add && !add.disabled) add.focus();
        else this.host.nativeElement.querySelector<HTMLElement>(`button[aria-label="Edit medicine ${index + 1}"]`)?.focus();
      });
    }
    return true;
  }

  /**
   * Before save / preview / send: a complete medicine left in the form goes on
   * the list. Returns false when the form holds an incomplete one (its errors
   * are shown) — only send insists on that.
   */
  private flushDraft(showErrors: boolean): boolean {
    if (!this.draftDirty()) return true;
    const d = this.draft();
    if (!d) return true;
    if (Object.keys(this.draftErrors(d)).length === 0) return this.commitDraft(false);
    if (showErrors) this.commitDraft();
    return false;
  }

  protected removeRow(key: number): void {
    if (this.locked()) return;
    const list = this.rows();
    const index = list.findIndex((r) => r.key === key);
    if (index < 0) return;
    this.touched();
    this.rows.set(list.filter((r) => r.key !== key));
    this.clearRowErrors(key);
    if (this.editingKey() === key) {
      this.editingKey.set(null);
      this.draft.set(null);
    }
    this.clearRemoved();
    this.removed.set({ row: list[index], index });
    this.removedTimer = setTimeout(() => this.removed.set(null), 8000);
    if (this.rows().length === 0 && !this.draft()) this.draft.set(this.emptyRow());
    this.afterRender(() => document.getElementById(this.id('undo'))?.focus());
  }

  protected undoRemove(): void {
    const r = this.removed();
    if (!r || this.locked() || !this.canUndo()) return;
    this.touched();
    this.rows.update((list) => {
      const next = [...list];
      next.splice(Math.min(r.index, next.length), 0, r.row);
      return next;
    });
    this.clearRemoved();
    // An empty "Add a medicine" form opened by the removal is no longer needed.
    if (this.editingKey() === null && !this.draftDirty()) this.draft.set(null);
  }

  private clearRemoved(): void {
    if (this.removedTimer) clearTimeout(this.removedTimer);
    this.removedTimer = null;
    this.removed.set(null);
  }

  /** The clinical summary arrived; a male patient's "Not applicable" is not an edit. */
  protected onSummary(s: ClinicalSummaryDto): void {
    const pristine = !this.dirty();
    this.summary.set(s);
    // Only when nothing real changes: a stored answer other than "not applicable"
    // for a male patient stays an unsaved change, so save / preview correct it.
    const stored = this.pregnancy();
    const cosmetic = !this.isMale() || stored === '' || stored === 'not_applicable';
    if (pristine && cosmetic && !this.locked() && !this.loading()) this.savedJson.set(this.formJson());
  }

  // ----- payload -----

  private buildForm(): { form: PrescriptionFormInput; rowKeys: number[] } {
    const readings: PrescriptionReadings = {};
    const values = this.readings();
    for (const f of this.readingFields()) {
      const v = (values[f.key] ?? '').trim();
      if (v !== '') readings[f.key] = v;
    }
    const source = this.readingSource();
    if (source) readings.source = source;
    const taken = this.takenAt();
    if (taken) readings.taken_at = localInputToIso(taken);

    const filled = this.rows().filter(isFilled);
    const followUpDate = this.followUpDate();
    const allows = this.allowsRepeats();
    const form: PrescriptionFormInput = {
      readings,
      reason: nullIfBlank(this.reason()),
      icd_code: nullIfBlank(this.icd()),
      current_medications: nullIfBlank(this.currentMeds()),
      pregnancy_status: this.isMale() ? 'not_applicable' : this.pregnancy() || null,
      items: filled.map((r) => ({
        rxcui: r.rxcui,
        dose: r.dose.trim(),
        route: r.route,
        frequency: r.frequency.trim(),
        duration: r.duration.trim(),
        quantity: r.quantity.trim(),
        repeats: toRepeats(r.repeats),
        no_substitute: r.no_substitute,
        instructions: r.instructions.trim(),
      })),
      advice: nullIfBlank(this.advice()),
      follow_up_date: followUpDate || null,
      follow_up_mode: followUpDate ? this.followUpMode() || null : null,
      tests_referrals: nullIfBlank(this.tests()),
      valid_until: this.validUntil() || null,
      ...(allows === null ? {} : { allows_repeats: allows }),
    };
    return { form, rowKeys: filled.map((r) => r.key) };
  }

  private createInput(form: PrescriptionFormInput): CreatePrescriptionInput {
    const appointmentId = this.appointmentId();
    return appointmentId
      ? { ...form, appointment_id: appointmentId }
      : { ...form, patient_id: this.patientId() };
  }

  /** Create the draft (first time) or save the whole form; emits `saved`. */
  private persist(): Observable<PrescriptionDto> {
    const { form, rowKeys } = this.buildForm();
    this.lastRowKeys = rowKeys;
    const json = JSON.stringify(form);
    const current = this.rx();
    const req$ = current
      ? this.api.updatePrescription(current.id, form)
      : this.api.createPrescription(this.createInput(form));
    return req$.pipe(
      map((res) => {
        this.rx.set(res.data);
        this.savedJson.set(json);
        this.saved.emit(res.data);
        return res.data;
      }),
    );
  }

  /** Map API field errors onto the form (`items.N.*` → the Nth filled row). */
  private mapErrors(fields: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [raw, msg] of Object.entries(fields)) {
      const key = raw.replace(/^form\./, '');
      const m = /^items\.(\d+)(?:\.(\w+))?$/.exec(key);
      if (m) {
        const rowKey = this.lastRowKeys[Number(m[1])];
        if (rowKey === undefined) {
          out['items'] = out['items'] ?? msg;
        } else {
          out[`row:${rowKey}.${m[2] ?? 'rxcui'}`] = msg;
        }
        continue;
      }
      out[key] = msg;
    }
    return out;
  }

  /**
   * Show an API error on the form: box errors next to their boxes, the
   * patient's-record error (`patient`) in its own banner by the Send button,
   * and errors that are not about a box (`appointment_id`, `patient_id` — e.g.
   * "this consultation was cancelled") as the message itself, never hidden
   * behind "check the highlighted boxes".
   */
  private showFormError(err: unknown, fallback: string): void {
    const general: string[] = [];
    const boxes: Record<string, string> = {};
    let patientMsg = '';
    for (const [raw, msg] of Object.entries(apiErrorFields(err))) {
      const key = raw.replace(/^form\./, '');
      if (isPatientKey(key)) patientMsg ||= msg;
      else if (GENERAL_ERROR_KEYS.includes(key)) general.push(msg);
      else boxes[raw] = msg;
    }
    if (patientMsg) this.patientError.set(patientMsg);
    const count = Object.keys(boxes).length;
    if (count > 0) {
      this.fieldErrors.set(this.mapErrors(boxes));
      this.scrollToFirstError();
      const more = count > 1 ? ` (and ${count - 1} more)` : '';
      const first = Object.values(boxes)[0];
      this.formError.set([...general, `Check the highlighted boxes — ${first}${more}`].join(' '));
      return;
    }
    if (general.length > 0) {
      this.formError.set(general.join(' '));
      return;
    }
    // Only the patient banner applies — it already says what to do.
    this.formError.set(patientMsg ? '' : apiErrorMessage(err, fallback));
  }

  /** Run after the next render (the app coalesces change detection to animation frames). */
  private afterRender(fn: () => void): void {
    afterNextRender(fn, { injector: this.injector });
  }

  private scrollToFirstError(): void {
    this.afterRender(() => {
      const el = this.host.nativeElement.querySelector<HTMLElement>(
        '[aria-invalid="true"], [data-rx-error]',
      );
      if (!el) return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      if (el.matches('input, select, textarea')) el.focus({ preventScroll: true });
    });
  }

  // ----- actions -----

  protected saveDraft(): void {
    if (this.busy() || this.locked() || this.disabled()) return;
    // A complete medicine left in the form is saved with the rest; an incomplete
    // one stays in the form (still counted as unsaved).
    this.flushDraft(false);
    this.formError.set('');
    this.notice.set('');
    this.busy.set('save');
    this.persist()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set('');
          this.notice.set('Draft saved.');
        },
        error: (err: unknown) => {
          this.busy.set('');
          this.showFormError(err, 'Could not save the draft. Please try again.');
        },
      });
  }

  /** Save first (if needed), then open the DRAFT-watermarked PDF in a new tab. */
  protected preview(): void {
    if (this.busy() || this.locked() || this.disabled()) return;
    this.flushDraft(false);
    this.formError.set('');
    this.notice.set('');
    this.blockedUrl.set(null);
    const current = this.rx();
    const needsSave = !current || this.dirty();
    this.busy.set('preview');
    const link$ = (needsSave || !current ? this.persist() : of(current)).pipe(
      switchMap((rx) => this.api.prescriptionLink(rx.id)),
      map((r) => r.data),
      takeUntilDestroyed(this.destroyRef),
    );
    this.files.open(
      link$,
      (err) => {
        this.busy.set('');
        this.showFormError(err, 'Could not open the preview. Please try again.');
      },
      () => this.busy.set(''),
      this.openOptions(),
    );
  }

  /** In a call a blocked tab must never take over this page — offer a link instead. */
  private openOptions(): RxOpenOptions {
    return {
      allowSameTab: !this.inCall(),
      onBlocked: (url) => this.blockedUrl.set(url),
    };
  }

  /** The sent PDF (from the success screen or a locked composer). */
  protected viewPdf(): void {
    const current = this.rx();
    if (!current || this.busy() || this.disabled()) return;
    this.busy.set('pdf');
    this.sendError.set('');
    this.blockedUrl.set(null);
    this.files.view(
      current.id,
      (err) => {
        this.busy.set('');
        const msg = apiErrorMessage(err, 'Could not open the PDF. Please try again.');
        if (this.sendOpen()) this.sendError.set(msg);
        else this.formError.set(msg);
      },
      () => this.busy.set(''),
      this.openOptions(),
    );
  }

  protected requestClose(): void {
    if (this.busy()) return;
    if (this.dirty()) this.confirmClose.set(true);
    else this.closed.emit();
  }

  protected onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  // ----- send -----

  /** What the API will insist on before sending — checked here first so it shows inline. */
  private clientSendErrors(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!this.reason().trim()) errs['reason'] = 'Enter the reason for the prescription';
    // "Not applicable" is no answer for a patient who must be asked.
    const preg = this.pregnancy();
    if (this.askPregnancy() && (!preg || preg === 'not_applicable')) {
      errs['pregnancy_status'] = 'Answer the pregnant or breastfeeding question';
    }
    const rows = this.rows();
    const filled = rows.filter(isFilled);
    for (const r of rows) {
      if (!r.rxcui && r.query.trim() !== '') errs[`row:${r.key}.rxcui`] = 'Choose the medicine from the list';
    }
    if (filled.length === 0 && !rows.some((r) => r.query.trim() !== '')) {
      errs['items'] = 'Add at least one medicine';
    }
    const labels: [keyof RowState, string][] = [
      ['dose', 'Enter how much to take'],
      ['route', 'Choose how to take it'],
      ['frequency', 'Enter how often'],
      ['duration', 'Enter for how long'],
      ['quantity', 'Enter the quantity to give'],
    ];
    for (const r of filled) {
      if (!r.rxcui) errs[`row:${r.key}.rxcui`] ??= 'Choose the medicine from the list';
      for (const [field, msg] of labels) {
        if (String(r[field]).trim() === '') errs[`row:${r.key}.${field}`] = msg;
      }
    }
    if (!this.validUntil()) errs['valid_until'] = 'Enter the date the prescription is valid until';
    if (this.allowsRepeats() === null) {
      errs['allows_repeats'] = 'Answer whether this prescription allows repeats';
    } else if (this.repeatsConflict()) {
      errs['allows_repeats'] =
        'Some medicines have repeats — answer Yes to "Does this prescription allow repeats?", or set repeats to 0';
    }
    if (this.followUpDate() && !this.followUpMode()) {
      errs['follow_up_mode'] = 'Tick Video or In person for the follow-up';
    }
    return errs;
  }

  protected openSend(): void {
    if (this.busy() || this.locked() || this.disabled()) return;
    this.notice.set('');
    if (!this.flushDraft(true)) {
      this.formError.set(
        this.editingKey() === null && this.rows().length >= this.maxItems()
          ? `This prescription already has ${this.maxItems()} medicines — cancel the one in the form (or remove another), then send again.`
          : `Finish the medicine in the form — press ${this.editingKey() === null ? 'Add to prescription' : 'Save changes'} — or cancel it, then send again.`,
      );
      return;
    }
    const errs = this.clientSendErrors();
    if (Object.keys(errs).length > 0) {
      this.fieldErrors.set(errs);
      this.formError.set('Some details are missing. Check the highlighted boxes, then send again.');
      this.scrollToFirstError();
      return;
    }
    this.formError.set('');
    this.checkAllergies.set(false);
    this.checkDoses.set(false);
    this.checkPatient.set(false);
    const hasSaved = !!this.options()?.has_signature;
    this.savedSigAvailable.set(hasSaved);
    this.setSigMode(hasSaved ? 'saved' : 'drawn');
    this.sendError.set('');
    this.sendFields.set({});
    this.sendDone.set(false);
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.sendOpen.set(true);
    if (hasSaved) this.loadSignaturePreview();
    this.afterRender(() => this.focusFirstInDialog());
  }

  private loadSignaturePreview(): void {
    if (this.sigPreview() || this.sigPreviewState() === 'loading') return;
    this.sigPreviewState.set('loading');
    this.api
      .getSignature()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.sigPreview.set(res.data.image);
          this.sigPreviewState.set(res.data.image ? 'idle' : 'error');
          if (!res.data.has_signature) {
            this.savedSigAvailable.set(false);
            if (this.sigMode() !== 'drawn') this.setSigMode('drawn');
          }
        },
        error: () => this.sigPreviewState.set('error'),
      });
  }

  /**
   * Switch between the saved signature and signing by hand. Every switch
   * starts from a blank pad, so a drawing the doctor can no longer see is never
   * sent (or saved over their profile signature).
   */
  protected setSigMode(mode: 'saved' | 'drawn'): void {
    this.sigMode.set(mode);
    this.drawn.set(null);
    this.saveDrawn.set(false);
  }

  protected confirmSend(): void {
    if (this.busy() || this.disabled()) return;
    this.sendError.set('');
    this.sendFields.set({});
    this.patientError.set('');
    if (!this.checkAllergies() || !this.checkDoses() || !this.checkPatient()) {
      this.sendFields.set({ confirm: 'Tick all three checks before you send.' });
      return;
    }
    const mode = this.sigMode();
    const image = this.drawn();
    if (mode === 'drawn' && !image) {
      this.sendFields.set({
        signature: this.savedSigAvailable()
          ? 'Sign in the box, or use your saved signature.'
          : 'Sign in the box before you send.',
      });
      return;
    }
    const { form, rowKeys } = this.buildForm();
    const input: SendPrescriptionInput = {
      form,
      confirm: { allergies: true, doses: true, patient: true },
      signature:
        mode === 'saved'
          ? { mode: 'saved' }
          : { mode: 'drawn', image: image ?? undefined, save: this.saveDrawn() },
    };
    const json = JSON.stringify(form);
    this.busy.set('send');
    const current = this.rx();
    const draft$ = current ? of(current) : this.persist();
    draft$
      .pipe(
        switchMap((rx) => {
          this.lastRowKeys = rowKeys;
          return this.api.sendPrescription(rx.id, input);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (res) => {
          this.busy.set('');
          this.rx.set(res.data);
          this.savedJson.set(json);
          this.sendDone.set(true);
          if (mode === 'drawn' && this.saveDrawn()) {
            this.options.update((o) => (o ? { ...o, has_signature: true } : o));
            this.sigPreview.set(null);
            this.sigPreviewState.set('idle');
          }
          this.afterRender(() => this.focusFirstInDialog());
        },
        error: (err: unknown) => {
          this.busy.set('');
          const fields = apiErrorFields(err);
          // `patient` = the patient's date of birth is not on file. Nothing on
          // the form can fix it, so it gets its own banner (in this dialog and
          // by the Send button) rather than "check the highlighted boxes".
          const patientMsg =
            Object.entries(fields).find(([k]) => isPatientKey(k.replace(/^form\./, '')))?.[1] ?? '';
          this.patientError.set(patientMsg);
          const formKeys = Object.keys(fields).filter(
            (k) => !isDialogKey(k) && !isPatientKey(k.replace(/^form\./, '')),
          );
          if (formKeys.length > 0) {
            this.closeSendDialog();
            this.showFormError(err, 'Complete the prescription before sending.');
            return;
          }
          const dialogFields: Record<string, string> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (isDialogKey(k)) dialogFields[k.split('.')[0]] = v;
          }
          this.sendFields.set(dialogFields);
          // A date-of-birth refusal is already explained by the patient banner.
          this.sendError.set(
            patientMsg && Object.keys(dialogFields).length === 0
              ? ''
              : apiErrorMessage(err, 'Could not send the prescription. Please try again.'),
          );
        },
      });
  }

  protected dismissSend(): void {
    if (this.busy() === 'send') return;
    if (this.sendDone()) {
      this.finishSent();
      return;
    }
    this.closeSendDialog();
  }

  protected finishSent(): void {
    this.closeSendDialog();
    const current = this.rx();
    if (current && !this.sentEmitted) {
      this.sentEmitted = true;
      this.sent.emit(current);
    }
  }

  private closeSendDialog(): void {
    this.sendOpen.set(false);
    const back = this.lastFocus;
    this.lastFocus = null;
    if (back) {
      this.afterRender(() => {
        if (document.contains(back)) back.focus();
      });
    }
  }

  private focusFirstInDialog(): void {
    const root = this.sendDialog()?.nativeElement;
    if (!root) return;
    // Success screen: focus "View PDF"/"Done"; otherwise the first checklist box.
    const inBody = this.sendDone()
      ? null
      : root.querySelector('[data-dialog-body]')?.querySelector<HTMLElement>(FOCUSABLE);
    const footer = Array.from(root.querySelectorAll<HTMLElement>('footer button:not([disabled])'));
    (inBody ?? footer[footer.length - 1] ?? root).focus();
  }

  protected dialogKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.dismissSend();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = this.sendDialog()?.nativeElement;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
