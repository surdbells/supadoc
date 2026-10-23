import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { APPLICATION_LANGUAGES } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { MultiSelectComponent } from './multi-select';

@Component({
  imports: [MultiSelectComponent, ReactiveFormsModule],
  template: `<onb-multi-select inputId="langs" [options]="options" [formControl]="ctrl" />`,
})
class Host {
  readonly options = APPLICATION_LANGUAGES;
  readonly ctrl = new FormControl<string[]>([], { nonNullable: true });
}

describe('MultiSelectComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    fixture.detectChanges();
  });

  afterEach(() => el.remove());

  const trigger = () => el.querySelector<HTMLButtonElement>('#langs') as HTMLButtonElement;
  const boxes = () => Array.from(el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const tick = (label: string) => {
    const box = boxes().find((b) => b.parentElement?.textContent?.trim() === label);
    if (!box) throw new Error(label);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };

  it('is a disclosure button over a fieldset of checkboxes (no listbox)', () => {
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().textContent).toContain('Select');
    trigger().click();
    fixture.detectChanges();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe('langs-panel');
    expect(el.querySelector('fieldset legend')?.textContent).toContain('Languages, choose up to 5');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(boxes()).toHaveLength(APPLICATION_LANGUAGES.length);
  });

  it('joins the chosen values in list order', () => {
    trigger().click();
    fixture.detectChanges();
    tick('Yoruba');
    tick('English');
    expect(fixture.componentInstance.ctrl.value).toEqual(['English', 'Yoruba']);
    expect(trigger().textContent).toContain('English, Yoruba');
  });

  it('allows at most 5 and says so', () => {
    trigger().click();
    fixture.detectChanges();
    for (const l of ['English', 'Yoruba', 'Igbo', 'Hausa', 'French']) tick(l);
    const unchecked = boxes().filter((b) => !b.checked);
    expect(unchecked.every((b) => b.disabled)).toBe(true);
    expect(el.textContent).toContain('You can choose up to 5.');
  });

  it('closes when focus tabs out of it (it never covers the next control), not when focus moves inside or nowhere', () => {
    const outside = document.createElement('textarea');
    document.body.appendChild(outside);
    trigger().click();
    fixture.detectChanges();
    const panel = el.querySelector<HTMLElement>('#langs-panel') as HTMLElement;
    expect(panel.getAttribute('tabindex')).toBe('-1');
    boxes()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: boxes()[1] }));
    boxes()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: panel }));
    boxes()[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    fixture.detectChanges();
    expect(el.querySelector('fieldset')).not.toBeNull();
    boxes()[boxes().length - 1].dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    fixture.detectChanges();
    expect(el.querySelector('fieldset')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    outside.remove();
  });

  it('closes on Escape and returns focus to the button', () => {
    trigger().click();
    fixture.detectChanges();
    boxes()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(el.querySelector('fieldset')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
