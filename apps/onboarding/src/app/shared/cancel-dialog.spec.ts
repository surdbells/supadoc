import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideSupadocIcons } from '@supadoc/ui';
import { buttonByText, settle, stubDialogs, textOf } from '../../testing/onb-testing';
import { CancelDialogComponent, type WithdrawChoice } from './cancel-dialog';

@Component({
  imports: [CancelDialogComponent],
  template: `
    <onb-cancel-dialog [open]="true" [mode]="mode()" statusLabel="Under Review" (confirm)="confirmed.push($event)" />
  `,
})
class Host {
  readonly mode = signal<'draft' | 'submitted'>('submitted');
  readonly confirmed: WithdrawChoice[] = [];
}

describe('CancelDialogComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let host: Host;

  beforeAll(() => stubDialogs());

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await settle(fixture);
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
  });

  it('withdraw: an alertdialog with the status, bullets and the reason list', () => {
    const dialog = el.querySelector('dialog');
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(textOf(el)).toContain('Withdraw application?');
    expect(textOf(el)).toContain("It's currently Under Review.");
    expect(textOf(el)).toContain("We'll stop reviewing your application straight away.");
    expect(el.querySelectorAll('option')).toHaveLength(6);
  });

  it('keeps "Yes, withdraw" Alert/30 and clickable until ticked; a click then asks for the tick', async () => {
    const yes = buttonByText(el, 'Yes, withdraw');
    expect(yes.getAttribute('aria-disabled')).toBe('true');
    expect(yes.className).toContain('bg-alert/30');
    yes.click();
    await settle(fixture);
    expect(host.confirmed).toHaveLength(0);
    expect(textOf(el)).toContain('Tick the box to confirm.');
    const tick = el.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement;
    expect(document.activeElement).toBe(tick);

    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    await settle(fixture);
    const select = el.querySelector<HTMLSelectElement>('select') as HTMLSelectElement;
    select.value = 'apply_later';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(buttonByText(el, 'Yes, withdraw').hasAttribute('aria-disabled')).toBe(false);
    buttonByText(el, 'Yes, withdraw').click();
    expect(host.confirmed).toEqual([{ reason: 'apply_later' }]);
  });

  it('draft mode: no reason or tick, "Yes, cancel" acts at once', async () => {
    host.mode.set('draft');
    await settle(fixture);
    expect(textOf(el)).toContain('Cancel application?');
    expect(textOf(el)).toContain("You haven't submitted it yet.");
    expect(el.querySelector('select')).toBeNull();
    buttonByText(el, 'Yes, cancel').click();
    expect(host.confirmed).toEqual([{ reason: null }]);
  });
});
