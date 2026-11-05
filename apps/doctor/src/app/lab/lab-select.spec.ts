import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { LabSelect, type LabSelectOption } from './lab-select';
import { must } from './testing/lab-fixtures';

const OPTIONS: LabSelectOption[] = [
  { value: 'diagnosis', label: 'Diagnosis' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'screening', label: 'Screening' },
  { value: 'pre_operative', label: 'Pre-operative' },
];

@Component({
  imports: [LabSelect],
  template: `
    <doc-lab-select
      id="purpose"
      label="Purpose"
      [options]="options"
      [value]="value()"
      [removable]="removable()"
      [disabled]="disabled()"
      [helper]="helper()"
      (valueChange)="picked.push($event); value.set($event)"
      (removed)="removed = removed + 1"
    />
    <button id="outside" type="button">Outside</button>
  `,
})
class Host {
  readonly options = OPTIONS;
  readonly value = signal<string | null>(null);
  readonly removable = signal(true);
  readonly disabled = signal(false);
  readonly helper = signal<string | undefined>(undefined);
  picked: string[] = [];
  removed = 0;
}

describe('LabSelect', () => {
  let host: Host;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  const combo = () => must(el.querySelector<HTMLElement>('[role="combobox"]'), '[role="combobox"]');
  const listbox = () => must(el.querySelector<HTMLElement>('[role="listbox"]'), '[role="listbox"]');
  const options = () => Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'));
  const key = (k: string, init: KeyboardEventInit = {}) => {
    combo().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
    fixture.detectChanges();
  };
  const active = () => combo().getAttribute('aria-activedescendant');

  it('is an APG select-only combobox labelled by its label, showing "Select" until chosen', () => {
    expect(combo().getAttribute('aria-haspopup')).toBe('listbox');
    expect(combo().getAttribute('aria-expanded')).toBe('false');
    expect(combo().getAttribute('aria-controls')).toBe('purpose-listbox');
    expect(combo().getAttribute('aria-labelledby')).toBe('purpose-label purpose');
    expect(el.querySelector('#purpose-label')?.textContent?.trim()).toBe('Purpose');
    expect(combo().textContent?.trim()).toContain('Select');
    expect(listbox().hidden).toBe(true);
    // The id is the combobox's only: never repeated on the host element.
    expect(el.querySelectorAll('#purpose').length).toBe(1);
    expect(el.querySelector('doc-lab-select')?.hasAttribute('id')).toBe(false);
  });

  it('opens with Enter, moves with arrows / Home / End and selects with Enter', () => {
    key('Enter');
    expect(combo().getAttribute('aria-expanded')).toBe('true');
    expect(listbox().hidden).toBe(false);
    // The placeholder row is option 0 and is skipped: the first real option is active.
    expect(active()).toBe('purpose-opt-1');
    key('ArrowDown');
    expect(active()).toBe('purpose-opt-2');
    key('End');
    expect(active()).toBe('purpose-opt-4');
    key('Home');
    expect(active()).toBe('purpose-opt-1');
    key('ArrowUp'); // can't go above the first selectable row
    expect(active()).toBe('purpose-opt-1');
    key('ArrowDown');
    key('Enter');
    expect(host.picked).toEqual(['monitoring']);
    expect(combo().getAttribute('aria-expanded')).toBe('false');
    expect(combo().textContent).toContain('Monitoring');
  });

  it('Escape closes without choosing and keeps focus on the box; Alt+↓ / Space open', () => {
    combo().focus();
    key('ArrowDown', { altKey: true });
    expect(combo().getAttribute('aria-expanded')).toBe('true');
    key('Escape');
    expect(combo().getAttribute('aria-expanded')).toBe('false');
    expect(host.picked).toEqual([]);
    expect(document.activeElement).toBe(combo());
    key(' ');
    expect(combo().getAttribute('aria-expanded')).toBe('true');
  });

  it('type-ahead jumps to the row starting with the letters typed', () => {
    key('s');
    expect(combo().getAttribute('aria-expanded')).toBe('true');
    expect(active()).toBe('purpose-opt-3'); // Screening
    key('c'); // "sc" still Screening
    expect(active()).toBe('purpose-opt-3');
    key('x'); // "scx" matches nothing: stays put
    expect(active()).toBe('purpose-opt-3');
  });

  it('type-ahead with several letters picks the matching row', () => {
    combo().click();
    fixture.detectChanges();
    key('p');
    key('r');
    expect(active()).toBe('purpose-opt-4'); // Pre-operative
    key('Enter');
    expect(host.picked).toEqual(['pre_operative']);
  });

  it('the "Select" placeholder row is shown but never selectable', () => {
    combo().click();
    fixture.detectChanges();
    const first = options()[0];
    expect(first.textContent?.trim()).toBe('Select');
    expect(first.getAttribute('aria-disabled')).toBe('true');
    first.click();
    fixture.detectChanges();
    expect(host.picked).toEqual([]);
    options()[2].click();
    fixture.detectChanges();
    expect(host.picked).toEqual(['monitoring']);
  });

  it('marks the chosen row aria-selected', () => {
    host.value.set('screening');
    fixture.detectChanges();
    combo().click();
    fixture.detectChanges();
    expect(options()[3].getAttribute('aria-selected')).toBe('true');
    expect(options()[1].getAttribute('aria-selected')).toBe('false');
    expect(active()).toBe('purpose-opt-3');
  });

  it('the ✕ is a sibling of the combobox (never inside it) and emits removed', () => {
    expect(el.querySelector('[aria-label^="Remove"]')).toBeNull();
    host.value.set('diagnosis');
    fixture.detectChanges();
    const x = must(el.querySelector<HTMLButtonElement>('button[aria-label="Remove Diagnosis"]'), 'button[aria-label="Remove Diagnosis"]');
    expect(x).not.toBeNull();
    expect(combo().contains(x)).toBe(false);
    expect(x.parentElement).toBe(combo().parentElement);
    x.click();
    expect(host.removed).toBe(1);
  });

  it('closes on a click outside', () => {
    combo().click();
    fixture.detectChanges();
    must(el.querySelector<HTMLElement>('#outside'), '#outside').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(combo().getAttribute('aria-expanded')).toBe('false');
  });

  it('a disabled select says why and does not open', () => {
    host.disabled.set(true);
    host.helper.set('Choose a specimen site first');
    fixture.detectChanges();
    expect(combo().getAttribute('aria-disabled')).toBe('true');
    expect(combo().getAttribute('aria-describedby')).toBe('purpose-helper');
    expect(el.querySelector('#purpose-helper')?.textContent?.trim()).toBe('Choose a specimen site first');
    combo().click();
    key('Enter');
    expect(combo().getAttribute('aria-expanded')).toBe('false');
  });
});
