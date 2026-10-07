import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { ClinicalNoteAmendment, ClinicalNoteDto } from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  EmptyStateComponent,
  IconComponent,
} from '@supadoc/ui';
import { rxDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_HINT,
  CLINICAL_LABEL,
  CLINICAL_META,
  CLINICAL_TEXTAREA,
  ClinicalBadge,
  ClinicalHeader,
} from './clinical-ui';

export type NoteLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type NoteSaveMode = 'draft' | 'finalize';
type SoapKey = 'subjective' | 'objective' | 'assessment' | 'plan';

const SOAP_FIELDS: ReadonlyArray<{ readonly key: SoapKey; readonly label: string; readonly hint: string }> = [
  { key: 'subjective', label: 'Subjective', hint: "Symptoms and history in the patient's own words." },
  { key: 'objective', label: 'Objective', hint: 'What you observed or measured during the visit.' },
  { key: 'assessment', label: 'Assessment', hint: 'Your impression or working diagnosis.' },
  { key: 'plan', label: 'Plan', hint: 'Treatment, advice and follow-up.' },
];

let nextUid = 0;

/**
 * Clinical tools → Clinical note: the SOAP editor (save draft / finalize &
 * sign), a read-only view once finalized, and the amendment history. Purely
 * presentational — the host owns loading, the draft values and saving, and
 * only shows Save / Finalize once the saved note has loaded (`state === 'ready'`).
 *
 * Usage:
 * `<doc-clinical-note [state]="noteState()" [note]="note()" [values]="noteValues()"
 *    [loadError]="noteLoadError()" [error]="sectionError()" [saving]="savingNote()"
 *    [savingMode]="noteSaveMode()" (valueChange)="…" (save)="saveNote($event)" (retry)="reloadNote()" />`
 */
@Component({
  selector: 'doc-clinical-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, EmptyStateComponent, IconComponent, ClinicalBadge, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header
      icon="file-text"
      heading="SOAP note"
      helper="Document the consultation. The patient sees the summary once you finalize it."
    >
      @if (state() === 'ready' && note()) {
        @if (finalized()) {
          <doc-clinical-badge tone="success" icon="circle-check" label="Finalized" />
        } @else {
          <doc-clinical-badge tone="draft" icon="pen-line" label="Draft" />
        }
      }
    </doc-clinical-header>

    @switch (state()) {
      @case ('ready') {
        <section class="${CLINICAL_CARD}" aria-label="SOAP note">
          <p class="${CLINICAL_META}">
            @if (finalized()) {
              <span class="inline-flex items-center gap-1"><sd-icon name="signature" [size]="13" />Signed {{ when(note()?.finalized_at) }}</span>
              @if (note()?.author) {
                <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ note()?.author }}</span>
              }
            } @else {
              <span class="inline-flex items-center gap-1">
                <sd-icon name="clock" [size]="13" />{{ note()?.updated_at ? 'Last saved ' + when(note()?.updated_at) : 'Not saved yet' }}
              </span>
            }
          </p>

          @if (finalized()) {
            <!-- Signed + locked: a readable record instead of greyed-out fields. -->
            <dl class="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
              @for (f of fields; track f.key) {
                <div class="flex flex-col gap-1 rounded-field bg-glacier/70 p-4">
                  <dt class="font-sans text-caption font-semibold text-slate">{{ f.label }}</dt>
                  @if (value(f.key)) {
                    <dd class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink">{{ value(f.key) }}</dd>
                  } @else {
                    <dd class="font-sans text-body-sm italic text-slate">Not recorded</dd>
                  }
                </div>
              }
            </dl>
            <sd-alert tone="success">Finalized{{ note()?.author ? ' by ' + note()?.author : '' }} — the patient can now see the summary.</sd-alert>
            @if (error()) {
              <sd-alert tone="error">{{ error() }}</sd-alert>
            }
          } @else {
            @for (f of fields; track f.key) {
              <div class="flex flex-col gap-2">
                <label class="${CLINICAL_LABEL}" [for]="uid + '-' + f.key">{{ f.label }}</label>
                <textarea
                  rows="4"
                  class="${CLINICAL_TEXTAREA}"
                  [id]="uid + '-' + f.key"
                  [attr.aria-describedby]="uid + '-' + f.key + '-hint'"
                  [value]="value(f.key)"
                  (input)="valueChange.emit({ key: f.key, value: $any($event.target).value })"
                ></textarea>
                <p class="${CLINICAL_HINT}" [id]="uid + '-' + f.key + '-hint'">{{ f.hint }}</p>
              </div>
            }

            @if (error()) {
              <sd-alert tone="error">{{ error() }}</sd-alert>
            }

            <div class="flex flex-col gap-4 border-t border-cloud pt-5 @2xl:flex-row @2xl:items-center @2xl:justify-between">
              <p class="flex items-start gap-1.5 ${CLINICAL_HINT} @2xl:max-w-xs">
                <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
                Finalizing signs and locks the note, then shares the summary with the patient.
              </p>
              <div class="flex flex-col-reverse gap-3 @md:flex-row">
                <sd-button variant="outline" [full]="true" class="w-full @md:w-auto" [disabled]="saving()" (click)="save.emit(false)">
                  @if (saving() && savingMode() === 'draft') {
                    <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Saving…
                  } @else {
                    <sd-icon name="save" [size]="18" />Save draft
                  }
                </sd-button>
                <sd-button [full]="true" class="w-full @md:w-auto" [disabled]="saving()" (click)="save.emit(true)">
                  @if (saving() && savingMode() === 'finalize') {
                    <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Finalizing…
                  } @else {
                    <sd-icon name="signature" [size]="18" />Finalize &amp; sign
                  }
                </sd-button>
              </div>
            </div>
          }
        </section>

        @if (amendments().length > 0) {
          <section class="${CLINICAL_CARD}" aria-label="Amendment history">
            <h3 class="${CLINICAL_H3}">
              <sd-icon name="history" [size]="18" class="text-cerulean" />Amendment history
              <span class="${CLINICAL_COUNT}">{{ amendments().length }}</span>
            </h3>
            <ol class="flex flex-col divide-y divide-cloud">
              @for (am of amendments(); track $index) {
                <li class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <p class="${CLINICAL_META}">
                    <span class="inline-flex items-center gap-1 font-semibold text-ink"><sd-icon name="pen-line" [size]="13" class="text-slate" />Amended {{ when(am.at) }}</span>
                    <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ am.author }}</span>
                  </p>
                  <details class="group rounded-field border border-cloud">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 rounded-field px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 [&::-webkit-details-marker]:hidden">
                      Previous version
                      <sd-icon name="chevron-down" [size]="16" class="transition-transform group-open:rotate-180" />
                    </summary>
                    <dl class="grid grid-cols-1 gap-3 border-t border-cloud p-4 @2xl:grid-cols-2">
                      @for (f of fields; track f.key) {
                        <div class="flex flex-col gap-0.5">
                          <dt class="font-sans text-caption font-semibold text-slate">{{ f.label }}</dt>
                          <dd class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink">{{ previous(am, f.key) || '—' }}</dd>
                        </div>
                      }
                    </dl>
                  </details>
                </li>
              }
            </ol>
          </section>
        }
      }
      @case ('error') {
        <!-- No editor until the saved note has loaded: a blank one could overwrite it. -->
        <section class="rounded-card border border-cloud bg-white px-4" aria-label="SOAP note">
          <sd-empty-state icon="wifi-off" tone="error" [title]="loadFailedTitle" [message]="loadError()">
            <p class="-mt-2 max-w-md font-sans text-caption text-slate">
              The note stays hidden until it loads, so nothing you type can replace the saved copy.
            </p>
            <sd-button variant="secondary" size="sm" (click)="retry.emit()">
              <sd-icon name="refresh-cw" [size]="16" />Try again
            </sd-button>
          </sd-empty-state>
        </section>
      }
      @default {
        <section class="${CLINICAL_CARD}" aria-busy="true">
          <span class="sr-only">Loading the clinical note…</span>
          <div class="sd-shimmer h-4 w-40 rounded-pill"></div>
          @for (f of fields; track f.key) {
            <div class="flex flex-col gap-2">
              <div class="sd-shimmer h-5 w-28 rounded-pill"></div>
              <div class="sd-shimmer h-24 rounded-field"></div>
            </div>
          }
        </section>
      }
    }
  `,
})
export class ClinicalNote {
  readonly state = input.required<NoteLoadState>();
  readonly note = input<ClinicalNoteDto | null>(null);
  /** The editable SOAP draft, keyed by field. */
  readonly values = input.required<Readonly<Record<string, string>>>();
  readonly loadError = input('');
  /** The section's last save error (real API message). */
  readonly error = input('');
  readonly saving = input(false);
  /** Which button started the in-flight save (for its spinner). */
  readonly savingMode = input<NoteSaveMode | null>(null);

  readonly valueChange = output<{ key: string; value: string }>();
  /** `true` = finalize & sign, `false` = save draft. */
  readonly save = output<boolean>();
  readonly retry = output<void>();

  protected readonly uid = `clinical-note-${++nextUid}`;
  protected readonly fields = SOAP_FIELDS;
  protected readonly loadFailedTitle = 'Could not load the note';
  protected readonly finalized = computed(() => this.note()?.status === 'finalized');
  protected readonly amendments = computed(() => [...(this.note()?.amendments ?? [])].reverse());

  protected value(key: SoapKey): string {
    return this.values()[key] ?? '';
  }

  protected when(iso: string | null | undefined): string {
    return rxDateTime(iso);
  }

  protected previous(amendment: ClinicalNoteAmendment, key: SoapKey): string {
    return amendment.previous?.[key] ?? '';
  }
}
