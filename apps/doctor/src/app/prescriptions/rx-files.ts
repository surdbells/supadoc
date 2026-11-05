import { inject, Injectable } from '@angular/core';
import { DoctorApi, PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionLinkDto } from '@supadoc/models';
import { DocumentViewerService, saveSignedLink, type ViewerErrorView, type ViewerRef } from '@supadoc/viewer';
import { map, type Observable, type Subscription } from 'rxjs';
import { draftPrescriptionSource, prescriptionSource } from '../viewer/doctor-viewer-sources';

/**
 * Prescription PDFs through short-lived signed links: View and Preview open
 * the shared document viewer (a modal over the page — during a call it gets
 * the call band and the patient's video from the registered call), Download
 * saves the file. Nothing opens a tab or navigates, so nothing here can ever
 * replace the page (or drop a call). Nothing needs to run inside a click.
 */
@Injectable({ providedIn: 'root' })
export class RxFiles {
  private readonly api = inject(DoctorApi);
  private readonly files = inject(PrescriptionsApi);
  private readonly viewer = inject(DocumentViewerService);

  /**
   * A prescription's PDF in the viewer (drafts carry a DRAFT watermark): one
   * `prescription.viewed` per open. Focus goes back to `opener` (default: the
   * focused button) when it closes.
   */
  view(
    rx: { readonly id: string; readonly number: string; readonly status?: string | null },
    opener?: HTMLElement | null,
  ): ViewerRef {
    return this.viewer.open(prescriptionSource(this.api, this.files, rx), opener ? { opener } : {});
  }

  /**
   * The composer's Preview: the viewer opens at once (loading); `resolve`
   * (save first when needed) runs inside its load — and again on "Try again" —
   * then the DRAFT PDF's link is minted for the id it gives. `draftKey` is the
   * composer's own (`'rx-draft:' + n`). `mapError`: the composer's copy for a
   * save that failed (null: the viewer's own).
   */
  preview(
    draftKey: string,
    resolve: () => Observable<{ readonly id: string }>,
    options: { readonly opener?: HTMLElement | null; readonly mapError?: (err: unknown) => ViewerErrorView | null } = {},
  ): ViewerRef {
    const source = draftPrescriptionSource(this.api, this.files, draftKey, resolve, { mapError: options.mapError });
    return this.viewer.open(source, options.opener ? { opener: options.opener } : {});
  }

  /**
   * Download the PDF: mint a download link (one `prescription.downloaded`),
   * fetch it with HttpClient and save it (a same-origin object URL). Never a
   * cross-origin `<a href download>`, which navigates the page on an error body.
   */
  download(rxId: string, onError: (err: unknown) => void, onDone?: () => void): Subscription {
    return saveSignedLink(
      this.api.prescriptionLink(rxId, true).pipe(map((r) => r.data)),
      (url) => this.files.fileBlob({ url } as PrescriptionLinkDto),
    ).subscribe({
      next: () => onDone?.(),
      error: (err: unknown) => onError(err),
    });
  }
}
