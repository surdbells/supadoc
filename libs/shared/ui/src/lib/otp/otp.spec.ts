import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { OtpComponent, type OtpVariant } from './otp';

@Component({
  imports: [OtpComponent, ReactiveFormsModule],
  template: `<sd-otp [formControl]="code" [variant]="variant()" [invalid]="invalid()" />`,
})
class Host {
  readonly code = new FormControl('', { nonNullable: true });
  readonly variant = signal<OtpVariant>('default');
  readonly invalid = signal(false);
}

describe('OtpComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  const boxes = () => Array.from(el.querySelectorAll<HTMLInputElement>('input'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('is a labelled group of six named digits', () => {
    const group = el.querySelector('[role="group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('6-digit code');
    expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Digit 1 of 6',
      'Digit 2 of 6',
      'Digit 3 of 6',
      'Digit 4 of 6',
      'Digit 5 of 6',
      'Digit 6 of 6',
    ]);
  });

  it('keeps the default boxes (56px, field radius)', () => {
    expect(boxes()[0].className).toContain('size-14');
    expect(boxes()[0].className).toContain('rounded-field');
  });

  it('compact boxes are 48px with 6px corners and a Slate border', () => {
    host.variant.set('compact');
    fixture.detectChanges();
    const cls = boxes()[0].className;
    expect(cls).toContain('size-12');
    expect(cls).toContain('rounded-md');
    expect(cls).toContain('border-slate');
    expect(cls).not.toContain('rounded-field');
  });

  it('shows alert borders and aria-invalid when invalid', () => {
    host.variant.set('compact');
    host.invalid.set(true);
    fixture.detectChanges();
    for (const b of boxes()) {
      expect(b.className).toContain('border-alert');
      expect(b.getAttribute('aria-invalid')).toBe('true');
    }
  });

  it('fills every box from a pasted code', () => {
    const paste = new Event('paste') as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '123 456' } });
    boxes()[0].dispatchEvent(paste);
    fixture.detectChanges();
    expect(host.code.value).toBe('123456');
  });

  it('focusFirstEmpty focuses where an incomplete code continues (the last box when full)', () => {
    document.body.appendChild(el);
    const otp = fixture.debugElement.query((d) => d.componentInstance instanceof OtpComponent).componentInstance as OtpComponent;
    host.code.setValue('12');
    fixture.detectChanges();
    otp.focusFirstEmpty();
    expect(document.activeElement).toBe(boxes()[2]);
    host.code.setValue('123456');
    fixture.detectChanges();
    otp.focusFirstEmpty();
    expect(document.activeElement).toBe(boxes()[5]);
    el.remove();
  });

  it('emits digits as they are typed', () => {
    const first = boxes()[0];
    first.value = '7';
    first.dispatchEvent(new Event('input'));
    expect(host.code.value).toBe('7');
  });
});
