import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { API_CONFIG } from '@supadoc/data-access';
import type { DoctorApplicationDetailDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { clinicLocalToIso, isoToClinicLocal } from '../application-ui';
import { applicationDetail } from '../testing';
import { ScheduleInterviewDialog } from './schedule-interview-dialog';

const BASE = 'http://api.test';
const URL_ = `${BASE}/api/doctor-applications/app-1/schedule-interview`;

@Component({
  imports: [ScheduleInterviewDialog],
  template: `<bo-schedule-interview-dialog [open]="open()" [detail]="d()" (done)="done.push($event)" (closed)="open.set(false)" />`,
})
class Host {
  readonly open = signal(false);
  readonly d = signal<DoctorApplicationDetailDto>(applicationDetail({ status: 'under_review' }));
  readonly done: DoctorApplicationDetailDto[] = [];
}

/** A Lagos wall time `days` ahead at 10:00 (always inside the API's window). */
function lagosLocal(days: number): string {
  const ymd = isoToClinicLocal(new Date(Date.now() + days * 86_400_000).toISOString()).slice(0, 10);
  return `${ymd}T10:00`;
}

describe('ScheduleInterviewDialog', () => {
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
  const field = <T extends HTMLElement>(selector: string): T => {
    const found = el.querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector}`);
    return found;
  };
  const type = async (selector: string, value: string) => {
    const input = field<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const submit = async () => {
    field('#bo-interview-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };
  const submitLabel = () => el.querySelector('button[form="bo-interview-form"]')?.textContent?.trim();

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

  it('sends the Lagos wall time with its offset, the length, the link and the note', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    expect(submitLabel()).toBe('Schedule interview');
    expect(field<HTMLSelectElement>('#bo-iv-length').value).toBe('30');
    const local = lagosLocal(3);
    await type('#bo-iv-when', local);
    await type('#bo-iv-url', 'https://meet.google.com/abc-defg-hij');
    await type('#bo-iv-note', 'Have your ID ready.');
    const length = field<HTMLSelectElement>('#bo-iv-length');
    length.value = '45';
    length.dispatchEvent(new Event('change'));
    await render();
    expect(el.textContent).toContain('Applicant sees:');
    expect(el.textContent).toContain('10:00 WAT · video call (meet.google.com)');
    await submit();
    const req = http.expectOne(URL_);
    expect(req.request.body).toEqual({
      expected_status: 'under_review',
      starts_at: clinicLocalToIso(local),
      duration_minutes: 45,
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      note: 'Have your ID ready.',
    });
    expect(req.request.body.starts_at).toMatch(/T10:00:00\+01:00$/);
    req.flush(ok(applicationDetail({ status: 'interview_scheduled' })));
    await render();
    expect(host.done).toHaveLength(1);
  });

  it('refuses a past or far-off time and a link that is not https', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    await submit();
    expect(el.textContent).toContain('Choose the date and time.');
    expect(el.textContent).toContain('Paste the full https:// meeting link.');
    await type('#bo-iv-when', lagosLocal(-1));
    await type('#bo-iv-url', 'http://zoom.us/j/1');
    await submit();
    expect(el.textContent).toContain('Choose a time at least 15 minutes from now.');
    expect(el.textContent).toContain('Paste the full https:// meeting link.');
    await type('#bo-iv-when', lagosLocal(120));
    await submit();
    expect(el.textContent).toContain('Choose a time within the next 90 days.');
    http.expectNone(URL_);
    expect(field('#bo-iv-url').getAttribute('aria-invalid')).toBe('true');
  });

  it('opens a reschedule on the current time and link', async () => {
    const starts = clinicLocalToIso(lagosLocal(5)) ?? '';
    await openWith(
      applicationDetail({
        status: 'interview_scheduled',
        interview: { starts_at: starts, starts_at_label: '', duration_minutes: 60, meeting_url: 'https://teams.microsoft.com/l/x', meeting_host: 'teams.microsoft.com', note: null },
      }),
    );
    expect(submitLabel()).toBe('Save new time');
    expect(field<HTMLInputElement>('#bo-iv-when').value).toBe(isoToClinicLocal(starts));
    expect(field<HTMLSelectElement>('#bo-iv-length').value).toBe('60');
    expect(field<HTMLInputElement>('#bo-iv-url').value).toBe('https://teams.microsoft.com/l/x');
  });

  it('shows the API’s field errors', async () => {
    await openWith(applicationDetail({ status: 'under_review' }));
    await type('#bo-iv-when', lagosLocal(2));
    await type('#bo-iv-url', 'https://meet.google.com/x');
    await submit();
    http.expectOne(URL_).flush(
      { status: 'error', message: 'Validation failed', errors: { meeting_url: 'Paste the full https:// meeting link.' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await render();
    expect(el.querySelector('#bo-iv-url-err')?.textContent).toContain('Paste the full https:// meeting link.');
    expect(host.done).toHaveLength(0);
  });
});
