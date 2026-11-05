import { TestBed } from '@angular/core/testing';
import { AppointmentsApi, WalletApi } from '@supadoc/data-access';
import type { PatientGuestListDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { type Observable, of } from 'rxjs';
import { InviteGuestDialog } from './invite-guest-dialog';

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });

/** A paid guest list (so the wallet is read too). */
const LIST = {
  guests: [],
  can_manage: true,
  can_add: true,
  max_guests: 3,
  manage_problem: null,
  currency: 'NGN',
  guest_fee: '5000.00',
} as unknown as PatientGuestListDto;

describe('InviteGuestDialog › background re-reads are passive', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });
  afterAll(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('opening reads the guests and the wallet (active); coming back to the tab re-reads both passively (X-SD-Passive)', async () => {
    const guests = vi.fn<(id: string, options?: { passive?: boolean }) => Observable<unknown>>(() => ok(LIST));
    const wallet = vi.fn<(currency?: string, options?: { passive?: boolean }) => Observable<unknown>>(() =>
      ok({ balance: '20000.00' }),
    );
    TestBed.configureTestingModule({
      imports: [InviteGuestDialog],
      providers: [
        provideSupadocIcons(),
        { provide: AppointmentsApi, useValue: { guests } },
        { provide: WalletApi, useValue: { wallet } },
      ],
    });
    const fixture = TestBed.createComponent(InviteGuestDialog);
    fixture.componentRef.setInput('appointmentId', 'ap-1');
    fixture.componentRef.setInput('detailsUrl', '/dashboard/appointments/ap-1');
    fixture.detectChanges();
    await fixture.whenStable();

    // The patient opened the dialog: these count as activity.
    expect(guests.mock.calls).toEqual([['ap-1', undefined]]);
    expect(wallet.mock.calls).toEqual([[undefined, undefined]]);

    // Back from topping up in the other tab.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(guests.mock.calls.slice(1)).toEqual([['ap-1', { passive: true }]]);
    expect(wallet.mock.calls.slice(1)).toEqual([[undefined, { passive: true }]]);

    fixture.destroy();
  });
});
