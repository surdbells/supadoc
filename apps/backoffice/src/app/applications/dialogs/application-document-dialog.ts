import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { Observable } from 'rxjs';
import { AdminDoctorApplicationsApi } from '@supadoc/data-access';
import type { ApplicationDocumentDto } from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { DIALOG_FOOTER, PILL } from '../../shared/layout';
import { DocumentViewer } from '../../shared/document-viewer';
import { BTN_GHOST, dateTime, fileSize } from '../../specialists/specialist-ui';
import { documentSourceBadge, documentTitle } from '../application-ui';

/**
 * One application document: the file itself (the shared viewer — fetched as a
 * blob, every view audited server-side, never a public link) beside what it
 * is, where it came from and, once approved, the credential it became.
 */
@Component({
  selector: 'bo-application-document-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, DocumentViewer, IconComponent],
  template: `
    <sd-dialog [open]="open()" [title]="title()" [subtitle]="subtitle()" size="xl" (closed)="closed.emit()">
      @if (document(); as doc) {
        <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          @if (open()) {
            <bo-document-viewer
              [load]="loadFile()"
              [mime]="doc.mime"
              [name]="doc.original_name"
              [sizeBytes]="doc.size_bytes"
              [alt]="title() + ' sent by the applicant'"
            />
          } @else {
            <div></div>
          }
          <div class="flex min-w-0 flex-col gap-4">
            <span class="${PILL}" [class]="source().cls"><sd-icon [name]="source().icon" [size]="13" />{{ source().label }}</span>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 font-sans text-body-sm">
              <dt class="text-slate">Document</dt><dd class="break-words text-ink">{{ doc.slot_label }}</dd>
              @if (doc.slot === 'additional' && doc.label) {
                <dt class="text-slate">Asked for</dt><dd class="break-words text-ink">{{ doc.label }}</dd>
              }
              <dt class="text-slate">File</dt><dd class="break-all text-ink">{{ doc.original_name }}</dd>
              <dt class="text-slate">Size</dt><dd class="text-ink">{{ size(doc.size_bytes) }}</dd>
              <dt class="text-slate">Uploaded</dt><dd class="text-ink">{{ when(doc.uploaded_at) }}</dd>
              <dt class="text-slate">State</dt><dd class="text-ink">{{ doc.state === 'replaced' ? 'Replaced by a newer upload' : 'Current' }}</dd>
              @if (doc.sha256) {
                <dt class="text-slate">SHA-256</dt><dd class="break-all font-mono text-[11px] text-slate">{{ doc.sha256 }}</dd>
              }
            </dl>
            @if (doc.credential_id) {
              <p class="flex items-start gap-1.5 font-sans text-caption text-sage-ink">
                <sd-icon name="badge-check" [size]="14" class="mt-0.5 shrink-0" />Added to the doctor's record as a verified credential.
              </p>
            }
          </div>
        </div>
      }
      <div dialogFooter class="${DIALOG_FOOTER}">
        <button type="button" class="${BTN_GHOST}" (click)="closed.emit()" data-autofocus>Close</button>
      </div>
    </sd-dialog>
  `,
})
export class ApplicationDocumentDialog {
  private readonly api = inject(AdminDoctorApplicationsApi);

  readonly open = input(false);
  readonly applicationId = input.required<string>();
  readonly document = input<ApplicationDocumentDto | null>(null);
  /** The applicant and reference, under the title. */
  readonly subtitle = input('');
  readonly closed = output<void>();

  protected readonly title = computed(() => {
    const d = this.document();
    return d ? documentTitle(d) : 'Document';
  });
  protected readonly source = computed(() => documentSourceBadge(this.document() ?? { uploaded_during: 'draft' }));

  /** Re-keyed on the document's id only: a refreshed copy of the same document isn't fetched (and audited) again. */
  private readonly documentId = computed(() => this.document()?.id ?? null);
  protected readonly loadFile = computed<(() => Observable<Blob>) | null>(() => {
    const id = this.documentId();
    const appId = this.applicationId();
    return id ? () => this.api.documentFile(appId, id) : null;
  });

  protected size(bytes: number): string {
    return fileSize(bytes);
  }
  protected when(iso: string | null | undefined): string {
    return dateTime(iso);
  }
}
