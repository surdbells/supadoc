import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type { SpecialistDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { BookConsultation } from './book-consultation';

const BASE = 'http://api.test';
const UPLOAD = `${BASE}/api/portal/appointment-documents`;

const specialist: SpecialistDto = {
  id: 'sp-1',
  name: 'Grace Bell',
  specialty: 'Cardiology',
  location: 'Lagos',
  consultation_fee: '15000.00',
  rating: '4.8',
  reviews_count: 12,
  available: true,
  years_experience: 9,
  languages: 'English',
  verified: true,
  gender: 'female',
  offers_in_person: false,
  photo_url: null,
  timezone: 'Africa/Lagos',
};

/** The booking's supporting documents (step 5): each goes up as soon as it is added. */
describe('BookConsultation supporting documents', () => {
  let fixture: ComponentFixture<BookConsultation>;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const bar = () => el.querySelector('[aria-label="Attached documents"] [role="progressbar"]') as HTMLElement | null;
  const pill = () => el.querySelector('[aria-label="Attached documents"] li span.rounded-pill')?.textContent?.trim();
  const live = () => el.querySelector('p.sr-only[aria-live="polite"][aria-atomic="true"]')?.textContent?.trim();
  const upload = (): TestRequest => http.expectOne((r) => r.method === 'POST' && r.url === UPLOAD);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BookConsultation],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(BookConsultation);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
    // Straight to the documents step for a loaded doctor (the time and reason steps have their own flows).
    const page = fixture.componentInstance as unknown as {
      specialist: { set(s: SpecialistDto): void };
      step: { set(n: number): void };
    };
    page.specialist.set(specialist);
    page.step.set(5);
    await render();
  });

  afterEach(() => el.remove());

  it('fills with real progress, says "Finishing…" (announced once) when sent, then attaches the file', async () => {
    const add = (fixture.componentInstance as unknown as { addAttachments(files: File[]): void }).addAttachments;
    add.call(fixture.componentInstance, [new File(['%PDF-1.4 scan'], 'scan.pdf', { type: 'application/pdf' })]);
    await render();
    const req = upload();
    expect(live()).toBe('Uploading scan.pdf.');

    req.event({ type: HttpEventType.UploadProgress, loaded: 25, total: 100 });
    await render();
    expect(bar()?.getAttribute('aria-label')).toBe('Uploading scan.pdf');
    expect(bar()?.getAttribute('aria-valuenow')).toBe('25');
    expect(pill()).toBe('25%');
    expect(live()).toBe('Uploading scan.pdf.'); // not on every tick

    // Every byte is out; the server is still storing it: no frozen 100%.
    req.event({ type: HttpEventType.UploadProgress, loaded: 100, total: 100 });
    await render();
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar()?.getAttribute('aria-valuetext')).toBe('Finishing…');
    expect(pill()).toBe('Finishing…');
    expect(live()).toBe('scan.pdf is sent. Finishing up…');

    req.flush({
      status: 'success',
      message: 'Uploaded',
      data: { id: 'doc-1', title: 'scan', type_label: 'Other', size_label: '1kb', created_at: '2026-11-05T10:00:00Z' },
    });
    await render();
    expect(bar()).toBeNull();
    expect(pill()).toBe('Attached');
    expect(live()).toBe('1 document attached.');
    expect(text()).toContain('scan.pdf');
  });
});
