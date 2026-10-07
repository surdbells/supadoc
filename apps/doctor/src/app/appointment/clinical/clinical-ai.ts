import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { CopilotDraftDto, TranscriptSegmentDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { rxDateTime, rxShortDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_META,
  ClinicalEmpty,
  ClinicalHeader,
} from './clinical-ui';

type DraftTextKey = 'summary' | 'subjective' | 'objective' | 'assessment' | 'plan' | 'follow_up';
type DraftListKey = 'symptoms' | 'diagnoses' | 'medications';

const DRAFT_TEXT: ReadonlyArray<{ readonly key: DraftTextKey; readonly label: string }> = [
  { key: 'summary', label: 'Summary' },
  { key: 'subjective', label: 'Subjective' },
  { key: 'objective', label: 'Objective' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'plan', label: 'Plan' },
  { key: 'follow_up', label: 'Follow-up' },
];

const DRAFT_LISTS: ReadonlyArray<{ readonly key: DraftListKey; readonly label: string }> = [
  { key: 'symptoms', label: 'Symptoms' },
  { key: 'diagnoses', label: 'Diagnoses' },
  { key: 'medications', label: 'Medications mentioned' },
];

/**
 * Clinical tools → Transcript & AI: the consultation transcript and the AI
 * copilot's draft (clinician review only). Presentational — the host owns the
 * data and the generate call (which needs the patient's AI consent).
 *
 * Usage:
 * `<doc-clinical-ai [transcript]="transcript()" [draft]="copilot()" [busy]="sectionBusy()"
 *    [error]="sectionError()" (generate)="generateCopilot()" />`
 */
@Component({
  selector: 'doc-clinical-ai',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, ClinicalEmpty, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header
      icon="sparkles"
      heading="Transcript & AI copilot"
      helper="Live transcription runs inside the call. The copilot drafts a summary from it for you to review."
    />

    <!-- Transcript -->
    <section class="${CLINICAL_CARD}" aria-label="Transcript">
      <h3 class="${CLINICAL_H3}">
        <sd-icon name="message-square" [size]="18" class="text-cerulean" />Transcript
        @if (transcript().length > 0) {
          <span class="${CLINICAL_COUNT}">{{ transcript().length }}</span>
        }
      </h3>
      @if (transcript().length === 0) {
        <doc-clinical-empty icon="message-square" message="No transcript captured. Live transcription runs inside the call." />
      } @else {
        <ol
          class="-mx-1 flex max-h-[28rem] flex-col gap-3 overflow-y-auto rounded-field px-1 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          tabindex="0"
          aria-label="Transcript lines"
        >
          @for (seg of transcript(); track seg.id) {
            <li class="flex items-start gap-3">
              <span
                class="flex size-9 shrink-0 items-center justify-center rounded-full"
                [class]="seg.role === 'doctor' ? 'bg-frost text-cerulean' : 'bg-sage/15 text-sage'"
                aria-hidden="true"
              >
                <sd-icon [name]="seg.role === 'doctor' ? 'stethoscope' : 'user'" [size]="16" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5 rounded-field bg-glacier/70 px-4 py-2.5">
                <p class="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span class="font-sans text-caption font-semibold" [class]="seg.role === 'doctor' ? 'text-cerulean' : 'text-sage'">{{ seg.role === 'doctor' ? 'Doctor' : 'Patient' }}</span>
                  @if (seg.at) {
                    <span class="font-sans text-[11px] text-slate">{{ short(seg.at) }}</span>
                  }
                </p>
                <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink">{{ seg.text }}</p>
              </div>
            </li>
          }
        </ol>
      }
    </section>

    <!-- AI copilot draft -->
    <section class="${CLINICAL_CARD}" aria-label="AI copilot draft" aria-live="polite">
      <div class="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
        <h3 class="${CLINICAL_H3}"><sd-icon name="sparkles" [size]="18" class="text-cerulean" />AI copilot draft</h3>
        <sd-button variant="secondary" size="sm" [full]="true" class="w-full @md:w-auto" [disabled]="busy()" (click)="generate.emit()">
          @if (busy()) {
            <sd-icon name="loader-circle" [size]="16" class="motion-safe:animate-spin" />Generating…
          } @else {
            <sd-icon name="sparkles" [size]="16" />{{ draft() ? 'Generate again' : 'Generate' }}
          }
        </sd-button>
      </div>

      @if (error()) {
        <sd-alert tone="error">{{ error() }}</sd-alert>
      }

      @if (draft(); as d) {
        <sd-alert tone="warning">AI-generated — review before use.</sd-alert>
        <p class="${CLINICAL_META}">
          <span class="inline-flex items-center gap-1"><sd-icon name="clock" [size]="13" />Generated {{ when(d.generated_at) }}</span>
          @if (d.generated_by) {
            <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ d.generated_by }}</span>
          }
        </p>
        @if (hasDraftContent()) {
          <dl class="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
            @for (f of textFields; track f.key) {
              @if (d[f.key]) {
                <div class="flex flex-col gap-1 rounded-field bg-glacier/70 p-4" [class]="f.key === 'summary' ? '@2xl:col-span-2' : ''">
                  <dt class="font-sans text-caption font-semibold text-slate">{{ f.label }}</dt>
                  <dd class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink">{{ d[f.key] }}</dd>
                </div>
              }
            }
            @for (l of listFields; track l.key) {
              @if (listItems(d, l.key).length > 0) {
                <div class="flex flex-col gap-2 rounded-field bg-glacier/70 p-4">
                  <dt class="font-sans text-caption font-semibold text-slate">{{ l.label }}</dt>
                  <dd>
                    <ul class="flex flex-wrap gap-2">
                      @for (item of listItems(d, l.key); track $index) {
                        <li class="rounded-pill bg-white px-3 py-1 font-sans text-caption font-medium text-ink ring-1 ring-inset ring-cloud">{{ item }}</li>
                      }
                    </ul>
                  </dd>
                </div>
              }
            }
          </dl>
        } @else {
          <p class="font-sans text-body-sm text-slate">This draft is empty.</p>
        }
      } @else {
        <doc-clinical-empty icon="sparkles" message="No draft yet." />
      }
    </section>
  `,
})
export class ClinicalAi {
  readonly transcript = input.required<TranscriptSegmentDto[]>();
  readonly draft = input<CopilotDraftDto | null>(null);
  readonly busy = input(false);
  readonly error = input('');

  readonly generate = output<void>();

  protected readonly textFields = DRAFT_TEXT;
  protected readonly listFields = DRAFT_LISTS;
  protected readonly hasDraftContent = computed(() => {
    const d = this.draft();
    if (!d) return false;
    return DRAFT_TEXT.some((f) => !!d[f.key]) || DRAFT_LISTS.some((l) => this.listItems(d, l.key).length > 0);
  });

  protected listItems(draft: CopilotDraftDto, key: DraftListKey): readonly string[] {
    return draft[key] ?? [];
  }

  protected when(iso: string): string {
    return rxDateTime(iso);
  }

  protected short(iso: string): string {
    return rxShortDateTime(iso);
  }
}
