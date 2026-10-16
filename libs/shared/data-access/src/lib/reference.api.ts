import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  CreateReferenceItemParams,
  PublicReferenceItemDto,
  ReferenceCategory,
  ReferenceItemDto,
  SuccessResponse,
  UpdateReferenceItemParams,
} from '@supadoc/models';
import { ApiService } from './api.service';

/**
 * Reference data — back-office-managed pick lists (first list: `specialty`).
 *
 * Forms that store a value from a list (the back office's new-specialist form,
 * the doctor's onboarding profile) offer {@link publicList}'s labels and send a
 * label back: the API accepts only an ACTIVE item's label (any case) and saves
 * it in the list's spelling — else 422 `errors.specialty` "Choose a specialty
 * from the list" (a doctor's current, since switched-off, specialty is kept).
 *
 * The staff methods need `settings.manage` (reading: `settings.manage` or
 * `specialists.manage`); every change is audited. Errors arrive in the usual
 * envelope — show them with `apiErrorMessage`.
 */
@Injectable({ providedIn: 'root' })
export class ReferenceApi {
  private readonly api = inject(ApiService);

  /**
   * GET /api/public/reference/{category} — the active items in list order
   * (public, no auth; cacheable for 60 s).
   */
  publicList(category: ReferenceCategory): Observable<SuccessResponse<PublicReferenceItemDto[]>> {
    return this.api.get<SuccessResponse<PublicReferenceItemDto[]>>(
      `api/public/reference/${encodeURIComponent(category)}`,
    );
  }

  /**
   * GET /api/reference/{category} — every item, active or not, in list order,
   * each with `usage_count` (doctors using it).
   */
  list(category: ReferenceCategory): Observable<SuccessResponse<ReferenceItemDto[]>> {
    return this.api.get<SuccessResponse<ReferenceItemDto[]>>(
      `api/reference/${encodeURIComponent(category)}`,
    );
  }

  /**
   * POST /api/reference/{category} — add an item (201). 422 per field: `label`
   * blank / over 120 characters / already on the list (in any case — the
   * message says when that one is switched off), `code`, `sort_order`, `active`.
   */
  create(
    category: ReferenceCategory,
    params: CreateReferenceItemParams,
  ): Observable<SuccessResponse<ReferenceItemDto>> {
    return this.api.post<SuccessResponse<ReferenceItemDto>>(
      `api/reference/${encodeURIComponent(category)}`,
      params,
    );
  }

  /**
   * PATCH /api/reference/{category}/{id} — rename, move or switch on/off (only
   * the keys sent change). A rename re-labels every doctor who had the old
   * label; `data.specialists_updated` says how many.
   */
  update(
    category: ReferenceCategory,
    id: string,
    params: UpdateReferenceItemParams,
  ): Observable<SuccessResponse<ReferenceItemDto>> {
    return this.api.patch<SuccessResponse<ReferenceItemDto>>(
      `api/reference/${encodeURIComponent(category)}/${encodeURIComponent(id)}`,
      params,
    );
  }

  /**
   * POST /api/reference/{category}/reorder — the item ids in the order wanted
   * (left-out items follow in their current order; sort orders become 10, 20,
   * 30…). Returns the whole list, as {@link list} does.
   */
  reorder(category: ReferenceCategory, ids: string[]): Observable<SuccessResponse<ReferenceItemDto[]>> {
    return this.api.post<SuccessResponse<ReferenceItemDto[]>>(
      `api/reference/${encodeURIComponent(category)}/reorder`,
      { ids },
    );
  }

  /**
   * DELETE /api/reference/{category}/{id} — remove an unused item. One in use
   * is refused with 422 "In use by N doctors — deactivate it instead" (also
   * `errors.item`): switch it off with {@link update} `{ active: false }`.
   */
  remove(category: ReferenceCategory, id: string): Observable<SuccessResponse<{ id: string }>> {
    return this.api.delete<SuccessResponse<{ id: string }>>(
      `api/reference/${encodeURIComponent(category)}/${encodeURIComponent(id)}`,
    );
  }
}
