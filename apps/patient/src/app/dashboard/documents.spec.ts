import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import {
  API_CONFIG,
  type DocumentListQuery,
  DocumentSharingApi,
  DocumentsApi,
  PrescriptionsApi,
} from '@supadoc/data-access';
import type { MedicalDocumentDto, PrescriptionSummaryDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { PatientDocuments } from './documents';

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => ok([])),
  });
}

const doc = (id: string, title: string, type: string): MedicalDocumentDto =>
  ({
    id,
    patient_id: 'p-1',
    uploader_role: 'patient',
    uploader_name: 'Ada Obi',
    appointment_id: null,
    document_type: type,
    custom_type: null,
    type_label: type === 'lab' ? 'Lab report' : 'Scan',
    title,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 100,
    size_label: '100 B',
    created_at: '2026-11-03T10:00:00Z',
  }) as MedicalDocumentDto;

const rx = (id: string): PrescriptionSummaryDto =>
  ({
    id,
    number: `GVM-RX-${id}`,
    status: 'active',
    appointment_id: 'ap-1',
    patient_id: 'p-1',
    prescriber: 'Dr Bayo Ade',
    patient_name: 'Ada Obi',
    items_count: 1,
    valid_until: null,
    allows_repeats: false,
    sent_at: '2026-11-03T09:00:00Z',
    cancelled_at: null,
    created_at: '2026-11-03T09:00:00Z',
  }) as PrescriptionSummaryDto;

describe('PatientDocuments › the document viewer', () => {
  let fixture: ComponentFixture<PatientDocuments>;
  let el: HTMLElement;
  const open = vi.fn();
  const all = [doc('d-1', 'Chest X-ray', 'scan'), doc('d-2', 'Blood count', 'lab'), doc('d-3', 'Lipids', 'lab')];
  const list = vi.fn((q?: DocumentListQuery) => {
    const data = q?.type ? all.filter((d) => d.document_type === q.type) : all;
    return of({ status: 'success', data, meta: { page: 1, per_page: 20, total: data.length, total_pages: 1 } });
  });
  const fileBlob = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
  const link = vi.fn(() => ok({ url: '/api/public/prescriptions/file?token=t', expires_at: '', filename: 'rx.pdf' }));
  const rxBlob = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
  };
  const lastOpen = () => open.mock.calls[open.mock.calls.length - 1] as [readonly ViewerSource[], ViewerOpenOptions];
  const rowButton = (title: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('ul li > button')).find((b) => b.textContent?.includes(title)) as HTMLButtonElement;

  beforeEach(async () => {
    open.mockReset();
    list.mockClear();
    fileBlob.mockClear();
    link.mockClear();
    rxBlob.mockClear();
    vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [PatientDocuments],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: DocumentsApi, useValue: apiStub({ list, fileBlob }) },
        { provide: PrescriptionsApi, useValue: apiStub({ mine: () => ok([rx('1'), rx('2'), rx('3'), rx('4')]), link, fileBlob: rxBlob }) },
        { provide: DocumentSharingApi, useValue: apiStub({}) },
        { provide: DocumentViewerService, useValue: { open } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PatientDocuments);
    el = fixture.nativeElement;
    document.body.append(el);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    vi.restoreAllMocks();
  });

  it('a row opens the viewer over the listed page, at that row, focus returning to it', async () => {
    const row = rowButton('Blood count');
    row.click();
    expect(open).toHaveBeenCalledTimes(1);
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['doc:d-1', 'doc:d-2', 'doc:d-3']);
    expect(sources.every((s) => s.policy === 'owner')).toBe(true);
    expect(options.index).toBe(1);
    expect(options.opener).toBe(row);
    expect(options.listLabel).toBe('your documents');
    // Nothing is fetched until the viewer loads it, and then only through the authenticated route.
    expect(fileBlob).not.toHaveBeenCalled();
    await firstValueFrom(sources[1].load());
    expect(fileBlob).toHaveBeenCalledExactlyOnceWith('d-2');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('opens the filtered list as shown (not the whole library)', async () => {
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]') as HTMLSelectElement;
    (fixture.componentInstance as unknown as { onFilter(v: string): void }).onFilter('lab');
    await settle();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'lab' }));
    expect(select).toBeTruthy();
    rowButton('Lipids').click();
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['doc:d-2', 'doc:d-3']);
    expect(options.index).toBe(1);
  });

  it('a prescription’s View opens the three cards as signed-link sources (no tab, no link minted yet)', async () => {
    const view = el.querySelector<HTMLButtonElement>('button[aria-label="View prescription GVM-RX-2"]') as HTMLButtonElement;
    view.click();
    const [sources, options] = lastOpen();
    expect(sources.map((s) => s.key)).toEqual(['rx:1', 'rx:2', 'rx:3']);
    expect(options.index).toBe(1);
    expect(options.opener).toBe(view);
    for (const s of sources) {
      expect(s.policy).toBe('owner');
      // A signed link: Download mints its own download link.
      expect(typeof s.download).toBe('function');
    }
    expect(link).not.toHaveBeenCalled();
    await firstValueFrom(sources[1].load());
    expect(link).toHaveBeenCalledExactlyOnceWith('2', false);
    expect(rxBlob).toHaveBeenCalledExactlyOnceWith({ url: '/api/public/prescriptions/file?token=t' });
    expect(window.open).not.toHaveBeenCalled();
    // The old busy spinner and its error line are gone: the viewer shows its own.
    expect(view.disabled).toBe(false);
  });
});
