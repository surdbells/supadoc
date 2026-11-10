import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { CallLaunchers, LAUNCHER_CSS } from './call-launchers';
import type { LauncherOpen, LauncherStatus, WorkspaceTabDef } from './workspace-types';

/** A call page's launchers (the patient's four, as an example: the component holds none of their words). */
type Key = 'notes' | 'prescriptions' | 'labs' | 'followup' | 'copilot';
const FOUR: readonly WorkspaceTabDef<Key>[] = [
  { key: 'notes', label: 'Consultation Notes', icon: 'clipboard-list' },
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab requests', icon: 'flask-conical' },
  { key: 'followup', label: 'Follow-up Plan', icon: 'calendar-clock' },
];
const FIVE: readonly WorkspaceTabDef<Key>[] = [...FOUR, { key: 'copilot', label: 'Transcript & AI', icon: 'sparkles' }];

@Component({
  imports: [CallLaunchers],
  template: `<sd-call-launchers [items]="items()" [statuses]="statuses()" [tone]="tone()" (opened)="last = $event" />`,
})
class Host {
  readonly items = signal<readonly WorkspaceTabDef<Key>[]>(FOUR);
  readonly statuses = signal<Partial<Record<Key, LauncherStatus>>>({});
  readonly tone = signal<'dark' | 'light'>('dark');
  last: LauncherOpen<Key> | null = null;
}

describe('CallLaunchers', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  const host = () => fixture.componentInstance;
  const launcher = (key: string) => el.querySelector<HTMLButtonElement>(`[data-ws-launcher="${key}"]`) as HTMLButtonElement;
  const name = (key: string) => launcher(key).textContent?.replace(/\s+/g, ' ').trim();
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    await render();
  });

  afterEach(() => fixture.destroy());

  it('one li > button per item, each a dialog launcher keyed by its tab', () => {
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('ul.ws-launchers[role="list"] > li > button.ws-launcher[data-ws-launcher]'));
    expect(buttons.map((b) => b.dataset['wsLauncher'])).toEqual(['notes', 'prescriptions', 'labs', 'followup']);
    expect(buttons.every((b) => b.type === 'button' && b.getAttribute('aria-haspopup') === 'dialog')).toBe(true);
    // The icon tile is decorative: the label names the button.
    expect(buttons.every((b) => b.querySelector(':scope > span[aria-hidden="true"] sd-icon') !== null)).toBe(true);
  });

  it('no status: the name is the label exactly, no status line, its line reserved (--bare)', () => {
    for (const t of FOUR) {
      expect(launcher(t.key).textContent?.trim()).toBe(t.label);
      expect(launcher(t.key).hasAttribute('aria-label')).toBe(false);
      expect(launcher(t.key).querySelector('.ws-launcher-status')).toBeNull();
      expect(launcher(t.key).querySelector('.ws-launcher-text')?.classList.contains('ws-launcher-text--bare')).toBe(true);
    }
  });

  it('a status: the name reads label, ", ", the words and the sr rest; the tone picks the class and the dot', async () => {
    host().statuses.set({
      notes: { text: 'Finalized', sr: ' — your visit summary is ready', tone: 'muted' },
      prescriptions: { text: 'New', sr: ' prescription', tone: 'new' },
      labs: { text: 'Not loaded', sr: ' — open to see why', tone: 'warn' },
      followup: { text: 'Live', tone: 'live' },
    });
    await render();
    expect(name('notes')).toBe('Consultation Notes, Finalized — your visit summary is ready');
    expect(name('prescriptions')).toBe('Prescriptions, New prescription');
    expect(name('labs')).toBe('Lab requests, Not loaded — open to see why');
    expect(name('followup')).toBe('Follow-up Plan, Live');
    // The name is given outright (a browser's name from content puts a space between the label and the
    // status line, two blocks: "Prescriptions , New …"); it starts with the visible label (2.5.3).
    expect(launcher('notes').getAttribute('aria-label')).toBe('Consultation Notes, Finalized — your visit summary is ready');
    expect(launcher('prescriptions').getAttribute('aria-label')).toBe('Prescriptions, New prescription');
    expect(launcher('labs').getAttribute('aria-label')).toBe('Lab requests, Not loaded — open to see why');
    expect(launcher('followup').getAttribute('aria-label')).toBe('Follow-up Plan, Live');
    for (const key of ['notes', 'prescriptions', 'labs', 'followup']) {
      expect(launcher(key).querySelector('.ws-launcher-text')?.classList.contains('ws-launcher-text--bare')).toBe(false);
    }
    const status = (key: string) => launcher(key).querySelector('.ws-launcher-status') as HTMLElement;
    // muted: the plain caption colour, no dot.
    expect(status('notes').classList).toContain('text-white/70');
    expect(status('notes').querySelector('.ws-launcher-dot')).toBeNull();
    // new: its own colour and a dot in it.
    expect(status('prescriptions').classList).toContain('ws-launcher-status--new');
    expect(status('prescriptions').querySelector('.ws-launcher-dot[aria-hidden="true"]')).not.toBeNull();
    // warn: the warning colour, no dot (words, never colour alone).
    expect(status('labs').classList).toContain('ws-launcher-status--warn');
    expect(status('labs').querySelector('.ws-launcher-dot')).toBeNull();
    // live: a pulsing alert dot.
    const live = status('followup').querySelector('.ws-launcher-dot') as HTMLElement;
    expect(live.classList).toContain('bg-alert');
    expect(live.classList).toContain('motion-safe:animate-pulse');
    expect(status('followup').classList).toContain('text-white/70');
    // The words are plain text (never HTML), truncated on one line.
    expect(status('prescriptions').querySelector('.ws-launcher-status-text')?.textContent).toBe('New');
  });

  it('a status coming and going toggles only its own launcher', async () => {
    host().statuses.set({ prescriptions: { text: 'New', tone: 'new' } });
    await render();
    expect(el.querySelectorAll('.ws-launcher-status').length).toBe(1);
    expect(el.querySelectorAll('.ws-launcher-text--bare').length).toBe(3);
    expect(el.querySelectorAll('[aria-label]').length).toBe(1);
    host().statuses.set({});
    await render();
    expect(el.querySelectorAll('.ws-launcher-status').length).toBe(0);
    expect(el.querySelectorAll('[aria-label]').length).toBe(0);
    expect(el.querySelectorAll('.ws-launcher-text--bare').length).toBe(4);
  });

  it('clicking emits the key and the button itself (focus returns there)', () => {
    launcher('labs').click();
    expect(host().last).toEqual({ key: 'labs', opener: launcher('labs') });
    // A click on the icon inside still names the button.
    (launcher('followup').querySelector('sd-icon') as HTMLElement).click();
    expect(host().last?.key).toBe('followup');
    expect(host().last?.opener).toBe(launcher('followup'));
  });

  it('the host carries the tone', async () => {
    const h = el.querySelector('sd-call-launchers') as HTMLElement;
    expect(h.getAttribute('data-tone')).toBe('dark');
    host().tone.set('light');
    await render();
    expect(h.getAttribute('data-tone')).toBe('light');
  });

  it('four and five launchers are each one list (one row from 32rem: grid-auto-flow column, measured in the real render)', async () => {
    expect(el.querySelectorAll('.ws-launchers > li').length).toBe(4);
    host().items.set(FIVE);
    await render();
    expect(el.querySelectorAll('.ws-launchers > li').length).toBe(5);
    expect(el.querySelectorAll('ul.ws-launchers').length).toBe(1);
  });

  describe('LAUNCHER_CSS (jsdom has no layout: the real render measures what these rules do)', () => {
    const css = LAUNCHER_CSS.replace(/\s+/g, ' ');
    /** The body of the first rule whose selector is exactly `sel`, within `scope` (a slice of the CSS). */
    const rule = (sel: string, scope = css) => {
      const at = scope.indexOf(sel + ' {');
      if (at < 0) return null;
      return scope.slice(at + sel.length + 2, scope.indexOf('}', at));
    };
    const block = (query: string) => {
      const at = css.indexOf(query);
      return at < 0 ? '' : css.slice(at, css.indexOf('} }', at) + 3);
    };

    it('the host is the container (its content box)', () => {
      expect(rule(':host')).toContain('container: sd-launchers / inline-size');
      expect(rule(':host')).toContain('display: block');
    });

    it('no status: the caption line is reserved under the label (icon above)', () => {
      expect(rule('.ws-launcher-text--bare')).toContain('padding-bottom: var(--text-caption--line-height)');
    });

    it('a status is exactly one caption line high', () => {
      expect(rule('.ws-launcher-status')).toContain('height: var(--text-caption--line-height)');
      expect(rule('.ws-launcher-status')).toContain('line-height: var(--text-caption--line-height)');
    });

    it('from 32rem: one row, as many columns as launchers', () => {
      const b = block('@container sd-launchers (min-width: 32rem)');
      expect(b).toContain('grid-auto-flow: column');
      expect(b).toContain('grid-auto-columns: minmax(0, 1fr)');
      expect(b).not.toContain('repeat(5');
    });

    it('from 52rem: icon beside, centred, the reserved line split 9 / 9 around a bare label', () => {
      const b = block('@container sd-launchers (min-width: 52rem)');
      expect(rule('.ws-launcher', b)).toContain('flex-direction: row');
      expect(rule('.ws-launcher', b)).toContain('align-items: center');
      expect(rule('.ws-launcher-text--bare', b)).toContain('padding-block: calc(var(--text-caption--line-height) / 2)');
    });

    it('the light tone: a cerulean focus ring, a glacier hover, ink and cerulean statuses', () => {
      expect(rule('.ws-launcher:focus-visible')).toContain('outline: 2px solid var(--color-frost)');
      expect(rule(":host([data-tone='light']) .ws-launcher:focus-visible")).toContain('outline-color: var(--color-cerulean)');
      expect(css).toContain("@media (hover: hover) { :host([data-tone='light']) .ws-launcher:hover { background-color: var(--color-glacier); } }");
      expect(rule(":host([data-tone='light']) .ws-launcher-status--warn")).toContain('var(--color-warning-ink)');
      expect(rule(":host([data-tone='light']) .ws-launcher-status--new")).toContain('var(--color-cerulean)');
    });

    it('only the "new" dot takes the status colour (the live dot keeps bg-alert)', () => {
      expect(rule('.ws-launcher-dot')).not.toContain('background');
      expect(rule('.ws-launcher-status--new .ws-launcher-dot')).toContain('background: currentColor');
    });

    it('the compiled component carries these styles (emulated encapsulation)', () => {
      const styles = (CallLaunchers as unknown as { ɵcmp: { styles: string[] } }).ɵcmp.styles.join('');
      expect(styles).toContain('sd-launchers');
      expect(styles).toContain('ws-launcher-text--bare');
    });
  });
});
