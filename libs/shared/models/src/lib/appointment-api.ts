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

/** Single-resource success envelope: `{ status, message, data }`. */
export interface SuccessResponse<T> {
  status: string;
  message: string;
  data: T;
}

/** Paginated success envelope: `{ status, message, data: T[], meta }`. */
export interface PaginatedResponse<T> {
  status: string;
  message: string;
  data: T[];
  meta: PageMeta;
}

/** One specialist as serialised by `Specialist::toArray()`. */
export interface SpecialistDto {
  id: string;
  name: string;
  specialty: string;
  location: string | null;
  consultation_fee: string;
  rating: string;
  reviews_count: number;
  available: boolean;
}

/** Agora RTC join credentials for a consultation call. */
export interface CallTokenDto {
  app_id: string;
  channel: string;
  uid: number;
  token: string;
  expires_in: number;
}

/** The signed-in patient's profile, from `Patient::toArray()`. */
export interface PatientProfileDto {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  phone_verified: boolean;
  date_of_birth: string | null;
  created_at: string;
}

/** One notification, from `Notification::toArray()`. */
export interface NotificationDto {
  id: string;
  type: 'appointment' | 'prescription' | 'payment' | 'system';
  type_label: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

/** Notifications list — the page meta also carries the total unread count. */
export interface NotificationsResponse {
  status: string;
  message: string;
  data: NotificationDto[];
  meta: PageMeta & { unread: number };
}

/** Query params accepted by the portal appointments list endpoint. */
export interface ListAppointmentsQuery {
  page?: number;
  per_page?: number;
  status?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}
