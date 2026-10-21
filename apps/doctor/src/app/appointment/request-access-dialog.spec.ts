import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi, NETWORK_ERROR_MESSAGE } from '@supadoc/data-access';
import type { DoctorAccessRequestDto, DocumentAccessRequestKind } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { Subject } from 'rxjs';
import { RequestAccessDialog } from './request-access-dialog';

const SENT: DoctorAccessRequestDto = {
  id: 'rq-1',
  kind: 'access',
  status: 'pending',
  message: 'To review your last scan',
  appointment_id: 'ap-1',
  created_at: '2026-10-21T09:00:00Z',
  expires_at: '2026-10-28T09:00:00Z',
  decided_at: null,
};

@Component({
  imports: [RequestAccessDialog],
  template: `
    <doc-request-access-dialog
      [open]="open()"
      appointmentId="ap-1"
      [patientName]="name()"
      [kind]="kind()"
      (closed)="closes = closes + 1; open.set(false)"
      (sent)="sent.push($event); open.set(false)"
      (refused)="refused.push($event)"
    />
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly name = signal<string | null>('Ada Obi');
  readonly kind = signal<DocumentAccessRequestKind>('access');
  closes = 0;
  readonly sent: DoctorAccessRequestDto[] = [];
  readonly refused: string[] = [];
}

describe('RequestAccessDialog', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let calls: { id: string; message: string | undefined; res: Subject<{ data: DoctorAccessRequestDto }> }[];

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const openIt = async () => {
    host.open.set(true);
    await render();
    await tick();
    await render();
  };
  const field = () => el.querySelector<HTMLTextAreaElement>('textarea');
  const form = () => el.querySelector<HTMLFormElement>('form');
  const submitButton = () => el.querySelector<HTMLButtonElement>('button[type="submit"]');
  const cancelButton = () =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Cancel') ?? null;
  const type = async (value: string) => {
    const f = field();
    if (!f) throw new Error('No reason field');
    f.value = value;
    f.dispatchEvent(new Event('input'));
    await render();
  };
  const submit = async () => {
    form()?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };
  const alertText = () => el.querySelector('[role="alert"]')?.textContent?.trim() ?? '';

  beforeEach(async () => {
    calls = [];
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideSupadocIcons(),
        {
          provide: DoctorApi,
          useValue: {
            requestDocumentAccess: (id: string, message?: string) => {
              const res = new Subject<{ data: DoctorAccessRequestDto }>();
              calls.push({ id, message, res });
              return res;
            },
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  });

  afterEach(() => el.remove());

  it('asks the patient by name, says what happens, and caps the note at 500 with a counter', async () => {
    await openIt();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Ask Ada Obi to share documents');
    expect(el.textContent).toContain(
      "They'll get a notification and choose what to share and for how long. You'll be told when they answer.",
    );
    expect(el.textContent).toContain("Shown to the patient in the app only. Don't include sensitive details.");
    expect(el.querySelector('label')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Reason (optional)');
    expect(field()?.getAttribute('maxlength')).toBe('500');
    expect(el.textContent).toContain('0/500');

    await type('To review your last scan');
    expect(el.textContent).toContain('24/500');

    // Never more than 500, even if something gets past maxlength (paste in an old browser).
    await type('x'.repeat(620));
    expect(el.textContent).toContain('500/500');
  });

  it('extension wording while a whole-folder share ends soon', async () => {
    host.kind.set('extend');
    await openIt();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Ask Ada Obi to keep sharing');
  });

  it('sends once, busy while it runs, then hands the answer to the page', async () => {
    await openIt();
    await type('To review your last scan');
    await submit();

    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe('ap-1');
    expect(calls[0].message).toBe('To review your last scan');
    // Busy: marked, buttons inert, the note read-only.
    expect(form()?.getAttribute('aria-busy')).toBe('true');
    expect(submitButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(submitButton()?.textContent).toContain('Sending…');
    expect(cancelButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(field()?.readOnly).toBe(true);

    // A second press (or Cancel) while it runs does nothing.
    await submit();
    cancelButton()?.click();
    await render();
    expect(calls.length).toBe(1);
    expect(host.closes).toBe(0);

    calls[0].res.next({ data: SENT });
    calls[0].res.complete();
    await render();
    expect(host.sent).toEqual([SENT]);
    expect(host.refused).toEqual([]);
  });

  it('offline: says so and keeps the note as typed', async () => {
    await openIt();
    await type('Please share the blood results');
    await submit();
    calls[0].res.error({ statusCode: 0, message: '' });
    await render();

    expect(alertText()).toBe(NETWORK_ERROR_MESSAGE);
    expect(field()?.value).toBe('Please share the blood results');
    expect(field()?.readOnly).toBe(false);
    expect(submitButton()?.getAttribute('aria-disabled')).toBeNull();
    expect(host.sent).toEqual([]);
    expect(host.refused).toEqual([]);
  });

  it('a request already waiting: explains it and tells the page to reload', async () => {
    await openIt();
    await submit();
    calls[0].res.error({
      statusCode: 409,
      message: 'You already asked this patient.',
      errors: { code: 'request_pending' },
    });
    await render();
    expect(alertText()).toBe('You already have a request waiting for the patient to answer.');
    expect(host.refused).toEqual(['request_pending']);
  });

  it('declined lately: when the doctor can ask again', async () => {
    await openIt();
    await submit();
    calls[0].res.error({
      statusCode: 409,
      message: 'Not yet.',
      errors: { code: 'request_cooldown', available_at: '2026-10-23T09:00:00Z' },
    });
    await render();
    expect(alertText()).toMatch(/^The patient declined your last request\. You can ask again after 23 Oct 2026, /);
    expect(host.refused).toEqual(['request_cooldown']);
  });

  it('a note the API refuses: its own words, no reload', async () => {
    await openIt();
    await submit();
    calls[0].res.error({
      statusCode: 422,
      message: 'Validation failed',
      errors: { message: 'Keep the note under 500 characters.' },
    });
    await render();
    expect(alertText()).toBe('Keep the note under 500 characters.');
    expect(host.refused).toEqual([]);
  });

  it('Cancel closes; opening again starts a fresh note', async () => {
    await openIt();
    await type('Something');
    cancelButton()?.click();
    await render();
    expect(host.closes).toBe(1);

    await openIt();
    expect(field()?.value).toBe('');
    expect(el.textContent).toContain('0/500');
  });
});
