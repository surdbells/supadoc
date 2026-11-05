import { Component, input, signal, type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { PrescriptionLinkDto, SpecialistCredentialDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { type ViewerFile, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom, of, throwError } from 'rxjs';
import { applicationDocument } from '../applications/testing';
import {
  applicationDocumentSource,
  credentialSource,
  EMBEDDED_VIEWER,
  EmbeddedViewer,
  retypedBlob,
  STAFF_NOTICE,
  staffPrescriptionSource,
} from './viewer-sources';

function credential(over: Partial<SpecialistCredentialDto> = {}): SpecialistCredentialDto {
  return {
    id: 'cred-1',
    type: 'annual_practising_licence',
    type_label: 'Annual practising licence',
    number: 'APL/2026/001',
    issued_at: '2026-01-01',
    expires_at: '2099-12-31',
    status: 'pending',
    status_label: 'Pending',
    rejection_reason: null,
    original_name: 'licence.pdf',
    mime: 'application/pdf',
    size_bytes: 2048,
    reviewed_at: null,
    created_at: '2026-10-20T10:00:00+00:00',
    ...over,
  };
}

const load = (s: ViewerSource): Promise<ViewerFile> => firstValueFrom(s.load());

describe('back-office viewer sources', () => {
  it('re-types the bytes from the stored type, never the response', () => {
    const png = new Blob(['x'], { type: 'image/png' });
    expect(retypedBlob(png, 'application/pdf').type).toBe('application/pdf');
    expect(retypedBlob(png, 'IMAGE/JPEG').type).toBe('image/jpeg');
    expect(retypedBlob(new Blob(['x'], { type: 'application/pdf' }), 'application/zip').type).toBe('application/octet-stream');
    expect(retypedBlob(png, null).type).toBe('application/octet-stream');
  });

  it("builds an applicant's document: staff_verification, keyed by id, with Download", async () => {
    const api = { documentFile: vi.fn(() => of(new Blob(['%PDF'], { type: 'image/png' }))) };
    const doc = applicationDocument({ slot: 'additional', label: 'Updated CV', original_name: 'cv.PDF', size_bytes: 2048 });
    const s = applicationDocumentSource(api, 'app-1', doc);
    expect(s).toMatchObject({
      key: 'appdoc:doc-1',
      title: 'Updated CV',
      typeLabel: 'Current MDCN practising licence',
      extension: 'pdf',
      sizeLabel: '2 KB',
      meta: ['cv.PDF'],
      policy: 'staff_verification',
      filename: 'cv.PDF',
    });
    // Download saves the viewed bytes (no signed link): the policy allows it.
    expect(s.download).toBeUndefined();
    expect(api.documentFile).not.toHaveBeenCalled();
    const file = await load(s);
    expect(api.documentFile).toHaveBeenCalledWith('app-1', 'doc-1');
    // The stored type wins over the response's (another viewable type).
    expect(file.mime).toBe('application/pdf');
    expect(file.blob.type).toBe('application/pdf');
  });

  it("keeps today's copy when the stored file can't be read", () => {
    const s = applicationDocumentSource({ documentFile: () => of(new Blob()) }, 'app-1', applicationDocument());
    expect(s.mapError?.({ statusCode: 404 })).toEqual({ state: 'gone', text: 'This document could not be read.', retry: false });
    expect(s.mapError?.({ statusCode: 500 })).toBeNull();
    const c = credentialSource({ credentialFile: () => of(new Blob()) }, 'sp-1', credential());
    expect(c.mapError?.({ status: 404 })?.text).toBe('This document could not be read. Ask the doctor to upload it again.');
  });

  it("builds a doctor's credential with the Credentials tab's loader", async () => {
    const api = { credentialFile: vi.fn(() => of(new Blob(['x'], { type: 'application/pdf' }))) };
    const s = credentialSource(api, 'sp-1', credential({ mime: 'image/jpeg', original_name: 'scan.jpg', size_bytes: 3 * 1024 * 1024 }));
    expect(s).toMatchObject({
      key: 'cred:cred-1',
      title: 'Annual practising licence',
      typeLabel: 'Annual practising licence',
      extension: 'jpg',
      sizeLabel: '3.0 MB',
      meta: ['scan.jpg'],
      policy: 'staff_verification',
      filename: 'scan.jpg',
    });
    const file = await load(s);
    expect(api.credentialFile).toHaveBeenCalledWith('sp-1', 'cred-1');
    expect(file.mime).toBe('image/jpeg');
  });

  it('opens a not-viewable stored type as octet-stream (the Download card)', async () => {
    const s = credentialSource({ credentialFile: () => of(new Blob(['x'], { type: 'application/pdf' })) }, 'sp-1', credential({ mime: 'application/msword' }));
    expect((await load(s)).mime).toBe('application/octet-stream');
  });

  it('builds a staff prescription: staff_record, one view link, never a Download', async () => {
    const link: PrescriptionLinkDto = { url: '/api/public/prescriptions/file?token=t1', expires_at: '2026-11-05T10:00:00Z', filename: 'GVM-RX-1.pdf' };
    const rxApi = {
      staffLink: vi.fn(() => of({ status: 'success', message: 'OK', data: link })),
      fileBlob: vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' }))),
    };
    const s = staffPrescriptionSource(rxApi as never, { id: 'rx-1', number: 'GVM-RX-20261105-00001', status: 'expired', prescriber: 'Dr Grace Bell' });
    expect(s).toMatchObject({
      key: 'rx:rx-1',
      title: 'Prescription GVM-RX-20261105-00001',
      typeLabel: 'Prescription',
      extension: 'pdf',
      meta: ['Expired', 'Dr Grace Bell'],
      policy: 'staff_record',
    });
    expect(s.download).toBeUndefined();
    expect(rxApi.staffLink).not.toHaveBeenCalled();
    const file = await load(s);
    expect(rxApi.staffLink).toHaveBeenCalledTimes(1);
    expect(rxApi.staffLink).toHaveBeenCalledWith('rx-1', false);
    expect(rxApi.fileBlob).toHaveBeenCalledWith({ url: link.url });
    expect(file.mime).toBe('application/pdf');
  });

  it('re-links once when the signed link has expired (410)', async () => {
    const link = { url: '/api/public/prescriptions/file?token=t', expires_at: '', filename: 'rx.pdf' };
    const rxApi = {
      staffLink: vi.fn(() => of({ status: 'success', message: 'OK', data: link })),
      fileBlob: vi
        .fn()
        .mockReturnValueOnce(throwError(() => ({ statusCode: 410 })))
        .mockReturnValueOnce(of(new Blob(['%PDF'], { type: 'application/pdf' }))),
    };
    const s = staffPrescriptionSource(rxApi as never, { id: 'rx-2', number: 'N', status: 'active', prescriber: null });
    expect(s.meta).toEqual(['Active']);
    await load(s);
    expect(rxApi.staffLink).toHaveBeenCalledTimes(2);
    expect(rxApi.staffLink).toHaveBeenNthCalledWith(2, 'rx-2', false);
  });
});

// ---------------------------------------------------------------- bo-embedded-viewer

@Component({ selector: 'bo-stub-viewer', template: `<span class="stub">{{ source().key }}</span>` })
class StubViewer {
  /** The bodies created so far (the element creates them with a ViewContainerRef). */
  static created: StubViewer[] = [];
  constructor() {
    StubViewer.created.push(this);
  }
  readonly source = input.required<ViewerSource>();
  readonly mode = input<'modal' | 'embedded'>('modal');
  readonly tone = input<'light' | 'dark' | 'auto'>('auto');
}

@Component({
  imports: [EmbeddedViewer],
  template: `@if (show()) { <bo-embedded-viewer [source]="source()" /> }`,
})
class Host {
  readonly show = signal(true);
  readonly source = signal<ViewerSource | null>(null);
}

describe('EmbeddedViewer', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let loader: ReturnType<typeof vi.fn>;

  const src = (id: string): ViewerSource =>
    applicationDocumentSource({ documentFile: () => of(new Blob()) }, 'app-1', applicationDocument({ id }));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function setup(load: () => Promise<Type<unknown>>) {
    loader = vi.fn(load);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideSupadocIcons(), { provide: EMBEDDED_VIEWER, useValue: loader }],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
  }

  it('loads the body for the first source, embedded and light, at a fixed height, with the staff notice', async () => {
    await setup(() => Promise.resolve(StubViewer));
    await render();
    expect(loader).not.toHaveBeenCalled();
    expect(el.textContent).toContain(STAFF_NOTICE);
    expect(STAFF_NOTICE).toBe('Confidential. Opening a document is recorded in the audit log.');

    host.source.set(src('doc-1'));
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Opening document…');
    await render();
    expect(loader).toHaveBeenCalledTimes(1);
    const body = el.querySelector('bo-stub-viewer') as HTMLElement;
    expect(body.className).toContain('h-[min(70dvh,48rem)]');
    expect(body.className).not.toMatch(/lg:h-/);
    const stub = StubViewer.created.at(-1) as StubViewer;
    expect(StubViewer.created.length).toBe(1);
    expect(stub.mode()).toBe('embedded');
    expect(stub.tone()).toBe('light');
    expect(stub.source().key).toBe('appdoc:doc-1');
    expect(el.querySelector('[role="status"]')).toBeNull();

    // A new source goes to the same body; the chunk is not imported again.
    host.source.set(src('doc-2'));
    await render();
    expect(el.querySelectorAll('bo-stub-viewer').length).toBe(1);
    expect(stub.source().key).toBe('appdoc:doc-2');
    expect(loader).toHaveBeenCalledTimes(1);

    // Removing the element removes the body (and with it the file).
    host.show.set(false);
    await render();
    expect(el.querySelector('bo-stub-viewer')).toBeNull();
  });

  it('offers a reload when the chunk cannot load (old file names after a deploy)', async () => {
    await setup(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    host.source.set(src('doc-1'));
    await render();
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('VideoMed was updated. Reload the page to open documents.');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.includes('Reload'))).toBe(true);
    expect(el.querySelector('bo-stub-viewer')).toBeNull();
  });
});
