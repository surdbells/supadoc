import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import type { AppointmentsApi, DocumentsApi, PrescriptionsApi } from '@supadoc/data-access';
import type { MedicalDocumentDto, PatientLabResultDto } from '@supadoc/models';
import { sourceProblem, VIEWER_DEFAULTS, VIEWER_POLICIES, type ViewerSource } from '@supadoc/viewer';
import { appConfig } from '../app.config';
import {
  deviceZone,
  myClinicalDocumentSource,
  myDocumentSource,
  myLabResultSource,
  myPrescriptionSource,
  openerOf,
  uploaderLabel,
  ymdIn,
} from './viewer-sources';

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });
/** The source's own Download (a signed link), failing the test when it has none. */
const downloadOf = (s: ViewerSource) => {
  if (!s.download) throw new Error(`${s.key} has no download()`);
  return s.download();
};
const pdf = () => new Blob(['%PDF-1.7'], { type: 'application/pdf' });

const doc = (over: Partial<MedicalDocumentDto> = {}): MedicalDocumentDto =>
  ({
    id: 'd-1',
    patient_id: 'p-1',
    uploader_role: 'doctor',
    uploader_name: 'Bayo Ade',
    appointment_id: null,
    document_type: 'blood_test_report',
    custom_type: null,
    type_label: 'Blood test report',
    title: 'Full blood count: "Nov"',
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1200,
    size_label: '1.2 KB',
    created_at: '2026-11-03T10:00:00Z',
    ...over,
  }) as MedicalDocumentDto;

describe('patient viewer sources', () => {
  const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

  afterEach(() => vi.restoreAllMocks());

  describe('myDocumentSource', () => {
    it('is an owner source of the library file, keyed by id, with the date and who uploaded it', async () => {
      const fileBlob = vi.fn(() => of(pdf()));
      const api = { fileBlob } as unknown as DocumentsApi;
      const s = myDocumentSource(api, doc(), 'Africa/Lagos');
      expect(s.key).toBe('doc:d-1');
      expect(s.policy).toBe('owner');
      expect(VIEWER_POLICIES[s.policy].download).toBe(true);
      expect(s.title).toBe('Full blood count: "Nov"');
      expect(s.typeLabel).toBe('Blood test report');
      expect(s.extension).toBe('pdf');
      expect(s.sizeLabel).toBe('1.2 KB');
      expect(s.meta).toEqual(['Added 3 Nov 2026', 'Doctor-uploaded']);
      // Built here (the API's Content-Disposition is not readable cross-origin), without unsafe characters.
      expect(s.filename).toBe('Full blood count Nov.pdf');
      // Nothing is fetched until the viewer loads it.
      expect(fileBlob).not.toHaveBeenCalled();
      const file = await firstValueFrom(s.load());
      expect(fileBlob).toHaveBeenCalledExactlyOnceWith('d-1');
      expect(file.mime).toBe('application/pdf');
      // The viewer saves the viewed blob (no signed link), and the §1.16 checks pass.
      expect(s.download).toBeUndefined();
      expect(sourceProblem(s, {})).toBeNull();
    });

    it('leaves out the uploader for the patient’s own uploads', () => {
      const s = myDocumentSource({ fileBlob: vi.fn() } as unknown as DocumentsApi, doc({ uploader_role: 'patient' }), 'UTC');
      expect(s.meta).toEqual(['Added 3 Nov 2026']);
      expect(uploaderLabel('patient')).toBe('Patient-upload');
      expect(uploaderLabel('staff')).toBe('Staff-uploaded');
    });
  });

  describe('myPrescriptionSource', () => {
    const rx = { id: 'rx-1', number: 'GVM-RX-20261103-00001', status: 'expired' as const, sent_at: '2026-11-03T09:00:00Z', created_at: '2026-11-02T09:00:00Z' };

    const rxApi = () => {
      const link = vi.fn((id: string, download: boolean) =>
        ok({ url: `/api/public/prescriptions/file?token=${download ? 'dl' : 'view'}`, expires_at: '', filename: download ? 'GVM-RX-1.pdf' : '' }),
      );
      const fileBlob = vi.fn(() => of(pdf()));
      return { link, fileBlob, api: { link, fileBlob } as unknown as PrescriptionsApi };
    };

    it('is an owner signed-link source: one view link and one fetch per load, minted lazily', async () => {
      const { link, fileBlob, api } = rxApi();
      const s = myPrescriptionSource(api, rx, 'Africa/Lagos');
      expect(s.key).toBe('rx:rx-1');
      expect(s.policy).toBe('owner');
      expect(s.title).toBe('Prescription GVM-RX-20261103-00001');
      expect(s.typeLabel).toBe('Prescription');
      expect(s.extension).toBe('pdf');
      expect(s.meta).toEqual(['Issued 3 Nov 2026', 'Expired']);
      expect(link).not.toHaveBeenCalled();
      await firstValueFrom(s.load());
      expect(link).toHaveBeenCalledExactlyOnceWith('rx-1', false);
      expect(fileBlob).toHaveBeenCalledExactlyOnceWith({ url: '/api/public/prescriptions/file?token=view' });
      expect(sourceProblem(s, {})).toBeNull();
    });

    it('Download mints a download link and fetches it with HttpClient (never the viewed blob, never a URL)', async () => {
      const { link, fileBlob, api } = rxApi();
      const s = myPrescriptionSource(api, { ...rx, status: 'active' }, 'UTC');
      expect(s.meta).toEqual(['Issued 3 Nov 2026']);
      const saved = await firstValueFrom(downloadOf(s));
      expect(link).toHaveBeenCalledExactlyOnceWith('rx-1', true);
      expect(fileBlob).toHaveBeenCalledExactlyOnceWith({ url: '/api/public/prescriptions/file?token=dl' });
      expect(saved.filename).toBe('GVM-RX-1.pdf');
      expect(saved.blob.type).toBe('application/pdf');
    });

    it('names the file itself when the link has no name', async () => {
      const link = vi.fn(() => ok({ url: '/f', expires_at: '', filename: '' }));
      const api = { link, fileBlob: () => of(pdf()) } as unknown as PrescriptionsApi;
      const saved = await firstValueFrom(downloadOf(myPrescriptionSource(api, rx, 'UTC')));
      expect(saved.filename).toBe('Prescription GVM-RX-20261103-00001.pdf');
    });
  });

  describe('myClinicalDocumentSource', () => {
    it('is the server-rendered PDF (?format=pdf), owner, keyed by kind and id', async () => {
      const documentPdf = vi.fn(() => of(pdf()));
      const api = { documentPdf } as unknown as AppointmentsApi;
      const s = myClinicalDocumentSource(api, 'ap-1', 'referral', { id: 'r-1', title: 'Referral · Cardiology', issued_at: '2026-11-04T10:00:00Z' }, 'UTC');
      expect(s.key).toBe('referral:r-1');
      expect(s.policy).toBe('owner');
      expect(s.title).toBe('Referral · Cardiology');
      expect(s.typeLabel).toBe('Referral letter');
      expect(s.extension).toBe('pdf');
      expect(s.meta).toEqual(['Issued 4 Nov 2026']);
      expect(s.filename).toBe('referral-2026-11-04.pdf');
      await firstValueFrom(s.load());
      expect(documentPdf).toHaveBeenCalledExactlyOnceWith('ap-1', 'referral', 'r-1');
      const cert = myClinicalDocumentSource(api, 'ap-1', 'certificate', { id: 'c-1', title: 'Sick leave', issued_at: '2026-11-04T10:00:00Z' }, 'UTC');
      expect(cert.key).toBe('certificate:c-1');
      expect(cert.typeLabel).toBe('Medical certificate');
      expect(cert.filename).toBe('medical-certificate-2026-11-04.pdf');
    });

    it('dates the file name in the device zone', () => {
      const api = { documentPdf: vi.fn() } as unknown as AppointmentsApi;
      const late = { id: 'r-1', title: 'Referral', issued_at: '2026-11-04T23:30:00Z' };
      // Lagos is UTC+1: already the 5th there.
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...realResolved.call(this), timeZone: 'Africa/Lagos' };
      });
      expect(deviceZone()).toBe('Africa/Lagos');
      expect(myClinicalDocumentSource(api, 'ap-1', 'referral', late).filename).toBe('referral-2026-11-05.pdf');
      expect(myClinicalDocumentSource(api, 'ap-1', 'referral', late, 'America/Los_Angeles').filename).toBe('referral-2026-11-04.pdf');
      expect(ymdIn('not a date', 'UTC')).toBe('');
      expect(myClinicalDocumentSource(api, 'ap-1', 'certificate', { ...late, issued_at: '' }).filename).toBe('medical-certificate.pdf');
    });
  });

  describe('myLabResultSource', () => {
    it('is an owner source of the result’s document, with the upload date and its own viewable flag', async () => {
      const fileBlob = vi.fn(() => of(pdf()));
      const r = {
        id: 'res-1',
        uploaded_at: '2026-11-03T10:00:00Z',
        item_ids: [],
        document: { id: 'd-9', title: 'Lipid panel', type_label: 'Laboratory test report', extension: 'pdf', size_label: '80 KB' },
        share_outcome: 'shared',
        shared_now: true,
        viewable: false,
        reviewable: false,
        review: null,
      } as unknown as PatientLabResultDto;
      const s = myLabResultSource({ fileBlob } as unknown as DocumentsApi, r, 'UTC');
      expect(s.key).toBe('doc:d-9');
      expect(s.policy).toBe('owner');
      expect(s.title).toBe('Lipid panel');
      expect(s.typeLabel).toBe('Laboratory test report');
      expect(s.sizeLabel).toBe('80 KB');
      expect(s.viewable).toBe(false);
      expect(s.meta).toEqual(['Added 3 Nov 2026']);
      expect(s.filename).toBe('Lipid panel.pdf');
      await firstValueFrom(s.load());
      expect(fileBlob).toHaveBeenCalledExactlyOnceWith('d-9');
    });
  });

  it('openerOf: the clicked control (a component host gives its own button)', () => {
    const button = document.createElement('button');
    expect(openerOf({ currentTarget: button } as unknown as Event)).toBe(button);
    const host = document.createElement('sd-button');
    const inner = document.createElement('button');
    host.append(inner);
    expect(openerOf({ currentTarget: host } as unknown as Event)).toBe(inner);
    expect(openerOf(undefined)).toBeNull();
  });

  it('the patient app gets the dark-mode-following tone without a provider (P-16 dropped)', () => {
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(VIEWER_DEFAULTS).tone).toBe('auto');
  });
});
