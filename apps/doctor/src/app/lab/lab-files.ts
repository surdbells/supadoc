import { inject, Injectable } from '@angular/core';
import { LabRequestsApi } from '@supadoc/data-access';
import type { LabRequestLinkDto } from '@supadoc/models';
import { DocumentViewerService, saveSignedLink, type ViewerRef } from '@supadoc/viewer';
import { map, type Subscription } from 'rxjs';
import { labRequestPdfSource } from './lab-viewer-sources';

/**
 * Lab request PDFs through short-lived signed links: View opens the shared
 * document viewer (a modal over the page), Download saves the file. Nothing
 * opens a tab or navigates (never a cross-origin `<a href>`).
 */
@Injectable({ providedIn: 'root' })
export class LabFiles {
  private readonly labApi = inject(LabRequestsApi);
  private readonly viewer = inject(DocumentViewerService);

  /** The request's PDF in the viewer: one `lab_request.viewed` per open. Focus goes back to `opener`. */
  view(lab: { readonly id: string; readonly number: string }, opener?: HTMLElement | null): ViewerRef {
    return this.viewer.open(labRequestPdfSource(this.labApi, lab), opener ? { opener, tone: 'light' } : { tone: 'light' });
  }

  /** Download the PDF: a download link (one `lab_request.downloaded`), fetched with HttpClient and saved. */
  download(labId: string, onError: (err: unknown) => void, onDone?: () => void): Subscription {
    return saveSignedLink(
      this.labApi.link(labId, true).pipe(map((r) => r.data)),
      (u) => this.labApi.fileBlob({ url: u } as LabRequestLinkDto),
    ).subscribe({
      next: () => onDone?.(),
      error: (err: unknown) => onError(err),
    });
  }
}
