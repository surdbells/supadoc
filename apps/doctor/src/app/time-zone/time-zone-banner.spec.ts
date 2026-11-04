import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { DoctorClock } from '../doctor-clock';
import { DoctorTimeZoneBanner, mismatchSnoozed, snoozeMismatch, TZ_MISMATCH_KEY, TZ_MISMATCH_SNOOZE_MS } from './time-zone-banner';

const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

/** This device reports `tz`. */
function deviceZone(tz: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...realResolved.call(this), timeZone: tz };
  });
}

describe('DoctorTimeZoneBanner', () => {
  let fixture: ComponentFixture<DoctorTimeZoneBanner>;
  let el: HTMLElement;
  let clock: DoctorClock;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label) ?? null;

  async function setup(profile: { timezone: string; timezone_source: 'auto' | 'manual' | null }) {
    TestBed.configureTestingModule({
      imports: [DoctorTimeZoneBanner],
      providers: [provideSupadocIcons(), { provide: DoctorApi, useValue: {} }],
    });
    clock = TestBed.inject(DoctorClock);
    clock.apply(profile);
    fixture = TestBed.createComponent(DoctorTimeZoneBanner);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
    try {
      localStorage.removeItem(TZ_MISMATCH_KEY);
    } catch {
      /* none */
    }
  });

  afterEach(() => {
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('asks to choose a zone when none was ever set and the device reports none', async () => {
    deviceZone('UTC');
    await setup({ timezone: 'Africa/Lagos', timezone_source: null });
    expect(text()).toContain("We couldn't detect your time zone. Choose one so your schedule and emails are right.");
    expect(button('Choose time zone')).not.toBeNull();
  });

  it('says nothing when the device is on the same offset', async () => {
    deviceZone('America/Winnipeg');
    await setup({ timezone: 'America/Chicago', timezone_source: 'manual' });
    expect(text()).toBe('');
  });

  it('offers the device zone on a mismatch, and Keep snoozes it even when storage throws', async () => {
    deviceZone('Africa/Lagos');
    await setup({ timezone: 'America/Chicago', timezone_source: 'manual' });
    expect(text()).toContain(
      'This device is set to West Africa Time (WAT), but your VideoMed time zone is Central Time (CST). Your schedule, availability and emails use CST.',
    );
    expect(button('Use West Africa Time')).not.toBeNull();

    const store = Object.getPrototypeOf(localStorage) as Storage;
    vi.spyOn(store, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(store, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    button('Keep Central Time')?.click();
    await render();
    expect(text()).not.toContain('This device is set to');
  });

  it('remembers Keep for 30 days, for that pair only', () => {
    const now = Date.parse('2026-11-04T15:00:00Z');
    snoozeMismatch('America/Chicago', 'Africa/Lagos', now);
    expect(mismatchSnoozed('America/Chicago', 'Africa/Lagos', now + 1000)).toBe(true);
    expect(mismatchSnoozed('America/Chicago', 'Europe/London', now + 1000)).toBe(false);
    expect(mismatchSnoozed('America/Chicago', 'Africa/Lagos', now + TZ_MISMATCH_SNOOZE_MS + 1)).toBe(false);
  });
});
