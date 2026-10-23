import type {
  ApplicationDocumentDto,
  ApprovalDocumentPrefillDto,
  ApprovalPreviewDto,
  DoctorApplicationDetailDto,
  DoctorApplicationRowDto,
} from '@supadoc/models';

/**
 * Test data for the doctor-application specs (not used by the app itself).
 * Made-up people and numbers only.
 */

export function applicationRow(over: Partial<DoctorApplicationRowDto> = {}): DoctorApplicationRowDto {
  return {
    id: 'app-1',
    reference: 'GVM-DR-2026-48213',
    status: 'submitted',
    status_label: 'New',
    full_name: 'Ada Obi',
    email: 'ada@example.test',
    specialty: 'Cardiology',
    licence_route: 'ng',
    licence_label: 'Nigeria · MDCN',
    submitted_at: '2026-10-20T09:00:00+00:00',
    awaiting_staff: true,
    interview_starts_at: null,
    last_activity_at: '2026-10-20T09:00:00+00:00',
    ...over,
  };
}

export function applicationDocument(over: Partial<ApplicationDocumentDto> = {}): ApplicationDocumentDto {
  return {
    id: 'doc-1',
    slot: 'practising_licence',
    slot_label: 'Current MDCN practising licence',
    label: null,
    original_name: 'apl.pdf',
    mime: 'application/pdf',
    size_bytes: 120_000,
    state: 'active',
    uploaded_during: 'draft',
    uploaded_at: '2026-10-19T10:00:00+00:00',
    credential_id: null,
    ...over,
  };
}

export function prefill(over: Partial<ApprovalDocumentPrefillDto> = {}): ApprovalDocumentPrefillDto {
  return {
    document_id: 'doc-1',
    slot: 'practising_licence',
    slot_label: 'Current MDCN practising licence',
    original_name: 'apl.pdf',
    credential_type: 'annual_practising_licence',
    needs_number: true,
    needs_issue_date: false,
    needs_expiry: true,
    prefill: { number: 'MDCN/R/12345', issued_on: null, expires_on: '2099-03-31', register_reference: '' },
    reference_hint: 'MDCN register entry or APL number checked',
    expiry_hint: null,
    ...over,
  };
}

export function approval(over: Partial<ApprovalPreviewDto> = {}): ApprovalPreviewDto {
  return {
    ready: true,
    problems: {},
    documents: [prefill()],
    login: { state: 'new', problem: null },
    specialty_on_list: true,
    register_name: 'the MDCN register',
    ...over,
  };
}

export function applicationDetail(over: Partial<DoctorApplicationDetailDto> = {}): DoctorApplicationDetailDto {
  return {
    ...applicationRow(),
    phone: '+2348031234567',
    email_verified_at: '2026-10-20T08:55:00+00:00',
    sections: {
      personal: {
        first_name: 'Ada',
        last_name: 'Obi',
        email: 'ada@example.test',
        phone: '+2348031234567',
        date_of_birth: '1988-04-12',
        gender: 'female',
        country_of_residence: 'NG',
        city: 'Lagos',
      },
      professional: { specialty: 'Cardiology', years_experience: 9, workplace: null, languages: ['English', 'Yoruba'], bio: 'Cardiologist with nine years of practice in Lagos.' },
      licence: { mdcn_number: 'MDCN/R/12345', full_registration_year: 2015, licence_expires_on: '2099-03-31' },
      qualifications: { entries: [{ degree: 'MBBS', institution: 'University of Lagos', year_awarded: 2012 }] },
      indemnity: { provider: 'Shield Co', policy_number: 'POL-778', cover_expires_on: '2099-01-31' },
      consent: { accept_terms: true, authorise_verification: true, confirm_accurate: true, signature_name: 'Ada Obi', consent_version: '2026-10', consented_at: '2026-10-20T08:59:00+00:00' },
    },
    documents: [applicationDocument()],
    info_requests: [],
    interview: null,
    rejection_reason: null,
    withdraw_reason: null,
    withdraw_reason_label: null,
    review_started_at: null,
    review_started_by_name: null,
    decided_at: null,
    decided_by_name: null,
    consent: {
      accept_terms: true,
      authorise_verification: true,
      confirm_accurate: true,
      signature_name: 'Ada Obi',
      consent_version: '2026-10',
      consented_at: '2026-10-20T08:59:00+00:00',
      consent_ip: '203.0.113.7',
    },
    specialist: null,
    actions: ['start_review', 'reject'],
    approval: null,
    events: [],
    notes_count: 0,
    ...over,
  };
}
