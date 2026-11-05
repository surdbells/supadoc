import { signal } from '@angular/core';
import type { DoctorSharedDocumentDto, SpecialistCredentialDto } from '@supadoc/models';
import { sourceProblem, type ViewerSession, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, Observable, of } from 'rxjs';
import { NOT_SHARED } from '../appointment/document-access';
import {
  clinicalDocumentSource,
  credentialSource,
  draftPrescriptionSource,
  patientDocOrigin,
  patientDocumentSource,
  prescriptionSource,
  revokeUnshared,
  viewerWatermark,
} from './doctor-viewer-sources';

const pdf = () => new Blob(['%PDF'], { type: 'application/pdf' });
const http = (status: number, code?: string) => ({ statusCode: status, errors: code ? { code } : {} });

function doc(id: string, over: Partial<DoctorSharedDocumentDto> = {}): DoctorSharedDocumentDto {
  return {
    id,
    patient_id: 'p1',
    uploader_role: 'patient',
    uploader_name: 'Bola Ade',
    appointment_id: 'ap-1',
    document_type: 'laboratory_test_report',
    custom_type: null,
    type_label: 'Lab report',
    title: `Report ${id}`,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1_200_000,
    size_label: '1.2 MB',
    created_at: '2026-11-04T14:00:00Z',
    via: 'document',
    shared_until: null,
    shared_until_label_at: null,
    shared_indefinitely: true,
    shared_at: '2026-11-04T14:00:00Z',
    ...over,
  };
}

describe('doctor viewer sources', () => {
  describe('patientDocumentSource (view-only)', () => {
    function setup(over: Partial<DoctorSharedDocumentDto> = {}) {
      const api = {
        patientDocumentView: vi.fn(() => of({ blob: pdf(), mime: 'application/pdf', viewRef: 'VM-7F3A2C1D', viewedAt: '2026-11-04T20:05:09Z' })),
        patientDocumentPrinted: vi.fn(() => of({ success: true, data: { recorded: true } })),
      };
      const onGone = vi.fn();
      const source = patientDocumentSource(api as never, 'ap-1', doc('d1', over), { onGone }, 'UTC');
      return { api, onGone, source };
    }

    it('is view_only with no download: key, title, meta, viewable', () => {
      const { source } = setup();
      expect(source.policy).toBe('view_only');
      expect(source.download).toBeUndefined();
      expect(source.key).toBe('doc:d1');
      expect(source.title).toBe('Report d1');
      expect(source.typeLabel).toBe('Lab report');
      expect(source.extension).toBe('pdf');
      expect(source.sizeLabel).toBe('1.2 MB');
      expect(source.meta).toEqual(['Patient upload', 'No end date']);
      expect(source.viewable).toBe(true);
      expect(setup({ viewable: false }).source.viewable).toBe(false);
      expect(setup({ uploader_role: 'doctor', shared_indefinitely: false, shared_until_label_at: null }).source.meta).toEqual([
        'Doctor-uploaded',
      ]);
    });

    it('loads through the view-only route (lazily) and records a print with the view reference first', async () => {
      const { api, source } = setup();
      expect(api.patientDocumentView).not.toHaveBeenCalled();
      const file = await firstValueFrom(source.load());
      expect(api.patientDocumentView).toHaveBeenCalledWith('ap-1', 'd1');
      expect(file.viewRef).toBe('VM-7F3A2C1D');
      const record = source.recordPrint;
      expect(record).toBeDefined();
      if (record) await firstValueFrom(record(file));
      expect(api.patientDocumentPrinted).toHaveBeenCalledWith('ap-1', 'd1', 'VM-7F3A2C1D');
    });

    it('"no longer shared": the doctor copy, and onGone re-reads the host list', () => {
      const { onGone, source } = setup();
      expect(source.mapError?.(http(404, 'not_shared'))).toEqual({ state: 'gone', text: NOT_SHARED, retry: false });
      source.onGone?.();
      expect(onGone).toHaveBeenCalledTimes(1);
    });

    it('is refused without a watermark, accepted with one (§1.16)', () => {
      const { source } = setup();
      expect(sourceProblem(source, {})).not.toBeNull();
      expect(sourceProblem(source, { watermark: { viewerName: 'Dr Ada Obi', timeZone: 'Africa/Lagos' } })).toBeNull();
    });

    it('patientDocOrigin: the appointment page’s pill wording', () => {
      expect(patientDocOrigin({ uploader_role: 'patient' })).toBe('Patient upload');
      expect(patientDocOrigin({ uploader_role: 'staff' })).toBe('Doctor-uploaded');
    });
  });

  describe('prescriptionSource (authored)', () => {
    function setup() {
      const calls: string[] = [];
      const api = {
        prescriptionLink: vi.fn((id: string, download = false) => {
          calls.push(`link:${id}:${download}`);
          return of({ success: true, data: { url: `api/public/prescriptions/file?token=${download ? 'dl' : 'v'}`, filename: 'GVM-RX-1.pdf', expires_at: '' } });
        }),
      };
      const files = {
        fileBlob: vi.fn((link: { url: string }) => {
          calls.push(`fetch:${link.url}`);
          return of(pdf());
        }),
      };
      const source = prescriptionSource(api as never, files as never, { id: 'rx-1', number: 'GVM-RX-20261104-00001', status: 'active' });
      return { api, calls, files, source };
    }

    it('key, policy, title, type and status', () => {
      const { api, source } = setup();
      expect(source.key).toBe('rx:rx-1');
      expect(source.policy).toBe('authored');
      expect(source.title).toBe('Prescription GVM-RX-20261104-00001');
      expect(source.typeLabel).toBe('Prescription');
      expect(source.extension).toBe('pdf');
      expect(source.meta).toEqual(['Active']);
      expect(api.prescriptionLink).not.toHaveBeenCalled();
    });

    it('one view link and one fetch per load; Download mints a download link and fetches it as a blob', async () => {
      const { calls, source } = setup();
      const file = await firstValueFrom(source.load());
      expect(file.mime).toBe('application/pdf');
      expect(calls).toEqual(['link:rx-1:false', 'fetch:api/public/prescriptions/file?token=v']);
      expect(source.download).toBeDefined();
      const download = source.download;
      if (!download) return;
      const saved = await firstValueFrom(download());
      expect(saved.filename).toBe('GVM-RX-1.pdf');
      expect(calls.slice(2)).toEqual(['link:rx-1:true', 'fetch:api/public/prescriptions/file?token=dl']);
    });
  });

  describe('draftPrescriptionSource (authored_draft)', () => {
    it('never captures an id: resolve runs inside load, before the link, which gets the resolved id', async () => {
      const order: string[] = [];
      const api = {
        prescriptionLink: vi.fn((id: string) => {
          order.push(`link:${id}`);
          return of({ success: true, data: { url: 'api/public/prescriptions/file?token=d', filename: 'draft.pdf', expires_at: '' } });
        }),
      };
      const files = { fileBlob: vi.fn(() => of(pdf())) };
      const resolve = vi.fn(
        () =>
          new Observable<{ id: string }>((sub) => {
            order.push('resolve');
            sub.next({ id: 'rx-new' });
            sub.complete();
          }),
      );
      const source = draftPrescriptionSource(api as never, files as never, 'rx-draft:3', resolve);
      expect(source.key).toBe('rx-draft:3');
      expect(source.policy).toBe('authored_draft');
      expect(source.title).toBe('Draft prescription');
      expect(source.download).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
      await firstValueFrom(source.load());
      expect(order).toEqual(['resolve', 'link:rx-new']);
      expect(api.prescriptionLink).toHaveBeenCalledWith('rx-new');
      expect(api.prescriptionLink).not.toHaveBeenCalledWith(undefined);
    });

    it('passes the host’s error copy through', () => {
      const mapError = vi.fn(() => ({ state: 'error' as const, text: 'Save failed', retry: true }));
      const source = draftPrescriptionSource({} as never, {} as never, 'rx-draft:1', () => of({ id: 'x' }), { mapError });
      expect(source.mapError?.(new Error('x'))).toEqual({ state: 'error', text: 'Save failed', retry: true });
      expect(draftPrescriptionSource({} as never, {} as never, 'rx-draft:2', () => of({ id: 'x' })).mapError).toBeUndefined();
    });
  });

  describe('clinicalDocumentSource (authored_print)', () => {
    it('a referral letter: Print, no Download, the API PDF', async () => {
      const api = { documentPdf: vi.fn(() => of(pdf())) };
      const source = clinicalDocumentSource(api as never, 'ap-1', 'referral', { id: 'r1', label: 'Cardiology, LUTH', issued_at: '2026-11-04T10:00:00Z' }, 'UTC');
      expect(source.policy).toBe('authored_print');
      expect(source.download).toBeUndefined();
      expect(source.filename).toBeUndefined();
      expect(source.key).toBe('referral:r1');
      expect(source.title).toBe('Referral letter');
      expect(source.typeLabel).toBe('Referral');
      expect(source.extension).toBe('pdf');
      expect(source.meta?.[0]).toBe('Cardiology, LUTH');
      expect(source.meta?.[1]).toMatch(/^Issued /);
      const file = await firstValueFrom(source.load());
      expect(api.documentPdf).toHaveBeenCalledWith('ap-1', 'referral', 'r1');
      expect(file.mime).toBe('application/pdf');
    });

    it('a medical certificate is titled by its type', () => {
      const source = clinicalDocumentSource({ documentPdf: () => of(pdf()) } as never, 'ap-1', 'certificate', { id: 'c1', label: 'Sick leave certificate' });
      expect(source.key).toBe('certificate:c1');
      expect(source.title).toBe('Sick leave certificate');
      expect(source.typeLabel).toBe('Medical certificate');
      expect(source.meta).toEqual([]);
    });
  });

  it('credentialSource: the doctor’s own file (owner), named as uploaded', async () => {
    const api = { credentialFile: vi.fn(() => of(pdf())) };
    const c = { id: 'c-1', type_label: 'Practising licence', original_name: 'licence.PDF' } as SpecialistCredentialDto;
    const source = credentialSource(api as never, c);
    expect(source.policy).toBe('owner');
    expect(source.key).toBe('cred:c-1');
    expect(source.title).toBe('Practising licence');
    expect(source.meta).toEqual(['licence.PDF']);
    expect(source.filename).toBe('licence.PDF');
    expect(source.extension).toBe('pdf');
    await firstValueFrom(source.load());
    expect(api.credentialFile).toHaveBeenCalledWith('c-1');
  });

  it('viewerWatermark: the profile name, else the session’s, never empty; the zone given or the clock’s', () => {
    const clock = (name: string | null) => ({ profile: () => (name === null ? null : { name }), zone: () => 'America/Chicago' });
    const auth = (name: string | null) => ({ displayName: () => name });
    expect(viewerWatermark(clock('Dr Ada Obi'), auth('ada@x'))).toEqual({ viewerName: 'Dr Ada Obi', timeZone: 'America/Chicago' });
    expect(viewerWatermark(clock(null), auth('Dr A. Obi'))).toEqual({ viewerName: 'Dr A. Obi', timeZone: 'America/Chicago' });
    expect(viewerWatermark(clock(' '), auth(null)).viewerName).toBe('Doctor');
    expect(viewerWatermark(clock('Dr Ada Obi'), auth(null), 'Africa/Lagos').timeZone).toBe('Africa/Lagos');
  });

  it('revokeUnshared: every patient document of the open viewer that is no longer shared, nothing else', () => {
    const src = (key: string) => ({ key }) as ViewerSource;
    const session = signal<ViewerSession | null>({
      seq: 1,
      sources: [src('doc:a'), src('doc:b'), src('rx:b'), src('doc:c')],
      refused: [null, null, null, null],
      options: {},
    });
    const viewer = { session, revoke: vi.fn() };
    expect(revokeUnshared(viewer as never, new Set(['a']))).toEqual(['b', 'c']);
    expect(viewer.revoke.mock.calls).toEqual([
      ['doc:b', NOT_SHARED],
      ['doc:c', NOT_SHARED],
    ]);
    session.set(null);
    expect(revokeUnshared(viewer as never, new Set())).toEqual([]);
  });
});
