import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StaffAuthService } from '@supadoc/auth';
import { API_CONFIG } from '@supadoc/data-access';
import type { AppointmentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { AppointmentResolveDialog, type ResolveMode, type ResolveOutcome } from './resolve-dialog';

const BASE = 'http://api.test';

/** A paid ₦10,000 consultation that ended yesterday, still confirmed. */
function appointment(over: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id: 'a1',
    patient_id: 'p1',
    patient: { id: 'p1', name: 'Ada Obi' },
    specialist: { id: 's1', name: 'Dr Bayo Ade' },
    scheduled_at: '2026-10-14T09:00:00Z',
    ends_at: '2026-10-14T09:30:00Z',
    type: 'video',
    type_label: 'Video',
    status: 'confirmed',
    status_label: 'Confirmed',
    amount: '10000.00',
    payment_status: 'paid',
    refunded_amount: null,
    phase: 'past',
    needs_attention: true,
    created_at: '2026-10-01T09:00:00Z',
    ...over,
  };
}

@Component({
  imports: [AppointmentResolveDialog],
  template: `
    <bo-appointment-resolve-dialog
      [open]="open()"
      [mode]="mode()"
      [appointment]="appt()"
      (closed)="open.set(false)"
      (resolved)="outcomes.push($event); open.set(false)"
    />
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly mode = signal<ResolveMode>('cancel');
  readonly appt = signal<AppointmentDto>(appointment());
  readonly outcomes: ResolveOutcome[] = [];
}

describe('AppointmentResolveDialog', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let http: HttpTestingController;

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const openAs = async (mode: ResolveMode, appt: AppointmentDto = appointment()) => {
    host.appt.set(appt);
    host.mode.set(mode);
    host.open.set(true);
    await render();
    await tick();
    await render();
  };
  const close = async () => {
    host.open.set(false);
    await render();
    await tick();
  };

  const form = () => el.querySelector<HTMLFormElement>('form');
  const submit = async () => {
    form()?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
    await tick();
    await render();
  };
  /** Pick a radio by its value (refund mode or no-show party). */
  const choose = async (value: string) => {
    const radio = el.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
    if (!radio) throw new Error(`No "${value}" option`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    await render();
  };
  const typeInto = async (selector: string, value: string) => {
    const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!field) throw new Error(`No ${selector}`);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await render();
  };
  const reasonField = () => el.querySelector<HTMLTextAreaElement>('textarea');
  const amountField = () => el.querySelector<HTMLInputElement>('input[inputmode="decimal"]');

  const expectStatus = (): TestRequest =>
    http.expectOne((r) => r.method === 'PATCH' && r.url === `${BASE}/api/appointments/a1/status`);
  const expectResolve = (): TestRequest =>
    http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/api/appointments/a1/resolve`);
  const ok = (req: TestRequest, over: Partial<AppointmentDto> = {}, refundedNow = '0.00') =>
    req.flush({ status: 'success', message: 'OK', data: { ...appointment(over), refunded_now: refundedNow } });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
        // No settings.manage: the no-show shares stay generic and nothing loads them.
        { provide: StaffAuthService, useValue: { hasPermission: () => false } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
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

  it('cancels with a full refund by default: no amount, no key', async () => {
    await openAs('cancel', appointment({ phase: 'upcoming', needs_attention: false }));
    await submit();
    const req = expectStatus();
    expect(req.request.body).toEqual({ status: 'cancelled', refund: 'full' });
    ok(req, { status: 'cancelled' }, '10000.00');
    await render();
    expect(host.outcomes[0]?.message).toContain('₦10,000.00 went back');
  });

  it('will not cancel without a refund until a reason is given', async () => {
    await openAs('cancel');
    await choose('none');
    await submit();
    http.expectNone(() => true);
    expect(reasonField()?.getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Say why');

    await typeInto('textarea', 'It took place after all.');
    await submit();
    const req = expectStatus();
    expect(req.request.body).toEqual({ status: 'cancelled', refund: 'none', reason: 'It took place after all.' });
    ok(req, { status: 'cancelled' });
  });

  it('sends a partial refund with one idempotency key per opening, kept across retries', async () => {
    const closed = appointment({ status: 'completed', needs_attention: false });
    await openAs('refund', closed);
    await choose('amount');
    await typeInto('input[inputmode="decimal"]', '2500');
    await typeInto('textarea', 'Goodwill refund after a poor connection.');

    await submit();
    const first = expectResolve();
    const key = first.request.body.idempotency_key as string;
    expect(first.request.body).toEqual({
      action: 'refund',
      reason: 'Goodwill refund after a poor connection.',
      refund: 'amount',
      amount: '2500',
      idempotency_key: key,
    });
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    first.flush({ message: 'Server error' }, { status: 503, statusText: 'Unavailable' });
    await render();

    // A retry of the same refund in the same opening posts once server-side.
    await submit();
    const retry = expectResolve();
    expect(retry.request.body.idempotency_key).toBe(key);
    retry.flush({ message: 'Server error' }, { status: 503, statusText: 'Unavailable' });
    await render();

    // Opening it again is a new refund: a new key.
    await close();
    await openAs('refund', closed);
    await choose('amount');
    await typeInto('input[inputmode="decimal"]', '2500');
    await typeInto('textarea', 'Goodwill refund after a poor connection.');
    await submit();
    const again = expectResolve();
    expect(again.request.body.idempotency_key).not.toBe(key);
    ok(again, { status: 'completed', refunded_amount: '2500.00' }, '2500.00');
  });

  it('marks it held with no refund by default', async () => {
    await openAs('held');
    await typeInto('textarea', 'The doctor confirmed it took place.');
    await submit();
    const req = expectResolve();
    expect(req.request.body).toEqual({ action: 'held', reason: 'The doctor confirmed it took place.', refund: 'none' });
    ok(req, { status: 'completed' });
  });

  it('marks it missed with the party and the no-show rules', async () => {
    // Only the doctor joined: the call records point to the patient.
    await openAs('no_show', appointment({ doctor_first_joined_at: '2026-10-14T09:01:00Z', patient_first_joined_at: null }));
    await typeInto('textarea', "The patient called to say they couldn't join.");
    await submit();
    const req = expectResolve();
    expect(req.request.body).toEqual({
      action: 'no_show',
      no_show: 'patient',
      reason: "The patient called to say they couldn't join.",
      refund: 'policy',
    });
    ok(req, { status: 'missed', no_show: 'patient' });
    await render();
    expect(host.outcomes[0]?.message).toContain("Patient didn't join");
  });

  it('does not report a change when a missed visit would stay exactly as it is', async () => {
    await openAs('no_show', appointment({ status: 'missed', no_show: 'both', phase: 'past', needs_attention: false }));
    await typeInto('textarea', 'Double-checked the call records.');
    await submit();
    http.expectNone(() => true);
    expect(el.textContent).toContain('Nothing would change');

    await choose('doctor');
    await submit();
    const req = expectResolve();
    expect(req.request.body).toMatchObject({ action: 'no_show', no_show: 'doctor', refund: 'policy' });
    ok(req, { status: 'missed', no_show: 'doctor' }, '10000.00');
  });

  it('sends no refund choice for an unpaid booking', async () => {
    await openAs('cancel', appointment({ payment_status: 'unpaid', phase: 'upcoming', needs_attention: false }));
    expect(el.querySelector('input[type="radio"]')).toBeNull();
    expect(el.textContent).toContain("It wasn't paid for");
    await submit();
    const req = expectStatus();
    expect(req.request.body).toEqual({ status: 'cancelled' });
    ok(req, { status: 'cancelled', payment_status: 'unpaid' });
  });

  it("shows the API's amount error next to the field and moves focus there", async () => {
    await openAs('refund', appointment({ status: 'completed', needs_attention: false }));
    await choose('amount');
    await typeInto('input[inputmode="decimal"]', '9000');
    await typeInto('textarea', 'Goodwill refund.');
    (document.activeElement as HTMLElement | null)?.blur();
    await submit();
    expectResolve().flush(
      { status: 'error', message: 'Validation failed', errors: { amount: 'Only ₦8,000.00 is left to refund' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await render();
    await tick();
    await render();
    const amount = amountField();
    expect(amount?.getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('Only ₦8,000.00 is left to refund');
    expect(document.activeElement).toBe(amount);
    // Inline only: no duplicate in the general alert.
    expect(el.querySelector('sd-alert')).toBeNull();
    expect(host.open()).toBe(true);
  });
});
