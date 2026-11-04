import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorTimeZoneResultDto, SetTimeZoneInput } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { Subject, throwError } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { DoctorTimeZoneDialog, timeZoneSavedText } from './time-zone-dialog';

@Component({
  imports: [DoctorTimeZoneDialog],
  template: `<doc-time-zone-dialog [open]="open()" [preset]="preset()" (closed)="closes = closes + 1; open.set(false)" (saved)="saved.push($event)" />`,
})
class HostComponent {
  readonly open = signal(false);
  readonly preset = signal<string | null>(null);
  closes = 0;
  readonly saved: DoctorTimeZoneResultDto[] = [];
}

interface DialogInternals {
  choose(tz: string | null): void;
}

describe('DoctorTimeZoneDialog', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;
  let clock: DoctorClock;
  let puts: { body: SetTimeZoneInput; res: Subject<{ data: DoctorTimeZoneResultDto }> }[];
  let fail: unknown = null;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label) ?? null;
  const dialog = () => fixture.debugElement.query((d) => d.componentInstance instanceof DoctorTimeZoneDialog).componentInstance as DialogInternals;
  const text = () => (el.textContent ?? '').replace(/\s+/g, ' ');

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
    puts = [];
    fail = null;
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideSupadocIcons(),
        {
          provide: DoctorApi,
          useValue: {
            setTimeZone: (body: SetTimeZoneInput) => {
              if (fail) return throwError(() => fail);
              const res = new Subject<{ data: DoctorTimeZoneResultDto }>();
              puts.push({ body, res });
              return res;
            },
          },
        },
      ],
    }).compileComponents();
    clock = TestBed.inject(DoctorClock);
    clock.apply({ timezone: 'Africa/Lagos', timezone_source: 'auto' });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    host.open.set(true);
    await render();
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    vi.useRealTimers();
  });

  it('asks about moving times only when the choice differs, and sends shift_slots only when ticked', async () => {
    expect(text()).not.toContain('Also move my unbooked open times');
    dialog().choose('America/Chicago');
    await render();
    expect(text()).toContain('From now on your weekly hours, availability, schedule and emails use Central Time (CST).');
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(false);

    button('Save time zone')?.click();
    await render();
    expect(puts[0].body).toEqual({ timezone: 'America/Chicago', source: 'manual' });
    puts[0].res.next({
      data: { timezone: 'America/Chicago', timezone_source: 'manual', changed: true, shifted: null },
    });
    puts[0].res.complete();
    await render();
    expect(clock.zone()).toBe('America/Chicago');
    expect(host.closes).toBe(1);

    host.open.set(true);
    await render();
    dialog().choose('Africa/Lagos');
    await render();
    const tick = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!tick) throw new Error('No checkbox');
    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    await render();
    button('Save time zone')?.click();
    await render();
    expect(puts[1].body).toEqual({ timezone: 'Africa/Lagos', source: 'manual', shift_slots: true });
  });

  it('says what moved and what could not', async () => {
    dialog().choose('America/Chicago');
    await render();
    button('Save time zone')?.click();
    await render();
    puts[0].res.next({
      data: { timezone: 'America/Chicago', timezone_source: 'manual', changed: true, shifted: { moved: 12, skipped: 1 } },
    });
    puts[0].res.complete();
    await render();
    const status = el.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(status).toBe(
      "Time zone changed to Central Time (CST). Moved 12 open times and blocks. 1 couldn't be moved (booked, already passed, or another time is already there).",
    );
    expect(host.saved.length).toBe(1);
  });

  it('leaves out the counts when nothing moved', () => {
    expect(timeZoneSavedText({ timezone: 'America/Chicago', shifted: { moved: 0, skipped: 0 } }, new Date('2026-11-04T15:00:00Z'))).toBe(
      'Time zone changed to Central Time (CST).',
    );
  });

  it('shows the field error from the API and stays open', async () => {
    fail = { status: 422, error: { errors: { timezone: 'Choose a time zone from the list' } } };
    dialog().choose('America/Chicago');
    await render();
    button('Save time zone')?.click();
    await render();
    expect(text()).toContain('Choose a time zone from the list');
    expect(host.closes).toBe(0);
  });
});
