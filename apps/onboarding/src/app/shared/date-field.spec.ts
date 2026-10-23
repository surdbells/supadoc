import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { provideSupadocIcons } from '@supadoc/ui';
import { DateFieldComponent, dateValueOf, maskDate } from './date-field';

@Component({
  imports: [DateFieldComponent, ReactiveFormsModule],
  template: `<onb-date-field inputId="dob" [formControl]="ctrl" min="2000-01-01" max="2030-12-31" />`,
})
class Host {
  readonly ctrl = new FormControl('', { nonNullable: true });
}

describe('DateFieldComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  const text = () => el.querySelector<HTMLInputElement>('#dob') as HTMLInputElement;
  const native = () => el.querySelector<HTMLInputElement>('input[type="date"]') as HTMLInputElement;

  it('masks typing as DD / MM / YYYY and emits YYYY-MM-DD', () => {
    expect(maskDate('1112')).toBe('11 / 12');
    expect(maskDate('11121999')).toBe('11 / 12 / 1999');
    expect(dateValueOf('11 / 12 / 1999')).toBe('1999-12-11');
    expect(dateValueOf('31 / 02 / 1999')).toBe('31 / 02 / 1999');
    const input = text();
    input.value = '11121999';
    input.dispatchEvent(new Event('input'));
    expect(input.value).toBe('11 / 12 / 1999');
    expect(fixture.componentInstance.ctrl.value).toBe('1999-12-11');
  });

  it('shows a written value in the mask', () => {
    fixture.componentInstance.ctrl.setValue('2028-04-11');
    fixture.detectChanges();
    expect(text().value).toBe('11 / 04 / 2028');
  });

  it('renders the native picker (not display:none) with its bounds, hidden from AT', () => {
    const n = native();
    expect(n).toBeTruthy();
    expect(n.getAttribute('aria-hidden')).toBe('true');
    expect(n.tabIndex).toBe(-1);
    expect(n.getAttribute('min')).toBe('2000-01-01');
    expect(n.getAttribute('max')).toBe('2030-12-31');
    expect(n.className.split(' ')).not.toContain('hidden');
  });

  it('opens the native picker, and focuses the text input when showPicker fails', () => {
    const n = native() as HTMLInputElement & { showPicker?: () => void };
    n.showPicker = vi.fn(() => {
      throw new Error('NotAllowedError');
    });
    el.querySelector<HTMLButtonElement>('button[aria-label="Choose date"]')?.click();
    expect(n.showPicker).toHaveBeenCalled();
    expect(document.activeElement === text() || !document.body.contains(el)).toBe(true);
  });

  it('takes a date picked in the native picker', () => {
    const n = native();
    n.value = '2026-04-21';
    n.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.componentInstance.ctrl.value).toBe('2026-04-21');
    expect(text().value).toBe('21 / 04 / 2026');
  });
});
