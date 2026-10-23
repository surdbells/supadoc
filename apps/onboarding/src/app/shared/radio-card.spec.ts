import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RadioCardComponent } from './radio-card';

@Component({
  imports: [RadioCardComponent],
  template: `
    <fieldset>
      <legend>Where are you licensed?</legend>
      <onb-radio-card name="route" value="ng" title="Nigeria" description="MDCN" [checked]="choice() === 'ng'" (picked)="choice.set($event)" />
      <onb-radio-card name="route" value="abroad" title="Abroad" description="Elsewhere" [checked]="choice() === 'abroad'" (picked)="choice.set($event)" />
    </fieldset>
  `,
})
class Host {
  readonly choice = signal<string | null>(null);
}

describe('RadioCardComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('groups native radios in a fieldset with a legend', () => {
    expect(el.querySelector('fieldset > legend')?.textContent).toContain('Where are you licensed?');
    const radios = el.querySelectorAll<HTMLInputElement>('input[type="radio"][name="route"]');
    expect(radios).toHaveLength(2);
    expect(radios[0].closest('label')).toBeTruthy();
  });

  it('selects through the native radio and shows the chosen state', () => {
    const abroad = el.querySelector<HTMLInputElement>('input[value="abroad"]') as HTMLInputElement;
    abroad.checked = true;
    abroad.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.componentInstance.choice()).toBe('abroad');
    expect(abroad.closest('label')?.className).toContain('bg-haze');
    expect(abroad.getAttribute('aria-describedby')).toBe('route-abroad-desc');
  });

  it('keeps the description AA on the chosen card (Ink/80 on Haze, not Slate)', () => {
    const desc = () => el.querySelector<HTMLElement>('#route-ng-desc') as HTMLElement;
    expect(desc().className).toContain('text-slate');
    fixture.componentInstance.choice.set('ng');
    fixture.detectChanges();
    expect(desc().className).toContain('text-ink/80');
    expect(desc().className).not.toContain('text-slate');
  });

  it('has a visible focus ring on the card', () => {
    expect(el.querySelector('label')?.className).toContain('focus-within:ring-2');
  });
});
