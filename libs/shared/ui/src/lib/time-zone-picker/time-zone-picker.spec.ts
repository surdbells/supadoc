import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import { availableTimeZones, TimeZonePickerComponent } from './time-zone-picker';

@Component({
  imports: [TimeZonePickerComponent],
  template: `
    <sd-time-zone-picker
      id="tz"
      label="Your time zone"
      [hint]="hint()"
      [invalid]="invalid()"
      [value]="value()"
      [menu]="menu()"
      (valueChange)="value.set($event)"
    />
  `,
})
class Host {
  readonly menu = signal<'overlay' | 'inline'>('overlay');
  readonly value = signal<string | null>('America/Chicago');
  readonly hint = signal<string | undefined>('Your schedule and emails use this time zone.');
  readonly invalid = signal<string | null>(null);
}

const real = Intl.DateTimeFormat.prototype.resolvedOptions;

/** Makes this device report `tz` as its zone. */
function deviceZone(tz: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone: tz };
  });
}

describe('TimeZonePickerComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  const trigger = () => el.querySelector('#tz') as HTMLButtonElement;
  const search = () => el.querySelector('input[role="combobox"]') as HTMLInputElement;
  const groups = () =>
    [...el.querySelectorAll('[role="listbox"] [role="group"]')].map((g) => ({
      label: g.getAttribute('aria-label'),
      options: [...g.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? ''),
    }));
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const open = async () => {
    trigger().click();
    await render();
  };
  const type = async (text: string) => {
    search().value = text;
    search().dispatchEvent(new Event('input'));
    await render();
  };

  async function create() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-15T12:00:00Z')); // winter: CST, GMT in London
    deviceZone('Africa/Lagos'); // whatever this machine says (a test may override)
  });

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is labelled, names the chosen zone, and is described by its hint and error', async () => {
    await create();
    const label = el.querySelector('label') as HTMLLabelElement;
    expect(label.textContent?.trim()).toBe('Your time zone');
    expect(label.htmlFor).toBe('tz');
    const names = (trigger().getAttribute('aria-labelledby') ?? '').split(' ').map((id) => el.querySelector(`#${id}`)?.textContent?.trim());
    expect(names).toEqual(['Your time zone', 'Central Time — America/Chicago (CST)']);
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-describedby')).toBe('tz-hint');

    host.invalid.set('Choose a time zone from the list');
    await render();
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(trigger().getAttribute('aria-describedby')).toBe('tz-hint tz-error');
    expect(el.querySelector('#tz-error')?.textContent).toContain('Choose a time zone from the list');
  });

  it('lists a Suggested group first: the detected zone, then Lagos, the US zones and London', async () => {
    deviceZone('Europe/Berlin');
    await create();
    await open();
    const [suggested, all] = groups();
    expect(suggested.label).toBe('Suggested');
    expect(suggested.options).toEqual([
      'Detected on this device · Central European Time — Europe/Berlin (CET)',
      expect.stringMatching(/^West Africa .* — Africa\/Lagos \(WAT\)$/),
      'Eastern Time — America/New_York (EST)',
      'Central Time — America/Chicago (CST)',
      'Mountain Time — America/Denver (MST)',
      'Pacific Time — America/Los_Angeles (PST)',
      expect.stringMatching(/ — Europe\/London \(GMT\)$/),
    ]);
    expect(all.label).toBe('All time zones');
    expect(all.options.length).toBeGreaterThan(300);
    expect(document.activeElement).toBe(search());
  });

  it('never suggests an undetectable device zone', async () => {
    deviceZone('Etc/UTC');
    await create();
    await open();
    expect(groups()[0].options[0]).not.toContain('Detected on this device');
  });

  it('searches the IANA name, the long name and the abbreviation', async () => {
    await create();
    await open();
    await type('CST');
    expect(groups().flatMap((g) => g.options)).toContain('Central Time — America/Chicago (CST)');
    expect(groups().flatMap((g) => g.options).every((o) => o.toLowerCase().includes('cst'))).toBe(true);

    await type('new york');
    expect(groups().flatMap((g) => g.options)).toEqual([
      'Eastern Time — America/New_York (EST)',
      'Eastern Time — America/New_York (EST)',
    ]);

    await type('west africa');
    expect(groups()[0].options[0]).toMatch(/Africa\/Lagos/);

    await type('zzzz');
    expect(groups()).toEqual([]);
    expect(el.textContent).toContain('No matching time zones');
  });

  it('keeps a current value the browser spells differently, selected', async () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Africa/Lagos', 'Asia/Kolkata', 'Europe/London']);
    await create();
    host.value.set('Asia/Calcutta');
    await render();
    await open();
    const all = groups().find((g) => g.label === 'All time zones');
    expect(all?.options).toEqual([
      expect.stringContaining('Africa/Lagos'),
      expect.stringContaining('Asia/Calcutta (IST)'),
      expect.stringContaining('Asia/Kolkata (IST)'),
      expect.stringContaining('Europe/London'),
      expect.stringContaining('— UTC (UTC)'),
    ]);
    const selected = [...el.querySelectorAll('[role="option"][aria-selected="true"]')].map((o) => o.textContent?.trim());
    expect(selected).toEqual([expect.stringContaining('Asia/Calcutta')]);
  });

  it('picks with the keyboard (aria-activedescendant) and by click, returning focus to the field', async () => {
    await create();
    await open();
    await type('denver');
    const active = () => el.querySelector(`#${search().getAttribute('aria-activedescendant')}`)?.textContent?.trim();
    expect(active()).toBe('Mountain Time — America/Denver (MST)');
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await render();
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await render();
    expect(host.value()).toBe('America/Denver');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await open();
    await type('london');
    (el.querySelector('[role="option"]') as HTMLElement).click();
    await render();
    expect(host.value()).toBe('Europe/London');

    await open();
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await render();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(host.value()).toBe('Europe/London');
  });

  it('floats the list by default, and opens it in the flow with menu="inline" (inside a dialog it is never clipped)', async () => {
    await create();
    await open();
    const menu = () => el.querySelector('[data-testid="tz-menu"]') as HTMLElement;
    expect(menu().classList).toContain('absolute');
    expect(menu().classList).not.toContain('relative');

    trigger().click(); // close
    host.menu.set('inline');
    await render();
    await open();
    expect(menu().classList).toContain('relative');
    expect(menu().classList).not.toContain('absolute');
    // Still the same listbox, themed the same way.
    expect(menu().querySelector('[role="listbox"]')).not.toBeNull();
    expect(menu().classList).toContain('sd-menu');
  });

  it('falls back to a built-in list when the browser cannot list zones', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => {
      throw new RangeError('unsupported');
    });
    const zones = availableTimeZones();
    for (const tz of ['Africa/Lagos', 'America/Chicago', 'Asia/Dubai', 'Asia/Riyadh', 'Australia/Sydney', 'America/Sao_Paulo', 'UTC']) {
      expect(zones).toContain(tz);
    }
  });
});
