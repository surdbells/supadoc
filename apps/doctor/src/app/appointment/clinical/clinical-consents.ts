import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ConsentDto } from '@supadoc/models';
import { EmptyStateComponent, IconComponent } from '@supadoc/ui';
import { rxDateTime } from '../../prescriptions/rx-shared';
import { CLINICAL_META, ClinicalBadge, ClinicalHeader } from './clinical-ui';

const CONSENT_META: Record<ConsentDto['type'], { readonly label: string; readonly icon: string }> = {
  recording: { label: 'Recording', icon: 'video' },
  ai_transcription: { label: 'AI transcription', icon: 'sparkles' },
  data_sharing: { label: 'Data sharing', icon: 'share-2' },
};

/**
 * Clinical tools → Consents (read-only): the patient's consent decisions for
 * this consultation. Recording and the AI tools depend on them.
 *
 * Usage: `<doc-clinical-consents [consents]="consents()" />`
 */
@Component({
  selector: 'doc-clinical-consents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, IconComponent, ClinicalBadge, ClinicalHeader],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <doc-clinical-header
      icon="shield-check"
      heading="Patient consents"
      helper="Decisions the patient made for this consultation. Recording and AI tools need their consent."
    >
      <doc-clinical-badge tone="neutral" icon="lock" label="Read-only" />
    </doc-clinical-header>

    @if (consents().length === 0) {
      <section class="rounded-card border border-cloud bg-white px-4" aria-label="Patient consents">
        <sd-empty-state icon="shield-check" [title]="emptyTitle" message="Recording and AI tools stay unavailable until the patient grants consent." />
      </section>
    } @else {
      <ul class="flex flex-col divide-y divide-cloud rounded-card border border-cloud bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)]" aria-label="Patient consents">
        @for (c of consents(); track c.type) {
          <li class="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div class="flex min-w-0 items-center gap-3">
              <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean">
                <sd-icon [name]="meta(c.type).icon" [size]="18" />
              </span>
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="font-sans text-body-sm font-semibold text-ink">{{ meta(c.type).label }}</span>
                <p class="${CLINICAL_META}">
                  @if (c.decided_at) {
                    <span class="inline-flex items-center gap-1"><sd-icon name="calendar-days" [size]="13" />{{ when(c.decided_at) }}</span>
                  }
                  @if (c.by_name) {
                    <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ c.by_name }}</span>
                  }
                  @if (c.version) {
                    <span class="inline-flex items-center gap-1"><sd-icon name="file-text" [size]="13" />Version {{ c.version }}</span>
                  }
                </p>
              </div>
            </div>
            @if (c.granted) {
              <doc-clinical-badge tone="success" icon="circle-check" label="Granted" />
            } @else {
              <doc-clinical-badge tone="neutral" icon="circle-x" label="Not granted" />
            }
          </li>
        }
      </ul>
    }
  `,
})
export class ClinicalConsents {
  readonly consents = input.required<ConsentDto[]>();

  protected readonly emptyTitle = 'No consent decisions yet';

  protected meta(type: ConsentDto['type']): { label: string; icon: string } {
    return CONSENT_META[type] ?? { label: type, icon: 'shield-check' };
  }

  protected when(iso: string): string {
    return rxDateTime(iso);
  }
}
