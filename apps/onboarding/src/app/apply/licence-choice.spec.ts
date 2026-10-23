import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DialogService } from '@supadoc/ui';
import { buttonByText, D, draft, HttpTestingController, ok, settle, testProviders, textOf, tick } from '../../testing/onb-testing';
import { ApplicantSession, ROUTE_KEY } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { OnbLicenceChoice } from './licence-choice';

describe('OnbLicenceChoice', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function create() {
    const fixture = TestBed.createComponent(OnbLicenceChoice);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el };
  }

  const choose = (el: HTMLElement, value: string) => {
    const radio = el.querySelector<HTMLInputElement>(`input[name="licence-route"][value="${value}"]`) as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  };

  it('offers Nigeria and Abroad as a radio group, with the corrected copy', async () => {
    const { el } = await create();
    expect(el.querySelector('fieldset legend')?.textContent).toContain('Where are you licensed?');
    expect(textOf(el)).toContain('I am licensed by a medical regulator outside Nigeria');
    expect(textOf(el)).toContain("Choose the licence you'll practise under with VideoMed.");
    expect(textOf(el)).not.toContain('Step 1 of');
    expect(el.querySelector('h1')?.textContent).toContain('Where are you licensed?');
    el.remove();
  });

  it('Continue looks disabled until a choice, and a click explains why', async () => {
    const { fixture, el } = await create();
    const cont = buttonByText(el, 'Continue');
    expect(cont.getAttribute('aria-disabled')).toBe('true');
    cont.click();
    await settle(fixture);
    expect(textOf(el)).toContain('Choose where you are licensed.');
    el.remove();
  });

  it('keeps the choice locally and goes to step 1', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create();
    choose(el, 'abroad');
    await settle(fixture);
    buttonByText(el, 'Continue').click();
    await tick();
    expect(sessionStorage.getItem(ROUTE_KEY)).toBe('abroad');
    expect(nav).toHaveBeenCalledWith('/apply/personal');
    el.remove();
  });

  it('a resumed draft still loading: Continue waits for it, then asks and PATCHes (no silent local route)', async () => {
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    const confirm = vi.spyOn(TestBed.inject(DialogService), 'confirm').mockResolvedValue({ confirmed: true });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create();
    choose(el, 'abroad');
    await settle(fixture);
    buttonByText(el, 'Continue').click();
    await tick();
    expect(confirm).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
    for (const req of http.match((r) => r.method === 'GET' && r.url === D)) req.flush(ok(draft({ licence_route: 'ng' })));
    await tick();
    expect(confirm).toHaveBeenCalled();
    const patch = http.expectOne((r) => r.method === 'PATCH' && r.url === D);
    patch.flush(ok(draft({ licence_route: 'abroad' })));
    await tick();
    expect(sessionStorage.getItem(ROUTE_KEY)).toBeNull();
    expect(nav).toHaveBeenCalledWith('/apply/personal');
    el.remove();
  });

  it('with a draft, asks before changing the route and then PATCHes it', async () => {
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    TestBed.inject(ApplicationDraftStore).draft.set(draft({ licence_route: 'ng' }));
    const confirm = vi.spyOn(TestBed.inject(DialogService), 'confirm').mockResolvedValue({ confirmed: true });
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await create();
    choose(el, 'abroad');
    await settle(fixture);
    buttonByText(el, 'Continue').click();
    await tick();
    expect(confirm).toHaveBeenCalled();
    expect(confirm.mock.calls[0][0].message).toContain('clears your licence details and certificate');
    const req = http.expectOne(D);
    expect(req.request.method).toBe('PATCH');
    req.flush(ok(draft({ licence_route: 'abroad' })));
    await tick();
    el.remove();
  });
});
