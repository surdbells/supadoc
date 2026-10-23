import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { provideSupadocIcons } from '@supadoc/ui';
import { NumberFieldComponent } from './number-field';

@Component({
  imports: [NumberFieldComponent, ReactiveFormsModule],
  template: `<onb-number-field inputId="years" [formControl]="ctrl" [stepper]="true" [min]="0" [max]="60" />`,
})
class Host {
  readonly ctrl = new FormControl<number | null>(null);
}

describe('NumberFieldComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  const input = () => el.querySelector<HTMLInputElement>('#years') as HTMLInputElement;

  it('is a spinbutton with its bounds and value', () => {
    expect(input().getAttribute('role')).toBe('spinbutton');
    expect(input().getAttribute('aria-valuemin')).toBe('0');
    expect(input().getAttribute('aria-valuemax')).toBe('60');
    fixture.componentInstance.ctrl.setValue(8);
    fixture.detectChanges();
    expect(input().getAttribute('aria-valuenow')).toBe('8');
  });

  it('keeps digits only', () => {
    input().value = '1a2';
    input().dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.ctrl.value).toBe(12);
    input().value = '';
    input().dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.ctrl.value).toBeNull();
  });

  it('has two 40px stepper buttons and arrow keys, within the bounds', () => {
    const inc = el.querySelector<HTMLButtonElement>('button[aria-label="Increase"]') as HTMLButtonElement;
    const dec = el.querySelector<HTMLButtonElement>('button[aria-label="Decrease"]') as HTMLButtonElement;
    for (const b of [inc, dec]) {
      expect(b.className).toContain('h-10');
      expect(b.className).toContain('w-10');
    }
    inc.click();
    expect(fixture.componentInstance.ctrl.value).toBe(0);
    inc.click();
    expect(fixture.componentInstance.ctrl.value).toBe(1);
    dec.click();
    dec.click();
    expect(fixture.componentInstance.ctrl.value).toBe(0);
    fixture.componentInstance.ctrl.setValue(60);
    fixture.detectChanges();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(fixture.componentInstance.ctrl.value).toBe(60);
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(fixture.componentInstance.ctrl.value).toBe(59);
  });
});
