import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { buttonByText } from '../../testing/onb-testing';
import { StepFooterComponent } from './step-footer';

@Component({
  imports: [StepFooterComponent],
  template: `
    <onb-step-footer
      [invalidLook]="invalid()"
      [busy]="busy()"
      [primaryWidth]="250"
      primaryLabel="Review your application"
      (primary)="primaries = primaries + 1"
      (save)="saves = saves + 1"
      (cancelApplication)="cancels = cancels + 1"
    />
  `,
})
class Host {
  readonly invalid = signal(true);
  readonly busy = signal(false);
  primaries = 0;
  saves = 0;
  cancels = 0;
}

describe('StepFooterComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let host: Host;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('keeps the invalid look focusable and clickable (D29)', () => {
    const primary = buttonByText(el, 'Review your application');
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    expect(primary.disabled).toBe(false);
    expect(primary.className).toContain('bg-cerulean/30');
    expect(primary.className).not.toContain('pointer-events-none');
    primary.click();
    expect(host.primaries).toBe(1);
  });

  it('drops the invalid look once the step is complete', () => {
    host.invalid.set(false);
    fixture.detectChanges();
    const primary = buttonByText(el, 'Review your application');
    expect(primary.hasAttribute('aria-disabled')).toBe(false);
    expect(primary.className).toContain('bg-cerulean ');
    expect(primary.className).toContain('min-[900px]:w-[250px]');
  });

  it('offers Save & continue later and Cancel application', () => {
    buttonByText(el, 'Save & continue later').click();
    buttonByText(el, 'Cancel application').click();
    expect(host.saves).toBe(1);
    expect(host.cancels).toBe(1);
  });

  it('ignores the primary while busy', () => {
    host.busy.set(true);
    fixture.detectChanges();
    buttonByText(el, 'Review your application').click();
    expect(host.primaries).toBe(0);
  });
});
