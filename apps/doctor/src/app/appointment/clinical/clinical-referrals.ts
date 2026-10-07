import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
} from '@angular/core';
import type { ReferralDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { rxDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_INPUT_ICON,
  CLINICAL_INPUT_WITH_ICON,
  CLINICAL_LABEL,
  CLINICAL_LIST_ITEM,
  CLINICAL_META,
  CLINICAL_RADIO_CARD,
  CLINICAL_SEGMENT,
  CLINICAL_SEGMENTED,
  CLINICAL_TEXTAREA,
  ClinicalBadge,
  ClinicalEmpty,
  ClinicalHeader,
  PRIORITY_META,
} from './clinical-ui';

type ReferralType = ReferralDto['referral_type'];
type Priority = 'routine' | 'urgent';

const REFERRAL_TYPES: ReadonlyArray<{ readonly key: ReferralType; readonly label: string }> = [
  { key: 'specialist', label: 'Specialist' },
  { key: 'hospital', label: 'Hospital' },
  { key: 'laboratory', label: 'Laboratory' },
  { key: 'imaging', label: 'Imaging' },
];

let nextUid = 0;

/**
 * Clinical tools → Referrals: raise a referral and open / print the ones
 * already raised. Presentational — the host owns the form values (two-way
 * bound), validation, the API call and document opening.
 *
 * Usage:
 * `<doc-clinical-referrals [referrals]="referrals()" [(type)]="refType" [(priority)]="refPriority"
 *    [(target)]="refTarget" [(reason)]="refReason" [(summary)]="refSummary" [busy]="sectionBusy()"
 *    [error]="sectionError()" (create)="createReferral()" (openDocument)="openDoc('referral', $event)" />`
 */
@Component({
  selector: 'doc-clinical-referrals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, ClinicalBadge, ClinicalEmpty, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header icon="share-2" heading="Referrals" helper="Refer the patient to a specialist, hospital, laboratory or imaging centre." />

    <section class="${CLINICAL_CARD}" aria-label="New referral">
      <h3 class="${CLINICAL_H3}"><sd-icon name="plus" [size]="18" class="text-cerulean" />New referral</h3>

      <fieldset>
        <legend class="mb-2 ${CLINICAL_LABEL}">Referral type</legend>
        <div class="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
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

      <fieldset>
        <legend class="mb-2 ${CLINICAL_LABEL}">Priority</legend>
        <div class="${CLINICAL_SEGMENTED}">
          @for (p of priorities; track p.key) {
            <label class="${CLINICAL_SEGMENT}">
              <input
                type="radio"
                class="sr-only"
                [name]="uid + '-priority'"
                [value]="p.key"
                [checked]="priority() === p.key"
                (change)="priority.set(p.key)"
              />
              <sd-icon [name]="p.icon" [size]="16" />{{ p.label }}
            </label>
          }
        </div>
      </fieldset>

      <div class="grid grid-cols-1 gap-5 @2xl:grid-cols-2">
        <div class="flex flex-col gap-2">
          <label class="${CLINICAL_LABEL}" [for]="uid + '-target'">Refer to <span class="text-alert">*</span></label>
          <div class="relative">
            <sd-icon name="building-2" [size]="18" class="${CLINICAL_INPUT_ICON}" />
            <input
              type="text"
              class="${CLINICAL_INPUT_WITH_ICON}"
              [id]="uid + '-target'"
              placeholder="Name or facility"
              [value]="target()"
              (input)="target.set($any($event.target).value)"
            />
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <label class="${CLINICAL_LABEL}" [for]="uid + '-reason'">Reason for referral <span class="text-alert">*</span></label>
          <div class="relative">
            <sd-icon name="stethoscope" [size]="18" class="${CLINICAL_INPUT_ICON}" />
            <input
              type="text"
              class="${CLINICAL_INPUT_WITH_ICON}"
              [id]="uid + '-reason'"
              placeholder="e.g. Persistent chest pain"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
            />
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <label class="${CLINICAL_LABEL}" [for]="uid + '-summary'">
          Clinical summary <span class="font-normal text-slate">(optional)</span>
        </label>
        <textarea
          rows="3"
          class="${CLINICAL_TEXTAREA}"
          [id]="uid + '-summary'"
          placeholder="Relevant history, findings and what you are asking for"
          [value]="summary()"
          (input)="summary.set($any($event.target).value)"
        ></textarea>
      </div>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      <div class="flex border-t border-cloud pt-5 @md:justify-end">
        <sd-button [full]="true" class="w-full @md:w-auto" [disabled]="busy()" (click)="create.emit()">
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Creating…
          } @else {
            <sd-icon name="share-2" [size]="18" />Create referral
          }
        </sd-button>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-label="Referrals raised">
      <h3 class="${CLINICAL_H3}">
        Raised
        @if (referrals().length > 0) {
          <span class="${CLINICAL_COUNT}">{{ referrals().length }}</span>
        }
      </h3>
      @if (referrals().length === 0) {
        <doc-clinical-empty icon="share-2" message="No referrals yet for this consultation." />
      } @else {
        <ul class="flex flex-col gap-3">
          @for (r of referrals(); track r.id) {
            <li class="flex flex-col gap-4 ${CLINICAL_LIST_ITEM} @2xl:flex-row @2xl:items-start @2xl:justify-between">
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <span class="hidden size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean @md:flex">
                  <sd-icon name="share-2" [size]="18" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-sans text-caption font-semibold text-cerulean">{{ typeLabel(r.referral_type) }}</span>
                    <doc-clinical-badge [tone]="priorityMeta(r.priority).tone" [icon]="priorityMeta(r.priority).icon" [label]="priorityMeta(r.priority).label" />
                  </div>
                  <span class="break-words font-heading text-body font-semibold text-ink">{{ r.target }}</span>
                  <p class="break-words font-sans text-body-sm text-ink">{{ r.reason }}</p>
                  @if (r.clinical_summary) {
                    <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-slate">{{ r.clinical_summary }}</p>
                  }
                  <p class="${CLINICAL_META}">
                    <span class="inline-flex items-center gap-1"><sd-icon name="calendar-days" [size]="13" />{{ when(r.created_at) }}</span>
                    @if (r.author) {
                      <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ r.author }}</span>
                    }
                  </p>
                </div>
              </div>
              <sd-button variant="secondary" size="sm" [full]="true" class="shrink-0 @md:w-auto" (click)="openDocument.emit(r.id)">
                <sd-icon name="printer" [size]="16" />Open / print
              </sd-button>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ClinicalReferrals {
  readonly referrals = input.required<ReferralDto[]>();
  readonly busy = input(false);
  readonly error = input('');

  readonly type = model.required<ReferralType>();
  readonly priority = model.required<Priority>();
  readonly target = model.required<string>();
  readonly reason = model.required<string>();
  readonly summary = model.required<string>();

  readonly create = output<void>();
  /** Open the printable referral letter (by referral id). */
  readonly openDocument = output<string>();

  protected readonly uid = `clinical-referrals-${++nextUid}`;
  protected readonly types = REFERRAL_TYPES;
  protected readonly priorities = (['routine', 'urgent'] as const).map((key) => ({ key, ...PRIORITY_META[key] }));

  protected typeLabel(type: ReferralType): string {
    return REFERRAL_TYPES.find((t) => t.key === type)?.label ?? type;
  }

  protected priorityMeta(p: Priority): (typeof PRIORITY_META)[Priority] {
    return PRIORITY_META[p] ?? PRIORITY_META.routine;
  }

  protected when(iso: string): string {
    return rxDateTime(iso);
  }
}
