import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { provideSupadocIcons } from '../icons/icons';
import { WORLD_COUNTRIES } from './countries';
import { COUNTRIES, countryForNumber, PhoneInputComponent } from './phone-input';

@Component({
  imports: [PhoneInputComponent, ReactiveFormsModule],
  template: `
    <sd-phone-input
      [formControl]="ctrl"
      [countries]="countries()"
      [size]="size()"
      label="Phone number"
      [required]="true"
      inputId="phone"
      [describedBy]="describedBy()"
      [invalid]="invalid()"
    />
  `,
})
class Host {
  readonly ctrl = new FormControl('', { nonNullable: true });
  readonly countries = signal(WORLD_COUNTRIES);
  readonly size = signal<'md' | 'lg'>('md');
  readonly describedBy = signal<string | null>('phone-hint');
  readonly invalid = signal(false);
}

describe('PhoneInputComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  const trigger = () => el.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
  const number = () => el.querySelector('input[type="tel"]') as HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('starts on the first country of the list it is given', () => {
    expect(trigger().getAttribute('aria-label')).toBe('Country code: Nigeria +234');
  });

  it('selects GB for a resumed +44 number (the primary country of the shared code)', () => {
    host.ctrl.setValue('+447700900123');
    fixture.detectChanges();
    expect(trigger().getAttribute('aria-label')).toBe('Country code: United Kingdom +44');
    expect(number().value).toBe('7700900123');
  });

  it('selects US for a +1 number and keeps the longest code otherwise', () => {
    expect(countryForNumber('+12025550143', WORLD_COUNTRIES)?.iso).toBe('US');
    expect(countryForNumber('+2348031234567', WORLD_COUNTRIES)?.iso).toBe('NG');
    expect(countryForNumber('+79161234567', WORLD_COUNTRIES)?.iso).toBe('RU');
    expect(countryForNumber('+447700900123', COUNTRIES)).toBeNull();
  });

  it('emits E.164 with the chosen dial code', () => {
    const input = number();
    input.value = '803 123 4567';
    input.dispatchEvent(new Event('input'));
    expect(host.ctrl.value).toBe('+2348031234567');
  });

  it('wires the label, description and invalid state to the number input', () => {
    const label = el.querySelector('label') as HTMLLabelElement;
    expect(label.getAttribute('for')).toBe('phone');
    expect(number().id).toBe('phone');
    expect(number().getAttribute('aria-describedby')).toBe('phone-hint');
    expect(number().hasAttribute('aria-invalid')).toBe(false);
    expect(label.querySelector('[aria-hidden="true"]')?.textContent).toContain('*');
    expect(label.querySelector('.sr-only')?.textContent).toContain('(required)');
    host.invalid.set(true);
    fixture.detectChanges();
    expect(number().getAttribute('aria-invalid')).toBe('true');
  });

  it('is a 48px control with 14px text at size md', () => {
    expect(number().className).toContain('py-3');
    expect(number().className).toContain('text-body-sm');
    host.size.set('lg');
    fixture.detectChanges();
    expect(number().className).toContain('py-4');
  });

  it('has an AA Slate placeholder at size md, keeping Slate/60 at lg (patient, mobile)', () => {
    expect(number().classList.contains('placeholder:text-slate')).toBe(true);
    expect(number().classList.contains('placeholder:text-slate/60')).toBe(false);
    host.size.set('lg');
    fixture.detectChanges();
    expect(number().className).toContain('placeholder:text-slate/60');
  });

  it('keeps focus inside when its open list is clicked (a focusable panel)', () => {
    trigger().click();
    fixture.detectChanges();
    const panel = el.querySelector('[role="listbox"]')?.parentElement as HTMLElement;
    expect(panel.getAttribute('tabindex')).toBe('-1');
  });

  it('offers a search box for long lists and filters by name or code', () => {
    trigger().click();
    fixture.detectChanges();
    const search = el.querySelector('input[aria-label="Search countries"]') as HTMLInputElement;
    expect(search).toBeTruthy();
    search.value = 'united k';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const options = Array.from(el.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('United Kingdom');
  });

  it('has no search box for the short default list', () => {
    host.countries.set(COUNTRIES);
    fixture.detectChanges();
    trigger().click();
    fixture.detectChanges();
    expect(el.querySelector('input[aria-label="Search countries"]')).toBeNull();
    expect(el.querySelectorAll('[role="option"]').length).toBe(COUNTRIES.length);
  });
});
