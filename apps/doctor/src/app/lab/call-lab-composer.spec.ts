import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { LabRequestsApi } from '@supadoc/data-access';
import type { CreateLabRequestInput, LabRequestDto } from '@supadoc/models';
import { DialogService, provideSupadocIcons } from '@supadoc/ui';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { STANDING_REFUSED } from '../call-workspace/call-workspace-copy';
import { CallLabComposer } from './call-lab-composer';
import { LabComposer, NOT_CONSULTED, OPEN_ERROR, UNSAVED_LAB_LEAVE } from './lab-composer';
import { LabPreviewDialog } from './lab-preview-dialog';
import { LabSentDialog } from './lab-sent-dialog';
import { labContext, labOptions, labRequest, must } from './testing/lab-fixtures';

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

@Component({
  imports: [CallLabComposer],
  template: `<doc-call-lab-composer
    patientId="p1"
    appointmentId="ap-1"
    [duplicate]="duplicate()"
    [disabled]="disabled()"
    (closed)="closed = closed + 1"
    (done)="done.push($event)"
  />`,
})
class Host {
  readonly duplicate = signal<LabRequestDto | null>(null);
  readonly disabled = signal(false);
  closed = 0;
  done: LabRequestDto[] = [];
}

// A first test compiles the whole component tree (JIT): beyond the 5 s default on a busy machine.
describe('CallLabComposer (the lab request composer inside the call)', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let api: {
    options: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn<(b: CreateLabRequestInput) => Observable<unknown>>>;
  };
  let confirmLeave: ReturnType<typeof vi.spyOn>;
  let leaveAnswer: boolean;

  async function setup(over: { context?: () => Observable<unknown>; duplicate?: LabRequestDto | null; disabled?: boolean; hasSignature?: boolean } = {}) {
    api = {
      options: vi.fn(() => of({ data: labOptions({ has_signature: over.hasSignature ?? true }) })),
      context: vi.fn(over.context ?? (() => of({ data: labContext({ appointment: { id: 'ap-1', scheduled_at: '2026-11-04T15:00:00Z' } }) }))),
      create: vi.fn(() => of({ data: labRequest({ id: 'new1', number: 'GVM-REQ-20261105-00001', sent_at: '2026-11-05T09:30:00Z' }) })),
    };
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideSupadocIcons(), { provide: LabRequestsApi, useValue: api }],
    });
    leaveAnswer = true;
    confirmLeave = vi.spyOn(TestBed.inject(DialogService), 'confirmLeave').mockImplementation(() => Promise.resolve(leaveAnswer));
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    if (over.duplicate !== undefined) host.duplicate.set(over.duplicate);
    if (over.disabled) host.disabled.set(true);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle();
  }

  async function settle() {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  const text = (node: Element | null = el) => node?.textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string, scope: ParentNode = el) =>
    must(Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === label), `button ${label}`);
  const buttons = (label: string, scope: ParentNode = el) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent?.replace(/\s+/g, ' ').trim() === label);
  const composerHost = () => fixture.debugElement.query((d) => d.componentInstance instanceof CallLabComposer).componentInstance as CallLabComposer;
  const labComposer = () => fixture.debugElement.query((d) => d.componentInstance instanceof LabComposer)?.componentInstance as LabComposer | undefined;
  const dialogEl = (title: string) =>
    must(
      Array.from(document.querySelectorAll('dialog')).find((d) => d.open && d.textContent?.includes(title)),
      `dialog "${title}"`,
    );

  async function pick(selectId: string, label: string) {
    must(document.getElementById(selectId), selectId).click();
    fixture.detectChanges();
    const opt = Array.from(document.querySelectorAll<HTMLElement>(`#${selectId}-listbox [role="option"]`)).find((o) => o.textContent?.trim() === label);
    must(opt, `option ${label}`).click();
    await settle();
  }

  async function type(id: string, value: string) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function fillValid() {
    await pick('lab-quick', 'FBC');
    await type('lab-question', 'Suspected iron-deficiency anaemia');
  }

  async function previewAndSend() {
    must(document.getElementById('lab-preview-button'), 'Preview Request').click();
    await settle();
    (document.getElementById('lab-attest') as HTMLInputElement).click();
    await settle();
    button('Send to Patient', dialogEl('Preview request')).click();
    await settle();
  }

  it('reads the options and this patient’s context for this consultation once; the embedded form has no h1 or Back of its own', async () => {
    await setup();
    expect(api.options).toHaveBeenCalledTimes(1);
    expect(api.context).toHaveBeenCalledTimes(1);
    expect(api.context).toHaveBeenCalledWith('p1', 'ap-1');
    expect(el.querySelector('doc-lab-composer')).not.toBeNull();
    expect(el.querySelector('doc-lab-composer h1')).toBeNull();
    expect(el.querySelector('h1')).toBeNull();
    const title = must(el.querySelector('h2#call-lab-compose-title'), 'title');
    expect(title.textContent?.trim()).toBe('New request');
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(title.hasAttribute('data-ws-focus')).toBe(true);
    const back = buttons('Back');
    expect(back.length).toBe(1);
    expect(back[0].getAttribute('aria-label')).toBe('Back to lab requests');
  });

  describe('refusals and errors on open', () => {
    it('422 not_consulted: NOT_CONSULTED, no Try again; Back to lab requests closes', async () => {
      await setup({ context: () => throwError(() => ({ statusCode: 422, errors: { patient_id: 'x', code: 'not_consulted' } })) });
      expect(text()).toContain(NOT_CONSULTED);
      expect(buttons('Try again').length).toBe(0);
      button('Back to lab requests').click();
      expect(host.closed).toBe(1);
    });

    it('422 on appointment_id: the API’s message', async () => {
      await setup({ context: () => throwError(() => ({ statusCode: 422, errors: { appointment_id: 'This consultation has not taken place yet.' } })) });
      expect(text()).toContain('This consultation has not taken place yet.');
      expect(buttons('Try again').length).toBe(0);
    });

    it('403 doctor_suspended: the standing copy, no Try again', async () => {
      await setup({ context: () => throwError(() => ({ status: 403, errors: { code: 'doctor_suspended' } })) });
      expect(text()).toContain(STANDING_REFUSED);
      expect(buttons('Try again').length).toBe(0);
    });

    it('500: OPEN_ERROR with Try again, which reads again', async () => {
      await setup({ context: () => throwError(() => ({ statusCode: 500 })) });
      expect(text()).toContain(OPEN_ERROR);
      api.context.mockImplementation(() => of({ data: labContext() }));
      button('Try again').click();
      await settle();
      expect(api.options).toHaveBeenCalledTimes(2);
      expect(api.context).toHaveBeenCalledTimes(2);
      expect(el.querySelector('doc-lab-composer')).not.toBeNull();
    });
  });

  describe('Duplicate', () => {
    it('this patient’s request pre-fills, and the send carries duplicated_from and this consultation', async () => {
      const fbc = { ...labRequest().items[0], specimen_mode: 'auto' as const, specimen_code: null, specimen_label: null };
      await setup({ duplicate: labRequest({ id: 'lr-7', items: [fbc] }) });
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('Suspected iron-deficiency anaemia');
      await previewAndSend();
      expect(api.create).toHaveBeenCalledTimes(1);
      const body = api.create.mock.calls[0][0];
      expect(body.duplicated_from).toBe('lr-7');
      expect(body.appointment_id).toBe('ap-1');
    });

    it('another patient’s request is ignored: an empty form, no duplicated_from', async () => {
      await setup({ duplicate: labRequest({ id: 'lr-9', patient: { id: 'p9', name: 'X', age: null, sex: null } }) });
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('');
      await fillValid();
      await previewAndSend();
      const body = api.create.mock.calls[0][0];
      expect(body.duplicated_from ?? null).toBeNull();
      expect(body.appointment_id).toBe('ap-1');
    });
  });

  it('signed out while loading: the read is dropped and the signed-out line shows; signed in again, it reads again', async () => {
    const reply = new Subject<unknown>();
    await setup({ context: () => reply });
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    host.disabled.set(true);
    await settle();
    expect(reply.observed).toBe(false);
    expect(text()).toContain('Sign in again to open the request form. This call keeps going.');
    api.context.mockImplementation(() => of({ data: labContext() }));
    host.disabled.set(false);
    await settle();
    expect(api.context).toHaveBeenCalledTimes(2);
    expect(el.querySelector('doc-lab-composer')).not.toBeNull();
  });

  describe('closing', () => {
    it('a clean form closes without asking', async () => {
      await setup();
      button('Back').click();
      await settle();
      expect(confirmLeave).not.toHaveBeenCalled();
      expect(host.closed).toBe(1);
    });

    it('unsent: one prompt (UNSAVED_LAB_LEAVE); declining keeps the form; Cancel in the footer asks the same', async () => {
      await setup();
      await fillValid();
      expect(composerHost().unsent()).toBe(true);
      leaveAnswer = false;
      button('Back').click();
      await settle();
      await wait();
      expect(confirmLeave).toHaveBeenCalledTimes(1);
      expect(confirmLeave).toHaveBeenCalledWith(UNSAVED_LAB_LEAVE);
      expect(host.closed).toBe(0);
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('Suspected iron-deficiency anaemia');
      leaveAnswer = true;
      button('Cancel').click();
      await settle();
      await wait();
      expect(confirmLeave).toHaveBeenCalledTimes(2);
      expect(host.closed).toBe(1);
    });

    it('while sending: nothing (no prompt, no close)', async () => {
      await setup();
      const reply = new Subject<unknown>();
      api.create.mockImplementation(() => reply);
      await fillValid();
      await previewAndSend();
      expect(composerHost().sending()).toBe(true);
      await composerHost().requestClose();
      expect(confirmLeave).not.toHaveBeenCalled();
      expect(host.closed).toBe(0);
      reply.complete();
    });
  });

  it('warns before unload while unsent or sending, not otherwise', async () => {
    await setup();
    const ev = () => {
      const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(ev()).toBe(false);
    await fillValid();
    expect(ev()).toBe(true);
    const reply = new Subject<unknown>();
    api.create.mockImplementation(() => reply);
    await previewAndSend();
    expect(ev()).toBe(true);
    reply.next({ data: labRequest({ id: 'new1', number: 'GVM-REQ-20261105-00001' }) });
    reply.complete();
    await settle();
    expect(ev()).toBe(false);
  });

  describe('sending', () => {
    it('Sent → "Back to lab requests" (the dialog’s second button) emits done with the request', async () => {
      await setup();
      await fillValid();
      await previewAndSend();
      const sent = dialogEl('Request Sent');
      expect(text(sent)).toContain('GVM-REQ-20261105-00001');
      expect(buttons('Back to Laboratory & Diagnostics', sent).length).toBe(0);
      expect(composerHost().unsent()).toBe(false);
      button('Back to lab requests', sent).click();
      await settle();
      expect(host.done.map((r) => r.number)).toEqual(['GVM-REQ-20261105-00001']);
    });

    it('"+ New Request": options and context read again, an empty form, a new client key, focus on the title', async () => {
      await setup();
      await fillValid();
      const firstKey = must(labComposer(), 'composer').state().clientKey;
      await previewAndSend();
      button('+ New Request', dialogEl('Request Sent')).click();
      await settle();
      await wait();
      await settle();
      expect(api.options).toHaveBeenCalledTimes(2);
      expect(api.context).toHaveBeenCalledTimes(2);
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('');
      expect(must(labComposer(), 'composer').state().clientKey).not.toBe(firstKey);
      expect(host.done).toEqual([]);
      expect(document.activeElement?.id).toBe('call-lab-compose-title');
    });

    it('signed out with the Sent dialog open: it closes and done is emitted', async () => {
      await setup();
      await fillValid();
      await previewAndSend();
      dialogEl('Request Sent');
      host.disabled.set(true);
      await settle();
      expect(host.done.length).toBe(1);
      expect(Array.from(document.querySelectorAll('dialog')).some((d) => d.open && d.textContent?.includes('Request Sent'))).toBe(false);
    });
  });

  describe('LabComposer, embedded (the call) and as on the page', () => {
    it('embedded: lc-embedded host; the container-query classes, none of the viewport ones', async () => {
      await setup();
      const c = must(el.querySelector('doc-lab-composer'), 'composer');
      expect(c.classList.contains('lc-embedded')).toBe(true);
      expect(c.querySelector('.cpe-top')).not.toBeNull();
      expect(c.querySelector('.cpe-cards')).not.toBeNull();
      expect(c.querySelector('doc-lab-patient-card.cpe-patient')).not.toBeNull();
      expect(c.innerHTML).not.toContain('lg:flex-row');
      expect(c.innerHTML).not.toContain('xl:grid-cols-2');
      expect(c.querySelector('.cp-patient')).toBeNull();
    });

    it('the embedded rules ship in the component’s own CSS (jsdom has no layout: the real render measures them)', () => {
      const css = (LabComposer as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('').replace(/\s+/g, ' ');
      expect(css).toMatch(/container: ?lab-composer ?\/ ?inline-size/);
      expect(css).toMatch(/@container lab-composer \(min-width: ?56rem\)/);
      expect(css).toMatch(/@container lab-composer \(min-width: ?54rem\)/);
      expect(css).toMatch(/@container lab-composer \(max-width: ?29\.99rem\)/);
      // The contained footer, the priority tiles' radios sized to their tile, the shared button row when narrow.
      expect(css).toContain('cp-footer');
      expect(css).toContain('doc-lab-priority-card');
      expect(css).toContain('cp-btn');
    });

    it('page mode (embedded false): the original classes and the header', () => {
      TestBed.configureTestingModule({ providers: [provideSupadocIcons(), { provide: LabRequestsApi, useValue: {} }] });
      const f = TestBed.createComponent(LabComposer);
      f.componentRef.setInput('context', labContext());
      f.componentRef.setInput('options', labOptions());
      f.detectChanges();
      const c = f.nativeElement as HTMLElement;
      expect(c.classList.contains('lc-embedded')).toBe(false);
      expect(c.querySelector('h1')?.textContent?.trim()).toBe('New request');
      expect(c.querySelector('.flex.flex-col.gap-8.lg\\:flex-row.lg\\:items-start')).not.toBeNull();
      expect(c.querySelector('.grid.grid-cols-1.items-start.gap-6.xl\\:grid-cols-2')).not.toBeNull();
      expect(c.querySelector('doc-lab-patient-card.cp-patient')).not.toBeNull();
      expect(c.querySelector('.cpe-top, .cpe-cards, .cpe-patient')).toBeNull();
      const preview = must(c.querySelector('#lab-preview-button'), 'Preview Request');
      // Nothing filled: today's attributes exactly.
      expect(preview.getAttribute('aria-disabled')).toBe('true');
      expect(preview.getAttribute('aria-describedby')).toBe('lab-preview-missing');
      expect(preview.hasAttribute('disabled')).toBe(false);
      expect(c.querySelector('#lab-signed-out-note')).toBeNull();
      f.destroy();
    });

    it('disabled: Preview Request stays focusable (aria-disabled, described by the status line), opens nothing; Send posts nothing', async () => {
      await setup();
      await fillValid();
      const preview = must(document.getElementById('lab-preview-button'), 'Preview Request') as HTMLButtonElement;
      expect(preview.getAttribute('aria-disabled')).toBeNull();
      preview.focus();
      host.disabled.set(true);
      await settle();
      expect(document.activeElement).toBe(preview);
      expect(preview.hasAttribute('disabled')).toBe(false);
      expect(preview.getAttribute('aria-disabled')).toBe('true');
      expect(preview.getAttribute('aria-describedby')).toBe('lab-signed-out-note');
      expect(text(document.getElementById('lab-signed-out-note'))).toContain(
        'You are signed out. Your selections are kept here — sign in again to preview and send.',
      );
      preview.click();
      await settle();
      expect(Array.from(document.querySelectorAll('dialog')).some((d) => d.open)).toBe(false);
      // The values are kept; signing in again brings Preview back.
      expect((document.getElementById('lab-question') as HTMLInputElement).value).toBe('Suspected iron-deficiency anaemia');
      host.disabled.set(false);
      await settle();
      expect(preview.getAttribute('aria-disabled')).toBeNull();
      expect(api.create).not.toHaveBeenCalled();
    });

    it('the preview dialog, disabled: Send to Patient disabled with its line; nothing is posted', async () => {
      await setup();
      await fillValid();
      must(document.getElementById('lab-preview-button'), 'Preview Request').click();
      await settle();
      (document.getElementById('lab-attest') as HTMLInputElement).click();
      await settle();
      host.disabled.set(true);
      await settle();
      const preview = dialogEl('Preview request');
      expect(text(preview)).toContain('You are signed out. Sign in again to send — your selections are kept here.');
      const send = button('Send to Patient', preview);
      expect(send.disabled).toBe(true);
      const dialog = fixture.debugElement.query((d) => d.componentInstance instanceof LabPreviewDialog).componentInstance as LabPreviewDialog;
      (dialog as unknown as { trySend(): void }).trySend();
      expect(api.create).not.toHaveBeenCalled();
    });
  });

  describe('LabSentDialog', () => {
    @Component({
      imports: [LabSentDialog],
      template: `<doc-lab-sent-dialog [open]="true" [request]="r" [backLabel]="label" (back)="backs = backs + 1" />`,
    })
    class SentHost {
      r = labRequest();
      label = 'Back to Laboratory & Diagnostics';
      backs = 0;
    }
    @Component({
      imports: [LabSentDialog],
      template: `<doc-lab-sent-dialog [open]="true" [request]="r" />`,
    })
    class SentDefault {
      r = labRequest();
    }

    it('default label "Back to Laboratory & Diagnostics"; a given backLabel replaces it; Esc emits back', async () => {
      TestBed.configureTestingModule({ imports: [SentHost, SentDefault], providers: [provideSupadocIcons()] });
      const d = TestBed.createComponent(SentDefault);
      document.body.appendChild(d.nativeElement);
      d.detectChanges();
      await d.whenStable();
      expect(Array.from((d.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent?.trim())).toContain('Back to Laboratory & Diagnostics');
      d.destroy();
      const f = TestBed.createComponent(SentHost);
      f.componentInstance.label = 'Back to lab requests';
      document.body.appendChild(f.nativeElement);
      f.detectChanges();
      await f.whenStable();
      const root = f.nativeElement as HTMLElement;
      const labels = Array.from(root.querySelectorAll('button')).map((b) => b.textContent?.trim());
      expect(labels).toContain('Back to lab requests');
      expect(labels).not.toContain('Back to Laboratory & Diagnostics');
      must(root.querySelector('dialog'), 'dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      f.detectChanges();
      await f.whenStable();
      expect(f.componentInstance.backs).toBe(1);
      f.destroy();
    });
  });
});
