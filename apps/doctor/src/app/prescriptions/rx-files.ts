import { inject, Injectable } from '@angular/core';
import { DoctorApi, openPendingTab, PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionLinkDto } from '@supadoc/models';
import { map, Observable, Subscription } from 'rxjs';

/** How a PDF is opened. */
export interface RxOpenOptions {
  /**
   * When the browser blocks the new tab, open the PDF in THIS tab instead.
   * Default true. Pass false during a live video call — leaving the page would
   * end the call — and offer `onBlocked`'s link instead.
   */
  allowSameTab?: boolean;
  /**
   * The PDF could not be opened in a new tab (and `allowSameTab` is false).
   * Show the doctor a link to `url` (a short-lived signed link) to open it.
   */
  onBlocked?: (url: string) => void;
}

/**
 * Opening / downloading prescription PDFs through short-lived signed links.
 *
 * `open*` methods MUST be called synchronously from a click handler: they open
 * a placeholder tab straight away (so popup blockers allow it) and point it at
 * the PDF once the link arrives — or close it again on failure.
 */
@Injectable({ providedIn: 'root' })
export class RxFiles {
  private readonly api = inject(DoctorApi);
  private readonly files = inject(PrescriptionsApi);

  /** Open the PDF of a prescription in a new tab (drafts carry a DRAFT watermark). */
  view(
    rxId: string,
    onError: (err: unknown) => void,
    onDone?: () => void,
    options: RxOpenOptions = {},
  ): Subscription {
    return this.open(
      this.api.prescriptionLink(rxId).pipe(map((r) => r.data)),
      onError,
      onDone,
      options,
    );
  }

  /** Open whatever link `link$` resolves to (e.g. "save first, then link"). */
  open(
    link$: Observable<PrescriptionLinkDto>,
    onError: (err: unknown) => void,
    onDone?: () => void,
    options: RxOpenOptions = {},
  ): Subscription {
    const pending = openPendingTab({ allowSameTab: options.allowSameTab ?? true });
    return link$.subscribe({
      next: (link) => {
        const url = this.files.fileUrl(link);
        if (!pending.go(url)) options.onBlocked?.(url);
        onDone?.();
      },
      error: (err: unknown) => {
        pending.fail();
        onError(err);
      },
    });
  }

  /** Download the PDF (the server answers with `Content-Disposition: attachment`). */
  download(rxId: string, onError: (err: unknown) => void, onDone?: () => void): Subscription {
    return this.api.prescriptionLink(rxId, true).subscribe({
      next: (res) => {
        const a = document.createElement('a');
        a.href = this.files.fileUrl(res.data);
        a.download = res.data.filename || 'prescription.pdf';
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        onDone?.();
      },
      error: (err: unknown) => onError(err),
    });
  }
}
