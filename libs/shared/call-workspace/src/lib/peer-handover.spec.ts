import type { CallUid, CallVideoTrack } from '@supadoc/ui';
import { PeerHandover, type PeerHandoverHost } from './peer-handover';

const PEER: CallUid = 1;
const GUEST: CallUid = 3;

function track(name: string): CallVideoTrack {
  return { name, play: () => undefined, stop: () => undefined } as unknown as CallVideoTrack;
}

function setup() {
  const log: string[] = [];
  const tracks = new Map<string, CallVideoTrack | null>([[String(PEER), track('v1')]]);
  const state = { open: false, left: false };
  const scheduled: Array<{ fn: () => void; destroyed: boolean }> = [];
  let self: PeerHandover | null = null;
  const host: PeerHandoverHost = {
    peerUid: () => PEER,
    remoteVideo: (uid) => tracks.get(String(uid)) ?? null,
    stageAttach: (uid, t) => log.push(`attach:${uid}:${(t as unknown as { name: string }).name}`),
    // Records whether the tile already had the track when the stage stopped it.
    stageDetach: (uid) => log.push(`detach:${uid}:${self?.track() ? 'tile-has-track' : 'tile-empty'}`),
    workspaceOpen: () => state.open,
    left: () => state.left,
    afterNextRender: (fn) => {
      const rec = { fn, destroyed: false };
      scheduled.push(rec);
      log.push('schedule');
      return { destroy: () => (rec.destroyed = true) };
    },
  };
  const peer = new PeerHandover(host);
  self = peer;
  /** Runs what is scheduled and not destroyed, as the next render would. */
  const render = () => {
    for (const rec of scheduled.splice(0)) if (!rec.destroyed) rec.fn();
  };
  return { peer, log, tracks, state, scheduled, render };
}

describe('PeerHandover', () => {
  it('workspace open from the stage: detached from the stage BEFORE the track is set', () => {
    const { peer, log, state, tracks } = setup();
    state.open = true;
    peer.workspaceOpened();
    expect(log).toEqual(['detach:1:tile-empty']);
    expect(peer.holder()).toBe('workspace');
    expect(peer.track()).toBe(tracks.get('1'));
  });

  it('workspace close: returning, no attach until the render; then one attach of the CURRENT track', () => {
    const { peer, log, state, tracks, render } = setup();
    state.open = true;
    peer.workspaceOpened();
    log.length = 0;
    state.open = false;
    peer.workspaceClosed();
    expect(peer.holder()).toBe('returning');
    expect(peer.track()).toBeNull();
    expect(log).toEqual(['schedule']);
    tracks.set('1', track('v2')); // the patient re-published meanwhile
    render();
    expect(peer.holder()).toBe('stage');
    expect(log).toEqual(['schedule', 'attach:1:v2']);
  });

  it('workspace close with no track on Agora: back to the stage with nothing attached', () => {
    const { peer, log, state, tracks, render } = setup();
    state.open = true;
    peer.workspaceOpened();
    state.open = false;
    peer.workspaceClosed();
    tracks.set('1', null);
    log.length = 0;
    render();
    expect(peer.holder()).toBe('stage');
    expect(log).toEqual([]);
  });

  it('close then reopen before the render: the callback is destroyed, no attach ever', () => {
    const { peer, log, state, render, scheduled } = setup();
    state.open = true;
    peer.workspaceOpened();
    state.open = false;
    peer.workspaceClosed();
    const rec = scheduled[0];
    state.open = true;
    log.length = 0;
    peer.workspaceOpened();
    expect(rec?.destroyed).toBe(true);
    expect(peer.holder()).toBe('workspace');
    expect(peer.track()).not.toBeNull();
    render();
    expect(log).toEqual([]);
  });

  it('viewer open from the workspace: no detach (the tile goes with the render); holder viewer, the current track', () => {
    const { peer, log, state, tracks } = setup();
    state.open = true;
    peer.workspaceOpened();
    log.length = 0;
    tracks.set('1', track('v3'));
    peer.viewerWillOpen();
    expect(log).toEqual([]);
    expect(peer.holder()).toBe('viewer');
    expect(peer.track()).toBe(tracks.get('1'));
  });

  it('viewer open from the cockpit: detached from the stage first', () => {
    const { peer, log } = setup();
    peer.viewerWillOpen();
    expect(log).toEqual(['detach:1:tile-empty']);
    expect(peer.holder()).toBe('viewer');
  });

  it('viewer open while returning: the pending stage attach is cancelled', () => {
    const { peer, log, state, render, scheduled } = setup();
    state.open = true;
    peer.workspaceOpened();
    state.open = false;
    peer.workspaceClosed();
    const rec = scheduled[0];
    log.length = 0;
    peer.viewerWillOpen();
    expect(rec?.destroyed).toBe(true);
    render();
    expect(log).toEqual([]);
    expect(peer.holder()).toBe('viewer');
  });

  it('viewer close with the workspace open: back to the workspace, no attach', () => {
    const { peer, log, state, tracks } = setup();
    state.open = true;
    peer.workspaceOpened();
    peer.viewerWillOpen();
    log.length = 0;
    tracks.set('1', track('v4'));
    peer.viewerDidClose();
    expect(peer.holder()).toBe('workspace');
    expect(peer.track()).toBe(tracks.get('1'));
    expect(log).toEqual([]);
  });

  it('viewer close with the workspace closed: one attach, track cleared', () => {
    const { peer, log } = setup();
    peer.viewerWillOpen();
    log.length = 0;
    peer.viewerDidClose();
    expect(peer.holder()).toBe('stage');
    expect(peer.track()).toBeNull();
    expect(log).toEqual(['attach:1:v1']);
  });

  it('Back to call (workspaceClosed while the viewer holds it, then viewerDidClose): one attach, nothing scheduled', () => {
    const { peer, log, state, scheduled } = setup();
    state.open = true;
    peer.workspaceOpened();
    peer.viewerWillOpen();
    log.length = 0;
    state.open = false;
    peer.workspaceClosed();
    expect(peer.holder()).toBe('viewer');
    expect(scheduled.length).toBe(0);
    peer.viewerDidClose();
    expect(peer.holder()).toBe('stage');
    expect(log).toEqual(['attach:1:v1']);
  });

  it('route(): the patient while held updates the track, the stage untouched; a guest goes to the stage; while stage all go to the stage', () => {
    const { peer, log, state } = setup();
    const t2 = track('t2');
    peer.route(PEER, t2);
    expect(log).toEqual(['attach:1:t2']);
    peer.route(PEER, null);
    expect(log).toEqual(['attach:1:t2', 'detach:1:tile-empty']);
    state.open = true;
    peer.workspaceOpened();
    log.length = 0;
    peer.route(PEER, t2);
    expect(peer.track()).toBe(t2);
    peer.route(PEER, null);
    expect(peer.track()).toBeNull();
    expect(log).toEqual([]);
    peer.route(GUEST, t2);
    expect(log).toEqual(['attach:3:t2']);
    peer.route(GUEST, null);
    expect(log).toEqual(['attach:3:t2', 'detach:3:tile-empty']);
  });

  it('uids compare as strings (Agora may give either)', () => {
    const { peer, log, state } = setup();
    state.open = true;
    peer.workspaceOpened();
    log.length = 0;
    const t = track('t');
    peer.route('1', t);
    expect(peer.track()).toBe(t);
    expect(log).toEqual([]);
  });

  it('after callLeft() nothing attaches: a pending callback, a viewer close, a workspace open', () => {
    const { peer, log, state, render, scheduled } = setup();
    state.open = true;
    peer.workspaceOpened();
    state.open = false;
    peer.workspaceClosed();
    const rec = scheduled[0];
    state.left = true;
    log.length = 0;
    peer.callLeft();
    expect(rec?.destroyed).toBe(true);
    expect(peer.holder()).toBe('stage');
    expect(peer.track()).toBeNull();
    render();
    peer.viewerDidClose();
    peer.workspaceOpened();
    expect(log).toEqual([]);
    expect(peer.holder()).toBe('stage');
  });

  it('left while the viewer holds it: nothing attaches on its close', () => {
    const { peer, log, state } = setup();
    peer.viewerWillOpen();
    state.left = true;
    log.length = 0;
    peer.viewerDidClose();
    expect(peer.holder()).toBe('stage');
    expect(log).toEqual([]);
  });
});
