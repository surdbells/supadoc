import { Component, input } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { AdminPatientsApi, LabRequestsApi, PrescriptionsApi } from '@supadoc/data-access';
import type { AdminLabRequestSummaryDto, PatientDetailDto, PrescriptionSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerSource } from '@supadoc/viewer';
import { DocumentViewerComponent } from '@supadoc/viewer/embed';
import { firstValueFrom, NEVER, type Observable, of, throwError } from 'rxjs';
import { sentLabel } from './lab-request-ui';
import { AdminPatientDetail } from './patient-detail';

const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });

const DETAIL: PatientDetailDto = {
  patient: {
    id: 'pt-1',
    email: 'patient@videomed.test',
    first_name: 'Ada',
    last_name: 'Obi',
    phone: null,
    phone_verified: false,
    date_of_birth: null,
    gender: null,
    address: null,
    avatar_url: null,
    two_factor_enabled: false,
    created_at: '2026-01-01T10:00:00Z',
  },
  appointments: [],
  appointments_total: 0,
};

const RX: PrescriptionSummaryDto = {
  id: 'rx-1',
  number: 'GVM-RX-20261105-00001',
  status: 'active',
  appointment_id: null,
  patient_id: 'pt-1',
  prescriber: 'Dr Grace Bell',
  patient_name: 'Ada Obi',
  items_count: 2,
  valid_until: '2026-12-05',
  allows_repeats: false,
  sent_at: '2026-11-05T10:00:00Z',
  cancelled_at: null,
  created_at: '2026-11-05T09:00:00Z',
};

function lab(over: Partial<AdminLabRequestSummaryDto> = {}): AdminLabRequestSummaryDto {
  return {
    id: 'lab-1',
    number: 'GVM-REQ-20261104-00012',
    status: 'booked',
    priority: 'urgent',
    doctor_name: 'Dr. James Smith',
    items_count: 2,
    results_count: 0,
    sent_at: '2026-11-04T15:30:00Z',
    last_activity_at: '2026-11-04T16:00:00Z',
    corrections: ['in_lab'],
    consented_on: '2026-11-04',
    last_correction_note: null,
    ...over,
  };
}

@Component({
  imports: [DocumentViewerComponent],
  template: `<sd-document-viewer class="block h-96" mode="embedded" [source]="source()" />`,
})
class RealViewerHost {
  readonly source = input.required<ViewerSource>();
}

interface Setup {
  /** Permissions the staff member holds. */
  readonly perms?: readonly string[];
  /** What GET …/lab-requests answers (an Observable, e.g. an error). */
  readonly labs?: Observable<unknown>;
}

describe('AdminPatientDetail', () => {
  let fixture: ComponentFixture<AdminPatientDetail>;
  let el: HTMLElement;
  const viewerOpen = vi.fn();
  const rxApi = {
    forPatient: vi.fn(() => of(ok([RX]))),
    staffLink: vi.fn(() => NEVER),
    fileBlob: vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' }))),
  };
  const labApi = {
    forPatient: vi.fn((): Observable<unknown> => of(ok([lab()]))),
    staffLink: vi.fn((): Observable<unknown> => NEVER),
    fileBlob: vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' }))),
    correctStatus: vi.fn((): Observable<unknown> => NEVER),
  };
  let windowOpen: ReturnType<typeof vi.spyOn>;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = (root: Element | null = el) => root?.textContent?.replace(/\s+/g, ' ') ?? '';
  const labSection = () => el.querySelector('section[aria-labelledby="bo-patient-labs-title"]');

  async function setup({ perms = ['monitoring.view'], labs }: Setup = {}): Promise<void> {
    viewerOpen.mockReset();
    rxApi.staffLink.mockClear();
    labApi.forPatient.mockReset();
    labApi.forPatient.mockImplementation(() => labs ?? of(ok([lab()])));
    labApi.staffLink.mockReset();
    labApi.staffLink.mockImplementation(() => NEVER);
    labApi.fileBlob.mockClear();
    labApi.correctStatus.mockReset();
    labApi.correctStatus.mockImplementation(() => NEVER);
    windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [AdminPatientDetail, RealViewerHost],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'pt-1' }) } } },
        { provide: AdminPatientsApi, useValue: { get: () => of(ok(DETAIL)) } },
        { provide: PrescriptionsApi, useValue: rxApi },
        { provide: LabRequestsApi, useValue: labApi },
        { provide: StaffAuthService, useValue: { hasPermission: (p: string) => perms.includes(p) } },
        { provide: DocumentViewerService, useValue: { open: viewerOpen } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminPatientDetail);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  afterEach(() => {
    el?.remove();
    windowOpen?.mockRestore();
  });

  describe('prescription PDFs', () => {
    beforeEach(() => setup());

    it('View PDF opens the staff prescription in the viewer: staff_record, no Download, no tab', async () => {
      const button = el.querySelector('[aria-label="View PDF of prescription GVM-RX-20261105-00001"]') as HTMLButtonElement;
      expect(button.textContent).toContain('View PDF');
      button.click();
      await render();

      expect(viewerOpen).toHaveBeenCalledTimes(1);
      const [source, options] = viewerOpen.mock.calls[0] as [ViewerSource, { opener: HTMLElement }];
      expect(source).toMatchObject({ key: 'rx:rx-1', policy: 'staff_record', title: 'Prescription GVM-RX-20261105-00001', typeLabel: 'Prescription' });
      expect(source.download).toBeUndefined();
      expect(options.opener).toBe(button);
      // The link is minted only when the viewer loads (one prescription.viewed row per open).
      expect(rxApi.staffLink).not.toHaveBeenCalled();
      expect(windowOpen).not.toHaveBeenCalled();
      // No placeholder state on the page: the viewer shows its own loading and errors.
      expect(button.disabled).toBe(false);
      expect(el.textContent).not.toContain('Opening…');
    });

    it('mints the staff view link (never a download link) when the viewer loads', async () => {
      rxApi.staffLink.mockReturnValueOnce(of(ok({ url: '/api/public/prescriptions/file?token=t', expires_at: '', filename: 'rx.pdf' })) as never);
      (el.querySelector('[aria-label^="View PDF of prescription"]') as HTMLButtonElement).click();
      const source = viewerOpen.mock.calls[0][0] as ViewerSource;
      const file = await firstValueFrom(source.load());
      expect(rxApi.staffLink).toHaveBeenCalledWith('rx-1', false);
      expect(rxApi.fileBlob).toHaveBeenCalledWith({ url: '/api/public/prescriptions/file?token=t' });
      expect(file.mime).toBe('application/pdf');
    });

    it('the viewer shows no Download control for it (Print only)', async () => {
      (el.querySelector('[aria-label^="View PDF of prescription"]') as HTMLButtonElement).click();
      const source = viewerOpen.mock.calls[0][0] as ViewerSource;
      const real = TestBed.createComponent(RealViewerHost);
      real.componentRef.setInput('source', source);
      real.detectChanges();
      await real.whenStable();
      real.detectChanges();
      const viewer = real.nativeElement.querySelector('sd-document-viewer') as HTMLElement;
      expect(viewer.querySelector('[aria-label="Print"]')).not.toBeNull();
      expect(viewer.querySelector('[aria-label^="Download"]')).toBeNull();
      expect(viewer.querySelector('a[download]')).toBeNull();
    });
  });

  describe('lab requests', () => {
    it('lists summary rows for monitoring.view: number, status, priority, doctor, sent, tests and results', async () => {
      await setup({
        labs: of(
          ok([
            lab(),
            lab({ id: 'lab-2', number: 'GVM-REQ-20261101-00003', status: 'result_ready', priority: 'stat', items_count: 4, results_count: 2, corrections: [] }),
          ]),
        ),
      });
      const section = labSection();
      expect(labApi.forPatient).toHaveBeenCalledWith('pt-1');
      expect(section?.querySelector('h2')?.textContent).toContain('Lab requests');
      expect(section?.querySelector('h2')?.textContent).toContain('2');
      expect(text(section)).toContain('Summary only. Opening a request PDF is recorded in the audit log.');

      const rows = Array.from(section?.querySelectorAll('li') ?? []);
      expect(rows.length).toBe(2);
      /** Each row's definition list as "term: value" pairs. */
      const fields = (li: Element) =>
        Array.from(li.querySelectorAll('dl > div')).map(
          (d) => `${d.querySelector('dt')?.textContent?.trim()}: ${d.querySelector('dd')?.textContent?.trim()}`,
        );
      expect(text(rows[0])).toContain('GVM-REQ-20261104-00012');
      expect(text(rows[0])).toContain('Booked');
      const first = fields(rows[0]);
      expect(first.length).toBe(5);
      expect(first[0]).toBe('Priority: Urgent');
      expect(first[1]).toBe('Doctor: Dr. James Smith');
      // In the browser's zone, so the calendar day depends on where the suite runs.
      expect(first[2]).toBe(`Sent: ${sentLabel(lab().sent_at)}`);
      expect(first[2]).toMatch(/^Sent: \d{1,2} Nov 2026, \d{1,2}:\d{2}$/);
      expect(first[3]).toBe('Tests: 2');
      expect(first[4]).toBe('Results: 0');
      expect(text(rows[1])).toContain('Result ready');
      expect(fields(rows[1])).toEqual(expect.arrayContaining(['Priority: STAT', 'Tests: 4', 'Results: 2']));
    });

    it('shows no clinical content, even if a row carried some', async () => {
      const leaky = { ...lab(), clinical_question: 'Suspected malaria', tests_label: 'FBC, Malaria parasite', staff_note: 'Phoned support' };
      await setup({ labs: of(ok([leaky])), perms: ['monitoring.view', 'labs.manage'] });
      // The leaky row really is on screen, so the checks below mean something.
      expect(labSection()).not.toBeNull();
      expect(labSection()?.querySelectorAll('li').length).toBe(1);
      const t = text(labSection());
      expect(t).toContain('GVM-REQ-20261104-00012');
      expect(t).toContain('Dr. James Smith');
      expect(t).not.toContain('Suspected malaria');
      expect(t).not.toContain('FBC');
      expect(t).not.toContain('Malaria');
      // staff_note is never bound; only last_correction_note is shown, and only when set.
      expect(t).not.toContain('Phoned support');
      expect(t).not.toContain('Last correction note');
    });

    it('without labs.manage: no View PDF, no Correct status, no correction note', async () => {
      await setup({ labs: of(ok([lab({ last_correction_note: 'Patient phoned support' })])) });
      const section = labSection();
      expect(section?.querySelector('[aria-label^="View PDF of lab request"]')).toBeNull();
      expect(text(section)).not.toContain('View PDF');
      expect(text(section)).not.toContain('Correct status');
      expect(text(section)).not.toContain('Last correction note');
      expect(text(section)).not.toContain('Patient phoned support');
      expect(el.querySelector('bo-lab-status-dialog')).toBeNull();
    });

    it('with labs.manage: View PDF opens the request PDF in the viewer (staff_record, no Download, no tab)', async () => {
      await setup({ perms: ['monitoring.view', 'labs.manage'] });
      const button = el.querySelector('[aria-label="View PDF of lab request GVM-REQ-20261104-00012"]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      expect(button.textContent).toContain('View PDF');
      button.click();
      await render();

      expect(viewerOpen).toHaveBeenCalledTimes(1);
      const [source, options] = viewerOpen.mock.calls[0] as [ViewerSource, { opener: HTMLElement }];
      expect(source).toMatchObject({
        key: 'lab:lab-1',
        policy: 'staff_record',
        title: 'Lab request GVM-REQ-20261104-00012',
        typeLabel: 'Lab request',
        extension: 'pdf',
      });
      expect(source.download).toBeUndefined();
      expect(options.opener).toBe(button);
      // The audited link is minted only when the viewer loads.
      expect(labApi.staffLink).not.toHaveBeenCalled();
      expect(windowOpen).not.toHaveBeenCalled();

      labApi.staffLink.mockReturnValueOnce(of(ok({ url: '/api/public/lab-requests/file?token=t', expires_at: '', filename: 'r.pdf' })));
      const file = await firstValueFrom(source.load());
      expect(labApi.staffLink).toHaveBeenCalledWith('lab-1', false);
      expect(labApi.fileBlob).toHaveBeenCalledWith({ url: '/api/public/lab-requests/file?token=t' });
      expect(file.mime).toBe('application/pdf');
    });

    it('with labs.manage: Correct status only when a correction is allowed; the note shows only when present', async () => {
      await setup({
        perms: ['monitoring.view', 'labs.manage'],
        labs: of(
          ok([
            lab({ last_correction_note: 'Patient phoned support: sample taken 5 Nov' }),
            lab({ id: 'lab-2', number: 'GVM-REQ-20261101-00003', status: 'result_ready', corrections: [] }),
          ]),
        ),
      });
      const rows = Array.from(labSection()?.querySelectorAll('li') ?? []);
      expect(rows[0].querySelector('[aria-label="Correct status of lab request GVM-REQ-20261104-00012"]')?.textContent).toContain('Correct status');
      expect(rows[1].querySelector('[aria-label^="Correct status"]')).toBeNull();
      expect(rows[1].querySelector('[aria-label="View PDF of lab request GVM-REQ-20261101-00003"]')).not.toBeNull();
      expect(text(rows[0])).toContain('Last correction note: Patient phoned support: sample taken 5 Nov');
      expect(text(rows[1])).not.toContain('Last correction note');
    });

    it('shows the empty state', async () => {
      await setup({ labs: of(ok([])) });
      const t = text(labSection());
      expect(t).toContain('No lab requests have been sent to this patient yet.');
      expect(labSection()?.querySelector('h2')?.textContent).toContain('0');
    });

    it('shows the error with Try again, which reloads', async () => {
      await setup({ labs: throwError(() => ({ statusCode: 500, message: 'Server error' })) });
      const alert = labSection()?.querySelector('[role="alert"]');
      expect(text(alert ?? null)).toContain("Could not load this patient's lab requests.");
      labApi.forPatient.mockImplementation(() => of(ok([lab()])));
      const retry = Array.from(alert?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Try again'));
      retry?.click();
      await render();
      expect(labApi.forPatient).toHaveBeenCalledTimes(2);
      expect(text(labSection())).toContain('GVM-REQ-20261104-00012');
    });

    it('corrects a status: the dialog opens, the row updates and "Status updated." is announced', async () => {
      await setup({ perms: ['monitoring.view', 'labs.manage'] });
      const fix = el.querySelector('[aria-label="Correct status of lab request GVM-REQ-20261104-00012"]') as HTMLButtonElement;
      fix.click();
      await render();
      await tick();
      await render();
      expect(text(el.querySelector('bo-lab-status-dialog'))).toContain('Correct lab request status');
      expect(text(el.querySelector('bo-lab-status-dialog'))).toContain('GVM-REQ-20261104-00012 · now Booked');

      labApi.correctStatus.mockReturnValueOnce(
        of(ok(lab({ status: 'in_lab', corrections: ['booked'], last_correction_note: 'Patient phoned support' }))),
      );
      const reason = el.querySelector('bo-lab-status-dialog textarea') as HTMLTextAreaElement;
      reason.value = 'Patient phoned support';
      reason.dispatchEvent(new Event('input'));
      await render();
      el.querySelector('bo-lab-status-dialog form')?.dispatchEvent(new Event('submit', { cancelable: true }));
      await render();
      await tick();
      await render();

      expect(labApi.correctStatus).toHaveBeenCalledWith('lab-1', { status: 'in_lab', reason: 'Patient phoned support' });
      const row = labSection()?.querySelector('li');
      expect(text(row ?? null)).toContain('In Lab');
      expect(text(row ?? null)).toContain('Last correction note: Patient phoned support');
      expect(labSection()?.querySelector('[role="status"]')?.textContent).toContain('Status updated.');

      // The closing dialog keeps the row it was opened with (no mid-close redraw of its
      // subtitle and choices, no NG0956); the next "Correct status" gets the updated row.
      const page = fixture.componentInstance as unknown as { correctionRow: () => AdminLabRequestSummaryDto | null };
      expect(page.correctionRow()?.status).toBe('booked');
      (el.querySelector('[aria-label="Correct status of lab request GVM-REQ-20261104-00012"]') as HTMLButtonElement).click();
      await render();
      await tick();
      await render();
      expect(text(el.querySelector('bo-lab-status-dialog'))).toContain('GVM-REQ-20261104-00012 · now In Lab');
    });

    it('when the request changed meanwhile (422 `status`), closing the dialog quietly reloads the rows', async () => {
      await setup({ perms: ['monitoring.view', 'labs.manage'] });
      expect(labApi.forPatient).toHaveBeenCalledTimes(1);
      (el.querySelector('[aria-label="Correct status of lab request GVM-REQ-20261104-00012"]') as HTMLButtonElement).click();
      await render();
      await tick();
      await render();

      labApi.correctStatus.mockReturnValueOnce(
        throwError(() => ({
          statusCode: 422,
          message: 'Choose a status from the list',
          errors: { status: 'Choose a status from the list' },
        })),
      );
      const reason = el.querySelector('bo-lab-status-dialog textarea') as HTMLTextAreaElement;
      reason.value = 'Patient phoned support';
      reason.dispatchEvent(new Event('input'));
      await render();
      el.querySelector('bo-lab-status-dialog form')?.dispatchEvent(new Event('submit', { cancelable: true }));
      await render();
      await tick();
      await render();
      expect(text(el.querySelector('bo-lab-status-dialog'))).toContain('This request changed. Reload and try again.');
      expect(labApi.forPatient).toHaveBeenCalledTimes(1);

      // The patient reported the sample meanwhile: the reload shows In Lab, with the rows kept on screen meanwhile.
      labApi.forPatient.mockImplementation(() => of(ok([lab({ status: 'in_lab', corrections: ['booked'] })])));
      const cancel = Array.from(el.querySelectorAll('bo-lab-status-dialog button')).find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement;
      cancel.click();
      await render();
      await tick();
      await render();
      expect(labApi.forPatient).toHaveBeenCalledTimes(2);
      expect(text(labSection()?.querySelector('li') ?? null)).toContain('In Lab');

      // A plain open-and-cancel afterwards does not reload again.
      (el.querySelector('[aria-label="Correct status of lab request GVM-REQ-20261104-00012"]') as HTMLButtonElement).click();
      await render();
      await tick();
      await render();
      expect(text(el.querySelector('bo-lab-status-dialog'))).toContain('now In Lab');
      (Array.from(el.querySelectorAll('bo-lab-status-dialog button')).find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement).click();
      await render();
      await tick();
      expect(labApi.forPatient).toHaveBeenCalledTimes(2);
    });
  });
});
