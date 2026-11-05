import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  type ComponentRef,
  computed,
  effect,
  inject,
  InjectionToken,
  input,
  signal,
  type Type,
  untracked,
  viewChild,
  ViewContainerRef,
} from '@angular/core';
import type { AdminDoctorApplicationsApi, PrescriptionsApi, SpecialistsApi } from '@supadoc/data-access';
import type {
  ApplicationDocumentDto,
  PrescriptionLinkDto,
  PrescriptionStatus,
  PrescriptionSummaryDto,
  SpecialistCredentialDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import {
  blobSource,
  CHUNK_RELOAD,
  OPENING,
  RELOAD,
  signedLinkSource,
  VIEWER_POLICIES,
  type ViewerErrorView,
  viewerKind,
  type ViewerSource,
} from '@supadoc/viewer';
import { map, type Observable } from 'rxjs';
import { documentTitle } from '../applications/application-ui';
import { BTN_GHOST, fileSize } from '../specialists/specialist-ui';

/*
 * The back office's documents in the shared viewer (spec §6.4): the source
 * builders, and `bo-embedded-viewer` for the two decision dialogs. Import this
 * file only from lazily loaded code (route pages and their dialogs): it pulls
 * in `@supadoc/viewer`, which must stay out of the initial bundle.
 */

/** The staff policies' notice, shown under an embedded viewer (it has no header of its own). */
export const STAFF_NOTICE = VIEWER_POLICIES.staff_verification.notice ?? '';

/**
 * The bytes typed from the stored, sniffed MIME type, never the response's
 * (the old back-office rule, kept exactly): a type the viewer draws keeps it,
 * anything else becomes `application/octet-stream`, the not-viewable card
 * with Download.
 */
export function retypedBlob(blob: Blob, storedMime: string | null | undefined): Blob {
  const mime = (storedMime ?? '').toLowerCase().split(';')[0].trim();
  const type = viewerKind(mime, 'staff_verification') === 'none' ? 'application/octet-stream' : mime;
  return new Blob([blob], { type });
}

/** "pdf" from "licence.PDF" (for the not-viewable copy), else null. */
function extensionOf(name: string | null | undefined): string | null {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** Today's copy when the stored file can't be read (404); every other error maps as usual. */
function unreadable(text: string): (err: unknown) => ViewerErrorView | null {
  return (err) => {
    const e = err as { statusCode?: unknown; status?: unknown } | null;
    return (e?.statusCode ?? e?.status) === 404 ? { state: 'gone', text, retry: false } : null;
  };
}

/** An applicant's document (every open audited server-side); staff may download it, as before. */
export function applicationDocumentSource(
  api: Pick<AdminDoctorApplicationsApi, 'documentFile'>,
  applicationId: string,
  doc: ApplicationDocumentDto,
): ViewerSource {
  return blobSource({
    key: 'appdoc:' + doc.id,
    title: documentTitle(doc),
    typeLabel: doc.slot_label,
    extension: extensionOf(doc.original_name),
    sizeLabel: fileSize(doc.size_bytes),
    meta: [doc.original_name],
    policy: 'staff_verification',
    filename: doc.original_name,
    fetch: () => api.documentFile(applicationId, doc.id).pipe(map((blob) => retypedBlob(blob, doc.mime))),
    mapError: unreadable('This document could not be read.'),
  });
}

/** A doctor's licensing document, read as the Credentials tab always has. */
export function credentialSource(
  api: Pick<SpecialistsApi, 'credentialFile'>,
  specialistId: string,
  c: SpecialistCredentialDto,
): ViewerSource {
  return blobSource({
    key: 'cred:' + c.id,
    title: c.type_label,
    typeLabel: c.type_label,
    extension: extensionOf(c.original_name),
    sizeLabel: fileSize(c.size_bytes),
    meta: [c.original_name],
    policy: 'staff_verification',
    filename: c.original_name,
    fetch: () => api.credentialFile(specialistId, c.id).pipe(map((blob) => retypedBlob(blob, c.mime))),
    mapError: unreadable('This document could not be read. Ask the doctor to upload it again.'),
  });
}

const RX_STATUS_LABEL: Record<PrescriptionStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/**
 * A patient's prescription PDF for staff: a signed staff link (one
 * `prescription.viewed` audit row per open), fetched as a blob. View and
 * print only: staff never had a Download for it (Q5).
 */
export function staffPrescriptionSource(
  rxApi: Pick<PrescriptionsApi, 'staffLink' | 'fileBlob'>,
  rx: Pick<PrescriptionSummaryDto, 'id' | 'number' | 'status' | 'prescriber'>,
): ViewerSource {
  return signedLinkSource({
    key: 'rx:' + rx.id,
    title: 'Prescription ' + rx.number,
    typeLabel: 'Prescription',
    extension: 'pdf',
    meta: [RX_STATUS_LABEL[rx.status] ?? rx.status, ...(rx.prescriber ? [rx.prescriber] : [])],
    policy: 'staff_record',
    canDownload: false,
    link: () => rxApi.staffLink(rx.id, false).pipe(map((r) => r.data)),
    fetch: (url: string): Observable<Blob> => rxApi.fileBlob({ url } as PrescriptionLinkDto),
  });
}

// ----- The embedded viewer (decision dialogs) -----

/**
 * The embedded viewer's frame: a fixed height at every width (§1.3.4), so the
 * dialog body keeps scrolling to the details and the decision form.
 */
export const EMBEDDED_VIEWER_FRAME = 'h-[min(70dvh,48rem)] overflow-hidden rounded-field border border-cloud';

/** Loads `sd-document-viewer` (`@supadoc/viewer/embed`, its own lazy chunk). Specs provide a stub. */
export const EMBEDDED_VIEWER = new InjectionToken<() => Promise<Type<unknown>>>('EMBEDDED_VIEWER', {
  providedIn: 'root',
  factory: () => () => import('@supadoc/viewer/embed').then((m) => m.DocumentViewerComponent),
});

/**
 * The shared viewer embedded in a decision dialog (`mode="embedded"`, light,
 * §1.3.4), with the staff notice under it. Its chunk is imported for the
 * first source, and the body is created with a `ViewContainerRef` rather than
 * `@defer` (the first `@defer` in an app adds Angular's deferred-loading
 * runtime to the initial bundle). It follows `source`, so keep that keyed on
 * the document's id (a new source is a new, audited read); removing this
 * element releases the file.
 */
@Component({
  selector: 'bo-embedded-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex min-w-0 flex-col gap-2' },
  template: `
    <ng-container #host />
    @if (state() === 'loading') {
      <div class="${EMBEDDED_VIEWER_FRAME} flex items-center justify-center bg-glacier" aria-busy="true">
        <span class="flex items-center gap-2 font-sans text-body-sm text-slate" role="status"><sd-icon name="loader-circle" [size]="18" class="animate-spin" />{{ openingText }}</span>
      </div>
    } @else if (state() === 'failed') {
      <div class="${EMBEDDED_VIEWER_FRAME} flex flex-col items-center justify-center gap-3 bg-glacier p-6 text-center">
        <sd-icon name="triangle-alert" [size]="28" class="text-alert" />
        <p class="font-sans text-body-sm text-slate" role="alert">{{ reloadText }}</p>
        <button type="button" class="${BTN_GHOST}" (click)="reload()"><sd-icon name="refresh-cw" [size]="16" />{{ reloadLabel }}</button>
      </div>
    }
    <p class="flex items-start gap-1.5 font-sans text-caption text-slate">
      <sd-icon name="shield-check" [size]="14" class="mt-0.5 shrink-0" />{{ notice }}
    </p>
  `,
})
export class EmbeddedViewer {
  private readonly load = inject(EMBEDDED_VIEWER);
  private readonly doc = inject(DOCUMENT);

  /** The document (null: nothing to show). */
  readonly source = input<ViewerSource | null>(null);

  protected readonly notice = STAFF_NOTICE;
  protected readonly openingText = OPENING;
  protected readonly reloadText = CHUNK_RELOAD;
  protected readonly reloadLabel = RELOAD;

  private readonly host = viewChild.required('host', { read: ViewContainerRef });
  private readonly type = signal<Type<unknown> | null>(null);
  private readonly failed = signal(false);
  /** The body's chunk: still loading, failed (old hashes after a deploy), or ready. */
  protected readonly state = computed(() => (this.failed() ? 'failed' : this.type() ? 'ready' : 'loading'));
  private ref: ComponentRef<unknown> | null = null;
  private requested = false;

  constructor() {
    effect(() => {
      const src = this.source();
      const component = this.type();
      untracked(() => this.mount(src, component));
    });
  }

  private mount(src: ViewerSource | null, component: Type<unknown> | null): void {
    if (!src) return;
    if (!component) {
      if (this.requested) return;
      this.requested = true;
      this.load().then(
        (c) => this.type.set(c),
        () => this.failed.set(true),
      );
      return;
    }
    if (!this.ref) {
      this.ref = this.host().createComponent(component);
      (this.ref.location.nativeElement as HTMLElement).classList.add(...EMBEDDED_VIEWER_FRAME.split(' '));
      this.ref.setInput('mode', 'embedded');
      this.ref.setInput('tone', 'light');
    }
    this.ref.setInput('source', src);
  }

  protected reload(): void {
    this.doc.defaultView?.location.reload();
  }
}
