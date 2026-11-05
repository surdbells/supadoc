import { TestBed } from '@angular/core/testing';
import { DocumentViewerService, type ViewerSource } from '@supadoc/viewer';
import { firstValueFrom } from 'rxjs';
import { doc, HttpTestingController, P, testProviders } from '../../testing/onb-testing';
import { ApplicantSession } from './applicant-session';
import { InfoResponseStore } from './info-response.store';

describe('InfoResponseStore.viewDocument', () => {
  let open: ReturnType<typeof vi.fn>;
  let windowOpen: ReturnType<typeof vi.spyOn>;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    open = vi.fn(() => ({ closed: Promise.resolve(), close: () => undefined }));
    windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    TestBed.configureTestingModule({
      providers: [...testProviders(), InfoResponseStore, { provide: DocumentViewerService, useValue: { open } }],
    });
    TestBed.inject(ApplicantSession).setAccessToken('acc');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    windowOpen.mockRestore();
  });

  it("opens the applicant's own file in the shared viewer (owner) through the track session, never a tab", async () => {
    const store = TestBed.inject(InfoResponseStore);
    await store.viewDocument(doc('additional', { id: 'd-9', original_name: 'letter.pdf', label: 'Updated letter' }));

    expect(open).toHaveBeenCalledTimes(1);
    const [source] = open.mock.calls[0] as [ViewerSource];
    expect(source).toMatchObject({ key: 'appdoc:d-9', policy: 'owner', title: 'letter.pdf', filename: 'letter.pdf' });
    expect(source.download).toBeUndefined();
    expect(windowOpen).not.toHaveBeenCalled();

    http.expectNone(`${P}/track/documents/d-9/file`);
    const loading = firstValueFrom(source.load());
    const req = http.expectOne(`${P}/track/documents/d-9/file`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe('Bearer acc');
    req.flush(new Blob(['%PDF'], { type: 'application/pdf' }));
    expect((await loading).mime).toBe('application/pdf');
  });
});
