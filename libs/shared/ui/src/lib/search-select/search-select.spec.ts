import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '../icons/icons';
import { SearchSelectComponent } from './search-select';

@Component({
  imports: [SearchSelectComponent],
  template: `
    <sd-search-select
      [value]="value()"
      (valueChange)="value.set($event)"
      [options]="options"
      [size]="size()"
      inputId="specialty"
      [describedBy]="describedBy()"
      [invalid]="invalid()"
    />
  `,
})
class Host {
  readonly value = signal('');
  readonly options = ['Cardiology', { value: 'GP', label: 'General Practice' }];
  readonly size = signal<'md' | 'lg' | 'field'>('field');
  readonly describedBy = signal<string | null>('specialty-error');
  readonly invalid = signal(false);
}

describe('SearchSelectComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  const trigger = () => el.querySelector('#specialty') as HTMLButtonElement;

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

  it('size "field" is a 48px control with 14px text', () => {
    expect(trigger().className).toContain('py-3');
    expect(trigger().className).toContain('text-body-sm');
    host.size.set('lg');
    fixture.detectChanges();
    expect(trigger().className).toContain('py-4');
  });

  it('size "field" has an AA Slate search placeholder; the other sizes keep Slate/60', () => {
    const search = () => el.querySelector('input[type="text"]') as HTMLInputElement;
    trigger().click();
    fixture.detectChanges();
    expect(search().classList.contains('placeholder:text-slate')).toBe(true);
    expect(search().classList.contains('placeholder:text-slate/60')).toBe(false);
    expect(el.querySelector('[role="listbox"]')?.parentElement?.getAttribute('tabindex')).toBe('-1');
    host.size.set('md');
    fixture.detectChanges();
    expect(search().className).toContain('placeholder:text-slate/60');
  });

  it('gives the trigger its id and listbox ARIA', () => {
    const t = trigger();
    expect(t.getAttribute('aria-haspopup')).toBe('listbox');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-describedby')).toBe('specialty-error');
    expect(t.hasAttribute('aria-invalid')).toBe(false);
    t.click();
    fixture.detectChanges();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[role="listbox"]')).toBeTruthy();
  });

  it('marks the trigger invalid with an alert border', () => {
    host.invalid.set(true);
    fixture.detectChanges();
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(trigger().className).toContain('border-alert');
  });

  it('picks an option and reports the selection', () => {
    trigger().click();
    fixture.detectChanges();
    const option = Array.from(el.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((o) =>
      o.textContent?.includes('General Practice'),
    ) as HTMLButtonElement;
    option.click();
    fixture.detectChanges();
    expect(host.value()).toBe('GP');
    expect(trigger().textContent).toContain('General Practice');
  });
});
