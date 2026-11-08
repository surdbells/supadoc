import { ApplicationRef, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CallWorkspace, WorkspacePanel } from '@supadoc/call-workspace';
import { DoctorApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { RxCancelForm } from '../prescriptions/rx-cancel-form';
import { WS_CLOSE, WS_KICKER, WS_TABS, type WorkspaceTab } from './call-workspace-copy';

/** The doctor's own Esc case: a real RxCancelForm projected into the shared shell (its generic case is in the lib's spec). */
@Component({
  imports: [CallWorkspace, WorkspacePanel, RxCancelForm],
  template: `
    <sd-call-workspace [open]="open()" [(tab)]="tab" [tabs]="tabs" title="Bola Ade" [kicker]="kicker" [closeLabel]="close" (closed)="onClosed()">
      <div sdWsPanel="prescriptions">
        <doc-rx-cancel-form prescriptionId="rx1" number="RX-1" (dismissed)="cancels = cancels + 1" />
      </div>
    </sd-call-workspace>
  `,
})
class Host {
  readonly open = signal(false);
  readonly tab = signal<WorkspaceTab>('prescriptions');
  readonly tabs = WS_TABS;
  readonly kicker = WS_KICKER;
  readonly close = WS_CLOSE;
  closes = 0;
  cancels = 0;
  onClosed(): void {
    this.closes++;
    this.open.set(false);
  }
}

describe('the workspace and Esc inside a tool’s inline form (doctor)', () => {
  let fixture: ComponentFixture<Host>;

  afterEach(() => {
    fixture?.destroy();
    (fixture?.nativeElement as HTMLElement | undefined)?.remove();
  });

  it('Esc inside a projected RxCancelForm in sd-call-workspace dismisses the form and leaves the dialog open', async () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons(), { provide: DoctorApi, useValue: {} }] });
    fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    const render = () => {
      fixture.detectChanges();
      TestBed.inject(ApplicationRef).tick();
    };
    render();
    host.open.set(true);
    render();
    await new Promise((r) => setTimeout(r));
    render();
    const form = document.querySelector('sd-call-workspace doc-rx-cancel-form form');
    expect(form).not.toBeNull();
    form?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    render();
    expect(host.cancels).toBe(1);
    expect(host.closes).toBe(0);
    expect(document.querySelector('dialog.sd-dialog--viewer')?.hasAttribute('open')).toBe(true);
  });
});
