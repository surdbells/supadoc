import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { detectTimeZone, offsetsDiffer, zoneAbbr, zoneLongName } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';
import { DoctorClock } from '../doctor-clock';
import { DoctorTimeZoneDialog } from './time-zone-dialog';

/** "Keep" hides the mismatch banner on this device for this long. */
export const TZ_MISMATCH_SNOOZE_MS = 30 * 24 * 60 * 60_000;
/** localStorage: "{profileTz}|{deviceTz}|{epochMs}" of the last "Keep". */
export const TZ_MISMATCH_KEY = 'videomed.tz-mismatch';

/** Whether "Keep {profile}" was chosen for this exact pair within the last 30 days. */
export function mismatchSnoozed(profileTz: string, deviceTz: string, now: number = Date.now()): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(TZ_MISMATCH_KEY);
  } catch {
    return false; // storage blocked: just show it
  }
  if (!raw) return false;
  const [p, d, at] = raw.split('|');
  const ms = Number(at);
  return p === profileTz && d === deviceTz && Number.isFinite(ms) && now - ms >= 0 && now - ms < TZ_MISMATCH_SNOOZE_MS;
}

/** Remember "Keep" for this pair (best effort). */
export function snoozeMismatch(profileTz: string, deviceTz: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(TZ_MISMATCH_KEY, `${profileTz}|${deviceTz}|${now}`);
  } catch {
    /* storage blocked: the banner comes back next time */
  }
}

const BANNER_BUTTON =
  'min-h-11 rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40';

type BannerState =
  | { readonly kind: 'undetected' }
  | {
      readonly kind: 'mismatch';
      readonly device: string;
      readonly deviceLong: string;
      readonly deviceAbbr: string;
      readonly profile: string;
      readonly profileLong: string;
      readonly profileAbbr: string;
    };

/**
 * The doctor's time-zone banner (in the shell, above the page):
 * - never set and this device reports no usable zone (a VPN or privacy
 *   browser says UTC): "Choose time zone";
 * - set, and this device is on a different offset now (travelling): "Use
 *   {device}" (opens the dialog preset to it) or "Keep {profile}" (snoozes it
 *   on this device for 30 days).
 */
@Component({
  selector: 'doc-time-zone-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, DoctorTimeZoneDialog],
  host: { class: 'contents' },
  template: `
    @if (state(); as s) {
      <section
        class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-cerulean/25 bg-frost/50 px-4 py-3 shadow-card"
        aria-label="Time zone"
      >
        <sd-icon name="globe" [size]="20" class="shrink-0 text-cerulean-dark" />
        @if (s.kind === 'undetected') {
          <p class="min-w-0 flex-1 basis-56 font-sans text-body-sm text-ink">
            We couldn't detect your time zone. Choose one so your schedule and emails are right.
          </p>
          <button type="button" class="${BANNER_BUTTON} bg-cerulean text-white hover:bg-cerulean-dark" (click)="openDialog(null)">
            Choose time zone
          </button>
        } @else {
          <p class="min-w-0 flex-1 basis-56 font-sans text-body-sm text-ink">
            This device is set to {{ s.deviceLong }} ({{ s.deviceAbbr }}), but your VideoMed time zone is
            {{ s.profileLong }} ({{ s.profileAbbr }}). Your schedule, availability and emails use {{ s.profileAbbr }}.
          </p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="${BANNER_BUTTON} bg-cerulean text-white hover:bg-cerulean-dark" (click)="openDialog(s.device)">
              Use {{ s.deviceLong }}
            </button>
            <button type="button" class="${BANNER_BUTTON} border border-haze bg-white text-ink hover:bg-glacier" (click)="keep(s.profile, s.device)">
              Keep {{ s.profileLong }}
            </button>
          </div>
        }
      </section>
    }
    <doc-time-zone-dialog [open]="dialogOpen()" [preset]="preset()" (closed)="dialogOpen.set(false)" />
  `,
})
export class DoctorTimeZoneBanner {
  private readonly clock = inject(DoctorClock);

  protected readonly dialogOpen = signal(false);
  protected readonly preset = signal<string | null>(null);
  /** The pair kept in this session (also when storage is blocked). */
  private readonly kept = signal<string | null>(null);

  protected readonly state = computed<BannerState | null>(() => {
    const kept = this.kept();
    if (this.clock.status() !== 'ready' || !this.clock.supported()) return null;
    const profile = this.clock.profileZone();
    const device = detectTimeZone();
    if (this.clock.source() === null) return device === null ? { kind: 'undetected' } : null;
    if (!profile || device === null || device === profile) return null;
    const now = new Date();
    if (!offsetsDiffer(now, device, profile) || kept === `${profile}|${device}`) return null;
    if (mismatchSnoozed(profile, device, now.getTime())) return null;
    return {
      kind: 'mismatch',
      device,
      deviceLong: zoneLongName(device, now),
      deviceAbbr: zoneAbbr(device, now),
      profile,
      profileLong: zoneLongName(profile, now),
      profileAbbr: zoneAbbr(profile, now),
    };
  });

  protected openDialog(preset: string | null): void {
    this.preset.set(preset);
    this.dialogOpen.set(true);
  }

  protected keep(profile: string, device: string): void {
    snoozeMismatch(profile, device);
    this.kept.set(`${profile}|${device}`);
  }
}

