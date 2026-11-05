/*
 * @supadoc/viewer — the light entry point: the service, the types, the
 * policies, the source builders, the copy and the pdf.js loader token. It
 * never re-exports `document-viewer.ts` or `document-viewer-outlet.ts`: the
 * service loads both by relative dynamic imports (D2), so neither is ever in
 * an app's initial bundle.
 */
export { DocumentViewerService } from './lib/document-viewer.service';
export { CallPeerTileComponent } from './lib/call-peer-tile';
export type {
  ViewerCallContext,
  ViewerErrorView,
  ViewerFile,
  ViewerInsets,
  ViewerKind,
  ViewerOpenOptions,
  ViewerPolicyId,
  ViewerRef,
  ViewerResumeState,
  ViewerSession,
  ViewerSource,
  ViewerState,
  ViewerTone,
  ViewerWatermark,
} from './lib/viewer-types';
export { assertPolicyTable, sourceProblem, VIEWER_POLICIES, viewerPolicy, type ViewerPolicy } from './lib/viewer-policy';
export { blobSource, defaultErrorView, safeFilename, signedLinkSource, viewOnlySource } from './lib/viewer-sources';
export { saveSignedLink } from './lib/save-file';
export { provideViewerDefaults, VIEWER_DEFAULTS, type ViewerDefaults } from './lib/viewer-defaults';
export * from './lib/viewer-copy';
export { viewerKind } from './lib/viewer-kind';
export { PDF_LOADER, type PdfLoader } from './lib/pdf-loader';
