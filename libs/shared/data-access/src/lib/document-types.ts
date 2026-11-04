/**
 * Which patient documents a doctor can open in VideoMed's view-only viewer.
 * Mirrors the API's `DocumentSharingRules::VIEWABLE_EXTENSIONS` (the server
 * also checks the stored type, and answers 415 `not_viewable` for the rest).
 */

/** Extensions a doctor can view in-app: PDF, photos (JPG, PNG, WEBP) and videos (MP4, WEBM). */
export const DOCTOR_VIEWABLE_EXTENSIONS: readonly string[] = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm'];

/** A file input `accept` for only those types (the in-call upload). */
export const DOCTOR_VIEWABLE_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.webp,.mp4,.webm,application/pdf,image/jpeg,image/png,image/webp,video/mp4,video/webm';

/** A file name's extension, lower-cased and without the dot ('' when it has none). */
export function fileExtension(name: string): string {
  const base = (name ?? '').trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Whether a doctor could open a file of this name in VideoMed (by extension).
 * False for DOCX, DOC, DCM, MOV and anything without an extension: warn the
 * patient before sharing such a file ("Share a PDF or photo").
 */
export function isDoctorViewableName(name: string): boolean {
  return DOCTOR_VIEWABLE_EXTENSIONS.includes(fileExtension(name));
}
