import type { ViewerOpenOptions, ViewerPolicyId, ViewerSource } from './viewer-types';

/** What a viewer may do with one kind of document (§2.2). Frozen; hosts pick an id. */
export interface ViewerPolicy {
  readonly id: ViewerPolicyId;
  /** `audited`: `source.recordPrint` must succeed before printing. */
  readonly print: 'audited' | 'open';
  readonly download: boolean;
  /** The traceable watermark on every raster (pages, thumbnails, photos, video overlay, print). */
  readonly watermark: boolean;
  /** Context menu, dragging, copying and Ctrl/Cmd+S refused; no selection. */
  readonly deterrents: boolean;
  /** A pdf.js text layer over drawn pages (D12). */
  readonly textLayer: boolean;
  /** While the local user shares their screen (D11). */
  readonly shareGuard: 'cover' | 'warn';
  readonly printDpi: number;
  readonly printFooter: boolean;
  readonly nativeVideoFullscreen: boolean;
  readonly notice: string | null;
  readonly noticeIcon: 'lock' | 'shield-check' | null;
  /** Which not-viewable copy (§1.6). */
  readonly notViewable: 'ask_patient' | 'download' | 'cant_show' | 'download_to_check';
}

const STAFF_NOTICE = 'Confidential. Opening a document is recorded in the audit log.';

const OPEN = {
  print: 'open',
  watermark: false,
  deterrents: false,
  textLayer: true,
  shareGuard: 'warn',
  printDpi: 200,
  printFooter: false,
  nativeVideoFullscreen: true,
} as const;

function policy(p: ViewerPolicy): ViewerPolicy {
  return Object.freeze(p);
}

/** The frozen policy table (§2.2). */
export const VIEWER_POLICIES: Readonly<Record<ViewerPolicyId, ViewerPolicy>> = Object.freeze({
  view_only: policy({
    id: 'view_only',
    print: 'audited',
    download: false,
    watermark: true,
    deterrents: true,
    textLayer: false,
    shareGuard: 'cover',
    printDpi: 150,
    printFooter: true,
    nativeVideoFullscreen: false,
    notice: 'View only · Downloads are turned off for patient documents.',
    noticeIcon: 'lock',
    notViewable: 'ask_patient',
  }),
  authored: policy({ ...OPEN, id: 'authored', download: true, notice: null, noticeIcon: null, notViewable: 'download' }),
  authored_print: policy({ ...OPEN, id: 'authored_print', download: false, notice: null, noticeIcon: null, notViewable: 'cant_show' }),
  authored_draft: policy({
    ...OPEN,
    id: 'authored_draft',
    download: false,
    notice: "Draft preview. It isn't valid until you send it.",
    noticeIcon: 'lock',
    notViewable: 'cant_show',
  }),
  owner: policy({ ...OPEN, id: 'owner', download: true, notice: null, noticeIcon: null, notViewable: 'download' }),
  staff_record: policy({
    ...OPEN,
    id: 'staff_record',
    download: false,
    notice: STAFF_NOTICE,
    noticeIcon: 'shield-check',
    notViewable: 'cant_show',
  }),
  staff_verification: policy({
    ...OPEN,
    id: 'staff_verification',
    download: true,
    notice: STAFF_NOTICE,
    noticeIcon: 'shield-check',
    notViewable: 'download_to_check',
  }),
});

/** Whether `id` names a policy (an own key of the table, never a prototype name). */
export function isViewerPolicyId(id: unknown): id is ViewerPolicyId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(VIEWER_POLICIES, id);
}

/** A policy by id; throws for an unknown id (a host bug). */
export function viewerPolicy(id: ViewerPolicyId): ViewerPolicy {
  if (!isViewerPolicyId(id)) throw new Error(`Unknown viewer policy: ${String(id)}`);
  return VIEWER_POLICIES[id];
}

/**
 * The table's own invariants (runs at module load and in the spec): nothing
 * watermarked or deterred may download, and nothing deterred has a text layer.
 */
export function assertPolicyTable(table: Readonly<Record<string, ViewerPolicy>> = VIEWER_POLICIES): void {
  for (const [id, p] of Object.entries(table)) {
    if ((p.watermark || p.deterrents) && p.download) throw new Error(`Viewer policy ${id}: a protected policy cannot download`);
    if (p.textLayer && p.deterrents) throw new Error(`Viewer policy ${id}: a deterred policy has no text layer`);
    if (p.print === 'audited' && p.download) throw new Error(`Viewer policy ${id}: an audited policy cannot download`);
  }
}
assertPolicyTable();

/** Sources built by `viewOnlySource` (the only builder allowed to yield `view_only`). */
const VIEW_ONLY_BUILT = new WeakSet<object>();

/** @internal `viewOnlySource` marks what it builds. */
export function markViewOnly<T extends object>(source: T): T {
  VIEW_ONLY_BUILT.add(source);
  return source;
}

/**
 * Why the viewer must refuse this source, or null (§1.16). Pure and in every
 * build (never `isDevMode()`): the service runs it on open() before handing
 * the peer over, and the body again before every load and every print.
 */
export function sourceProblem(source: ViewerSource, options?: Pick<ViewerOpenOptions, 'watermark'> | null): string | null {
  if (!source || !isViewerPolicyId(source.policy)) return 'unknown policy';
  const p = VIEWER_POLICIES[source.policy];
  if (p.watermark) {
    const w = options?.watermark;
    if (!w || !String(w.viewerName ?? '').trim() || !String(w.timeZone ?? '').trim()) return 'a watermarked policy needs a watermark';
  }
  if (source.policy === 'view_only' && !VIEW_ONLY_BUILT.has(source)) return 'view_only sources are built with viewOnlySource';
  if (p.print === 'audited' && typeof source.recordPrint !== 'function') return 'an audited print needs recordPrint';
  if (!p.download && typeof source.download === 'function') return 'this policy cannot download';
  return null;
}
