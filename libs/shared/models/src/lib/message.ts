/** One message in a per-appointment secure thread between patient and doctor. */
export interface MessageDto {
  readonly id: string;
  readonly appointment_id: string;
  readonly sender_role: 'patient' | 'doctor';
  readonly sender_name: string;
  readonly body: string;
  readonly read: boolean;
  readonly created_at: string;
}
