import { callHoldWanted } from './call-hold';

const base = {
  live: true,
  othersInCall: 0,
  someoneJoined: false,
  firstWaitOver: false,
};

describe('callHoldWanted (doctor call screen keep-alive)', () => {
  it('holds while connected and someone else is in the call', () => {
    expect(
      callHoldWanted({ ...base, othersInCall: 1, someoneJoined: true }),
    ).toBe(true);
    expect(
      callHoldWanted({
        ...base,
        othersInCall: 2,
        someoneJoined: true,
        firstWaitOver: true,
      }),
    ).toBe(true);
  });

  it('holds while first waiting for the patient — for a bounded time', () => {
    expect(callHoldWanted(base)).toBe(true);
    expect(callHoldWanted({ ...base, firstWaitOver: true })).toBe(false);
  });

  it('lets go once everyone has left (an ended call left open still times out)', () => {
    expect(callHoldWanted({ ...base, someoneJoined: true })).toBe(false);
  });

  it('never holds outside a live call (connecting, failed, closed by the API)', () => {
    expect(callHoldWanted({ ...base, live: false, othersInCall: 1 })).toBe(
      false,
    );
    expect(callHoldWanted({ ...base, live: false })).toBe(false);
  });
});
