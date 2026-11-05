import { TestBed } from '@angular/core/testing';
import { type CallTile, type CallVideoTrack, provideSupadocIcons } from '@supadoc/ui';
import { CallPeerTileComponent } from './call-peer-tile';

const doctor: CallTile = { uid: 2, name: 'Dr Ada Obi', role: 'doctor', hasVideo: true, muted: false };

function fakeTrack(log?: string[]): CallVideoTrack & { played: [HTMLElement, unknown][]; stops: number } {
  const t = {
    played: [] as [HTMLElement, unknown][],
    stops: 0,
    play(el: HTMLElement, config?: unknown) {
      t.played.push([el, config]);
    },
    stop() {
      t.stops++;
      log?.push('stop');
    },
  };
  return t;
}

describe('CallPeerTileComponent (sd-call-peer-tile)', () => {
  async function render(tile: CallTile) {
    await TestBed.configureTestingModule({ imports: [CallPeerTileComponent], providers: [provideSupadocIcons()] }).compileComponents();
    const fixture = TestBed.createComponent(CallPeerTileComponent);
    fixture.componentRef.setInput('tile', tile);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }
  const flush = async (f: Awaited<ReturnType<typeof render>>) => {
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
  };

  it('fills its box, is labelled "{name}, live video" and holds nothing focusable', async () => {
    const f = await render(doctor);
    const root: HTMLElement = f.nativeElement;
    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Dr Ada Obi, live video');
    expect(root.querySelector('button, a[href], input, select, textarea, [tabindex]')).toBeNull();
  });

  it('plays the track once, never mirrored; stops when the track goes, and synchronously on destroy', async () => {
    const f = await render(doctor);
    const root: HTMLElement = f.nativeElement;
    const t = fakeTrack();
    f.componentRef.setInput('track', t);
    await flush(f);
    await flush(f);
    expect(t.played).toEqual([[root.querySelector('[data-sd-peer-video]'), { fit: 'contain', mirror: false }]]);
    f.componentRef.setInput('track', null);
    await flush(f);
    expect(t.stops).toBe(1);
    const log: string[] = [];
    const next = fakeTrack(log);
    f.componentRef.setInput('track', next);
    await flush(f);
    expect(next.played.length).toBe(1);
    f.destroy();
    log.push('after destroy');
    expect(log).toEqual(['stop', 'after destroy']);
  });

  it('shows the initials, "Camera off" in its label, and the muted badge', async () => {
    const f = await render({ ...doctor, hasVideo: false, muted: true });
    const root: HTMLElement = f.nativeElement;
    expect(root.textContent).toContain('AO');
    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Dr Ada Obi, live video. Camera off');
    expect(root.querySelector('.sdv-peer-muted')).not.toBeNull();
  });
});
