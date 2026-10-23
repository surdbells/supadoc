import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DialogService } from '@supadoc/ui';
import { buttonByText, D, doc, draft, fail, flushAndSettle, HttpTestingController, ok, settle, testProviders, typeInto } from '../../testing/onb-testing';
import { ApplicantSession } from '../core/applicant-session';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { OnbIndemnityStep } from './indemnity-step';

/** StepBase behaviour (spec §1.2, §6.6), through the indemnity step. */
describe('StepBase: unsaved values and leaving', () => {
  let http: HttpTestingController;
  let store: ApplicationDraftStore;

  const filled = { provider: 'Medical Protection Society', policy_number: 'MPS-1', cover_expires_on: '2030-06-30' };

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ApplicantSession).setDraftToken('tok');
    store = TestBed.inject(ApplicationDraftStore);
    store.draft.set(draft({ next_step: 'indemnity', documents: [doc('indemnity_certificate')] }));
  });

  afterEach(() => http.verify());

  async function create() {
    const fixture = TestBed.createComponent(OnbIndemnityStep);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el, step: fixture.componentInstance };
  }

  function beforeUnload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('counts values restored from memory as unsaved: the tab-close warning and the leave prompt both fire', async () => {
    store.pending.set('indemnity', { ...filled });
    const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave').mockResolvedValue(false);
    const { fixture, el, step } = await create();
    expect((el.querySelector('#onb-provider') as HTMLInputElement).value).toBe('Medical Protection Society');
    expect(step.dirty()).toBe(true);
    expect(beforeUnload()).toBe(true);
    await expect(Promise.resolve(step.canLeave())).resolves.toBe(false);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave.mock.calls[0][0]?.message).toContain('on this step');
    expect(store.pending.has('indemnity')).toBe(true);
    fixture.destroy();
    el.remove();
  });

  it('a clean step still warns while another step holds unsaved values, and leaving drops them all', async () => {
    store.pending.set('licence', { mdcn_number: 'MDCN/R/1' });
    const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave').mockResolvedValue(true);
    const { fixture, el, step } = await create();
    expect(step.dirty()).toBe(false);
    expect(beforeUnload()).toBe(true);
    await expect(Promise.resolve(step.canLeave())).resolves.toBe(true);
    expect(leave.mock.calls[0][0]?.message).toContain("If you leave now, they'll be lost.");
    expect(store.pending.size).toBe(0);
    fixture.destroy();
    el.remove();
  });

  it('keeps unsaved values in memory without asking when moving within the wizard', async () => {
    const router = TestBed.inject(Router);
    const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave');
    const { fixture, el, step } = await create();
    typeInto(el.querySelector('#onb-provider') as HTMLInputElement, 'MPS');
    await settle(fixture);
    vi.spyOn(router, 'currentNavigation').mockReturnValue({ finalUrl: router.parseUrl('/apply/documents') } as never);
    expect(step.canLeave()).toBe(true);
    expect(leave).not.toHaveBeenCalled();
    expect((store.pending.get('indemnity') as Record<string, unknown>)['provider']).toBe('MPS');
    fixture.destroy();
    el.remove();
  });

  it('restored values are clean once Continue saved them', async () => {
    store.pending.set('indemnity', { ...filled });
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el, step } = await create();
    buttonByText(el, 'Continue').click();
    const req = http.expectOne(`${D}/sections/indemnity`);
    expect(req.request.body.values).toEqual(filled);
    req.flush(ok(draft({ next_step: 'consent', documents: [doc('indemnity_certificate')] })));
    await flushAndSettle(fixture);
    expect(step.dirty()).toBe(false);
    expect(store.pending.size).toBe(0);
    expect(beforeUnload()).toBe(false);
    fixture.destroy();
    el.remove();
  });

  it('draft_submitted: no "Leave your application?" prompt on the way to the Track modal', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave');
    const { fixture, el, step } = await create();
    for (const [id, value] of Object.entries(filled)) {
      typeInto(el.querySelector(`#onb-${id}`) as HTMLInputElement, id === 'cover_expires_on' ? '30062030' : value);
    }
    await settle(fixture);
    expect(step.dirty()).toBe(true);
    buttonByText(el, 'Continue').click();
    const f = fail(409, 'Conflict', { code: 'draft_submitted', reference: 'GVM-DR-2026-12345' });
    http.expectOne(`${D}/sections/indemnity`).flush(f.body, f.opts);
    await flushAndSettle(fixture);
    expect(nav).toHaveBeenCalledWith('/?dialog=track');
    expect(step.canLeave()).toBe(true);
    expect(leave).not.toHaveBeenCalled();
    fixture.destroy();
    el.remove();
  });

  it('a session that ended under the step does not prompt (nothing can be saved)', async () => {
    const leave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave');
    const { fixture, el, step } = await create();
    typeInto(el.querySelector('#onb-provider') as HTMLInputElement, 'MPS');
    await settle(fixture);
    TestBed.inject(ApplicantSession).setDraftToken(null);
    expect(step.canLeave()).toBe(true);
    expect(leave).not.toHaveBeenCalled();
    fixture.destroy();
    el.remove();
  });
});
