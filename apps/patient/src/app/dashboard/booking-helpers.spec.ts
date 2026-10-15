import { convertToParamMap } from '@angular/router';
import { addDaysYmd, todayLocal, viewerTimeZone } from '@supadoc/data-access';
import {
  ANY_WHEN,
  calendarErrorText,
  hasDateFilter,
  hasWhenFilter,
  httpStatus,
  lastSearchDay,
  notBookableText,
  whenDay,
  whenFromQuery,
  whenLastDay,
  whenParams,
  whenQuery,
  whenText,
  type WhenFilter,
} from './booking-helpers';

const q = (params: Record<string, string>) => convertToParamMap(params);

describe('whenFromQuery', () => {
  it('reads today / tomorrow / this week and a part of the day', () => {
    expect(whenFromQuery(q({ when: 'today', time: 'morning' }))).toEqual({
      when: 'today',
      date: '',
      time: 'morning',
    });
    expect(whenFromQuery(q({ when: 'WEEK' }))).toEqual({
      when: 'week',
      date: '',
      time: 'any',
    });
  });

  it('reads a date from today on, and ignores a past or malformed one', () => {
    const tomorrow = todayLocal(1);
    expect(whenFromQuery(q({ when: tomorrow }))).toEqual({
      when: 'date',
      date: tomorrow,
      time: 'any',
    });
    expect(whenFromQuery(q({ when: todayLocal(-1), time: 'evening' }))).toEqual(
      { ...ANY_WHEN, time: 'evening' },
    );
    expect(whenFromQuery(q({ when: 'soon', time: 'night' }))).toEqual(ANY_WHEN);
  });

  it('round-trips through the deep-link params', () => {
    const f: WhenFilter = {
      when: 'date',
      date: todayLocal(3),
      time: 'afternoon',
    };
    expect(whenQuery(f)).toEqual({ when: f.date, time: 'afternoon' });
    expect(whenFromQuery(q(whenQuery(f) as Record<string, string>))).toEqual(f);
    expect(whenQuery(ANY_WHEN)).toEqual({ when: undefined, time: undefined });
  });
});

describe('whenParams', () => {
  it('sends a date or a window — never both — and always the viewer’s zone', () => {
    expect(
      whenParams({ when: 'date', date: '2030-01-02', time: 'any' }),
    ).toEqual({
      available_on: '2030-01-02',
      available_within: undefined,
      part_of_day: undefined,
      tz: viewerTimeZone(),
    });
    expect(whenParams({ when: 'tomorrow', date: '', time: 'evening' })).toEqual(
      {
        available_on: undefined,
        available_within: 'tomorrow',
        part_of_day: 'evening',
        tz: viewerTimeZone(),
      },
    );
    expect(whenParams(ANY_WHEN).tz).toBe(viewerTimeZone());
  });

  it('a "Pick a date" with no date yet filters nothing', () => {
    const picking: WhenFilter = { when: 'date', date: '', time: 'any' };
    expect(whenParams(picking).available_on).toBeUndefined();
    expect(hasDateFilter(picking)).toBe(false);
    expect(hasWhenFilter({ ...picking, time: 'morning' })).toBe(true);
  });
});

describe('whenDay / whenLastDay / whenText', () => {
  it('names the day the filter is about', () => {
    expect(whenDay({ when: 'today', date: '', time: 'any' })).toBe(
      todayLocal(),
    );
    expect(whenDay({ when: 'tomorrow', date: '', time: 'any' })).toBe(
      todayLocal(1),
    );
    expect(whenDay({ when: 'week', date: '', time: 'any' })).toBeNull();
    expect(whenLastDay({ when: 'week', date: '', time: 'any' })).toBe(
      todayLocal(6),
    );
    expect(whenLastDay(ANY_WHEN)).toBeNull();
  });

  it('words it for a heading', () => {
    expect(whenText({ when: 'date', date: '2026-10-16', time: 'any' })).toBe(
      'on Fri 16 Oct',
    );
    expect(whenText({ when: 'today', date: '', time: 'evening' })).toBe(
      'today in the evening',
    );
    expect(whenText({ when: 'any', date: '', time: 'morning' })).toBe(
      'in the morning',
    );
  });

  it('offers dates up to the default booking horizon', () => {
    expect(lastSearchDay()).toBe(addDaysYmd(todayLocal(), 59));
  });
});

describe('doctor not bookable', () => {
  it('reads the status from either error shape', () => {
    expect(httpStatus({ statusCode: 404 })).toBe(404);
    expect(httpStatus({ status: 422 })).toBe(422);
    expect(httpStatus('nope')).toBeUndefined();
  });

  it('words a 404 from the calendar as "not taking bookings"', () => {
    expect(calendarErrorText('Specialist "abc" not found', 'Dr Ada Obi')).toBe(
      notBookableText('Dr Ada Obi'),
    );
    expect(calendarErrorText('Something else', 'Dr Ada Obi')).toBe(
      'Something else',
    );
    expect(calendarErrorText(null, 'Dr Ada Obi')).toBe('');
    expect(notBookableText(null)).toBe(
      "This doctor isn't taking bookings at the moment.",
    );
  });
});
