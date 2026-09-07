/** Support ticket categories + statuses (mirror of the API enums). */
export type SupportCategory = 'general' | 'billing' | 'technical' | 'appointment';
export type SupportStatus = 'open' | 'pending' | 'resolved' | 'closed';

/** A support ticket summary (list + header). */
export interface SupportTicketDto {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_email: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  last_message_at: string;
  last_message_preview: string;
  last_message_role: 'patient' | 'staff';
  created_at: string;
}

/** One message in a support ticket thread. */
export interface SupportMessageDto {
  id: string;
  ticket_id: string;
  author_role: 'patient' | 'staff';
  author_name: string;
  body: string;
  created_at: string;
}

/** A ticket with its full thread (GET .../support/tickets/{id}). */
export interface SupportThreadDto {
  ticket: SupportTicketDto;
  messages: SupportMessageDto[];
}

/** Body for opening a ticket. */
export interface CreateTicketParams {
  subject: string;
  category: SupportCategory;
  message: string;
}
