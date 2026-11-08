import { SeenIds } from './seen-ids';

describe('SeenIds', () => {
  it('the first call is the baseline: false whatever the ids', () => {
    expect(new SeenIds().fresh(['a', 'b'])).toBe(false);
    expect(new SeenIds().fresh([])).toBe(false);
  });

  it('later: true for an id not seen before, false for repeats', () => {
    const seen = new SeenIds();
    seen.fresh(['a']);
    expect(seen.fresh(['a'])).toBe(false);
    expect(seen.fresh(['a', 'b'])).toBe(true);
    expect(seen.fresh(['a', 'b'])).toBe(false);
    // An id that went and came back is not new again.
    expect(seen.fresh(['b'])).toBe(false);
    expect(seen.fresh(['a', 'b'])).toBe(false);
  });

  it('an empty baseline (nothing yet): the first id after it is new', () => {
    const seen = new SeenIds();
    expect(seen.fresh([])).toBe(false);
    expect(seen.fresh(['plan'])).toBe(true);
    expect(seen.fresh(['plan'])).toBe(false);
  });

  it('separate instances keep separate baselines', () => {
    const referrals = new SeenIds();
    const certificates = new SeenIds();
    referrals.fresh(['r1']);
    // The certificates' first read is its own baseline, even after the referrals'.
    expect(certificates.fresh(['c1'])).toBe(false);
    expect(certificates.fresh(['c1', 'c2'])).toBe(true);
    expect(referrals.fresh(['r1'])).toBe(false);
  });
});
