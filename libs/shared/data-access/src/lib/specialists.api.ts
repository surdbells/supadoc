import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  SpecialistPhotoResultDto,
  AvailabilityRangeDto,
  CreateSpecialistParams,
  DayAvailability,
  DaySlotsDto,
  PartOfDay,
  SpecialistSuggestionsDto,
  DoctorInviteResultDto,
  ListAppointmentsQuery,
  PaginatedResponse,
  PricingDto,
  SpecialistAdminDto,
  SpecialistDto,
  SpecialistFacets,
  SpecialistOnboardingReviewDto,
  SpecialtyCount,
  SuccessResponse,
  UpdateSpecialistParams,
  // Back-office doctor management
  AdminSpecialistsQuery,
  AdminSpecialistUpdate,
  ApproveSpecialistInput,
  ReviewDto,
  SpecialistAdminRowDto,
  SpecialistAppointmentRowDto,
  SpecialistAppointmentsQuery,
  SpecialistDetailDto,
  SpecialistHistoryDto,
  SpecialistPayoutsDto,
  SpecialistReviewQueueDto,
  SpecialistReviewSummaryDto,
  SuspendSpecialistDto,
  SuspendSpecialistInput,
  SuspensionPreviewDto,
  VerifyCredentialInput,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService, QueryParams } from './api.service';

/** Query params for the specialist directory. */
export interface ListSpecialistsQuery
  extends Pick<
    ListAppointmentsQuery,
    'page' | 'per_page' | 'sort_by' | 'sort_dir'
  > {
  search?: string;
  specialty?: string;
  /** @deprecated ignored by the API (unavailable doctors are never listed) — use the "when" filters. */
  available?: boolean;
  location?: string;
  language?: string;
  gender?: string;
  mode?: 'online' | 'in_person';
  /** Free on this date ('YYYY-MM-DD' in `tz`, today … today + horizon). Not with `available_within`. */
  available_on?: string;
  available_within?: 'today' | 'tomorrow' | 'week';
  /** On its own (no date) it means "in the booking window". */
  part_of_day?: PartOfDay | 'any';
  /** The viewer's IANA zone — always send it with a date filter (viewerTimeZone()). */
  tz?: string;
  fee_max?: number | string;
  min_rating?: number | string;
  min_years?: number | string;
}

/**
 * Public directory search (GET /api/public/specialists): the directory's
 * filters, paged by `limit` (≤ 24) and `page`. `sort_by` name (default) |
 * rating | consultation_fee | years_experience | reviews_count | soonest.
 */
export interface PublicSpecialistSearchParams
  extends Omit<ListSpecialistsQuery, 'per_page' | 'available'> {
  limit?: number;
}

/** GET /api/public/specialists/suggestions — similar doctors free on a date. */
export interface SpecialistSuggestionParams {
  /** Compare with this doctor: excluded, and their specialty + fee are inherited. */
  like?: string;
  /** Required without `like`. */
  specialty?: string;
  /** 'YYYY-MM-DD' in `tz` (default today). */
  date?: string;
  part_of_day?: PartOfDay | 'any';
  tz?: string;
  language?: string;
  gender?: string;
  location?: string;
  mode?: 'online' | 'in_person';
  fee_max?: number | string;
  /** Default 4, at most 8. */
  limit?: number;
}

/** Specialist directory client for the VideoMed backend (customer portal). */
@Injectable({ providedIn: 'root' })
export class SpecialistsApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /** Resolve a relative asset path (e.g. a photo_url) to an absolute URL. */
  assetUrl(relative: string | null | undefined): string | null {
    if (!relative) return null;
    if (/^https?:\/\//.test(relative)) return relative;
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return `${base}/${relative.replace(/^\/+/, '')}`;
  }

  /** GET /api/portal/specialists — the bookable specialist directory. */
  list(
    query?: ListSpecialistsQuery,
  ): Observable<PaginatedResponse<SpecialistDto>> {
    return this.api.get<PaginatedResponse<SpecialistDto>>(
      'api/portal/specialists',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/public/specialists/{id} — one specialist (public, for booking). */
  getPublic(id: string): Observable<SuccessResponse<SpecialistDto>> {
    return this.api.get<SuccessResponse<SpecialistDto>>(
      `api/public/specialists/${encodeURIComponent(id)}`,
    );
  }

  /** GET /api/portal/specialists/specialties — distinct specialties for filtering. */
  specialties(): Observable<SuccessResponse<string[]>> {
    return this.api.get<SuccessResponse<string[]>>(
      'api/portal/specialists/specialties',
    );
  }

  /**
   * GET /api/public/specialists/{id}/slots?days=N — legacy: the next N days with
   * open slots, grouped by UTC date. Prefer {@link availability} + {@link daySlots}.
   */
  slots(
    id: string,
    days = 7,
  ): Observable<SuccessResponse<DayAvailability[]>> {
    return this.api.get<SuccessResponse<DayAvailability[]>>(
      `api/public/specialists/${encodeURIComponent(id)}/slots`,
      { days },
    );
  }

  /**
   * GET /api/public/specialists/{id}/availability — the booking calendar: a
   * status per date for `from` … `to` (at most 42 days, i.e. a 6-week grid),
   * the bookable window and the next opening. Dates are days in `tz`.
   */
  availability(
    id: string,
    params: { from: string; to: string; tz?: string },
  ): Observable<SuccessResponse<AvailabilityRangeDto>> {
    return this.api.get<SuccessResponse<AvailabilityRangeDto>>(
      `api/public/specialists/${encodeURIComponent(id)}/availability`,
      params,
    );
  }

  /** GET /api/public/specialists/{id}/slots?date= — the open times on one date (in `tz`). */
  daySlots(
    id: string,
    date: string,
    tz?: string,
  ): Observable<SuccessResponse<DaySlotsDto>> {
    return this.api.get<SuccessResponse<DaySlotsDto>>(
      `api/public/specialists/${encodeURIComponent(id)}/slots`,
      { date, tz },
    );
  }

  /**
   * GET /api/specialists/{id}/availability — the booking calendar for staff
   * booking on a patient's behalf (`appointments.create` or `.book`): like
   * {@link availability}, but reaching a year ahead (not the patient horizon)
   * and shown for a doctor switched off for bookings. Use it through
   * `AvailabilityCalendarStore.load(id, tz, { scope: 'staff' })`.
   */
  staffAvailability(
    id: string,
    params: { from: string; to: string; tz?: string },
  ): Observable<SuccessResponse<AvailabilityRangeDto>> {
    return this.api.get<SuccessResponse<AvailabilityRangeDto>>(
      `api/specialists/${encodeURIComponent(id)}/availability`,
      params,
    );
  }

  /** GET /api/specialists/{id}/slots?date= — staff: the open times on one date (in `tz`), as {@link staffAvailability}. */
  staffDaySlots(
    id: string,
    date: string,
    tz?: string,
  ): Observable<SuccessResponse<DaySlotsDto>> {
    return this.api.get<SuccessResponse<DaySlotsDto>>(
      `api/specialists/${encodeURIComponent(id)}/slots`,
      { date, tz },
    );
  }

  /**
   * GET /api/public/specialists/suggestions — similar doctors (same specialty)
   * free on a date, tiered, each with a `match.reason`; `requested` says whether
   * the `like` doctor is free that date and when they next are.
   */
  suggestions(
    params: SpecialistSuggestionParams,
  ): Observable<SuccessResponse<SpecialistSuggestionsDto>> {
    return this.api.get<SuccessResponse<SpecialistSuggestionsDto>>(
      'api/public/specialists/suggestions',
      params as QueryParams,
    );
  }

  /** GET /api/public/specialties — specialties + counts (no auth, homepage). */
  publicSpecialties(): Observable<SuccessResponse<SpecialtyCount[]>> {
    return this.api.get<SuccessResponse<SpecialtyCount[]>>(
      'api/public/specialties',
    );
  }

  /** GET /api/public/facets — filter options (specialties/locations/languages). */
  publicFacets(): Observable<SuccessResponse<SpecialistFacets>> {
    return this.api.get<SuccessResponse<SpecialistFacets>>(
      'api/public/facets',
    );
  }

  /** GET /api/public/pricing — currency + guest/platform fees (no auth). */
  pricing(): Observable<SuccessResponse<PricingDto>> {
    return this.api.get<SuccessResponse<PricingDto>>('api/public/pricing');
  }

  /**
   * GET /api/specialists — every specialist (up to 500, by name, incl. the
   * contact email), for pickers. Staff-scoped (needs `specialists.manage`).
   * The back-office list pages with {@link listAdminPage}.
   */
  listAdmin(): Observable<SuccessResponse<SpecialistAdminDto[]>> {
    return this.api.get<SuccessResponse<SpecialistAdminDto[]>>('api/specialists');
  }

  /**
   * GET /api/specialists?q=&filter=&page=… — the back-office list, server-
   * paginated: search, one filter (review, changes, onboarding, rejected,
   * approved, suspended, licence_expiring, licence_expired,
   * credentials_missing, credentials_pending) and sort.
   */
  listAdminPage(
    query: AdminSpecialistsQuery,
  ): Observable<PaginatedResponse<SpecialistAdminRowDto>> {
    return this.api.get<PaginatedResponse<SpecialistAdminRowDto>>(
      'api/specialists',
      { page: 1, per_page: 20, ...query } as QueryParams,
    );
  }

  /**
   * GET /api/specialists/review-queue — what waits for a reviewer: profiles in
   * review, change requests, documents to verify (`total` is the badge), plus
   * licence and missing-document counts. Staff-scoped (`specialists.manage`).
   */
  reviewQueue(): Observable<SuccessResponse<SpecialistReviewQueueDto>> {
    return this.api.get<SuccessResponse<SpecialistReviewQueueDto>>('api/specialists/review-queue');
  }

  /**
   * POST /api/specialists — onboard a new specialist from the back office.
   * Staff-scoped (needs `specialists.manage`).
   */
  createAdmin(
    params: CreateSpecialistParams,
  ): Observable<SuccessResponse<SpecialistAdminDto>> {
    return this.api.post<SuccessResponse<SpecialistAdminDto>>(
      'api/specialists',
      params,
    );
  }

  /**
   * PATCH /api/specialists/{id} — back-office edit of a specialist's contact,
   * booking and public-profile fields (not the locked identity fields; `verified`
   * is ignored — it follows approval). Staff-scoped (needs `specialists.manage`);
   * audited before/after; the response echoes the otherwise server-side email.
   */
  update(
    id: string,
    params: UpdateSpecialistParams | AdminSpecialistUpdate,
  ): Observable<SuccessResponse<SpecialistAdminDto>> {
    return this.api.patch<SuccessResponse<SpecialistAdminDto>>(
      `api/specialists/${encodeURIComponent(id)}`,
      params,
    );
  }

  /**
   * POST /api/specialists/{id}/photo (multipart `photo`) — upload or replace a
   * doctor's headshot from the back office: JPG, PNG or WebP, ≤ 2 MB
   * (SPECIALIST_PHOTO_*), verified from the bytes server-side. Emits HttpEvents
   * (UploadProgress for the bar, Response with the updated specialist —
   * `photo_url` is the new path). Audited; needs `specialists.manage`. 422
   * `errors.photo` when the image is refused.
   */
  uploadPhoto(
    id: string,
    file: File,
  ): Observable<HttpEvent<SuccessResponse<SpecialistPhotoResultDto>>> {
    const form = new FormData();
    form.append('photo', file, file.name);
    return this.http.post<SuccessResponse<SpecialistPhotoResultDto>>(
      this.api.absoluteUrl(`api/specialists/${encodeURIComponent(id)}/photo`),
      form,
      { reportProgress: true, observe: 'events' },
    );
  }

  /** DELETE /api/specialists/{id}/photo — remove the doctor's headshot (idempotent, audited). */
  removePhoto(id: string): Observable<SuccessResponse<SpecialistPhotoResultDto>> {
    return this.api.delete<SuccessResponse<SpecialistPhotoResultDto>>(
      `api/specialists/${encodeURIComponent(id)}/photo`,
    );
  }

  /**
   * POST /api/specialists/{id}/invite — email the doctor a one-time link to set
   * their password (creating / linking their login). Calling again resends.
   */
  invite(id: string): Observable<SuccessResponse<DoctorInviteResultDto>> {
    return this.api.post<SuccessResponse<DoctorInviteResultDto>>(
      `api/specialists/${encodeURIComponent(id)}/invite`,
      {},
    );
  }

  /** GET /api/specialists/{id}/onboarding — checklist, profile + login (review panel). */
  onboardingReview(id: string): Observable<SuccessResponse<SpecialistOnboardingReviewDto>> {
    return this.api.get<SuccessResponse<SpecialistOnboardingReviewDto>>(
      `api/specialists/${encodeURIComponent(id)}/onboarding`,
    );
  }

  /**
   * POST /api/specialists/{id}/approve {attest, note?} — list + make bookable
   * (emails the doctor). 422 with every reason by field (`approval.problems` on
   * the review payload says the same beforehand) unless the documents are
   * verified, the terms accepted and `attest` is true — so the caller always
   * passes the reviewer's attestation explicitly.
   */
  approve(
    id: string,
    input: ApproveSpecialistInput,
  ): Observable<SuccessResponse<SpecialistReviewSummaryDto>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto>>(
      `api/specialists/${encodeURIComponent(id)}/approve`,
      input,
    );
  }

  /** POST /api/specialists/{id}/reject — send the profile back with a reason. */
  reject(id: string, reason: string): Observable<SuccessResponse<SpecialistReviewSummaryDto>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto>>(
      `api/specialists/${encodeURIComponent(id)}/reject`,
      { reason },
    );
  }

  // ----- Back-office doctor page (all need `specialists.manage`) -----

  /** GET /api/specialists/{id} — the doctor page: review summary, profile, login, masked payout account, stats. */
  detail(id: string): Observable<SuccessResponse<SpecialistDetailDto>> {
    return this.api.get<SuccessResponse<SpecialistDetailDto>>(
      `api/specialists/${encodeURIComponent(id)}`,
    );
  }

  /** GET /api/specialists/{id}/appointments — the doctor's consultations (patient names only), newest first. */
  doctorAppointments(
    id: string,
    query?: SpecialistAppointmentsQuery,
  ): Observable<PaginatedResponse<SpecialistAppointmentRowDto>> {
    return this.api.get<PaginatedResponse<SpecialistAppointmentRowDto>>(
      `api/specialists/${encodeURIComponent(id)}/appointments`,
      query as QueryParams | undefined,
    );
  }

  /** GET /api/specialists/{id}/payouts — earnings summary, payouts and the (masked) payout account. */
  doctorPayouts(id: string): Observable<SuccessResponse<SpecialistPayoutsDto>> {
    return this.api.get<SuccessResponse<SpecialistPayoutsDto>>(
      `api/specialists/${encodeURIComponent(id)}/payouts`,
    );
  }

  /** GET /api/specialists/{id}/reviews — patients' reviews, newest first. */
  doctorReviews(
    id: string,
    query?: { page?: number; per_page?: number },
  ): Observable<PaginatedResponse<ReviewDto>> {
    return this.api.get<PaginatedResponse<ReviewDto>>(
      `api/specialists/${encodeURIComponent(id)}/reviews`,
      query as QueryParams | undefined,
    );
  }

  /** GET /api/specialists/{id}/history — status events + the audit trail for this doctor. */
  history(id: string): Observable<SuccessResponse<SpecialistHistoryDto>> {
    return this.api.get<SuccessResponse<SpecialistHistoryDto>>(
      `api/specialists/${encodeURIComponent(id)}/history`,
    );
  }

  /**
   * GET /api/specialists/{id}/credentials/{cid}/file — one of the doctor's
   * documents as a Blob (show it from an object URL; revoke it after). Every
   * view is audited server-side.
   */
  credentialFile(id: string, credentialId: string): Observable<Blob> {
    return this.api.getBlob(
      `api/specialists/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/file`,
    );
  }

  /** POST …/credentials/{cid}/verify — verify a waiting document with the reviewer's attestation. */
  verifyCredential(
    id: string,
    credentialId: string,
    input: VerifyCredentialInput,
  ): Observable<SuccessResponse<SpecialistReviewSummaryDto>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto>>(
      `api/specialists/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/verify`,
      input,
    );
  }

  /** POST …/credentials/{cid}/reject — turn a document down with a reason the doctor sees. */
  rejectCredential(
    id: string,
    credentialId: string,
    reason: string,
  ): Observable<SuccessResponse<SpecialistReviewSummaryDto>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto>>(
      `api/specialists/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/reject`,
      { reason },
    );
  }

  /** GET /api/specialists/{id}/suspend/preview — what suspending would cancel and refund (changes nothing). */
  suspensionPreview(id: string): Observable<SuccessResponse<SuspensionPreviewDto>> {
    return this.api.get<SuccessResponse<SuspensionPreviewDto>>(
      `api/specialists/${encodeURIComponent(id)}/suspend/preview`,
    );
  }

  /**
   * POST /api/specialists/{id}/suspend {code, reason} — the doctor stopped
   * practising: unlisted, signed out, future bookings cancelled + refunded,
   * proposals withdrawn, patients told. `affected.incomplete` → call it again.
   */
  suspend(
    id: string,
    input: SuspendSpecialistInput,
  ): Observable<SuccessResponse<SuspendSpecialistDto>> {
    return this.api.post<SuccessResponse<SuspendSpecialistDto>>(
      `api/specialists/${encodeURIComponent(id)}/suspend`,
      input,
    );
  }

  /** POST /api/specialists/{id}/reinstate {note} — needs a verified, unexpired licence; restores no booking. */
  reinstate(id: string, note: string): Observable<SuccessResponse<SpecialistReviewSummaryDto>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto>>(
      `api/specialists/${encodeURIComponent(id)}/reinstate`,
      { note },
    );
  }

  /** POST /api/specialists/{id}/changes/approve — the doctor's requested changes go live. */
  approveChanges(
    id: string,
  ): Observable<SuccessResponse<SpecialistReviewSummaryDto & { profile: SpecialistDetailDto['profile'] }>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto & { profile: SpecialistDetailDto['profile'] }>>(
      `api/specialists/${encodeURIComponent(id)}/changes/approve`,
      {},
    );
  }

  /** POST /api/specialists/{id}/changes/reject {reason} — turn the requested changes down. */
  rejectChanges(id: string, reason: string): Observable<SuccessResponse<SpecialistReviewSummaryDto>> {
    return this.api.post<SuccessResponse<SpecialistReviewSummaryDto>>(
      `api/specialists/${encodeURIComponent(id)}/changes/reject`,
      { reason },
    );
  }

  /**
   * GET /api/public/specialists — public specialist search (no auth), paged
   * (`meta`); every doctor carries `availability`.
   */
  publicSearch(
    params: PublicSpecialistSearchParams,
  ): Observable<PaginatedResponse<SpecialistDto>> {
    return this.api.get<PaginatedResponse<SpecialistDto>>(
      'api/public/specialists',
      params as QueryParams,
    );
  }
}
