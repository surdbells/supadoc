/** One selectable medical-document type (value + human label). */
export interface DocumentTypeOption {
  readonly value: string;
  readonly label: string;
}

/** A file in a patient's medical record. */
export interface MedicalDocumentDto {
  readonly id: string;
  readonly patient_id: string;
  readonly uploader_role: 'patient' | 'doctor' | 'staff';
  readonly uploader_name: string;
  readonly appointment_id: string | null;
  readonly document_type: string;
  readonly custom_type: string | null;
  readonly type_label: string;
  readonly title: string;
  readonly extension: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly size_label: string;
  readonly created_at: string;
}

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
