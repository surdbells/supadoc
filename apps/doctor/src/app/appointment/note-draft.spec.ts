import { TestBed } from '@angular/core/testing';
import { draftIsNewer, NOTE_DRAFT_MAX_AGE_MS, NoteDraftStore } from './note-draft';

const NOTE = {
  subjective: 'Cough for 3 days',
  objective: 'T 37.9',
  assessment: 'URTI',
  plan: 'Fluids, review in 1 week',
};

describe('NoteDraftStore', () => {
  let drafts: NoteDraftStore;

  beforeEach(() => {
    localStorage.clear();
    drafts = TestBed.inject(NoteDraftStore);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('keeps a note for the same doctor and appointment, with when it was kept', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
    expect(drafts.save('appt-1', 'doc-a', NOTE)).toBe(true);
    expect(drafts.take('appt-1', 'doc-a')).toEqual({
      payload: NOTE,
      savedAt: Date.parse('2026-10-20T08:00:00Z'),
    });
    expect(drafts.take('appt-2', 'doc-a')).toBeNull();
  });

  it('never hands one doctor’s note to another doctor on the same device', () => {
    drafts.save('appt-1', 'doc-a', NOTE);
    expect(drafts.take('appt-1', 'doc-b')).toBeNull();
    expect(drafts.take('appt-1', null)).toBeNull();
    // …and the first doctor still has it.
    expect(drafts.take('appt-1', 'doc-a')?.payload).toEqual(NOTE);
  });

  it('drops a note older than a day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
    drafts.save('appt-1', 'doc-a', NOTE);
    vi.setSystemTime(new Date(Date.now() + NOTE_DRAFT_MAX_AGE_MS + 1));
    expect(drafts.take('appt-1', 'doc-a')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('clear() forgets it; pendingCount counts only this doctor’s notes', () => {
    drafts.save('appt-1', 'doc-a', NOTE);
    drafts.save('appt-2', 'doc-a', NOTE);
    drafts.save('appt-3', 'doc-b', NOTE);
    expect(drafts.pendingCount('doc-a')).toBe(2);
    drafts.clear('appt-1');
    expect(drafts.take('appt-1', 'doc-a')).toBeNull();
    expect(drafts.pendingCount('doc-a')).toBe(1);
    expect(drafts.pendingCount(null)).toBe(0);
  });

  it('draftIsNewer: a note saved on the account after the draft was kept wins (never overwritten)', () => {
    const kept = { payload: NOTE, savedAt: Date.parse('2026-10-20T08:00:00Z') };
    // Never saved before, or saved before the draft was kept: the draft may be restored.
    expect(draftIsNewer(kept, null)).toBe(true);
    expect(draftIsNewer(kept, '2026-10-20T07:59:00+00:00')).toBe(true);
    // Edited on another device after the draft was kept: the account's note wins.
    expect(draftIsNewer(kept, '2026-10-20T08:05:00+00:00')).toBe(false);
    expect(draftIsNewer(kept, '2026-10-20T08:00:00+00:00')).toBe(false);
    // This device's clock runs 10 minutes fast: the draft was really kept at 07:50.
    expect(draftIsNewer(kept, '2026-10-20T07:55:00+00:00', 10 * 60_000)).toBe(false);
    // An unreadable server time keeps the account's note.
    expect(draftIsNewer(kept, 'not a date')).toBe(false);
  });

  it('ignores a corrupt entry', () => {
    localStorage.setItem('videomed.doctor.note-draft.appt-9', '{not json');
    expect(drafts.take('appt-9', 'doc-a')).toBeNull();
    expect(
      localStorage.getItem('videomed.doctor.note-draft.appt-9'),
    ).toBeNull();
  });
});
