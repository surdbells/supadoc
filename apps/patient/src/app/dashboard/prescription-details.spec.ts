import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, firstValueFrom, of, throwError } from 'rxjs';
import { API_CONFIG, AppointmentsApi, PrescriptionsApi } from '@supadoc/data-access';
import type { PrescriptionDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { DocumentViewerService, type ViewerOpenOptions, type ViewerSource } from '@supadoc/viewer';
import { PrescriptionDetails } from './prescription-details';

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

/** An API service whose every other method answers an empty list. */
function apiStub(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => ok([])),
  });
}

const prescription = {
  id: 'rx-1',
  number: 'GVM-RX-20261101-00001',
  status: 'active',
  appointment_id: null,
  patient_id: 'p-1',
  prescriber: 'Dr Bayo Ade',
  prescriber_details: { name: 'Bayo Ade', specialty: 'Cardiology' },
  patient_name: 'Ada Obi',
  items_count: 1,
  valid_until: '2026-12-01',
  allows_repeats: false,
  sent_at: '2026-11-01T15:20:00Z',
  cancelled_at: null,
  created_at: '2026-11-01T15:10:00Z',
  items: [],
  readings: {},
  reason: null,
  icd_code: null,
  current_medications: null,
  pregnancy_status: null,
} as unknown as PrescriptionDto;

describe('PrescriptionDetails › the file actions', () => {
  let fixture: ComponentFixture<PrescriptionDetails>;
  let el: HTMLElement;
  const open = vi.fn();
  const link = vi.fn((id: string, download: boolean) =>
    ok({ url: `/api/public/prescriptions/file?token=${download ? 'dl' : 'view'}`, expires_at: '', filename: download ? 'GVM-RX-20261101-00001.pdf' : '' }),
  );
  const fileBlob = vi.fn(() => of(new Blob(['%PDF'], { type: 'application/pdf' })));
  const createObjectURL = vi.fn(() => 'blob:http://localhost/rx');
  const revokeObjectURL = vi.fn();
  const clicked: { href: string; download: string }[] = [];
  const fetchSpy = vi.fn();
  const originalMatchMedia = window.matchMedia;

  /** A save keeps a 30 s timer (the object URL's revoke), so the zone isn't stable meanwhile: flush by hand. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const lastOpen = () => open.mock.calls[open.mock.calls.length - 1] as [ViewerSource, ViewerOpenOptions];
  const action = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('sd-button button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

  beforeEach(async () => {
    open.mockReset();
    link.mockClear();
    fileBlob.mockClear();
    createObjectURL.mockClear();
    clicked.length = 0;
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(window, 'open').mockReturnValue(null);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    await TestBed.configureTestingModule({
      imports: [PrescriptionDetails],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id: 'rx-1' })) } },
        { provide: PrescriptionsApi, useValue: apiStub({ get: () => ok(prescription), link, fileBlob }) },
        { provide: AppointmentsApi, useValue: apiStub({}) },
        { provide: DocumentViewerService, useValue: { open } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PrescriptionDetails);
    el = fixture.nativeElement;
    document.body.append(el);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    window.matchMedia = originalMatchMedia;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** None of the old ways: a hidden print frame, a raw fetch, a new tab (or this one) at the file. */
  const noOldPaths = () => {
    expect(document.querySelector('iframe')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(clicked.filter((a) => !a.href.startsWith('blob:'))).toEqual([]);
  };

  it('View opens the prescription in the document viewer (labelled View, with an eye)', async () => {
    const view = action('View');
    expect(view).toBeTruthy();
    expect(el.textContent).not.toContain('View full screen');
    view.click();
    expect(open).toHaveBeenCalledTimes(1);
    const [source, options] = lastOpen();
    expect(source.key).toBe('rx:rx-1');
    expect(source.policy).toBe('owner');
    expect(source.title).toBe('Prescription GVM-RX-20261101-00001');
    expect(options.autoPrint).toBe(false);
    expect(options.opener).toBe(view);
    // The viewer mints the link when it loads (one prescription.viewed row).
    expect(link).not.toHaveBeenCalled();
    await firstValueFrom(source.load());
    expect(link).toHaveBeenCalledExactlyOnceWith('rx-1', false);
    noOldPaths();
  });

  it('Print opens the viewer with autoPrint (the same raster print on every device)', () => {
    // A touch device used to get a new tab: now it gets the viewer too.
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    action('Print').click();
    const [source, options] = lastOpen();
    expect(source.key).toBe('rx:rx-1');
    expect(options.autoPrint).toBe(true);
    noOldPaths();
  });

  it('Download goes through saveSignedLink: a download link, an HttpClient blob, a same-origin save', async () => {
    action('Download').click();
    await settle();
    expect(link).toHaveBeenCalledExactlyOnceWith('rx-1', true);
    expect(fileBlob).toHaveBeenCalledExactlyOnceWith({ url: '/api/public/prescriptions/file?token=dl' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Saved from a same-origin object URL under the link's name; never an anchor at the API.
    expect(clicked).toEqual([{ href: 'blob:http://localhost/rx', download: 'GVM-RX-20261101-00001.pdf' }]);
    expect(el.textContent).toContain('Your download has started (GVM-RX-20261101-00001.pdf).');
    expect(open).not.toHaveBeenCalled();
    noOldPaths();
  });

  it('a failed download says so in the page (and nothing navigates)', async () => {
    link.mockImplementationOnce(() => throwError(() => ({ status: 410 })));
    action('Download').click();
    await settle();
    expect(el.textContent).toContain("We couldn't download your prescription. Please try again.");
    expect(clicked).toEqual([]);
    noOldPaths();
  });
});
