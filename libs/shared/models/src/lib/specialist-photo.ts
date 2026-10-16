// ----- Specialist photo, uploaded by the back office -----

import type { SpecialistAdminDto } from './appointment-api';

/**
 * POST / DELETE /api/specialists/{id}/photo — the updated specialist (the
 * PATCH /api/specialists/{id} payload); `photo_url` is the new
 * `/uploads/avatars/dr-{id}-….{jpg|png|webp}` path, or null once removed.
 * Show it through `SpecialistsApi.assetUrl(photo_url)`.
 *
 * 422 `errors.photo`: "No image was uploaded" | "Image must be 2MB or smaller" |
 * "Only JPG, PNG or WEBP images are allowed".
 */
export type SpecialistPhotoResultDto = SpecialistAdminDto;

/** What the back office may upload (checked again from the bytes server-side). */
export const SPECIALIST_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** For an `<input type="file" accept>` / sd-file-drop. */
export const SPECIALIST_PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';

/** 2 MB. */
export const SPECIALIST_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
