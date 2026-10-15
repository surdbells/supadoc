import { TestBed } from '@angular/core/testing';
import { CallTilesComponent, CallVideoTrack } from './call-tiles';
import {
  buildCallTiles,
  CALL_RECORDER_UID,
  CallTile,
  callTileInitials,
  callTilesMode,
} from './call-tiles.model';
import { RemoteParticipants } from './remote-participants';
import { provideSupadocIcons } from '../icons/icons';

const doctor: CallTile = { uid: 2, name: 'Dr Ada Obi', role: 'doctor', hasVideo: true, muted: false };
const guest: CallTile = { uid: 100, name: 'Sam Lee', role: 'guest', hasVideo: false, muted: true };
const self: CallTile = { uid: 1, name: 'Tola Ade', role: 'patient', hasVideo: true, muted: false, self: true };

function fakeTrack(): CallVideoTrack & { played: HTMLElement[]; stops: number } {
  const t = {
    played: [] as HTMLElement[],
    stops: 0,
    play(el: HTMLElement) {
      t.played.push(el);
    },
    stop() {
      t.stops++;
    },
  };
  return t;
}

describe('RemoteParticipants', () => {
  it('keeps each uid separate: one unpublish never touches another', () => {
    const changes: string[] = [];
    const remotes = new RemoteParticipants((_, c) => changes.push(c.type));
    remotes.published(2, 'video');
    remotes.published(2, 'audio');
    remotes.published(100, 'video');
    remotes.unpublished(100, 'video');
    expect(remotes.get(2)).toEqual({ uid: 2, hasVideo: true, hasAudio: true, speaking: false });
    expect(remotes.get(100)?.hasVideo).toBe(false);
    expect(changes).toEqual(['joined', 'updated', 'joined', 'updated']);
  });

  it('follows mute info, speaking levels and leaving', () => {
    const remotes = new RemoteParticipants();
    remotes.joined(2);
    expect(remotes.get(2)).toEqual({ uid: 2, hasVideo: false, hasAudio: false, speaking: false });
    remotes.published(2, 'audio');
    remotes.volumes([{ uid: 2, level: 40 }, { uid: 1, level: 60 }]);
    expect(remotes.get(2)?.speaking).toBe(true);
    expect(remotes.has(1)).toBe(false);
    remotes.infoUpdated(2, 'mute-audio');
    expect(remotes.get(2)).toMatchObject({ hasAudio: false, speaking: false });
    remotes.infoUpdated(2, 'unmute-audio');
    expect(remotes.get(2)?.hasAudio).toBe(true);
    remotes.published(2, 'datachannel');
    remotes.left(2);
    expect(remotes.size).toBe(0);
  });

  it('ignores the cloud recorder', () => {
    const changes: string[] = [];
    const remotes = new RemoteParticipants((_, c) => changes.push(c.type));
    remotes.joined(CALL_RECORDER_UID);
    remotes.joined(String(CALL_RECORDER_UID));
    remotes.published(CALL_RECORDER_UID, 'audio');
    expect(remotes.size).toBe(0);
    expect(changes).toEqual([]);
  });

  it('binds to and unbinds from a client', () => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      on: (e: string, fn: (...args: never[]) => void) => handlers.set(e, fn),
      off: (e: string) => handlers.delete(e),
    };
    const remotes = new RemoteParticipants();
    const unbind = remotes.bind(client);
    (handlers.get('user-published') as unknown as (u: { uid: number }, k: string) => void)({ uid: 7 }, 'video');
    expect(remotes.get(7)?.hasVideo).toBe(true);
    unbind();
    expect(handlers.size).toBe(0);
  });
});

describe('buildCallTiles', () => {
  it('names from the roster, falls back by uid, orders by role and puts self last', () => {
    const tiles = buildCallTiles({
      remotes: [
        { uid: 101, hasVideo: false, hasAudio: true, speaking: false },
        { uid: 1, hasVideo: true, hasAudio: false, speaking: true },
        { uid: 100, hasVideo: true, hasAudio: true, speaking: false },
      ],
      roster: [
        { uid: 1, role: 'patient', name: 'Tola Ade' },
        { uid: 100, role: 'guest', name: 'Sam Lee' },
      ],
      self: { uid: 2, role: 'doctor', name: 'Dr Ada Obi', hasVideo: true, muted: false },
    });
    expect(tiles.map((t) => [t.uid, t.name, t.role])).toEqual([
      [1, 'Tola Ade', 'patient'],
      [100, 'Sam Lee', 'guest'],
      [101, 'Guest', 'guest'],
      [2, 'Dr Ada Obi', 'doctor'],
    ]);
    expect(tiles[0]).toMatchObject({ muted: true, speaking: true });
    expect(tiles[3].self).toBe(true);
  });

  it('never gives the cloud recorder a tile', () => {
    const tiles = buildCallTiles({
      remotes: [
        { uid: 2, hasVideo: true, hasAudio: true, speaking: false },
        { uid: String(CALL_RECORDER_UID), hasVideo: false, hasAudio: false, speaking: false },
      ],
      self: { uid: 1, role: 'patient', hasVideo: true, muted: false },
    });
    expect(tiles.map((t) => t.uid)).toEqual([2, 1]);
    expect(callTilesMode(tiles)).toBe('spotlight');
  });

  it('picks the layout and initials', () => {
    expect(callTilesMode([doctor, self])).toBe('spotlight');
    expect(callTilesMode([self])).toBe('spotlight');
    expect(callTilesMode([doctor, guest, self])).toBe('grid');
    expect(callTilesMode([doctor, self], 'grid')).toBe('grid');
    expect(callTileInitials('Dr Ada Obi')).toBe('AO');
    expect(callTileInitials('  sam ')).toBe('S');
    expect(callTileInitials('')).toBe('?');
  });
});

describe('CallTilesComponent', () => {
  async function render(tiles: CallTile[]) {
    await TestBed.configureTestingModule({
      imports: [CallTilesComponent],
      providers: [provideSupadocIcons()],
    }).compileComponents();
    const fixture = TestBed.createComponent(CallTilesComponent);
    fixture.componentRef.setInput('tiles', tiles);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('renders 1:1 as main + self view and a grid from three people', async () => {
    const fixture = await render([doctor, self]);
    const root: HTMLElement = fixture.nativeElement;
    expect(fixture.componentInstance.mode()).toBe('spotlight');
    expect(root.querySelectorAll('.sd-tile').length).toBe(2);
    expect(root.textContent).toContain('Dr Ada Obi');
    expect(root.textContent).toContain('You');

    const doctorEl = fixture.componentInstance.elementFor(2);
    expect(doctorEl).toBeTruthy();

    fixture.componentRef.setInput('tiles', [doctor, guest, self]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.mode()).toBe('grid');
    expect(root.querySelector('[data-count="3"]')).toBeTruthy();
    // The doctor's tile (and its video element) survived the layout change.
    expect(fixture.componentInstance.elementFor(2)).toBe(doctorEl);
    expect(root.textContent).toContain('SL');
  });

  it('plays a track attached before its tile exists, and stops it on detach', async () => {
    const fixture = await render([self]);
    const track = fakeTrack();
    fixture.componentInstance.attach(100, track);
    expect(track.played.length).toBe(0);

    fixture.componentRef.setInput('tiles', [guest, self]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.isReady(100)).toBe(true);
    expect(track.played).toEqual([fixture.componentInstance.elementFor(100)]);

    const screen = fakeTrack();
    fixture.componentInstance.attach(100, screen, { fit: 'contain' });
    expect(track.stops).toBe(1);
    expect(screen.played.length).toBe(1);
    fixture.componentInstance.detach(100);
    expect(screen.stops).toBe(1);
  });
});
