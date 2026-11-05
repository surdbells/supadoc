import type { ViewerKind, ViewerPolicyId } from './viewer-types';

/** The served type without parameters, lower-case. */
export function normalMime(mime: string | null | undefined): string {
  return (mime ?? '').toLowerCase().split(';')[0].trim();
}

/** Safari plays MOV; elsewhere it gets the "can't play" card (Q14). */
function canPlayQuickTime(): boolean {
  try {
    return typeof document !== 'undefined' && document.createElement('video').canPlayType?.('video/quicktime') !== '';
  } catch {
    return false;
  }
}

/**
 * What the viewer can draw (§1.2.2). The served (or sniffed) MIME type
 * decides; the extension never does.
 */
export function viewerKind(mime: string | null | undefined, policy: ViewerPolicyId): ViewerKind {
  const m = normalMime(mime);
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/jpeg' || m === 'image/png' || m === 'image/webp') return 'image';
  if (m === 'video/mp4' || m === 'video/webm') return 'video';
  if (m === 'video/quicktime' && policy !== 'view_only' && canPlayQuickTime()) return 'video';
  return 'none';
}
