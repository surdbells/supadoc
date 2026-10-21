import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StaffAuthService } from '@supadoc/auth';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorOnboardingDto } from '@supadoc/models';
import { Subject } from 'rxjs';
import { DoctorStandingStore } from './doctor-standing.store';

/** Just enough of the payload for the store (it only reads `standing`). */
function payload(over: Partial<DoctorOnboardingDto> = {}): DoctorOnboardingDto {
  return { status: 'approved', standing: null, ...over } as DoctorOnboardingDto;
}

/** Each GET /doctor/onboarding is a Subject the test answers (or fails) by hand. */
function setup(signedIn = true) {
  const calls: Subject<{ data: DoctorOnboardingDto }>[] = [];
  const api = {
    onboarding: () => {
      const s = new Subject<{ data: DoctorOnboardingDto }>();
      calls.push(s);
      return s;
    },
  };
  const authed = signal(signedIn);
  TestBed.configureTestingModule({
    providers: [
      { provide: DoctorApi, useValue: api },
      { provide: StaffAuthService, useValue: { isAuthenticated: authed.asReadonly() } },
    ],
  });
  const store = TestBed.inject(DoctorStandingStore);
  const answer = (i: number, data: DoctorOnboardingDto) => {
    calls[i].next({ data });
    calls[i].complete();
  };
  const fail = (i: number) => calls[i].error(new Error('offline'));
  return { store, calls, answer, fail, authed };
}

/** Let the promise chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('DoctorStandingStore', () => {
  it('resolves a failed forced load to null, never the copy it had', async () => {
    const { store, answer, fail } = setup();
    const first = store.load();
    answer(0, payload());
    await first;

    const forced = store.load(true);
    fail(1);
    await expect(forced).resolves.toBeNull();
  });

  it('reads again after a read already in flight when forced, and keeps a refusal noted meanwhile', async () => {
    const { store, calls, answer } = setup();
    const early = store.load();
    store.noteRefusal('doctor_suspended', 'Suspended');
    expect(store.code()).toBe('doctor_suspended');
    expect(calls.length).toBe(1); // the forced read waits for the one in flight

    answer(0, payload()); // began before the refusal: must not wipe it
    await early;
    expect(store.code()).toBe('doctor_suspended');

    await flush();
    expect(calls.length).toBe(2);
    answer(1, payload({ status: 'suspended', standing: { code: 'doctor_suspended', message: 'Suspended' } }));
    await flush();
    expect(store.onboarding()?.status).toBe('suspended');
    expect(store.code()).toBe('doctor_suspended');
  });

  it('drops a read still in flight when cleared (a new sign-in)', async () => {
    const { store, calls, answer } = setup();
    const stale = store.load();
    store.clear();
    const fresh = store.load();
    expect(calls.length).toBe(2);

    answer(0, payload({ status: 'suspended' }));
    await expect(stale).resolves.toBeNull();
    expect(store.onboarding()).toBeNull();

    answer(1, payload());
    await expect(fresh).resolves.toEqual(payload());
    expect(store.onboarding()?.status).toBe('approved');
  });

  it('forgets the doctor as soon as the session ends, however it ends', async () => {
    const { store, answer, authed } = setup();
    const first = store.load();
    answer(0, payload({ status: 'suspended', standing: { code: 'doctor_suspended', message: 'Suspended' } }));
    await first;
    expect(store.code()).toBe('doctor_suspended');
    authed.set(false); // idle timeout, expiry, signed out in another tab…
    TestBed.tick();
    expect(store.onboarding()).toBeNull();
    expect(store.code()).toBeNull();
  });

  it('signed out: load() resolves null at once, without a request', async () => {
    const { store, calls } = setup(false);
    await expect(store.load()).resolves.toBeNull();
    await expect(store.load(true)).resolves.toBeNull();
    expect(calls.length).toBe(0);
  });

  it('a read whose session ended meanwhile is dropped, not kept', async () => {
    const { store, calls, authed } = setup();
    const pending = store.load();
    authed.set(false);
    TestBed.tick();
    calls[0].error({ statusCode: 401, errors: { code: 'signed_out' } });
    await expect(pending).resolves.toBeNull();
    expect(store.onboarding()).toBeNull();
  });
});
