/**
 * Reference data: back-office-managed pick lists (first list: doctors'
 * specialties). Records store an item's `label` (a doctor's `specialty` is the
 * label string), so a form offers the labels and sends one back.
 */

/** The pick lists the API knows (an unknown one is a 404). */
export type ReferenceCategory = 'specialty';

/**
 * An active item as a form offers it — `GET /api/public/reference/{category}`
 * (public, cacheable for 60 s), in list order.
 */
export interface PublicReferenceItemDto {
  id: string;
  /** Stable slug, kept through renames (e.g. `ent-otolaryngology`). */
  code: string;
  /** What records store and people see (e.g. "ENT (Otolaryngology)"). */
  label: string;
  sort_order: number;
}

/** An item in the back office — `GET /api/reference/{category}` and the write endpoints. */
export interface ReferenceItemDto extends PublicReferenceItemDto {
  category: ReferenceCategory;
  /** Offered in the pick list; a switched-off item stays on the records that have it. */
  active: boolean;
  /** How many doctors (not deleted) have this label, case and spacing aside. */
  usage_count: number;
  created_at: string | null;
  updated_at: string | null;
  /** PATCH only: doctors re-labelled by a rename. */
  specialists_updated?: number;
}

/** `POST /api/reference/{category}` (needs `settings.manage`). */
export interface CreateReferenceItemParams {
  /** Required, ≤ 120 characters, not already on the list in any case. */
  label: string;
  /** Optional lower-case slug; made from the label when absent. */
  code?: string;
  /** Default: after the last item. */
  sort_order?: number;
  /** Default true. */
  active?: boolean;
}

/**
 * `PATCH /api/reference/{category}/{id}` (needs `settings.manage`) — only the
 * keys sent change. A new label is given to every doctor who had the old one.
 */
export interface UpdateReferenceItemParams {
  label?: string;
  sort_order?: number;
  active?: boolean;
}

/** `POST /api/reference/{category}/reorder` — item ids in the order wanted (left-out items follow). */
export interface ReorderReferenceItemsParams {
  ids: string[];
}
