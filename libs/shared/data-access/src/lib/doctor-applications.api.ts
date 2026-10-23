import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ApplicantApplicationDto,
  ApplicationConfigDto,
  ApplicationDocumentDto,
  ApplicationDocumentSlot,
  ApplicationDraftDto,
  ApplicationSectionKey,
  ApplicationStatusDto,
  CodeSentDto,
  CreateDraftInput,
  CreateDraftResultDto,
  DraftSessionDto,
  InfoResponseSubmitInput,
  LicenceRoute,
  ResumeDraftInput,
  ResumeEmailSentDto,
  SaveSectionInput,
  SubmittedApplicationDto,
  SuccessResponse,
  TrackRequestCodeInput,
  TrackSessionDto,
  TrackStartDto,
  TrackStartInput,
  TrackVerifyInput,
  VerifyCodeInput,
  WithdrawInput,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService } from './api.service';

/** Applicant API root (public: anonymous rate-limit bucket whatever the headers). */
export const DOCTOR_APPLICATIONS_PUBLIC_PATH = 'api/public/doctor-applications';
/** Requests under this prefix carry the DRAFT token (added by the onboarding app's interceptor). */
export const APPLICANT_DRAFT_PREFIX = `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/drafts/current`;
/** Requests under these prefixes carry the TRACK access token. */
export const APPLICANT_TRACK_PREFIXES: readonly string[] = [
  `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/track/status`,
  `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/track/application`,
  `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/track/info-response`,
  `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/track/documents`,
  `${DOCTOR_APPLICATIONS_PUBLIC_PATH}/track/withdraw`,
];

const P = DOCTOR_APPLICATIONS_PUBLIC_PATH;
const D = APPLICANT_DRAFT_PREFIX;
const enc = encodeURIComponent;

/**
 * The public doctor-application API (apps/onboarding). No sign-in: drafts use a
 * draft token, the status page an access token, each attached by the app's
 * interceptor by URL prefix — never put either in a URL. Errors arrive as
 * ApiError (httpErrorInterceptor); branch on apiErrorCode(err).
 */
@Injectable({ providedIn: 'root' })
export class DoctorApplicationsApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /** GET config — consent version, upload limits, doctor portal URL, SMS on/off. */
  config$(): Observable<SuccessResponse<ApplicationConfigDto>> {
    return this.api.get(`${P}/config`);
  }

  // ----- Drafts -----

  /** POST drafts (201) — creates the draft and emails the resume link + code. */
  createDraft(input: CreateDraftInput): Observable<SuccessResponse<CreateDraftResultDto>> {
    return this.api.post(`${P}/drafts`, input);
  }

  /** POST drafts/resume — 422 resume_invalid / 429 resume_locked. */
  resumeWithCode(input: ResumeDraftInput): Observable<SuccessResponse<DraftSessionDto>> {
    return this.api.post(`${P}/drafts/resume`, input);
  }

  /** POST drafts/resume-link — the token read from the #fragment. 422 link_invalid. */
  resumeWithLink(token: string): Observable<SuccessResponse<DraftSessionDto>> {
    return this.api.post(`${P}/drafts/resume-link`, { token });
  }

  /** POST drafts/resend — always 202 with the same message. */
  resendResume(email: string): Observable<SuccessResponse<null>> {
    return this.api.post(`${P}/drafts/resend`, { email });
  }

  getDraft(): Observable<SuccessResponse<ApplicationDraftDto>> {
    return this.api.get(D);
  }

  /** PATCH drafts/current — clears licence details + certificate. */
  changeRoute(licence_route: LicenceRoute): Observable<SuccessResponse<ApplicationDraftDto>> {
    return this.api.patch(D, { licence_route });
  }

  saveSection<K extends ApplicationSectionKey>(
    section: K,
    input: SaveSectionInput<K>,
  ): Observable<SuccessResponse<ApplicationDraftDto>> {
    return this.api.put(`${D}/sections/${enc(section)}`, input);
  }

  /** POST drafts/current/documents (multipart) with upload progress events. */
  uploadDocument(
    slot: ApplicationDocumentSlot,
    file: File,
  ): Observable<HttpEvent<SuccessResponse<ApplicationDocumentDto>>> {
    return this.upload(`${D}/documents`, slot, file);
  }

  removeDocument(id: string): Observable<SuccessResponse<{ deleted: boolean }>> {
    return this.api.delete(`${D}/documents/${enc(id)}`);
  }

  documentFile(id: string): Observable<Blob> {
    return this.api.getBlob(`${D}/documents/${enc(id)}/file`);
  }

  /** POST drafts/current/resume-email — 429 resend_cooldown. */
  sendResumeEmail(): Observable<SuccessResponse<ResumeEmailSentDto>> {
    return this.api.post(`${D}/resume-email`, {});
  }

  sendEmailCode(): Observable<SuccessResponse<CodeSentDto>> {
    return this.api.post(`${D}/email-code`, {});
  }

  verifyEmail(input: VerifyCodeInput): Observable<SuccessResponse<ApplicationDraftDto>> {
    return this.api.post(`${D}/email-verify`, input);
  }

  /**
   * POST drafts/current/submit — idempotent (a replay returns the same reference).
   * 409 email_unverified | duplicate_open_application | already_registered | consent_outdated; 422 incomplete.
   */
  submit(): Observable<SuccessResponse<SubmittedApplicationDto>> {
    return this.api.post(`${D}/submit`, {});
  }

  discardDraft(): Observable<SuccessResponse<{ deleted: boolean }>> {
    return this.api.delete(D);
  }

  // ----- Track -----

  /** POST track/start — always 200 (never reveals whether anything matched). */
  trackStart(input: TrackStartInput): Observable<SuccessResponse<TrackStartDto>> {
    return this.api.post(`${P}/track/start`, input);
  }

  /** POST track/request-code — always 202; 410 track_expired. */
  trackRequestCode(input: TrackRequestCodeInput): Observable<SuccessResponse<CodeSentDto>> {
    return this.api.post(`${P}/track/request-code`, input);
  }

  /** POST track/verify — 422 code_invalid | code_expired | code_locked. */
  trackVerify(input: TrackVerifyInput): Observable<SuccessResponse<TrackSessionDto>> {
    return this.api.post(`${P}/track/verify`, input);
  }

  status(): Observable<SuccessResponse<ApplicationStatusDto>> {
    return this.api.get(`${P}/track/status`);
  }

  application(): Observable<SuccessResponse<ApplicantApplicationDto>> {
    return this.api.get(`${P}/track/application`);
  }

  saveInfoSection<K extends ApplicationSectionKey>(
    section: K,
    input: SaveSectionInput<K>,
  ): Observable<SuccessResponse<ApplicantApplicationDto>> {
    return this.api.put(`${P}/track/info-response/sections/${enc(section)}`, input);
  }

  uploadInfoDocument(
    slot: ApplicationDocumentSlot,
    file: File,
  ): Observable<HttpEvent<SuccessResponse<ApplicationDocumentDto>>> {
    return this.upload(`${P}/track/info-response/documents`, slot, file);
  }

  removeInfoDocument(id: string): Observable<SuccessResponse<{ deleted: boolean }>> {
    return this.api.delete(`${P}/track/info-response/documents/${enc(id)}`);
  }

  trackDocumentFile(id: string): Observable<Blob> {
    return this.api.getBlob(`${P}/track/documents/${enc(id)}/file`);
  }

  submitInfoResponse(input: InfoResponseSubmitInput): Observable<SuccessResponse<ApplicationStatusDto>> {
    return this.api.post(`${P}/track/info-response/submit`, input);
  }

  withdraw(input: WithdrawInput): Observable<SuccessResponse<ApplicationStatusDto>> {
    return this.api.post(`${P}/track/withdraw`, input);
  }

  private upload(
    path: string,
    slot: ApplicationDocumentSlot,
    file: File,
  ): Observable<HttpEvent<SuccessResponse<ApplicationDocumentDto>>> {
    const form = new FormData();
    form.append('slot', slot);
    form.append('file', file, file.name);
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return this.http.post<SuccessResponse<ApplicationDocumentDto>>(`${base}/${path}`, form, {
      reportProgress: true,
      observe: 'events',
    });
  }
}
