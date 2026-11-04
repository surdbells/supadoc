import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type { TimeZoneSource } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { SettingsNotifications } from './settings-notifications';

const BASE = 'http://api.test';
const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

function deviceZone(tz: string) {
  return vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...realResolved.call(this), timeZone: tz };
  });
}

describe('Settings › Notification Preferences › Time zone', () => {
  let fixture: ComponentFixture<SettingsNotifications>;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const load = async (timezone: string, source: TimeZoneSource | null) => {
    fixture = TestBed.createComponent(SettingsNotifications);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    fixture.detectChanges();
    http.expectOne(`${BASE}/api/portal/me/settings`).flush({
      status: 'success',
      message: 'OK',
      data: { notifications: {}, delivery: {} },
    });
    http.expectOne(`${BASE}/api/portal/me`).flush({
      status: 'success',
      message: 'OK',
      data: { id: 'p-1', email: 'ada@example.test', first_name: 'Ada', last_name: 'Obi', timezone, timezone_source: source },
    });
    await render();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsNotifications],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    fixture?.destroy();
    el?.remove();
    vi.restoreAllMocks();
  });

  it('shows the saved zone, explains what it is for, and saves a choice as the patient\'s own', async () => {
    deviceZone('Africa/Lagos');
    await load('Africa/Lagos', 'auto');
    expect(text()).toContain('Time zone for emails and reminders');
    expect(text()).toContain(
      "Used for the times in your emails, texts and notifications. The app always shows times in this device's time zone (WAT).",
    );
    expect(text()).toContain('Africa/Lagos');
    const save = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Save time zone'));
    expect(save?.disabled).toBe(true); // nothing changed yet

    (fixture.componentInstance as unknown as { tzValue: { set: (v: string) => void } }).tzValue.set('America/Chicago');
    await render();
    expect(save?.disabled).toBe(false);
    save?.click();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/api/portal/me/timezone`);
    expect(put.request.body).toEqual({ timezone: 'America/Chicago', source: 'manual' });
    put.flush({ status: 'success', message: 'OK', data: { timezone: 'America/Chicago', timezone_source: 'manual', changed: true } });
    await render();
    expect(text()).toContain('Time zone saved.');
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toContain('Time zone saved.');
  });

  it('says WAT is used for now when the zone was never set and this device hides its own', async () => {
    deviceZone('UTC');
    await load('Africa/Lagos', null);
    expect(el.querySelector('[data-testid="tz-undetected"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      "We couldn't detect your time zone; we're using West Africa Time (WAT) for now.",
    );
    // The zone shown can be confirmed as the patient's own (manual), so the note goes.
    const save = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Save time zone'));
    expect(save?.disabled).toBe(false);
    save?.click();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/api/portal/me/timezone`);
    expect(put.request.body).toEqual({ timezone: 'Africa/Lagos', source: 'manual' });
    put.flush({ status: 'success', message: 'OK', data: { timezone: 'Africa/Lagos', timezone_source: 'manual', changed: true } });
    await render();
    expect(el.querySelector('[data-testid="tz-undetected"]')).toBeNull();
    expect(save?.disabled).toBe(true);
  });

  it('shows the field error from the API under the picker', async () => {
    deviceZone('Africa/Lagos');
    await load('Africa/Lagos', 'manual');
    (fixture.componentInstance as unknown as { tzValue: { set: (v: string) => void } }).tzValue.set('Europe/London');
    await render();
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Save time zone'))?.click();
    http
      .expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/api/portal/me/timezone`)
      .flush(
        { status: 'error', message: 'Validation failed', errors: { timezone: 'Choose a time zone from the list' } },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    await render();
    expect(text()).toContain('Choose a time zone from the list');
  });
});
