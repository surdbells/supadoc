/**
 * Test helpers for apps/onboarding specs (not part of the app bundle: nothing
 * in src/app imports this file).
 */
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { EnvironmentProviders, Provider } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { API_CONFIG, httpErrorInterceptor, LOGGER } from '@supadoc/data-access';
import type {
  ApplicationDocumentDto,
  ApplicationDocumentSlot,
  ApplicationDraftDto,
  ApplicationStatusDto,
  ApplicationStepKey,
} from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { applicantTokenInterceptor } from '../app/core/applicant-token.interceptor';

export const BASE = 'http://api.test';
export const P = `${BASE}/api/public/doctor-applications`;
export const D = `${P}/drafts/current`;

export const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function testProviders(routes: Routes = []): (Provider | EnvironmentProviders)[] {
  return [
    provideHttpClient(withInterceptors([httpErrorInterceptor, applicantTokenInterceptor])),
    provideHttpClientTesting(),
    provideRouter(routes),
    provideSupadocIcons(),
    { provide: API_CONFIG, useValue: { baseUrl: BASE } },
    { provide: LOGGER, useValue: silentLogger },
  ];
}

export const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });

/** An API error body plus its HTTP status, for `req.flush(body, opts)`. */
export function fail(status: number, message: string, errors: Record<string, unknown> = {}) {
  return {
    body: { status: 'error', message, errors },
    opts: { status, statusText: 'Error' },
  };
}

export function doc(slot: ApplicationDocumentSlot, over: Partial<ApplicationDocumentDto> = {}): ApplicationDocumentDto {
  return {
    id: `doc-${slot}`,
    slot,
    slot_label: slot,
    label: null,
    original_name: `${slot}.pdf`,
    mime: 'application/pdf',
    size_bytes: 3072,
    state: 'active',
    uploaded_during: 'draft',
    uploaded_at: '2026-10-20T10:00:00Z',
    ...over,
  };
}

const ALL_STEPS: ApplicationStepKey[] = [
  'personal',
  'professional',
  'licence',
  'qualifications',
  'documents',
  'indemnity',
  'consent',
];

export function draft(over: Partial<ApplicationDraftDto> = {}): ApplicationDraftDto {
  return {
    id: 'app-1',
    status: 'draft',
    licence_route: 'ng',
    sections: {
      personal: null,
      professional: null,
      licence: null,
      qualifications: null,
      indemnity: null,
      consent: null,
    },
    documents: [],
    steps: Object.fromEntries(ALL_STEPS.map((s) => [s, 'not_started'])) as ApplicationDraftDto['steps'],
    next_step: 'personal',
    ready_to_submit: false,
    email_verified: false,
    expires_at: '2026-11-22T10:00:00Z',
    last_saved_at: null,
    ...over,
  };
}

/** A draft with every step complete. */
export function fullDraft(over: Partial<ApplicationDraftDto> = {}): ApplicationDraftDto {
  return draft({
    sections: {
      personal: {
        first_name: 'Ada',
        last_name: 'Obi',
        email: 'ada.obi@example.com',
        phone: '+2348031234567',
        date_of_birth: '1985-03-12',
        gender: 'female',
        country_of_residence: 'NG',
        city: 'Lagos',
      },
      professional: {
        specialty: 'Cardiology',
        years_experience: 8,
        workplace: null,
        languages: ['English', 'Yoruba'],
        bio: 'Consultant cardiologist caring for adults with heart disease in Lagos.',
      },
      licence: { mdcn_number: 'MDCN/R/123456', full_registration_year: 2016, licence_expires_on: '2027-04-11' },
      qualifications: { entries: [{ degree: 'MBBS', institution: 'University of Lagos', year_awarded: 2014 }] },
      indemnity: { provider: 'Medical Protection Society', policy_number: 'MPS-1', cover_expires_on: '2027-06-30' },
      consent: {
        accept_terms: true,
        authorise_verification: true,
        confirm_accurate: true,
        signature_name: 'Ada Obi',
        consent_version: '2026-10',
      },
    },
    documents: [
      doc('mdcn_certificate'),
      doc('government_id'),
      doc('medical_degree'),
      doc('practising_licence'),
      doc('curriculum_vitae'),
      doc('indemnity_certificate'),
    ],
    steps: Object.fromEntries(ALL_STEPS.map((s) => [s, 'complete'])) as ApplicationDraftDto['steps'],
    next_step: 'review',
    ready_to_submit: true,
    ...over,
  });
}

export function statusDto(over: Partial<ApplicationStatusDto> = {}): ApplicationStatusDto {
  return {
    id: 'app-1',
    reference: 'GVM-DR-2026-12689',
    status: 'submitted',
    status_label: 'Submitted',
    full_name: 'Olawunmi Clement',
    licence_route: 'ng',
    submitted_at: '2026-10-20T10:00:00Z',
    timeline: [
      { key: 'submitted', label: 'Submitted', state: 'current', at: '2026-10-20T10:00:00Z', description: "We've received your application." },
      { key: 'under_review', label: 'Under Review', state: 'pending', at: null, description: null },
      { key: 'approved', label: 'Approved', state: 'pending', at: null, description: null },
    ],
    interview: null,
    info_request: null,
    rejection_reason: null,
    can_withdraw: true,
    doctor_portal_url: null,
    email_masked: 'cle***@gmail.com',
    ...over,
  };
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export async function settle<T>(fixture: ComponentFixture<T>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** Lets awaited HTTP calls resume, then renders. */
export async function flushAndSettle<T>(fixture: ComponentFixture<T>): Promise<void> {
  await tick();
  await settle(fixture);
}

export function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((x) =>
    (x.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(text),
  );
  if (!b) throw new Error(`No "${text}" button`);
  return b;
}

export function textOf(root: HTMLElement): string {
  return (root.textContent ?? '').replace(/\s+/g, ' ');
}

export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export { HttpTestingController };

/** jsdom has <dialog> but not its modal API. */
export function stubDialogs(): void {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}
