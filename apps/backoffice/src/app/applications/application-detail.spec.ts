import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { DoctorApplicationDetailDto } from '@supadoc/models';
import { type ConfirmOptions, DialogService, provideSupadocIcons } from '@supadoc/ui';
import { isObservable, lastValueFrom } from 'rxjs';
import { actionButtons, AdminApplicationDetail } from './application-detail';
import { applicationDetail, applicationDocument } from './testing';

const BASE = 'http://api.test';
const DETAIL = `${BASE}/api/doctor-applications/app-1`;

describe('actionButtons — what each status offers', () => {
  const labels = (d: Pick<DoctorApplicationDetailDto, 'status' | 'actions'>) => actionButtons(d).map((b) => b.label);

  it('follows the status, primary first', () => {
    expect(labels({ status: 'submitted', actions: ['start_review', 'reject'] })).toEqual(['Start review', 'Reject']);
    expect(labels({ status: 'under_review', actions: ['approve', 'schedule_interview', 'request_info', 'reject'] })).toEqual([
      'Approve',
      'Schedule interview',
      'Request more info',
      'Reject',
    ]);
    expect(labels({ status: 'more_info_needed', actions: ['start_review', 'reject'] })).toEqual(['Resume review', 'Reject']);
    expect(
      labels({
        status: 'interview_scheduled',
        actions: ['approve', 'schedule_interview', 'resend_interview', 'request_info', 'start_review', 'reject'],
      }),
    ).toEqual(['Approve', 'Reschedule', 'Resend interview details', 'Request more info', 'Resume review', 'Reject']);
  });

  it('shows only what the API allows now, and nothing once decided', () => {
    expect(labels({ status: 'under_review', actions: ['request_info', 'reject'] })).toEqual(['Request more info', 'Reject']);
    expect(labels({ status: 'approved', actions: [] })).toEqual([]);
    expect(labels({ status: 'rejected', actions: ['reject'] })).toEqual([]);
  });
});

describe('AdminApplicationDetail', () => {
  let harness: RouterTestingHarness;
  let el: HTMLElement;
  let http: HttpTestingController;
  let asked: ConfirmOptions[];
  /** What the next confirm dialog answers with (a reason, or a refusal). */
  let answer: { confirmed: boolean; reason?: string };

  const render = async () => {
    harness.fixture.detectChanges();
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
  };
  const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });
  const byText = (text: string) =>
    Array.from(el.querySelectorAll<HTMLElement>('button, a')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);

  async function open(d: DoctorApplicationDetailDto, url = '/applications/app-1') {
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, AdminApplicationDetail);
    el = harness.routeNativeElement as HTMLElement;
    http.expectOne(DETAIL).flush(ok(d));
    await render();
  }

  beforeEach(async () => {
    asked = [];
    answer = { confirmed: true };
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'applications/:id', component: AdminApplicationDetail }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        // No queue reads.
        { provide: StaffAuthService, useValue: { hasPermission: () => false, isAuthenticated: () => true } },
        {
          provide: DialogService,
          useValue: {
            confirm: async (o: ConfirmOptions) => {
              asked.push(o);
              if (!answer.confirmed) return { confirmed: false };
              if (o.action) {
                const run = o.action(answer.reason);
                await (isObservable(run) ? lastValueFrom(run) : run);
              }
              return answer;
            },
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('heads the page with the applicant, reference, status, route and how long it has waited', async () => {
    await open(applicationDetail({ review_started_by_name: 'Kemi Ade', review_started_at: '2026-10-21T10:00:00Z' }));
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Ada Obi');
    const header = el.querySelector('section')?.textContent ?? '';
    expect(header).toContain('GVM-DR-2026-48213');
    expect(header).toContain('New');
    expect(header).toContain('Needs action');
    expect(header).toContain('Nigeria · MDCN');
    expect(header).toMatch(/Waiting (\d+ days?|since today)/);
    expect(header).toContain('Review started by Kemi Ade');
    expect(el.querySelector('button[aria-label="Copy reference GVM-DR-2026-48213"]')).toBeTruthy();
    // Tabs, with the document count.
    const tabs = Array.from(el.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.replace(/\s+/g, ' ').trim());
    expect(tabs).toEqual(['Application', 'Documents 1', 'Timeline', 'Notes']);
    expect(el.textContent).toContain('MDCN registration number');
  });

  it('starts the review through a confirmation, then offers the next actions', async () => {
    await open(applicationDetail());
    byText('Start review')?.click();
    await render();
    expect(asked[0].title).toBe('Start reviewing this application?');
    expect(asked[0].message).toContain('told by email and SMS');
    const req = http.expectOne(`${DETAIL}/start-review`);
    expect(req.request.body).toEqual({ expected_status: 'submitted' });
    req.flush(ok(applicationDetail({ status: 'under_review', awaiting_staff: false, actions: ['approve', 'schedule_interview', 'request_info', 'reject'] })));
    await render();
    await render();
    expect(byText('Approve')).toBeTruthy();
    expect(byText('Schedule interview')).toBeTruthy();
    expect(byText('Start review')).toBeUndefined();
    expect(el.textContent).toContain('Review started. The applicant has been told.');
  });

  it('rejects with a required reason shown to the applicant', async () => {
    await open(applicationDetail());
    answer = { confirmed: true, reason: 'Your licence could not be verified.' };
    byText('Reject')?.click();
    await render();
    expect(asked[0].tone).toBe('danger');
    expect(asked[0].reason).toMatchObject({ label: 'Reason (shown to the applicant)', required: true, maxLength: 2000 });
    const req = http.expectOne(`${DETAIL}/reject`);
    expect(req.request.body).toEqual({ expected_status: 'submitted', reason: 'Your licence could not be verified.' });
    req.flush(ok(applicationDetail({ status: 'rejected', actions: [], awaiting_staff: false, rejection_reason: 'Your licence could not be verified.' })));
    await render();
    await render();
    expect(el.textContent).toContain('reason shown to the applicant:');
    expect(el.textContent).toContain('Your licence could not be verified.');
    expect(el.textContent).toContain('This application is closed.');
  });

  it('waits for the applicant while more info is needed', async () => {
    await open(
      applicationDetail({
        status: 'more_info_needed',
        awaiting_staff: false,
        info_requests: [
          { id: 'r1', message: 'Please send a clearer ID.', items: [{ kind: 'document', key: 'government_id', label: 'Government-issued ID' }], requested_at: '2026-10-21T10:00:00Z', responded_at: null, response_note: null, requested_by_name: 'Kemi Ade', closed_at: null },
        ],
      }),
    );
    expect(el.textContent).toContain('Waiting for the applicant since 21 Oct 2026');
    expect(byText('Resume review')).toBeTruthy();
    expect(el.textContent).toContain('Please send a clearer ID.');
    expect(el.textContent).toContain('Waiting for the applicant');
  });

  it('links an approved application to the doctor page and resends the invite while no password is set', async () => {
    const approved = applicationDetail({
      status: 'approved',
      awaiting_staff: false,
      actions: [],
      decided_at: '2026-10-22T10:00:00Z',
      specialist: {
        id: 'sp-1',
        name: 'Dr. Ada Obi',
        status: 'invited',
        login: { id: 'u-1', email: 'ada@example.test', active: true, password_set: false, invite_pending: true, invite_expires_at: '2026-10-29T10:00:00Z' },
      },
      documents: [applicationDocument({ credential_id: 'cred-1' })],
    });
    await open(approved);
    expect(byText('Open doctor page')?.getAttribute('href')).toBe('/specialists/sp-1');
    expect(el.textContent).toContain('Invite sent');
    byText('Resend invite')?.click();
    await render();
    http.expectOne(`${BASE}/api/specialists/sp-1/invite`).flush(ok({ email_sent: true, expires_at: '2026-10-30T10:00:00Z', dev_link: 'http://localhost:4204/auth/set-password?token=t' }));
    await render();
    http.expectOne(DETAIL).flush(ok(approved));
    await render();
    expect(el.textContent).toContain('Invite sent. The link works for 7 days.');
    expect(el.textContent).toContain('Testing only — set-password link');
  });

  it('deep-links a tab and shows the documents with their source', async () => {
    await open(
      applicationDetail({
        documents: [
          applicationDocument(),
          applicationDocument({ id: 'doc-2', slot: 'additional', slot_label: 'Another document', label: 'Specialist certificate', uploaded_during: 'info_response' }),
          applicationDocument({ id: 'doc-3', state: 'replaced', original_name: 'old.pdf' }),
        ],
      }),
      '/applications/app-1?tab=documents',
    );
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Documents');
    expect(el.textContent).toContain('Current MDCN practising licence');
    expect(el.textContent).toContain('Specialist certificate');
    expect(el.textContent).toContain('Sent after request');
    expect(el.textContent).toContain('With application');
    expect(el.textContent).toContain('Replaced documents (1)');
    expect(el.textContent).toContain('Not on file:');
  });
});
