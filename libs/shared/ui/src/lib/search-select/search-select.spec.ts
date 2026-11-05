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

  afterEach(() => el.remove());

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

  it('keeps the original menu by default: option buttons in a floating light list, no combobox ARIA', () => {
    document.body.appendChild(el); // focus checks below (removed after each test)
    trigger().click();
    fixture.detectChanges();
    const menu = el.querySelector('.sd-menu') as HTMLElement;
    // The same classes as before (order is not significant).
    expect([...menu.classList].sort()).toEqual(
      'sd-menu absolute left-0 right-0 z-30 mt-2 min-w-[200px] overflow-hidden rounded-card border border-haze bg-white shadow-overlay focus:outline-none'
        .split(' ')
        .sort(),
    );
    expect(el.querySelectorAll('ul[role="listbox"] > li > button[role="option"]').length).toBe(3); // clear row + 2
    const search = el.querySelector('input[type="text"]') as HTMLInputElement;
    for (const attr of ['role', 'aria-controls', 'aria-activedescendant', 'aria-expanded', 'aria-labelledby']) expect(search.hasAttribute(attr)).toBe(false);
    expect(search.getAttribute('aria-label')).toBe('Search…');
    // Pressing an option button still focuses it (its own Tab stop here).
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.querySelector('button[role="option"]')?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(trigger().hasAttribute('aria-controls')).toBe(false);
    expect(trigger().hasAttribute('aria-labelledby')).toBe(false);
    expect(trigger().className).toContain('bg-white');
    expect(el.querySelector('.sd-ss-call')).toBeNull();
    // ↓ does nothing new here; Esc still closes back to the trigger.
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(el.querySelector('.sd-ss-active')).toBeNull();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});

@Component({
  imports: [SearchSelectComponent],
  template: `
    <span id="type-label">Document type</span>
    <div [class]="cockpit() ? 'sd-call' : ''" [attr.data-theme]="cockpit()">
      <sd-search-select
        pattern="combobox"
        menu="inline"
        size="field"
        inputId="type"
        labelledBy="type-label"
        [theme]="cockpit() ? 'call' : 'light'"
        [clearable]="clearable()"
        [value]="value()"
        (valueChange)="value.set($event)"
        [options]="options()"
        [noOptionsText]="noOptionsText()"
        placeholder="Select document type"
        searchPlaceholder="Search document types"
      />
    </div>
    <button type="button" id="outside">Elsewhere</button>
  `,
})
class ComboHost {
  readonly value = signal('');
  readonly clearable = signal(false);
  readonly cockpit = signal<'dark' | 'light' | null>(null);
  readonly options = signal([
    { value: 'lab', label: 'Laboratory Test Report' },
    { value: 'blood', label: 'Blood Test Report' },
    { value: 'xray', label: 'X-Ray Report' },
  ]);
  readonly noOptionsText = signal('No options');
}

describe('SearchSelectComponent pattern="combobox"', () => {
  let fixture: ComponentFixture<ComboHost>;
  let host: ComboHost;
  let el: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const trigger = () => el.querySelector('#type') as HTMLButtonElement;
  const search = () => el.querySelector('input[role="combobox"]') as HTMLInputElement;
  const options = () => Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'));
  const activeLabel = () => el.querySelector(`#${search().getAttribute('aria-activedescendant')}`)?.textContent?.trim();
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const typeInto = async (text: string) => {
    search().value = text;
    search().dispatchEvent(new Event('input'));
    await render();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComboHost],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    fixture = TestBed.createComponent(ComboHost);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  });

  afterEach(() => el.remove());

  it('names the trigger "label, value" and wires the APG combobox + listbox', async () => {
    expect(trigger().getAttribute('aria-labelledby')).toBe('type-label type-value');
    expect(el.querySelector('#type-value')?.textContent?.trim()).toBe('Select document type');
    expect(trigger().hasAttribute('aria-controls')).toBe(false);
    trigger().click();
    await render();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe('type-list');
    expect(search().getAttribute('aria-autocomplete')).toBe('list');
    expect(search().getAttribute('aria-expanded')).toBe('true');
    expect(search().getAttribute('aria-controls')).toBe('type-list');
    // The search box is named by the field's label too ("Document type Search document types"),
    // so two fields' lists never read alike.
    expect(search().hasAttribute('aria-label')).toBe(false);
    expect(search().getAttribute('aria-labelledby')).toBe('type-label type-search-label');
    const searchLabel = el.querySelector('#type-search-label') as HTMLElement;
    expect(searchLabel.hidden).toBe(true);
    expect(searchLabel.textContent?.trim()).toBe('Search document types');
    expect(search().getAttribute('autocomplete')).toBe('off');
    expect(document.activeElement).toBe(search());
    const list = el.querySelector('#type-list') as HTMLElement;
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.getAttribute('aria-labelledby')).toBe('type-label');
    // Rows are options that only take a click (focus stays in the search box).
    expect(options().every((o) => o.tagName === 'DIV' && o.getAttribute('tabindex') === '-1')).toBe(true);
    expect(options().map((o) => o.id)).toEqual(['type-list-0', 'type-list-1', 'type-list-2']);
    expect(activeLabel()).toBe('Laboratory Test Report');
  });

  it('filters anywhere in the label, ignoring case, keeps option ids stable, and says when nothing matches', async () => {
    trigger().click();
    await render();
    await typeInto('  REPORT ');
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Laboratory Test Report', 'Blood Test Report', 'X-Ray Report']);
    await typeInto('test');
    expect(options().map((o) => o.id)).toEqual(['type-list-0', 'type-list-1']);
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('2 matches');
    await typeInto('-ray');
    expect(options().map((o) => o.id)).toEqual(['type-list-2']);
    expect(activeLabel()).toBe('X-Ray Report');
    await typeInto('scan');
    expect(options()).toEqual([]);
    expect(el.querySelector('.sd-menu')?.textContent).toContain('No matches');
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('No matches');
    expect(search().hasAttribute('aria-activedescendant')).toBe(false);
    const enter = key(search(), 'Enter');
    await render();
    expect(enter.defaultPrevented).toBe(true);
    expect(host.value()).toBe(''); // nothing to pick
    expect(el.querySelector('.sd-menu')).not.toBeNull();
  });

  it('moves with ↓ ↑ PageDown PageUp (no wrap) and picks with Enter, back on the trigger', async () => {
    trigger().focus();
    key(trigger(), 'ArrowDown');
    await render();
    expect(activeLabel()).toBe('Laboratory Test Report');
    key(search(), 'ArrowUp');
    await render();
    expect(activeLabel()).toBe('Laboratory Test Report');
    key(search(), 'PageDown');
    await render();
    expect(activeLabel()).toBe('X-Ray Report');
    key(search(), 'ArrowDown');
    await render();
    expect(activeLabel()).toBe('X-Ray Report');
    key(search(), 'PageUp');
    key(search(), 'ArrowDown');
    await render();
    expect(activeLabel()).toBe('Blood Test Report');
    expect(el.querySelector('.sd-ss-active')?.id).toBe('type-list-1');
    key(search(), 'Enter');
    await render();
    expect(host.value()).toBe('blood');
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    // Reopens on the chosen option, marked selected.
    trigger().click();
    await render();
    expect(activeLabel()).toBe('Blood Test Report');
    expect(el.querySelector('[aria-selected="true"]')?.id).toBe('type-list-1');
  });

  it('a letter on the closed field opens it searching for that letter', async () => {
    trigger().focus();
    const e = key(trigger(), 'x');
    await render();
    expect(e.defaultPrevented).toBe(true);
    expect(search().value).toBe('x');
    expect(options().map((o) => o.textContent?.trim())).toEqual(['X-Ray Report']);
    expect(activeLabel()).toBe('X-Ray Report');
    // Modified keys and Space are left alone.
    key(search(), 'Escape');
    await render();
    expect(key(trigger(), 'c', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(el.querySelector('.sd-menu')).toBeNull();
  });

  it('picks with the pointer', async () => {
    trigger().click();
    await render();
    options()[2].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await render();
    expect(activeLabel()).toBe('X-Ray Report');
    options()[2].click();
    await render();
    expect(host.value()).toBe('xray');
    expect(trigger().textContent).toContain('X-Ray Report');
    expect(document.activeElement).toBe(trigger());
  });

  it('Esc closes only the list (handled, so a dialog around it stays)', async () => {
    const outer = vi.fn();
    el.addEventListener('keydown', outer);
    trigger().click();
    await render();
    const esc = key(search(), 'Escape');
    await render();
    expect(esc.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Tab closes the list and moves on (the browser’s own move); Shift+Tab moves on back from the trigger', async () => {
    const outside = el.querySelector('#outside') as HTMLElement;
    const leave = async (from: Element) => {
      // The browser's own move (jsdom has none): focus leaves the field.
      from.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
      await render();
    };
    trigger().click();
    await render();
    const searchBox = search();
    // Nothing in the list is a tab stop (Chrome would make the scrolling list one).
    expect(el.querySelector('#type-list')?.getAttribute('tabindex')).toBe('-1');
    const tab = key(searchBox, 'Tab');
    // Not cancelled, and the box stays until focus has left: the browser moves on from it.
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(searchBox);
    await render();
    expect(el.querySelector('.sd-menu')).not.toBeNull();
    await leave(searchBox);
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(host.value()).toBe(''); // Tab picks nothing
    trigger().click();
    await render();
    const back = key(search(), 'Tab', { shiftKey: true });
    // The trigger has focus when the browser moves back, so it lands before the field.
    expect(back.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trigger());
    await render();
    expect(el.querySelector('.sd-menu')).not.toBeNull(); // moving within the field
    await leave(trigger());
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(host.value()).toBe('');
  });

  it('a press anywhere in the list keeps focus in the search box, so its keys (Esc) still work', async () => {
    const outer = vi.fn();
    el.addEventListener('keydown', outer);
    trigger().click();
    await render();
    const press = (target: Element) => {
      const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const menu = el.querySelector('.sd-menu') as HTMLElement;
    // The magnifier, the search row's padding, the list, a row: focus never leaves the search box.
    expect(press(menu.querySelector('sd-icon') as Element)).toBe(true);
    expect(press(menu.firstElementChild as Element)).toBe(true);
    expect(press(el.querySelector('#type-list') as Element)).toBe(true);
    expect(press(options()[1])).toBe(true);
    // The search box itself keeps its own press (caret placement, selection).
    expect(press(search())).toBe(false);
    await typeInto('zzz');
    expect(press(Array.from(menu.querySelectorAll('p')).find((p) => /No matches/.test(p.textContent ?? '')) as Element)).toBe(true);
    // Whatever else gets focus in the list (a screen reader, touch) hands it back to the search box.
    menu.focus();
    expect(document.activeElement).toBe(search());
    const esc = key(document.activeElement as Element, 'Escape');
    await render();
    expect(esc.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('options that arrive with the list open: says so while there are none, then starts on the first', async () => {
    host.options.set([]);
    host.noOptionsText.set('Loading document types…');
    await render();
    trigger().click();
    await render();
    expect(options()).toEqual([]);
    expect(el.querySelector('.sd-menu')?.textContent).toContain('Loading document types…');
    expect(el.querySelector('.sd-menu')?.textContent).not.toContain('No matches');
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('Loading document types…');
    host.options.set([
      { value: 'lab', label: 'Laboratory Test Report' },
      { value: 'blood', label: 'Blood Test Report' },
    ]);
    await render();
    expect(el.querySelector('.sd-menu')?.textContent).not.toContain('Loading');
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
    expect(activeLabel()).toBe('Laboratory Test Report');
    expect(el.querySelector('.sd-ss-active')?.id).toBe('type-list-0');
    key(search(), 'ArrowDown');
    await render();
    expect(activeLabel()).toBe('Blood Test Report');
    key(search(), 'Enter');
    await render();
    expect(host.value()).toBe('blood');
  });

  it('marks the active row with a forced-colours outline (High Contrast drops tints and shadows)', () => {
    const styles = ((SearchSelectComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles ?? []).join('\n');
    expect(styles).toMatch(/@media\s*\(forced-colors:\s*active\)[^@]*\.sd-ss-active[^}]*outline:\s*2px solid Highlight/);
  });

  it('closes when focus leaves the field, not when it moves into its own list', async () => {
    trigger().click();
    await render();
    search().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: options()[1] }));
    await render();
    expect(el.querySelector('.sd-menu')).not.toBeNull();
    search().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: el.querySelector('#outside') }));
    await render();
    expect(el.querySelector('.sd-menu')).toBeNull();
  });

  it('the click-away backdrop closes it with focus back on the trigger', async () => {
    trigger().click();
    await render();
    (el.querySelector('button[aria-hidden="true"]') as HTMLButtonElement).click();
    await render();
    expect(el.querySelector('.sd-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('offers the clear row first when clearable', async () => {
    host.clearable.set(true);
    host.value.set('lab');
    await render();
    trigger().click();
    await render();
    expect(options()[0].id).toBe('type-list-none');
    expect(options()[0].textContent?.trim()).toBe('Select document type');
    expect(activeLabel()).toBe('Laboratory Test Report');
    key(search(), 'ArrowUp');
    key(search(), 'Enter');
    await render();
    expect(host.value()).toBe('');
  });

  it('menu="inline" opens the list in the flow (a dialog body cannot clip it)', async () => {
    trigger().click();
    await render();
    const menu = el.querySelector('.sd-menu') as HTMLElement;
    expect(menu.classList.contains('relative')).toBe(true);
    expect(menu.classList.contains('absolute')).toBe(false);
  });

  it('theme="call" takes the cockpit palette (its own rules, not the light utilities)', async () => {
    host.cockpit.set('dark');
    await render();
    expect(el.querySelector('sd-search-select > div')?.classList.contains('sd-ss-call')).toBe(true);
    expect(trigger().classList.contains('bg-(--ss-surface)')).toBe(true);
    expect(trigger().classList.contains('border-(--ss-border)')).toBe(true);
    expect(trigger().classList.contains('bg-white')).toBe(false);
    trigger().click();
    await render();
    const menu = el.querySelector('.sd-menu') as HTMLElement;
    expect(menu.classList.contains('bg-white')).toBe(false);
    expect(menu.classList.contains('border-(--ss-menu-border)')).toBe(true);
    expect(search().classList.contains('text-(--ss-text)')).toBe(true);
    expect(options()[0].classList.contains('sd-ss-active')).toBe(true);
    expect(options()[0].classList.contains('text-(--ss-text)')).toBe(true);
  });
});
