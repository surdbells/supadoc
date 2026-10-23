import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CONFIG } from '@supadoc/data-access';
import type { DoctorApplicationDetailDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { applicationDetail } from '../testing';
import { RequestInfoDialog } from './request-info-dialog';

const BASE = 'http://api.test';
const URL_ = `${BASE}/api/doctor-applications/app-1/request-info`;

@Component({
  imports: [RequestInfoDialog],
  template: `<bo-request-info-dialog [open]="open()" [detail]="d()" (done)="done.push($event)" (stale)="stale = stale + 1" (closed)="open.set(false)" />`,
})
class Host {
  readonly open = signal(false);
  readonly d = signal<DoctorApplicationDetailDto>(applicationDetail({ status: 'under_review' }));
  readonly done: DoctorApplicationDetailDto[] = [];
  stale = 0;
}

describe('RequestInfoDialog', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });
  const box = (label: string): HTMLInputElement => {
    const row = Array.from(el.querySelectorAll('label')).find((l) => l.textContent?.trim() === label);
    const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error(`No checkbox "${label}"`);
    return input;
  };
  const tick = async (label: string) => {
    box(label).click();
    await render();
  };
  const type = async (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!input) throw new Error(`No ${selector}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const submit = async () => {
    el.querySelector('#bo-request-info-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };

  async function openWith(d: DoctorApplicationDetailDto) {
    host.d.set(d);
    host.open.set(true);
    await render();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideSupadocIcons(), { provide: API_CONFIG, useValue: { baseUrl: BASE } }],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('offers the sections and the route’s documents', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    for (const label of ['Personal details', 'Professional details', 'Licence', 'Qualifications', 'Indemnity']) expect(box(label)).toBeTruthy();
    expect(box('MDCN full registration certificate')).toBeTruthy();
    expect(box('Current MDCN practising licence')).toBeTruthy();
    expect(box('Another document')).toBeTruthy();
    expect(el.textContent).not.toContain('This cancels the scheduled interview.');

    await openWith(applicationDetail({ status: 'interview_scheduled', licence_route: 'abroad' }));
    expect(box('Certificate of Good Standing')).toBeTruthy();
    expect(box('Current practising licence')).toBeTruthy();
    expect(el.textContent).toContain('This cancels the scheduled interview.');
  });

  it('needs at least one item and a message', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    await submit();
    http.expectNone(URL_);
    expect(el.textContent).toContain('Choose at least one section or document.');
    expect(el.textContent).toContain('Write a message to the applicant.');
  });

  it('sends the items in order, with the reviewer’s words for another document', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    await tick('Licence');
    await tick('Curriculum vitae');
    await tick('Another document');
    await submit();
    expect(el.textContent).toContain('Say which document you need (2–120 characters).');
    await type('#bo-ri-another', 'Specialist registration certificate');
    const typed = '  Please upload a clearer licence and your specialist certificate.  ';
    await type('#bo-ri-message', typed);
    expect(el.textContent).toContain(`${typed.length} / 2000`);
    await submit();
    const req = http.expectOne(URL_);
    expect(req.request.body).toEqual({
      expected_status: 'under_review',
      message: 'Please upload a clearer licence and your specialist certificate.',
      items: [
        { kind: 'section', key: 'licence' },
        { kind: 'document', key: 'curriculum_vitae' },
        { kind: 'document', key: 'additional', label: 'Specialist registration certificate' },
      ],
    });
    req.flush(ok(applicationDetail({ status: 'more_info_needed' })));
    await render();
    expect(host.done).toHaveLength(1);
    expect(host.done[0].status).toBe('more_info_needed');
  });

  it('caps a request at 10 items', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    for (const label of ['Personal details', 'Professional details', 'Licence', 'Qualifications', 'Indemnity', 'MDCN full registration certificate', 'Government-issued ID', 'Medical degree certificate', 'Current MDCN practising licence', 'Curriculum vitae', 'Indemnity certificate']) {
      await tick(label);
    }
    await type('#bo-ri-message', 'Please update these.');
    await submit();
    http.expectNone(URL_);
    expect(el.textContent).toContain('Ask for at most 10 items at a time.');
  });

  it('tells the page to re-read when the application moved on (409)', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    await tick('Licence');
    await type('#bo-ri-message', 'Please update your licence details.');
    await submit();
    http.expectOne(URL_).flush(
      { status: 'error', message: 'This application changed. Reload it.', errors: { code: 'status_changed' } },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    expect(host.stale).toBe(1);
    expect(el.textContent).toContain('This application changed. Reload it.');
    expect(host.done).toHaveLength(0);
  });
});
