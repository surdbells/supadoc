import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  buttonByText,
  fail,
  flushAndSettle,
  HttpTestingController,
  ok,
  P,
  settle,
  stubDialogs,
  testProviders,
  textOf,
  typeInto,
} from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { TrackStore } from '../core/track.store';
import { codeSubtitle, normaliseReference, TrackDialogComponent } from './track-dialog';

@Component({
  imports: [TrackDialogComponent],
  template: `<onb-track-dialog [open]="true" />`,
})
class Host {}

const channels = [
  { channel: 'sms', destination: 'The phone number on your application', generic: true, default: false },
  { channel: 'email', destination: 'cle***@gmail.com', generic: false, default: true },
];

describe('TrackDialogComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(async () => {
    // The countdown's interval and clock are fake; setTimeout stays real for the HTTP helpers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    sessionStorage.clear();
    await TestBed.configureTestingModule({ imports: [Host], providers: testProviders([{ path: '**', children: [] }]) }).compileComponents();
    TestBed.inject(TrackStore).prefill('GVM-DR-2026-12345');
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await settle(fixture);
  });

  afterEach(() => {
    http.verify();
    fixture.destroy();
    el.remove();
    vi.useRealTimers();
  });

  async function toMethod(): Promise<void> {
    typeInto(el.querySelector('#onb-track-contact') as HTMLInputElement, 'clement@gmail.com');
    await settle(fixture);
    buttonByText(el, 'Check status').click();
    const start = http.expectOne(`${P}/track/start`);
    expect(start.request.body).toEqual({ reference: 'GVM-DR-2026-12345', contact: 'clement@gmail.com' });
    start.flush(ok({ track_id: 'trk', expires_in: 900, channels }));
    await flushAndSettle(fixture);
  }

  async function toCode(): Promise<void> {
    await toMethod();
    buttonByText(el, 'Send code').click();
    http
      .expectOne(`${P}/track/request-code`)
      .flush(ok({ sent_to: 'cle***@gmail.com', expires_in: 600, resend_after: 60 }), { status: 202, statusText: 'Accepted' });
    await flushAndSettle(fixture);
  }

  const typeCode = async (digits: string) => {
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('[role="group"] input'));
    digits.split('').forEach((d, i) => typeInto(boxes[i], d));
    await settle(fixture);
  };

  it('prefills the reference and normalises it', async () => {
    expect((el.querySelector('#onb-track-reference') as HTMLInputElement).value).toBe('GVM-DR-2026-12345');
    expect(normaliseReference(' gvm dr 2026 12345 ')).toBe('GVM-DR-2026-12345');
  });

  it('shows the two channel cards with the default preselected (keyboard radios)', async () => {
    await toMethod();
    expect(textOf(el)).toContain('Verify it’s you');
    const radios = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"][name="track-channel"]'));
    expect(radios.map((r) => r.value)).toEqual(['sms', 'email']);
    expect(radios.find((r) => r.checked)?.value).toBe('email');
    expect(el.querySelector('fieldset legend')).toBeTruthy();
    expect(textOf(el)).toContain('The phone number on your application');
    radios[0].checked = true;
    radios[0].dispatchEvent(new Event('change'));
    await settle(fixture);
    buttonByText(el, 'Send code').click();
    const req = http.expectOne(`${P}/track/request-code`);
    expect(req.request.body).toEqual({ track_id: 'trk', channel: 'sms' });
    req.flush(ok({ sent_to: 'The phone number on your application', expires_in: 600, resend_after: 60 }));
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain('We sent a 6-digit code to the phone number on your application.');
  });

  it('enables Verify only at 6 digits, then opens /status', async () => {
    await toCode();
    const verify = () => buttonByText(el, 'Verify and check status');
    expect(verify().getAttribute('aria-disabled')).toBe('true');
    await typeCode('123456');
    expect(verify().hasAttribute('aria-disabled')).toBe(false);
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    verify().click();
    http.expectOne(`${P}/track/verify`).flush(ok({ access_token: 'acc', expires_in: 1800 }));
    await flushAndSettle(fixture);
    expect(TestBed.inject(ApplicantSession).accessToken()).toBe('acc');
    expect(nav).toHaveBeenCalledWith('/status');
  });

  it('a click on Verify with an incomplete code explains it and focuses where the code continues (D29)', async () => {
    await toCode();
    await typeCode('12');
    const verify = buttonByText(el, 'Verify and check status');
    verify.focus();
    expect(document.activeElement).toBe(verify);
    verify.click();
    await settle(fixture);
    http.expectNone(`${P}/track/verify`);
    expect(textOf(el)).toContain('Enter the 6-digit code.');
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('[role="group"] input'));
    expect(document.activeElement).toBe(boxes[2]);
  });

  it('shows a wrong code with alert borders and the message', async () => {
    await toCode();
    await typeCode('111111');
    buttonByText(el, 'Verify and check status').click();
    const f = fail(422, 'Wrong', { code: 'code_invalid', attempts_left: 2 });
    http.expectOne(`${P}/track/verify`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain("That code isn't right. Check it and try again.");
    expect(el.querySelector('[role="group"] input')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('counts down, holds Resend for the cooldown, and clears the boxes when the code expires', async () => {
    await toCode();
    expect(textOf(el)).toMatch(/Code expires in 10:00\./);
    expect(textOf(el)).toContain('Resend in 1:00');
    vi.advanceTimersByTime(61_000);
    await settle(fixture);
    expect(textOf(el)).toContain('Resend code');
    await typeCode('12');
    vi.advanceTimersByTime(600_000);
    await settle(fixture);
    expect(textOf(el)).toContain('Code expired.');
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('[role="group"] input'));
    expect(boxes.every((b) => b.value === '')).toBe(true);
  });

  it("a refused resend holds Resend for the server's Retry-After, not a fixed minute", async () => {
    await toCode();
    vi.advanceTimersByTime(61_000);
    await settle(fixture);
    buttonByText(el, 'Resend code').click();
    const f = fail(429, 'Please wait a minute before asking for another code.', { code: 'resend_cooldown', retry_after: 42 });
    http.expectOne(`${P}/track/request-code`).flush(f.body, { ...f.opts, headers: { 'Retry-After': '42' } });
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain('Resend in 0:42');
  });

  it('a timed-out check goes back to the first step with a message', async () => {
    await toMethod();
    buttonByText(el, 'Send code').click();
    const f = fail(410, 'Gone', { code: 'track_expired' });
    http.expectOne(`${P}/track/request-code`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain('This check has timed out. Start again.');
    expect(el.querySelector('#onb-track-reference')).toBeTruthy();
  });

  it('words a generic destination naturally', () => {
    expect(codeSubtitle('The email address on your application')).toBe(
      'We sent a 6-digit code to the email address on your application. It expires in 10 minutes.',
    );
    expect(codeSubtitle('cle***@gmail.com')).toContain('to cle***@gmail.com.');
  });
});
