import type { Signal, TemplateRef } from '@angular/core';
import type { Observable } from 'rxjs';

/** What a viewer may do with a document (§2.2); hosts pick one, never single permissions. */
export type ViewerPolicyId =
  | 'view_only'
  | 'authored'
  | 'authored_print'
  | 'authored_draft'
  | 'owner'
  | 'staff_record'
  | 'staff_verification';

/** `auto`: the patient app, following `html[data-theme]`. */
export type ViewerTone = 'light' | 'dark' | 'auto';

export type ViewerKind = 'pdf' | 'image' | 'video' | 'none';

/** The bytes of one open (fetched once per open; zoom, rotate, page and print never re-fetch). */
export interface ViewerFile {
  readonly blob: Blob;
  /** The served Content-Type, lower-case, no parameters. */
  readonly mime: string;
  /** "VM-7F3A2C1D" (view_only), else absent. */
  readonly viewRef?: string | null;
  /** ISO, for the watermark (view_only). */
  readonly viewedAt?: string;
}

export interface ViewerErrorView {
  readonly state: 'error' | 'not_viewable' | 'gone' | 'reload';
  readonly text: string;
  /** Shows "Try again". */
  readonly retry: boolean;
}

export interface ViewerSource {
  /** Stable per document, e.g. "doc:<id>", "rx:<id>". */
  readonly key: string;
  readonly title: string;
  /** "Lab report", "Prescription", "Referral letter". */
  readonly typeLabel: string;
  /** "pdf". */
  readonly extension?: string | null;
  /** "1.2 MB". */
  readonly sizeLabel?: string | null;
  /** Extra header parts, e.g. "Added 3 Nov 2026", "Patient upload". */
  readonly meta?: readonly string[];
  /** false: the not-viewable card at once, nothing fetched. */
  readonly viewable?: boolean;
  readonly policy: ViewerPolicyId;
  /** Blob Download name (default `safeFilename(title, extension)`). */
  readonly filename?: string;
  load(): Observable<ViewerFile>;
  /** Required when the policy's print is 'audited'. Must succeed before printing. */
  recordPrint?(file: ViewerFile): Observable<unknown>;
  /**
   * Signed attachment link (prescriptions, lab request PDFs): Download mints a download link
   * (one `…downloaded` audit row) and fetches it as a Blob with HttpClient, instead of saving
   * the viewed blob. Never a cross-origin <a href> navigation (§1.8.2).
   */
  download?(): Observable<{ readonly blob: Blob; readonly filename: string }>;
  /** Host-specific error copy; return null for the default mapping. */
  mapError?(err: unknown): ViewerErrorView | null;
  /** The error meant "no longer shared / gone": the host refreshes its list. */
  onGone?(): void;
}

export interface ViewerWatermark {
  readonly viewerName: string;
  readonly timeZone: string;
}

export interface ViewerOpenOptions {
  /** Start position in a list (default 0). */
  readonly index?: number;
  /** Default: `document.activeElement` at open(). */
  readonly opener?: HTMLElement | null;
  /** When the opener is gone after closing. */
  readonly fallbackFocus?: () => HTMLElement | null;
  /** Default `VIEWER_DEFAULTS.tone` ('light'; patient app 'auto'); a registered call overrides it (§3). */
  readonly tone?: ViewerTone;
  /** Required for view_only (refused without it, §1.16). */
  readonly watermark?: ViewerWatermark;
  /** Patient prescription "Print" (§6.3). */
  readonly autoPrint?: boolean;
  /** E.g. "shared documents", for "Document 2 of 5 in shared documents". */
  readonly listLabel?: string;
}

/** A call page's context while it lives (§3). */
export interface ViewerCallContext {
  /**
   * The host's call band content (rendered inside `.sd-call[data-theme=dark]`, §1.9).
   * A button's text label marked `data-band-label` is for screen readers only on a
   * phone held sideways, where the band shares one 48 px row (§1.3.5: Back to call is
   * icon-only there); it stays the button's name.
   */
  readonly bar: TemplateRef<unknown>;
  /** The host's `<sd-call-peer-tile>` (null: no tile). */
  readonly peer: TemplateRef<unknown> | null;
  readonly peerName: Signal<string>;
  /** The cockpit's theme. */
  readonly tone: Signal<'dark' | 'light'>;
  /** A computed over signals (§3.2): print asks first, Reload is hidden. */
  readonly live: Signal<boolean>;
  readonly sharingScreen: Signal<boolean>;
  /** The cloud recording is running (banner copy, §3.6). */
  readonly recording: Signal<boolean>;
  stopSharing(): void;
  /** Hand the remote video to the tile (after every check passed, §1.2.4). */
  willOpen(): void;
  /** Take it back (after the tile has been destroyed and stopped, §3.4). */
  didClose(): void;
}

export interface ViewerResumeState {
  readonly page: number;
  readonly zoomMode: 'auto' | 'width' | 'page' | 'custom';
  readonly zoom: number;
  readonly rotation: 0 | 90 | 180 | 270;
}

/** The body's `state` output (resume). */
export interface ViewerState extends ViewerResumeState {
  readonly total: number;
}

/** Where the stage scroller sits inside the body host (px), for the PiP layer. */
export interface ViewerInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ViewerRef {
  /** Resolves when this open ends (closed, or replaced by another open). */
  readonly closed: Promise<void>;
  close(): void;
}

/** One open of the viewer (read by the outlet). */
export interface ViewerSession {
  /** Increments per open(). */
  readonly seq: number;
  readonly sources: readonly ViewerSource[];
  /** Per source: why §1.16 refused it (never loaded), else null. */
  readonly refused: readonly (string | null)[];
  readonly options: ViewerOpenOptions;
}
