import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { ApplicantApplicationDto } from '@supadoc/models';
import {
  buttonByText,
  doc,
  fail,
  flushAndSettle,
  fullDraft,
  HttpTestingController,
  ok,
  P,
  settle,
  statusDto,
  testProviders,
  textOf,
} from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { NOTICE, Notices } from '../core/notices';
import { OnbRespondPage } from './respond-page';

function application(over: Partial<ApplicantApplicationDto> = {}): ApplicantApplicationDto {
  const d = fullDraft();
  return {
    id: 'app-1',
    reference: 'GVM-DR-2026-12689',
    status: 'more_info_needed',
    licence_route: 'ng',
    sections: d.sections,
    documents: d.documents,
    info_request: {
      id: 'req-1',
      message: 'Please update your licence details.\nAnd send your CV.',
      items: [
        { kind: 'section', key: 'licence', label: 'Licence' },
        { kind: 'document', key: 'curriculum_vitae', label: 'Curriculum vitae' },
      ],
      requested_at: '2026-10-22T10:00:00Z',
      responded_at: null,
      response_note: null,
    },
    ...over,
  };
}

describe('OnbRespondPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setAccessToken('acc');
  });

  afterEach(() => http.verify());

  async function create(app = application()) {
    const fixture = TestBed.createComponent(OnbRespondPage);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    http.expectOne(`${P}/track/application`).flush(ok(app));
    await flushAndSettle(fixture);
    return { fixture, el };
  }

  it('shows the team message and only the requested items', async () => {
    const { el } = await create();
    expect(textOf(el)).toContain('Please update your licence details.');
    expect(el.querySelector('.whitespace-pre-line')).toBeTruthy();
    expect(textOf(el)).toContain('Licence · Nigeria');
    expect(textOf(el)).toContain('Curriculum vitae');
    expect(textOf(el)).not.toContain('Professional Details');
    expect(buttonByText(el, 'Send to VideoMed').getAttribute('aria-disabled')).toBe('true');
    el.remove();
  });

  it('opens a requested section as its step form in info mode, saving through track/info-response', async () => {
    const { fixture, el } = await create();
    (el.querySelector('[aria-label="Edit Licence · Nigeria"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.querySelector('#onb-mdcn_number')).toBeTruthy();
    // The certificate is not in the request: read-only.
    expect(el.querySelector('[aria-label="Remove MDCN full registration certificate"]')).toBeNull();
    buttonByText(el, 'Save').click();
    const put = http.expectOne(`${P}/track/info-response/sections/licence`);
    expect(put.request.headers.get('Authorization')).toBe('Bearer acc');
    expect(put.request.body.partial).toBeUndefined();
    put.flush(ok(application()));
    await flushAndSettle(fixture);
    expect(textOf(el)).toContain('Updated');
    // The header reads [title …… Updated  Edit]: the tag sits between them, not reordered to the front.
    const heading = el.querySelector('#respond-licence-heading') as HTMLElement;
    const row = heading.parentElement as HTMLElement;
    const tag = Array.from(row.querySelectorAll('span')).find((s) => s.textContent?.trim() === 'Updated') as HTMLElement;
    const edit = row.querySelector('[aria-label="Edit Licence · Nigeria"]') as HTMLElement;
    expect(heading.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tag.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tag.className).not.toMatch(/order-first|ml-auto/);
    el.remove();
  });

  it('sends the reply once every item is updated, then returns to the status page', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    sessionStorage.setItem('videomed.onb.respond.req-1', JSON.stringify(['licence']));
    const app = application();
    app.documents = [
      ...app.documents.filter((d) => d.slot !== 'curriculum_vitae'),
      doc('curriculum_vitae', { uploaded_during: 'info_response', uploaded_at: '2026-10-23T09:00:00Z' }),
    ];
    const { fixture, el } = await create(app);
    expect(buttonByText(el, 'Send to VideoMed').hasAttribute('aria-disabled')).toBe(false);
    buttonByText(el, 'Send to VideoMed').click();
    const req = http.expectOne(`${P}/track/info-response/submit`);
    expect(req.request.body).toEqual({ note: null });
    req.flush(ok(statusDto({ status: 'under_review' })));
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/status');
    expect(TestBed.inject(Notices).peek('status')).toBe(NOTICE.reviewResumed);
    el.remove();
  });

  it('knows which sections were already saved from the server (a new tab or device)', async () => {
    const app = application();
    app.info_request = { ...(app.info_request as NonNullable<ApplicantApplicationDto['info_request']>), updated_sections: ['licence'] };
    app.documents = [
      ...app.documents.filter((d) => d.slot !== 'curriculum_vitae'),
      doc('curriculum_vitae', { uploaded_during: 'info_response', uploaded_at: '2026-10-23T09:00:00Z' }),
    ];
    const { el } = await create(app);
    expect(sessionStorage.getItem('videomed.onb.respond.req-1')).toBeNull();
    expect(textOf(el)).toContain('Updated');
    expect(buttonByText(el, 'Send to VideoMed').hasAttribute('aria-disabled')).toBe(false);
    el.remove();
  });

  it('a reply that lost a race with staff (409) goes to the status page and says why', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    sessionStorage.setItem('videomed.onb.respond.req-1', JSON.stringify(['licence']));
    const app = application();
    app.documents = [
      ...app.documents.filter((d) => d.slot !== 'curriculum_vitae'),
      doc('curriculum_vitae', { uploaded_during: 'info_response', uploaded_at: '2026-10-23T09:00:00Z' }),
    ];
    const { fixture, el } = await create(app);
    buttonByText(el, 'Send to VideoMed').click();
    const f = fail(409, "This application isn't waiting for more information.", { code: 'not_allowed' });
    http.expectOne(`${P}/track/info-response/submit`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/status');
    expect(TestBed.inject(Notices).peek('status-info')).toBe("This application isn't waiting for more information.");
    expect(TestBed.inject(Notices).peek('status')).toBeNull();
    el.remove();
  });

  it('a section save refused with 409 re-reads the application, so the stale form goes away', async () => {
    const { fixture, el } = await create();
    (el.querySelector('[aria-label="Edit Licence · Nigeria"]') as HTMLButtonElement).click();
    await settle(fixture);
    buttonByText(el, 'Save').click();
    const f = fail(409, "This application isn't waiting for more information.", { code: 'not_allowed' });
    http.expectOne(`${P}/track/info-response/sections/licence`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    http.expectOne(`${P}/track/application`).flush(ok(application({ status: 'under_review', info_request: null })));
    await flushAndSettle(fixture);
    expect(el.querySelector('#onb-mdcn_number')).toBeNull();
    expect(textOf(el)).toContain("There's nothing to send right now.");
    el.remove();
  });

  it('lists what is still missing when Send is clicked too early', async () => {
    const { fixture, el } = await create();
    buttonByText(el, 'Send to VideoMed').click();
    await settle(fixture);
    expect(textOf(el)).toContain('Update every item first: Licence · Nigeria, Curriculum vitae.');
    http.expectNone(`${P}/track/info-response/submit`);
    el.remove();
  });
});
