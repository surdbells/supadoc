import { TestBed } from '@angular/core/testing';
import type { ApplicationStatusDto } from '@supadoc/models';
import { Router } from '@angular/router';
import {
  buttonByText,
  fail,
  flushAndSettle,
  HttpTestingController,
  ok,
  P,
  settle,
  statusDto,
  stubDialogs,
  testProviders,
  textOf,
} from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { Notices } from '../core/notices';
import { DEFAULT_CONFIG } from '../core/onboarding-config.store';
import { interviewLabel } from './interview';
import { OnbStatusPage } from './status-page';

describe('OnbStatusPage', () => {
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setAccessToken('acc');
  });

  afterEach(() => http.verify());

  async function create(status: ApplicationStatusDto) {
    const fixture = TestBed.createComponent(OnbStatusPage);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    http.expectOne(`${P}/config`).flush(ok(DEFAULT_CONFIG));
    const req = http.expectOne(`${P}/track/status`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer acc');
    req.flush(ok(status));
    await flushAndSettle(fixture);
    return { fixture, el };
  }

  it('shows the name, reference and the current row first among pending ones', async () => {
    const { el } = await create(statusDto());
    expect(textOf(el)).toContain('Olawunmi Clement · Reference GVM-DR-2026-12689');
    const current = el.querySelector('li[aria-current="step"]');
    expect(current?.textContent).toContain('Submitted');
    expect(current?.textContent).toContain('Current status');
    expect(textOf(el)).not.toContain('(Only if needed)');
    expect(el.querySelectorAll('ol > li')).toHaveLength(3);
    // Figma App 24: the title ~60px under the header, the subtitle 16px under the title.
    const title = el.querySelector('h1') as HTMLElement;
    expect(title.parentElement?.className).toContain('min-[900px]:mt-[60px]');
    expect(title.nextElementSibling?.className).toContain('mt-4');
    el.remove();
  });

  it('keeps the server order: the current Under Review row after the done More Info Needed row', async () => {
    const { el } = await create(
      statusDto({
        status: 'under_review',
        timeline: [
          { key: 'submitted', label: 'Submitted', state: 'done', at: null, description: null },
          { key: 'more_info_needed', label: 'More Info Needed', state: 'done', at: null, description: null },
          { key: 'under_review', label: 'Under Review', state: 'current', at: null, description: "We're verifying…" },
          { key: 'approved', label: 'Approved', state: 'pending', at: null, description: null },
        ],
      }),
    );
    const labels = Array.from(el.querySelectorAll('ol > li')).map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels[1]).toContain('More Info Needed');
    expect(labels[2]).toContain('Under Review');
    expect(el.querySelectorAll('li')[2].getAttribute('aria-current')).toBe('step');
    el.remove();
  });

  it('labels the interview in WAT, with the viewer time when it differs', () => {
    expect(interviewLabel('2026-10-14T10:00:00+01:00', 'Africa/Lagos')).toBe('Wednesday 14 October, 10:00 WAT · video call');
    // London keeps WAT's offset in October (BST), so no suffix; in December it is an hour behind.
    expect(interviewLabel('2026-10-14T10:00:00+01:00', 'Europe/London')).toBe('Wednesday 14 October, 10:00 WAT · video call');
    expect(interviewLabel('2026-12-14T10:00:00+01:00', 'Europe/London')).toContain(
      'Monday 14 December, 10:00 WAT · video call · 09:00 your time (',
    );
    const ny = interviewLabel('2026-10-14T10:00:00+01:00', 'America/New_York');
    expect(ny).toContain(' · 05:00 your time (');
  });

  it('shows the interview block with Join and Add to calendar', async () => {
    const { el } = await create(
      statusDto({
        status: 'interview_scheduled',
        timeline: [{ key: 'interview_scheduled', label: 'Interview Scheduled', state: 'current', at: null, description: 'Join your interview…' }],
        interview: {
          starts_at: '2026-10-14T10:00:00+01:00',
          starts_at_label: 'Wednesday 14 October, 10:00 WAT',
          duration_minutes: 30,
          meeting_url: 'https://meet.google.com/abc',
          meeting_host: 'meet.google.com',
          note: 'Bring your ID',
        },
      }),
    );
    const join = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Join interview'));
    expect(join?.getAttribute('href')).toBe('https://meet.google.com/abc');
    expect(join?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(textOf(el)).toContain('10:00 WAT · video call');
    expect(() => buttonByText(el, 'Add to calendar')).not.toThrow();
    el.remove();
  });

  it('approved: the portal link (new tab) and the password caption', async () => {
    const { el } = await create(
      statusDto({
        status: 'approved',
        can_withdraw: false,
        doctor_portal_url: 'https://doctor.example.test',
        timeline: [{ key: 'approved', label: 'Approved', state: 'current', at: null, description: 'Welcome aboard.' }],
      }),
    );
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Set up my profile'));
    expect(link?.getAttribute('href')).toBe('https://doctor.example.test/auth/login');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(textOf(el)).toContain('Use the link we emailed to cle***@gmail.com to choose your password first.');
    expect(textOf(el)).not.toContain('Need to withdraw?');
    el.remove();
  });

  it('rejected: the reason, Contact support, no withdraw box', async () => {
    const { el } = await create(
      statusDto({
        status: 'rejected',
        can_withdraw: false,
        rejection_reason: 'We could not verify your licence.',
        timeline: [{ key: 'rejected', label: 'Rejected', state: 'current', at: null, description: 'The outcome is shown on this page.' }],
      }),
    );
    expect(textOf(el)).toContain('We could not verify your licence.');
    expect(Array.from(el.querySelectorAll('a')).some((a) => a.getAttribute('href') === 'mailto:support@videomed.app')).toBe(true);
    expect(textOf(el)).not.toContain('Need to withdraw?');
    el.remove();
  });

  it('withdraws after the tick, then reloads', async () => {
    const { fixture, el } = await create(statusDto());
    expect(textOf(el)).toContain('You can withdraw your application at any time before a decision is made.');
    buttonByText(el, 'Withdraw application').click();
    await settle(fixture);
    const tick = document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]') as HTMLInputElement;
    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    await settle(fixture);
    buttonByText(document.body, 'Yes, withdraw').click();
    const req = http.expectOne(`${P}/track/withdraw`);
    expect(req.request.body).toEqual({ confirm: true, reason: null });
    req.flush(ok(statusDto({ status: 'withdrawn', can_withdraw: false })));
    await flushAndSettle(fixture);
    http.expectOne(`${P}/track/status`).flush(ok(statusDto({ status: 'withdrawn', can_withdraw: false })));
    await flushAndSettle(fixture);
    expect(textOf(el)).not.toContain('Need to withdraw?');
    fixture.destroy();
    el.remove();
  });

  it('a withdraw that lost a race with a decision (409) closes the dialog, says so and shows the fresh status', async () => {
    const { fixture, el } = await create(statusDto());
    buttonByText(el, 'Withdraw application').click();
    await settle(fixture);
    const tick = document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]') as HTMLInputElement;
    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    await settle(fixture);
    buttonByText(document.body, 'Yes, withdraw').click();
    const f = fail(409, 'This application can no longer be withdrawn.', { code: 'not_allowed' });
    http.expectOne(`${P}/track/withdraw`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(document.querySelector('dialog[open]')).toBeNull();
    http.expectOne(`${P}/track/status`).flush(ok(statusDto({ status: 'approved', can_withdraw: false })));
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain('This application can no longer be withdrawn.');
    expect(textOf(el)).not.toContain('Need to withdraw?');
    fixture.destroy();
    el.remove();
  });

  it('shows why the respond page sent the applicant here (status-info notice)', async () => {
    TestBed.inject(Notices).set('status-info', "This application isn't waiting for more information.");
    const { el } = await create(statusDto({ status: 'under_review' }));
    expect(textOf(el)).toContain("This application isn't waiting for more information.");
    expect(TestBed.inject(Notices).peek('status-info')).toBeNull();
    el.remove();
  });

  it('Back to home is a 250×48 Cerulean button', async () => {
    const { el } = await create(statusDto());
    const home = buttonByText(el, 'Back to home');
    expect(home.className).toContain('bg-cerulean');
    expect(home.className).toContain('min-[900px]:w-[250px]');
    expect(home.className).toContain('py-3');
    el.remove();
  });

  it('a 401 sends the applicant back to the Track modal', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(OnbStatusPage);
    await settle(fixture);
    http.expectOne(`${P}/config`).flush(ok(DEFAULT_CONFIG));
    const f = fail(401, 'Ended', { code: 'applicant_token_invalid' });
    http.expectOne(`${P}/track/status`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/?dialog=track');
    expect(TestBed.inject(ApplicantSession).accessToken()).toBeNull();
  });
});
