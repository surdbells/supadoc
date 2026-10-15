import { TestBed } from '@angular/core/testing';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorOnboardingDto } from '@supadoc/models';
import { Subject } from 'rxjs';
import { DoctorStandingStore } from './doctor-standing.store';

/** Just enough of the payload for the store (it only reads `standing`). */
function payload(over: Partial<DoctorOnboardingDto> = {}): DoctorOnboardingDto {
  return { status: 'approved', standing: null, ...over } as DoctorOnboardingDto;
}

/** Each GET /doctor/onboarding is a Subject the test answers (or fails) by hand. */
function setup() {
  const calls: Subject<{ data: DoctorOnboardingDto }>[] = [];
  const api = {
    onboarding: () => {
      const s = new Subject<{ data: DoctorOnboardingDto }>();
      calls.push(s);
      return s;
    },
  };
  TestBed.configureTestingModule({ providers: [{ provide: DoctorApi, useValue: api }] });
  const store = TestBed.inject(DoctorStandingStore);
  const answer = (i: number, data: DoctorOnboardingDto) => {
    calls[i].next({ data });
    calls[i].complete();
  };
  const fail = (i: number) => calls[i].error(new Error('offline'));
  return { store, calls, answer, fail };
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
});
