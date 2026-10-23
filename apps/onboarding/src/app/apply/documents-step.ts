import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { ApplicationDocumentDto, ApplicationDocumentSlot } from '@supadoc/models';
import { AlertComponent } from '@supadoc/ui';
import { DOCUMENT_STEP_SLOTS, slotCopy } from '../core/documents';
import { documentInSlot } from '../core/step-source';
import { CancelDialogComponent } from '../shared/cancel-dialog';
import { FileFieldComponent } from '../shared/file-field';
import { FormState } from '../shared/form-state';
import { SavedDialogComponent } from '../shared/saved-dialog';
import { StepFooterComponent } from '../shared/step-footer';
import { StepShellComponent } from '../shared/step-shell';
import { StepBase } from './step-base';

export const DOCUMENTS_SUBTITLE = 'Upload the following documents. (Fields marked * are required)';

/** Step 5 of 7, Documents (Figma App 12/13): four uploads in a 2×2 grid; labels follow the licence route. */
@Component({
  selector: 'onb-documents-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, CancelDialogComponent, FileFieldComponent, SavedDialogComponent, StepFooterComponent, StepShellComponent],
  template: `
    <onb-step-shell [bare]="isInfo()" [step]="stepNumber()" [heading]="heading()" [subtitle]="subtitle" (back)="goBack()">
      @if (banner()) {
        <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
      }
      <div class="mt-8 grid grid-cols-1 gap-x-6 gap-y-10 md:grid-cols-2 min-[900px]:mt-10">
        @for (slot of slots(); track slot.slot) {
          <onb-file-field
            [inputId]="'onb-' + slot.slot"
            [label]="slot.label"
            [hint]="slot.hint"
            [required]="true"
            [compact]="true"
            [document]="docOf(slot.slot)"
            [progress]="uploads.progressOf(slot.slot)"
            [error]="uploads.errorOf(slot.slot)"
            [readonly]="!source().slotEditable(slot.slot)"
            [removable]="removable(slot.slot)"
            (pick)="uploads.pick(slot.slot, $event)"
            (remove)="remove(slot.slot)"
            (view)="view(slot.slot)"
          />
        }
      </div>

      @if (wizard()) {
        <onb-step-footer stepFooter [primaryLabel]="primaryLabel()" [invalidLook]="missing().length > 0" [busy]="busy()" (primary)="onContinue()" (save)="onSaveLater()" (cancelApplication)="onCancel()" />
      }
    </onb-step-shell>

    @if (wizard()) {
      <onb-saved-dialog [open]="savedOpen()" [sentTo]="savedTo()" [cooldown]="savedCooldown()" (home)="savedHome()" (keepGoing)="savedOpen.set(false)" />
      <onb-cancel-dialog [open]="cancelOpen()" mode="draft" [busy]="cancelBusy()" [error]="cancelError()" (confirm)="confirmCancel()" (closed)="cancelOpen.set(false)" />
    }
  `,
})
export class OnbDocumentsStep extends StepBase {
  readonly key = 'documents' as const;
  protected readonly subtitle = DOCUMENTS_SUBTITLE;
  protected readonly form = new FormState(signal({}));

  private readonly regulatorName = computed(() => {
    const licence = this.source().sections()?.licence;
    return typeof licence?.regulator_name === 'string' ? licence.regulator_name : null;
  });
  protected readonly slots = computed(() =>
    DOCUMENT_STEP_SLOTS.map((s) => slotCopy(s, this.source().route(), this.regulatorName())),
  );
  protected readonly missing = computed(() =>
    DOCUMENT_STEP_SLOTS.filter((s) => !documentInSlot(this.source().documents(), s)),
  );

  constructor() {
    super();
    this.markBaseline();
  }

  protected docOf(slot: ApplicationDocumentSlot): ApplicationDocumentDto | null {
    return documentInSlot(this.source().documents(), slot);
  }

  protected removable(slot: ApplicationDocumentSlot): boolean {
    const doc = this.docOf(slot);
    return doc ? this.source().documentRemovable(doc) : true;
  }

  protected remove(slot: ApplicationDocumentSlot): void {
    const doc = this.docOf(slot);
    if (doc) void this.uploads.remove(doc);
  }

  protected view(slot: ApplicationDocumentSlot): void {
    const doc = this.docOf(slot);
    if (doc) this.source().viewDocument(doc);
  }

  protected validate(): Record<string, string> {
    return {};
  }

  protected payload(): Record<string, unknown> {
    return {};
  }

  protected fieldOrder(): string[] {
    return [];
  }

  protected override missingUploads(): string[] {
    return this.wizard() ? this.missing() : [];
  }

  /** No fields: make sure the step's completeness is current before moving on. */
  protected override async persist(): Promise<void> {
    await this.store.refresh();
  }
}
