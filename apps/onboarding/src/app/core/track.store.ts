import { computed, inject, Injectable, signal } from '@angular/core';
import { DoctorApplicationsApi } from '@supadoc/data-access';
import type { ApplicantChannel, CodeSentDto, TrackChannelDto } from '@supadoc/models';
import { firstValueFrom } from 'rxjs';
import { ApplicantSession } from './applicant-session';

/**
 * "Check your application status": reference + contact → a channel → a
 * 6-digit code → a 30-minute access token (sessionStorage) for /status. The
 * check itself (track id, channels, where the code went, the prefilled
 * reference) lives in memory only.
 */
@Injectable({ providedIn: 'root' })
export class TrackStore {
  private readonly api = inject(DoctorApplicationsApi);
  private readonly session = inject(ApplicantSession);

  readonly trackId = signal<string | null>(null);
  readonly channels = signal<TrackChannelDto[]>([]);
  readonly chosen = signal<ApplicantChannel | null>(null);
  readonly sentTo = signal<string | null>(null);
  /** A reference to prefill in the Track modal (from Submitted, or a 409 draft_submitted). */
  readonly prefillReference = signal<string | null>(null);
  readonly hasAccess = computed(() => !!this.session.accessToken());

  prefill(reference: string | null | undefined): void {
    this.prefillReference.set(reference ? reference.trim().toUpperCase() : null);
  }

  /** POST track/start: always the same shape (never reveals a match). */
  async start(reference: string, contact: string): Promise<TrackChannelDto[]> {
    const res = await firstValueFrom(this.api.trackStart({ reference, contact }));
    this.trackId.set(res.data.track_id);
    this.channels.set(res.data.channels);
    const preferred = res.data.channels.find((c) => c.default) ?? res.data.channels[0];
    this.chosen.set(preferred?.channel ?? null);
    this.sentTo.set(null);
    return res.data.channels;
  }

  /** POST track/request-code (always 202; 410 track_expired). */
  async requestCode(channel: ApplicantChannel): Promise<CodeSentDto> {
    const trackId = this.trackId();
    if (!trackId) throw new Error('No track check in progress');
    const res = await firstValueFrom(this.api.trackRequestCode({ track_id: trackId, channel }));
    this.chosen.set(channel);
    this.sentTo.set(res.data.sent_to);
    return res.data;
  }

  /** POST track/verify: stores the access token for /status. */
  async verify(code: string): Promise<void> {
    const trackId = this.trackId();
    if (!trackId) throw new Error('No track check in progress');
    const res = await firstValueFrom(this.api.trackVerify({ track_id: trackId, code }));
    this.session.setAccessToken(res.data.access_token);
    this.reset();
  }

  /** Forget the check in progress (not the access token). */
  reset(): void {
    this.trackId.set(null);
    this.channels.set([]);
    this.chosen.set(null);
    this.sentTo.set(null);
  }

  /** End the status session. */
  signOut(): void {
    this.session.setAccessToken(null);
    this.reset();
  }
}
