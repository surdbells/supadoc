import { Component, input } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { AdminPatientsApi, PrescriptionsApi } from '@supadoc/data-access';
import type { PatientDetailDto, PrescriptionSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerSource } from '@supadoc/viewer';
import { DocumentViewerComponent } from '@supadoc/viewer/embed';
import { firstValueFrom, NEVER, of } from 'rxjs';
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

@Component({
  imports: [DocumentViewerComponent],
  template: `<sd-document-viewer class="block h-96" mode="embedded" [source]="source()" />`,
})
class RealViewerHost {
  readonly source = input.required<ViewerSource>();
}

describe('AdminPatientDetail (prescription PDFs)', () => {
  let fixture: ComponentFixture<AdminPatientDetail>;
  let el: HTMLElement;
  const viewerOpen = vi.fn();
  const rxApi = {
    forPatient: vi.fn(() => of(ok([RX]))),
    staffLink: vi.fn(() => NEVER),
    fileBlob: vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' }))),
  };
  let windowOpen: ReturnType<typeof vi.spyOn>;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    viewerOpen.mockReset();
    rxApi.staffLink.mockClear();
    windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [AdminPatientDetail, RealViewerHost],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'pt-1' }) } } },
        { provide: AdminPatientsApi, useValue: { get: () => of(ok(DETAIL)) } },
        { provide: PrescriptionsApi, useValue: rxApi },
        { provide: DocumentViewerService, useValue: { open: viewerOpen } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminPatientDetail);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  });

  afterEach(() => {
    el.remove();
    windowOpen.mockRestore();
  });

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
