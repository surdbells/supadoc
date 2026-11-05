/*
 * @supadoc/viewer/embed — the heavy entry point: the `sd-document-viewer`
 * body, for hosts that embed it inside their own dialog (the back office's
 * decision dialogs, §6.4). Banned in the doctor app (every doctor view goes
 * through DocumentViewerService and its §1.16 checks).
 */
export { DocumentViewerComponent } from './lib/document-viewer';
