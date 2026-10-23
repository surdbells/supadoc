import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  buttonByText,
  draft,
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
import { normaliseDraftCode, RESEND_RESULT, ResumeDialogComponent } from './resume-dialog';

@Component({
  imports: [ResumeDialogComponent],
  template: `<onb-resume-dialog [open]="true" (closed)="closes = closes + 1" />`,
})
class Host {
  closes = 0;
}

describe('ResumeDialogComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({ imports: [Host], providers: testProviders([{ path: '**', children: [] }]) }).compileComponents();
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
  });

  const email = () => el.querySelector<HTMLInputElement>('#onb-resume-email') as HTMLInputElement;
  const code = () => el.querySelector<HTMLInputElement>('#onb-resume-code') as HTMLInputElement;

  it('normalises the draft code (upper case, O→0, I/L→1, no spaces or hyphens)', async () => {
    expect(normaliseDraftCode('ab-c 1o')).toBe('ABC10');
    expect(normaliseDraftCode('7k3m9l')).toBe('7K3M91');
    typeInto(code(), '7k3-m9q');
    await settle(fixture);
    expect(code().value).toBe('7K3M9Q');
  });

  it('keeps Resume inert-looking until both fields are valid, and shows the client errors on click', async () => {
    const resume = buttonByText(el, 'Resume application');
    expect(resume.getAttribute('aria-disabled')).toBe('true');
    resume.click();
    await settle(fixture);
    expect(textOf(el)).toContain('Enter a valid email address.');
    expect(textOf(el)).toContain('Draft code must be 6 characters.');
    http.expectNone(`${P}/drafts/resume`);
  });

  it('shows the server refusal under the fields', async () => {
    typeInto(email(), 'ada@example.com');
    typeInto(code(), '7K3M9Q');
    await settle(fixture);
    buttonByText(el, 'Resume application').click();
    const req = http.expectOne(`${P}/drafts/resume`);
    expect(req.request.body).toEqual({ email: 'ada@example.com', draft_code: '7K3M9Q' });
    const f = fail(422, 'Invalid', {
      code: 'resume_invalid',
      draft_code: "We couldn't find a draft with those details. Check your resume email.",
    });
    req.flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain("We couldn't find a draft with those details. Check your resume email.");
  });

  it('on success stores the token and goes to the next step', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    typeInto(email(), 'Ada@Example.com ');
    typeInto(code(), '7K3M9Q');
    await settle(fixture);
    buttonByText(el, 'Resume application').click();
    http
      .expectOne(`${P}/drafts/resume`)
      .flush(ok({ draft_token: 'tok', expires_in: 14400, draft: draft({ next_step: 'licence' }) }));
    await flushAndSettle(fixture);
    expect(TestBed.inject(ApplicantSession).draftToken()).toBe('tok');
    expect(nav).toHaveBeenCalledWith('/apply/licence');
    expect(fixture.componentInstance.closes).toBe(1);
  });

  it('"Send a new code" always answers the same way', async () => {
    typeInto(email(), 'ada@example.com');
    await settle(fixture);
    buttonByText(el, 'Send a new code').click();
    const req = http.expectOne(`${P}/drafts/resend`);
    expect(req.request.body).toEqual({ email: 'ada@example.com' });
    req.flush(ok(null), { status: 202, statusText: 'Accepted' });
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain(RESEND_RESULT);
  });
});
