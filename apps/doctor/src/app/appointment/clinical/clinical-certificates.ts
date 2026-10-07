import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
} from '@angular/core';
import type { MedicalCertificateDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { rxDate, rxDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_INPUT,
  CLINICAL_INPUT_ICON,
  CLINICAL_INPUT_WITH_ICON,
  CLINICAL_LABEL,
  CLINICAL_LIST_ITEM,
  CLINICAL_META,
  CLINICAL_RADIO_CARD,
  CLINICAL_TEXTAREA,
  ClinicalBadge,
  ClinicalEmpty,
  ClinicalHeader,
} from './clinical-ui';

type CertificateType = MedicalCertificateDto['type'];

const CERTIFICATE_TYPES: ReadonlyArray<{ readonly key: CertificateType; readonly label: string }> = [
  { key: 'sick_leave', label: 'Sick leave' },
  { key: 'fitness', label: 'Fitness / return to work' },
  { key: 'general', label: 'General' },
];

let nextUid = 0;

/**
 * Clinical tools → Certificates: issue a medical certificate and open / print
 * the ones already issued. Presentational — the host owns the form values
 * (two-way bound), validation, the API call and document opening.
 *
 * Usage:
 * `<doc-clinical-certificates [certificates]="certificates()" [(type)]="certType"
 *    [(diagnosis)]="certDiagnosis" [(from)]="certFrom" [(to)]="certTo" [(statement)]="certStatement"
 *    [busy]="sectionBusy()" [error]="sectionError()" (issue)="issueCertificate()"
 *    (openDocument)="openDoc('certificate', $event)" />`
 */
@Component({
  selector: 'doc-clinical-certificates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, ClinicalBadge, ClinicalEmpty, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header icon="id-card" heading="Medical certificates" helper="Issue a signed certificate the patient can download and print." />

    <section class="${CLINICAL_CARD}" aria-label="New certificate">
      <h3 class="${CLINICAL_H3}"><sd-icon name="plus" [size]="18" class="text-cerulean" />New certificate</h3>

      <fieldset>
        <legend class="mb-2 ${CLINICAL_LABEL}">Certificate type</legend>
        <div class="grid grid-cols-1 gap-2 @xl:grid-cols-3">
          @for (t of types; track t.key) {
            <label class="${CLINICAL_RADIO_CARD}">
              <input
                type="radio"
                class="size-4 shrink-0 accent-cerulean"
                [name]="uid + '-type'"
                [value]="t.key"
                [checked]="type() === t.key"
                (change)="type.set(t.key)"
              />
              {{ t.label }}
            </label>
          }
        </div>
      </fieldset>

      <div class="flex flex-col gap-2">
        <label class="${CLINICAL_LABEL}" [for]="uid + '-diagnosis'">
          Diagnosis <span class="font-normal text-slate">(optional)</span>
        </label>
        <div class="relative">
          <sd-icon name="stethoscope" [size]="18" class="${CLINICAL_INPUT_ICON}" />
          <input
            type="text"
            class="${CLINICAL_INPUT_WITH_ICON}"
            [id]="uid + '-diagnosis'"
            placeholder="e.g. Acute gastroenteritis"
            [value]="diagnosis()"
            (input)="diagnosis.set($any($event.target).value)"
          />
        </div>
      </div>

      @if (type() === 'sick_leave') {
        <fieldset>
          <legend class="mb-2 ${CLINICAL_LABEL}">Leave period <span class="text-alert">*</span></legend>
          <div class="grid grid-cols-1 gap-3 @md:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <label class="font-sans text-caption font-semibold text-slate" [for]="uid + '-from'">From</label>
              <input type="date" class="${CLINICAL_INPUT}" [id]="uid + '-from'" [value]="from()" (input)="from.set($any($event.target).value)" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="font-sans text-caption font-semibold text-slate" [for]="uid + '-to'">To</label>
              <input type="date" class="${CLINICAL_INPUT}" [id]="uid + '-to'" [value]="to()" (input)="to.set($any($event.target).value)" />
            </div>
          </div>
        </fieldset>
      }

      <div class="flex flex-col gap-2">
        <label class="${CLINICAL_LABEL}" [for]="uid + '-statement'">Certifying statement <span class="text-alert">*</span></label>
        <textarea
          rows="4"
          class="${CLINICAL_TEXTAREA}"
          [id]="uid + '-statement'"
          placeholder="What you are certifying, as it should appear on the certificate"
          [value]="statement()"
          (input)="statement.set($any($event.target).value)"
        ></textarea>
      </div>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      <div class="flex border-t border-cloud pt-5 @md:justify-end">
        <sd-button [full]="true" class="w-full @md:w-auto" [disabled]="busy()" (click)="issue.emit()">
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Issuing…
          } @else {
            <sd-icon name="file-check" [size]="18" />Issue certificate
          }
        </sd-button>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-label="Certificates issued">
      <h3 class="${CLINICAL_H3}">
        Issued
        @if (certificates().length > 0) {
          <span class="${CLINICAL_COUNT}">{{ certificates().length }}</span>
        }
      </h3>
      @if (certificates().length === 0) {
        <doc-clinical-empty icon="id-card" message="No certificates issued for this consultation." />
      } @else {
        <ul class="flex flex-col gap-3">
          @for (c of certificates(); track c.id) {
            <li class="flex flex-col gap-4 ${CLINICAL_LIST_ITEM} @2xl:flex-row @2xl:items-start @2xl:justify-between">
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <span class="hidden size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean @md:flex">
                  <sd-icon name="id-card" [size]="18" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-heading text-body font-semibold text-ink">{{ c.type_label }}</span>
                    @if (c.days) {
                      <doc-clinical-badge tone="brand" icon="calendar-days" [label]="c.days + (c.days === 1 ? ' day' : ' days')" />
                    }
                  </div>
                  <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink">{{ c.statement }}</p>
                  @if (c.diagnosis) {
                    <p class="break-words font-sans text-body-sm text-ink"><span class="text-slate">Diagnosis:</span> {{ c.diagnosis }}</p>
                  }
                  <p class="${CLINICAL_META}">
                    <span class="inline-flex items-center gap-1"><sd-icon name="calendar-days" [size]="13" />Issued {{ when(c.created_at) }}</span>
                    @if (c.from_date || c.to_date) {
                      <span class="inline-flex items-center gap-1"><sd-icon name="calendar-clock" [size]="13" />{{ day(c.from_date) }} – {{ day(c.to_date) }}</span>
                    }
                    @if (c.author) {
                      <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ c.author }}</span>
                    }
                  </p>
                </div>
              </div>
              <sd-button variant="secondary" size="sm" [full]="true" class="shrink-0 @md:w-auto" (click)="openDocument.emit(c.id)">
                <sd-icon name="printer" [size]="16" />Open / print
              </sd-button>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ClinicalCertificates {
  readonly certificates = input.required<MedicalCertificateDto[]>();
  readonly busy = input(false);
  readonly error = input('');

  readonly type = model.required<CertificateType>();
  readonly diagnosis = model.required<string>();
  /** Sick-leave start (YYYY-MM-DD). */
  readonly from = model.required<string>();
  /** Sick-leave end (YYYY-MM-DD). */
  readonly to = model.required<string>();
  readonly statement = model.required<string>();

  readonly issue = output<void>();
  /** Open the printable certificate (by certificate id). */
  readonly openDocument = output<string>();

  protected readonly uid = `clinical-certificates-${++nextUid}`;
  protected readonly types = CERTIFICATE_TYPES;

  protected day(value: string | null): string {
    return rxDate(value);
  }

  protected when(iso: string): string {
    return rxDateTime(iso);
  }
}
