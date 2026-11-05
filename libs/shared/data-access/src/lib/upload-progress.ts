import { HttpEventType, type HttpEvent } from '@angular/common/http';

/**
 * How far one upload has got, for its progress bar (`<sd-upload-progress>`).
 *
 * Upload progress only arrives through Angular's XHR backend: an app that
 * uploads with a bar needs `withXhr()` in its `provideHttpClient(...)`. The
 * default fetch backend never reports it, so the bar would sit at 0% until the
 * response (the 2026-11-05 "stuck at zero, then suddenly uploaded" report).
 */
export interface UploadProgress {
  /** 0–100: how much of the file has been sent; null while the browser can't tell (no total). */
  readonly percent: number | null;
  /** Every byte is sent: the server is storing the file and hasn't answered yet. */
  readonly finishing: boolean;
}

/** An upload that has just started: nothing sent yet. */
export const UPLOAD_STARTED: UploadProgress = { percent: 0, finishing: false };

/**
 * What one HttpClient upload event (`reportProgress: true, observe: 'events'`)
 * says about the progress, or null when it says nothing (Sent, Response, User).
 *
 * - A total of 0 or none (the browser can't tell the size): `percent` null,
 *   so the bar is indeterminate rather than stuck at 0%.
 * - 100% only once every byte is out (never rounded up from 99.6%); the
 *   upload is then `finishing` until the response arrives.
 * - The server starting to answer (response headers, download progress) is
 *   finishing too, whatever upload events came before.
 */
export function uploadProgressFrom(event: HttpEvent<unknown>): UploadProgress | null {
  switch (event.type) {
    case HttpEventType.UploadProgress: {
      const total = event.total ?? 0;
      if (!(total > 0)) return { percent: null, finishing: false };
      if (event.loaded >= total) return { percent: 100, finishing: true };
      return { percent: Math.max(0, Math.min(99, Math.floor((event.loaded / total) * 100))), finishing: false };
    }
    case HttpEventType.ResponseHeader:
    case HttpEventType.DownloadProgress:
      return { percent: 100, finishing: true };
    default:
      return null;
  }
}

/** The short visible status: "42%", "Finishing…", or "Uploading…" while the size is unknown. */
export function uploadProgressText(progress: UploadProgress): string {
  if (progress.finishing) return 'Finishing…';
  return progress.percent === null ? 'Uploading…' : `${progress.percent}%`;
}

/** What screen readers hear (politely) once every byte is sent: "scan.pdf is sent. Finishing up…". */
export function uploadFinishingText(subject: string): string {
  return `${subject.trim() || 'The file'} is sent. Finishing up…`;
}
