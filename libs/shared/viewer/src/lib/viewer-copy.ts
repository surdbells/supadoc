/**
 * Every string the viewer shows (§1.6, §1.8, §3). Plain text: rendered with
 * Angular interpolation or `textContent`, never as HTML.
 */

export const OPENING = 'Opening document…';
export const NETWORK_ERROR = "Couldn't open the document. Check your connection and try again.";
export const GONE_TEXT = 'This document is no longer available.';
export const LINK_EXPIRED = 'This link has expired. Close the viewer and open the document again.';
export const UPDATE_RELOAD = 'Reload VideoMed to open documents.';
export const UPDATE_IN_CALL = 'VideoMed was updated. Close the viewer and reload after the call.';
export const CHUNK_RELOAD = 'VideoMed was updated. Reload the page to open documents.';
export const VIEW_UNAVAILABLE = 'Could not open the document right now. Try again.';
export const GENERIC_ERROR = "Couldn't open the document. Try again.";
export const REFUSED_TEXT = "This document can't be shown here.";
export const PASSWORD_VIEW_ONLY =
  "This file is password-protected and can't be shown here. Ask the patient to share an unlocked copy.";
export const PASSWORD_OTHER =
  "This file is password-protected, so it can't be shown here. Download it and open it with its password.";
export const CANT_SHOW_TEXT = "This file can't be shown.";
export const VIDEO_CANT_PLAY = "This video can't play in this browser. Download it to watch it on your device.";
export const TRY_AGAIN = 'Try again';
export const RELOAD = 'Reload';

/** The not-viewable copy, by the policy's `notViewable` kind (§1.6). */
export function notViewableCopy(kind: 'ask_patient' | 'download' | 'cant_show' | 'download_to_check', ext: string): string {
  const e = ext ? ` (${ext})` : '';
  switch (kind) {
    case 'ask_patient':
      return `Preview isn't available for this file type${e}. Ask the patient to share it as a PDF or photo.`;
    case 'download':
      return `Preview isn't available for this file type${e}. Download it to open it on your device.`;
    case 'download_to_check':
      return `Preview isn't available for this file type${e}. Download it to check it.`;
    default:
      return CANT_SHOW_TEXT;
  }
}

/** The doctor's not-viewable copy for patient documents (shared with `document-access.ts`). */
export function viewOnlyNotViewableText(extension: string | null | undefined): string {
  return notViewableCopy('ask_patient', (extension ?? '').replace(/^\./, '').toUpperCase());
}

// ----- Print and download -----
export const PRINT_CONFIRM = {
  title: 'Print during the call?',
  message: 'The call stays connected, but your video may freeze until you close the print dialog.',
  confirmLabel: 'Print',
  cancelLabel: 'Cancel',
} as const;
export const PREPARING_PRINT = 'Preparing the print…';
export const DOWNLOAD_STARTED = 'Download started.';
export const DOWNLOAD_FAILED = "Couldn't start the download. Try again.";

// ----- Header and navigation -----
export const CLOSE_DOCUMENT = 'Close document';
export const PREVIOUS_DOCUMENT = 'Previous document';
export const NEXT_DOCUMENT = 'Next document';
export const DETAILS = 'Details';
export const DETAILS_HIDDEN = 'Details hidden while you share your screen.';
export const documentOf = (n: number, total: number, title: string) => `Document ${n} of ${total}: ${title}`;
export const backOnPage = (n: number) => `Back on page ${n}.`;

// ----- Toolbar -----
export const TOOLBAR_LABEL = 'Document tools';
export const SHOW_PAGES = 'Show pages';
export const HIDE_PAGES = 'Hide pages';
export const ZOOM_OUT = 'Zoom out';
export const ZOOM_IN = 'Zoom in';
export const ROTATE = 'Rotate';
export const PREVIOUS_PAGE = 'Previous page';
export const NEXT_PAGE = 'Next page';
export const PRINT = 'Print';
export const FULL_SCREEN = 'Full screen';
export const EXIT_FULL_SCREEN = 'Exit full screen';
export const KEYBOARD_SHORTCUTS = 'Keyboard shortcuts';
export const MORE_OPTIONS = 'More options';
export const FIT_WIDTH = 'Fit width';
export const FIT_PAGE = 'Fit page';
export const GO_TO_PAGE = 'Go to page';
export const PAGE_NUMBER = 'Page number';
export const GO = 'Go';
export const PAGES = 'Pages';
export const SINGLE_KEYS = 'Single-key shortcuts';
export const SINGLE_KEYS_HINT = 'Turn off if you use speech input or keys trigger by mistake.';
export const zoomLevel = (pct: number) => `Zoom level ${pct}%`;
export const zoomAnnounce = (pct: number) => `Zoom ${pct}%`;
export const rotatedTo = (deg: number) => `Rotated to ${deg} degrees.`;
export const pageOf = (n: number, total: number) => `Page ${n} of ${total}`;
export const pageButtonLabel = (n: number, total: number) => `Page ${n} of ${total}. Go to page`;
export const pageRange = (total: number) => `Enter a page from 1 to ${total}.`;
export const downloadLabel = (title: string) => `Download ${title}`;
export const downloadExt = (ext: string) => (ext ? `Download ${ext}` : 'Download');

// ----- Screen sharing (§3.6) -----
export const SHARE_COVER_TITLE = 'Hidden while you share your screen';
export const shareCoverText = (recording: boolean) =>
  recording ? 'Everyone in the call can see your screen, and the recording captures it.' : 'Everyone in the call can see your screen.';
export const shareBanner = (recording: boolean) =>
  recording
    ? "You're sharing your screen and the call is being recorded. Everyone in the call, and the recording, can see this document."
    : "You're sharing your screen. Everyone in the call can see this document.";
export const STOP_SHARING = 'Stop sharing';
export const SHOW_ANYWAY = 'Show anyway';
export const SHOWN_WHILE_SHARING = 'Document shown while you share your screen.';

// ----- Call band and picture-in-picture (§3.3, §3.4) -----
export const SHOW_VIDEO = 'Show video';
export const HIDE_VIDEO = 'Hide video';
export const moveVideoLabel = (name: string) => `Move ${name || 'the other person'}'s video to another corner`;
export const videoMoved = (corner: string) => `Video moved to the ${corner}.`;

/** The keyboard shortcuts popover (§1.10.3). `mod` is "Ctrl" or "⌘". */
export function shortcutRows(mod: string): readonly { keys: string; action: string }[] {
  return [
    { keys: '+ / -', action: 'Zoom in / out' },
    { keys: '0 / 1', action: 'Fit width / Fit page' },
    { keys: 'R / Shift+R', action: 'Rotate clockwise / anticlockwise' },
    { keys: 'Page Down / Page Up', action: 'Next / previous page' },
    { keys: 'Home / End', action: 'First / last page' },
    { keys: 'T', action: 'Show or hide pages' },
    { keys: 'F', action: 'Full screen' },
    { keys: '[ / ]', action: 'Previous / next document' },
    { keys: `${mod}+P`, action: 'Print' },
    { keys: `${mod}+S`, action: 'Download, when available' },
    { keys: 'Esc', action: 'Close' },
  ];
}
