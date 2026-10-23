// ----- Back-office dashboard (GET /api/admin/dashboard) -----

import type { ApiAppointmentStatus } from './appointment-api';

/** `?period=` — today (midnight … now), the last 7 or 30 days (today included). */
export type AdminDashboardPeriod = 'today' | '7d' | '30d';

/** Query for {@link AdminDashboardDto}. */
export interface AdminDashboardQuery {
  /** Default `today`. */
  period?: AdminDashboardPeriod;
  /** The viewer's IANA zone (`viewerTimeZone()`): where "today" and each trend day start. Default: the clinic's. */
  tz?: string;
  /** Skip the short (≤ 60 s) server cache — e.g. a "Refresh" button. */
  refresh?: boolean;
}

/**
 * A part of the dashboard, granted by the permission its back-office page needs:
 * - `kpis.activity`, `live`, `trends.activity`, `breakdowns.status`,
 *   `breakdowns.specialties`, `breakdowns.activity` → monitoring.view
 * - `kpis.money`, `trends.revenue` (and the revenue columns) → monitoring.view or payouts.manage
 * - `kpis.doctors` → monitoring.view or specialists.manage
 * - `attention.appointments` → appointments.view
 * - `attention.doctors`, `breakdowns.doctors` → specialists.manage
 * - `attention.payouts` → payouts.manage; `attention.support` → support.manage
 * - `attention.payments` → payouts.manage or support.manage
 */
export type AdminDashboardPart =
  | 'kpis.activity'
  | 'kpis.money'
  | 'kpis.doctors'
  | 'live'
  | 'attention.appointments'
  | 'attention.doctors'
  | 'attention.payouts'
  | 'attention.support'
  | 'attention.payments'
  | 'trends.activity'
  | 'trends.revenue'
  | 'breakdowns.status'
  | 'breakdowns.specialties'
  | 'breakdowns.doctors'
  | 'breakdowns.activity';

/** The top-level sections; each is present only when listed in `sections`. */
export type AdminDashboardSection = 'kpis' | 'live' | 'attention' | 'trends' | 'breakdowns';

export type AdminDashboardKpiKey =
  | 'bookings'
  | 'consultations_completed'
  | 'revenue'
  | 'wallet_topups'
  | 'refunds'
  | 'new_patients'
  | 'active_doctors'
  | 'cancellations'
  | 'missed'
  | 'average_rating';

/**
 * One KPI tile, against the previous equal period (`today` → the same hours
 * yesterday; `7d` / `30d` → the 7 / 30 days before).
 *
 * - `format: 'count'` → `value` / `previous` are integers;
 * - `format: 'money'` → strings with 2 decimals, in the dashboard `currency`
 *   (`count` = how many payments / ledger entries);
 * - `format: 'rating'` → 0–5 with 2 decimals, null when no reviews
 *   (`count` = how many reviews).
 *
 * Definitions: bookings = bookings made (follow-up proposals the patient never
 * accepted are not bookings); consultations_completed / cancellations / missed
 * by when they closed; revenue = paid bookings (follow-ups and guest fees
 * included) less what was refunded for them, by booking date; wallet_topups /
 * refunds = successful wallet top-ups / refunds to wallets; new_patients =
 * accounts created; active_doctors = approved and taking bookings now (a
 * snapshot: `previous` null, `breakdown` {approved, taking_bookings});
 * missed `breakdown` = by who didn't come {patient, doctor, both, unknown};
 * average_rating = reviews left in the period.
 */
export interface AdminDashboardKpi {
  key: AdminDashboardKpiKey;
  label: string;
  format: 'count' | 'money' | 'rating';
  value: number | string | null;
  /** null: nothing to compare with (a snapshot). */
  previous: number | string | null;
  /** % change vs `previous` (1 dp); null when previous is 0 / null or value null. */
  change_pct: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  /** Colour the change: up is good (bookings) or bad (refunds, cancellations, missed). */
  higher_is_better: boolean;
  count: number | null;
  previous_count: number | null;
  breakdown: Record<string, number> | null;
}

/** A consultation in "Live now". */
export interface AdminDashboardLiveItem {
  /** Appointment id → /appointments/:id (or /monitoring). */
  id: string;
  /** ISO 8601 with offset (in the requested `tz`). */
  scheduled_at: string;
  ends_at: string;
  status: ApiAppointmentStatus;
  status_label: string;
  type: string;
  patient_name: string;
  specialist: { id: string; name: string; specialty: string; photo_url: string | null };
  /** Who is in the call now (in_progress only); null for starting_soon. */
  in_call: { doctor: boolean; patient: boolean; guests: number } | null;
}

export interface AdminDashboardLiveDto {
  /** Someone is in the call right now. */
  in_progress: AdminDashboardLiveItem[];
  in_progress_count: number;
  /** Open bookings starting within `window_minutes`, soonest first (up to 10). */
  starting_soon: AdminDashboardLiveItem[];
  starting_soon_count: number;
  window_minutes: number;
}

export type AdminDashboardAttentionKey =
  | 'appointments_attention'
  | 'doctor_reviews_pending'
  | 'credentials_to_verify'
  | 'profile_change_requests'
  | 'licences_expiring'
  | 'licences_expired'
  | 'payouts_awaiting_approval'
  | 'support_open'
  | 'topups_held'
  | 'card_payments_review'
  | 'doctor_applications_waiting';

/** A router link to an already-filtered back-office page. */
export interface AdminDashboardLink {
  /** e.g. '/specialists'. */
  path: string;
  /** e.g. { filter: 'review' } — pass as `[queryParams]`. */
  query: Record<string, string>;
}

/**
 * A queue that needs someone (listed even at 0, for an "all clear"). Links:
 * appointments_attention → /appointments?when=attention; doctor_reviews_pending →
 * /specialists?filter=review; credentials_to_verify → ?filter=credentials_pending;
 * profile_change_requests → ?filter=changes; licences_expiring / licences_expired →
 * ?filter=licence_expiring / licence_expired; payouts_awaiting_approval →
 * /payouts?status=pending; support_open → /support?status=open; topups_held and
 * card_payments_review have no back-office page yet (`link` null).
 */
export interface AdminDashboardAttentionItem {
  key: AdminDashboardAttentionKey;
  label: string;
  description: string;
  count: number;
  /** Money total for money queues (payouts, held payments), else null. */
  amount: string | null;
  tone: 'info' | 'warning' | 'alert';
  link: AdminDashboardLink | null;
}

/** One local calendar day of the trend charts; a series the caller can't see is null. */
export interface AdminDashboardTrendDay {
  /** 'YYYY-MM-DD' in the requested `tz`. */
  date: string;
  bookings: number | null;
  completed: number | null;
  revenue: string | null;
}

export interface AdminDashboardTrendsDto {
  from: string;
  to: string;
  /** The series present ('bookings' | 'completed' | 'revenue'). */
  series: ('bookings' | 'completed' | 'revenue')[];
  /** 30 days, oldest first; the last is today. */
  days: AdminDashboardTrendDay[];
  totals: { bookings: number | null; completed: number | null; revenue: string | null };
}

export interface AdminDashboardStatusCount {
  status: ApiAppointmentStatus;
  label: string;
  count: number;
}

export interface AdminDashboardSpecialtyRow {
  specialty: string;
  bookings: number;
  completed: number;
  /** null without a money permission. */
  revenue: string | null;
}

export interface AdminDashboardDoctorRow {
  /** Specialist id → /specialists/:id. */
  id: string;
  name: string;
  specialty: string;
  photo_url: string | null;
  /** Overall rating '4.80' and its review count. */
  rating: string;
  reviews_count: number;
  bookings: number;
  /** Completed consultations. */
  consultations: number;
  /** null without a money permission. */
  revenue: string | null;
  /** Missed consultations the doctor didn't attend (no-show doctor or both). */
  doctor_no_shows: number;
  patient_no_shows: number;
}

export interface AdminDashboardActivityItem {
  id: string;
  action: string;
  /** "Doctor approved". */
  label: string;
  /** "Doctor approved · Dr. Grace Bell". */
  summary: string;
  actor_name: string;
  actor_role: string;
  created_at: string;
  /** The page it concerns, when the caller can open it. */
  link: AdminDashboardLink | null;
}

/**
 * Breakdowns over consultations SCHEDULED from the period start to the end of
 * today (`from` … `to`); recent activity is the latest audit events (routine
 * reads left out).
 */
export interface AdminDashboardBreakdownsDto {
  from: string;
  to: string;
  /** pending, confirmed, rescheduled, completed, missed, cancelled (always all six). */
  by_status?: AdminDashboardStatusCount[];
  /** Up to 6, most bookings first. */
  top_specialties?: AdminDashboardSpecialtyRow[];
  /** Up to 5, most consultations first. */
  top_doctors?: AdminDashboardDoctorRow[];
  /** Up to 8, newest first. */
  recent_activity?: AdminDashboardActivityItem[];
}

/** GET /api/admin/dashboard — each section only when granted (see `parts` / `sections`). */
export interface AdminDashboardDto {
  period: AdminDashboardPeriod;
  timezone: string;
  /** Currency of every money value, e.g. 'NGN'. */
  currency: string;
  generated_at: string;
  /** The current window (`from` … `to` = now) and the previous one it is compared with. */
  range: { from: string; to: string; previous_from: string; previous_to: string };
  parts: AdminDashboardPart[];
  sections: AdminDashboardSection[];
  /** Sections that failed to load this time (the rest still did). */
  unavailable: AdminDashboardSection[];
  kpis?: AdminDashboardKpi[];
  live?: AdminDashboardLiveDto;
  attention?: AdminDashboardAttentionItem[];
  trends?: AdminDashboardTrendsDto;
  breakdowns?: AdminDashboardBreakdownsDto;
}
