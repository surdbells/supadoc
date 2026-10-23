import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminDoctorApplicationsApi, openBlobDocument } from '@supadoc/data-access';
import type { ApplicationDocumentDto, DoctorApplicationDetailDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { afterDialogCloses, focusIfLost } from '../../shared/after-dialog';
import { CARD_ITEM, CARD_LIST, CARD_RAISED, LIST_CARD_EMPTY, PILL, SECTION_TITLE } from '../../shared/layout';
import { type Badge, BTN_SECONDARY, dateOnly, fileSize } from '../../specialists/specialist-ui';
import { documentSourceBadge, documentTitle, routeSlots, slotLabel } from '../application-ui';
import { ApplicationDocumentDialog } from '../dialogs/application-document-dialog';

/**
 * The application's documents: each current one with what it is, the file,
 * its size and upload date and where it came from (with the application, or
 * sent after a request), to View here or open in a new tab (every view is
 * audited). Required slots still empty are named. Replaced uploads are folded
 * away. Once approved, documents carried over link to the doctor's
 * Credentials tab.
 */
@Component({
  selector: 'bo-application-documents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, ApplicationDocumentDialog],
  template: `
    <div class="flex flex-col gap-6">
      <section class="flex flex-col gap-4" aria-labelledby="bo-app-docs-title">
        <h2 id="bo-app-docs-title" class="${SECTION_TITLE}"><sd-icon name="file-text" [size]="20" class="text-cerulean" />Documents</h2>
        @if (missing().length > 0) {
          <p class="flex items-start gap-2 rounded-field bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink">
            <sd-icon name="circle-alert" [size]="16" class="mt-0.5 shrink-0 text-warning" />
            <span>Not on file: {{ missing().join(', ') }}.</span>
          </p>
        }
        @if (current().length === 0) {
          <div class="${CARD_RAISED} ${LIST_CARD_EMPTY}">
            <sd-icon name="folder-open" [size]="28" class="text-slate" />
            <p class="font-sans text-body-sm text-slate">No documents on this application.</p>
          </div>
        } @else {
          <ul class="${CARD_LIST}">
            @for (doc of current(); track doc.id) {
              <li class="${CARD_ITEM}">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div class="flex min-w-0 flex-col gap-1">
                    <span class="break-words font-heading text-body-lg text-ink">{{ title(doc) }}</span>
                    <span class="break-all font-sans text-caption text-slate">{{ doc.original_name }} · {{ size(doc.size_bytes) }} · uploaded {{ day(doc.uploaded_at) }}</span>
                  </div>
                  <span class="flex flex-wrap items-center gap-1.5">
                    <span class="${PILL}" [class]="source(doc).cls"><sd-icon [name]="source(doc).icon" [size]="13" />{{ source(doc).label }}</span>
                    @if (doc.credential_id && specialistId()) {
                      <a [routerLink]="['/specialists', specialistId()]" [queryParams]="{ tab: 'credentials' }" class="${PILL} bg-sage/15 text-sage-ink transition-colors hover:bg-sage/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40">
                        <sd-icon name="badge-check" [size]="13" />Verified credential<span class="sr-only"> — open on the doctor's Credentials tab</span>
                      </a>
                    }
                  </span>
                </div>
                <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button type="button" [id]="'bo-app-doc-view-' + doc.id" class="${BTN_SECONDARY}" (click)="view(doc)" [attr.aria-label]="'View ' + title(doc)">
                    <sd-icon name="eye" [size]="16" />View
                  </button>
                  <button type="button" class="${BTN_SECONDARY}" (click)="openTab(doc)" [attr.aria-label]="'Open ' + title(doc) + ' in a new tab'">
                    <sd-icon name="external-link" [size]="16" />Open in new tab
                  </button>
                </div>
              </li>
            }
          </ul>
        }
      </section>

      @if (replaced().length > 0) {
        <details class="${CARD_RAISED} p-5">
          <summary class="flex min-h-11 cursor-pointer items-center gap-2 font-sans text-body-sm font-semibold text-ink">
            <sd-icon name="history" [size]="16" class="text-slate" />Replaced documents ({{ replaced().length }})
          </summary>
          <ul class="mt-3 flex flex-col divide-y divide-cloud">
            @for (doc of replaced(); track doc.id) {
              <li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex min-w-0 flex-col">
                  <span class="break-words font-sans text-body-sm text-ink">{{ title(doc) }}</span>
                  <span class="break-all font-sans text-caption text-slate">{{ doc.original_name }} · uploaded {{ day(doc.uploaded_at) }}</span>
                </div>
                <button type="button" [id]="'bo-app-doc-view-' + doc.id" class="${BTN_SECONDARY}" (click)="view(doc)" [attr.aria-label]="'View replaced ' + title(doc)">
                  <sd-icon name="eye" [size]="16" />View
                </button>
              </li>
            }
          </ul>
        </details>
      }
    </div>

    <bo-application-document-dialog
      [open]="dialogOpen()"
      [applicationId]="detail().id"
      [document]="selected()"
      [subtitle]="detail().full_name + ' · ' + detail().reference"
      (closed)="closeDialog()"
    />
  `,
})
export class ApplicationDocumentsTab {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly doc = inject(DOCUMENT);

  readonly detail = input.required<DoctorApplicationDetailDto>();

  private readonly selectedId = signal<string | null>(null);
  protected readonly dialogOpen = signal(false);
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.detail().documents.find((d) => d.id === id) ?? null) : null;
  });

  protected readonly current = computed(() => this.detail().documents.filter((d) => d.state === 'active'));
  protected readonly replaced = computed(() => this.detail().documents.filter((d) => d.state === 'replaced'));
  protected readonly specialistId = computed(() => this.detail().specialist?.id ?? null);
  /** The route's required slots with no current document (approval needs every one). */
  protected readonly missing = computed(() => {
    const d = this.detail();
    const have = new Set(this.current().map((x) => x.slot));
    return routeSlots(d.licence_route)
      .filter((slot) => !have.has(slot))
      .map((slot) => slotLabel(slot, d.licence_route));
  });

  protected view(doc: ApplicationDocumentDto): void {
    this.selectedId.set(doc.id);
    this.dialogOpen.set(true);
  }

  protected closeDialog(): void {
    const id = this.selectedId();
    this.dialogOpen.set(false);
    // Focus goes back to the View button (it stays); a list that changed meanwhile loses it.
    afterDialogCloses(() => focusIfLost(id ? this.doc.getElementById(`bo-app-doc-view-${id}`) : null, this.doc), this.doc);
  }

  /** Popup-safe: the tab opens on the click, the file follows from a blob URL. */
  protected openTab(doc: ApplicationDocumentDto): void {
    openBlobDocument(this.api.documentFile(this.detail().id, doc.id));
  }

  protected title(doc: ApplicationDocumentDto): string {
    return documentTitle(doc);
  }
  protected source(doc: ApplicationDocumentDto): Badge {
    return documentSourceBadge(doc);
  }
  protected size(bytes: number): string {
    return fileSize(bytes);
  }
  protected day(iso: string | null | undefined): string {
    return dateOnly(iso);
  }
}
