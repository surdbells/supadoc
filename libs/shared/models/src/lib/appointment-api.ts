/**
 * Wire shapes returned by the VideoMed backend (apps/api) — these mirror the
 * entities' `toArray()` output and the standard `{status,message,data,meta}`
 * envelope. Distinct from the richer domain types in `appointment.ts`, which
 * predate the real API.
 */

export type ApiAppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'rescheduled'
  | 'completed'
  | 'cancelled';

export interface ApiSpecialistRef {
  id: string;
  name: string;
  specialty?: string | null;
}

/** One appointment as serialised by `Appointment::toArray()`. */
export interface AppointmentDto {
  id: string;
  patient_id: string;
  specialist: ApiSpecialistRef;
  scheduled_at: string;
  type: string;
  type_label: string;
  status: ApiAppointmentStatus;
  status_label: string;
  amount: string;
  created_at: string;
}

export interface PageMeta {
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

/** Paginated success envelope: `{ status, message, data: T[], meta }`. */
export interface PaginatedResponse<T> {
  status: string;
  message: string;
  data: T[];
  meta: PageMeta;
}

/** Query params accepted by the portal appointments list endpoint. */
export interface ListAppointmentsQuery {
  page?: number;
  per_page?: number;
  status?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}
