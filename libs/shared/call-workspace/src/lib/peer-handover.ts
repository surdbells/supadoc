import { signal } from '@angular/core';
import type { CallUid, CallVideoTrack } from '@supadoc/ui';

/** Who plays the peer's video (the other side of the call): the cockpit's stage, the workspace's tile, the document viewer's tile, or nobody for one render (the workspace's tile is going). */
export type PeerHolder = 'stage' | 'workspace' | 'viewer' | 'returning';

export interface PeerHandoverHost {
  /** The peer's uid now (e.g. the roster's, else the emailed link's). */
  peerUid(): CallUid;
  /** Agora's CURRENT video track of a uid (never a stored copy). */
  remoteVideo(uid: CallUid): CallVideoTrack | null;
  /** CallTilesComponent.attach: plays at once when the uid's tile exists. */
  stageAttach(uid: CallUid, track: CallVideoTrack): void;
  /** CallTilesComponent.detach: stops synchronously. */
  stageDetach(uid: CallUid): void;
  workspaceOpen(): boolean;
  left(): boolean;
  /** afterNextRender(fn, { injector }). */
  afterNextRender(fn: () => void): { destroy(): void };
}

/**
 * One owner of the peer's video at a time (an Agora track plays in one
 * element: stopping one playback stops the other). A tile that gives the video
 * up is DESTROYED in the update phase of a tick (its `DestroyRef` stops the track
 * synchronously), and a receiving tile only plays in `afterRenderEffect`, which
 * runs after every view's update in that tick. The stage only receives the track
 * from an `afterNextRender` scheduled after the change that destroys the last
 * tile. So `play()` never runs while another element plays it, and at most one
 * frame shows the video nowhere.
 */
export class PeerHandover {
  private readonly holderState = signal<PeerHolder>('stage');
  readonly holder = this.holderState.asReadonly();
  private readonly trackState = signal<CallVideoTrack | null>(null);
  /** The peer's track for the tile that holds it (workspace or viewer); null while the stage holds it. */
  readonly track = this.trackState.asReadonly();
  private pending: { destroy(): void } | null = null;

  constructor(private readonly host: PeerHandoverHost) {}

  /** The one gate for every remote video change: published, unpublished, left, rejoin's detach loop. */
  route(uid: CallUid, track: CallVideoTrack | null): void {
    if (this.holderState() !== 'stage' && this.isPeer(uid)) {
      this.trackState.set(track);
      return;
    }
    if (track) this.host.stageAttach(uid, track);
    else this.host.stageDetach(uid);
  }

  workspaceOpened(): void {
    if (this.host.left()) return;
    const from = this.holderState();
    const uid = this.host.peerUid();
    if (from === 'returning') {
      // Closed and opened again before the stage took it back: it never left.
      this.cancelPending();
      this.holderState.set('workspace');
      this.trackState.set(this.host.remoteVideo(uid));
      return;
    }
    if (from !== 'stage') return; // the viewer holds it (the cockpit is inert under it)
    this.host.stageDetach(uid); // stopped on the stage FIRST
    this.holderState.set('workspace');
    this.trackState.set(this.host.remoteVideo(uid)); // the workspace tile plays it once rendered
  }

  workspaceClosed(): void {
    if (this.holderState() !== 'workspace') return; // 'viewer': viewerDidClose decides where it goes
    this.holderState.set('returning'); // the workspace tile is destroyed by the next render (stops the track)
    this.trackState.set(null);
    this.pending = this.host.afterNextRender(() => {
      this.pending = null;
      if (this.holderState() !== 'returning') return;
      this.holderState.set('stage');
      if (this.host.left()) return;
      const uid = this.host.peerUid();
      const t = this.host.remoteVideo(uid); // re-read: the peer may have re-published or left
      if (t) this.host.stageAttach(uid, t);
    });
  }

  /** ViewerCallContext.willOpen (after every check passed). */
  viewerWillOpen(): void {
    const from = this.holderState();
    this.cancelPending();
    const uid = this.host.peerUid();
    this.holderState.set('viewer');
    // 'workspace' / 'returning': that tile is destroyed in the next render's update phase,
    // before the viewer's tile plays (its afterRenderEffect).
    if (from === 'stage') this.host.stageDetach(uid);
    this.trackState.set(this.host.remoteVideo(uid));
  }

  /** ViewerCallContext.didClose (after the render that destroyed the viewer's tile). */
  viewerDidClose(): void {
    if (this.holderState() !== 'viewer') return;
    const uid = this.host.peerUid();
    if (!this.host.left() && this.host.workspaceOpen()) {
      this.holderState.set('workspace'); // back to the workspace's tile (re-created next render)
      this.trackState.set(this.host.remoteVideo(uid));
      return;
    }
    this.holderState.set('stage');
    this.trackState.set(null);
    if (this.host.left()) return;
    const t = this.host.remoteVideo(uid);
    if (t) this.host.stageAttach(uid, t);
  }

  /** This side left the call (teardown): nothing is handed anywhere again. */
  callLeft(): void {
    this.cancelPending();
    this.holderState.set('stage');
    this.trackState.set(null);
  }

  private isPeer(uid: CallUid): boolean {
    return String(uid) === String(this.host.peerUid());
  }

  private cancelPending(): void {
    this.pending?.destroy();
    this.pending = null;
  }
}
