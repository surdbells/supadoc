import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { DoctorRecordingStateDto, RecordingFileDto } from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent } from '@supadoc/ui';
import { rxDateTime } from '../../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_LINK_BUTTON,
  CLINICAL_META,
  ClinicalBadge,
  ClinicalEmpty,
  ClinicalHeader,
} from './clinical-ui';

/**
 * Clinical tools → Recording: cloud-recording start / stop and the recorded
 * files. Presentational — the host owns the state, the files and the calls
 * (which the API refuses without the patient's recording consent).
 *
 * Usage:
 * `<doc-clinical-recording [state]="recording()" [files]="recordingFiles()" [busy]="sectionBusy()"
 *    [error]="sectionError()" (startRecording)="startRecording()" (stopRecording)="stopRecording()" />`
 */
@Component({
  selector: 'doc-clinical-recording',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, ButtonComponent, IconComponent, ClinicalBadge, ClinicalEmpty, ClinicalHeader],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header
      icon="circle-play"
      heading="Cloud recording"
      helper="Record the consultation. The patient must grant recording consent first."
    >
      @if (state(); as rec) {
        @if (!rec.configured) {
          <doc-clinical-badge tone="neutral" icon="ban" label="Not configured" />
        } @else if (rec.active) {
          <doc-clinical-badge tone="danger" icon="mic" label="Recording" [pulse]="true" />
        } @else {
          <doc-clinical-badge tone="neutral" icon="mic-off" label="Not recording" />
        }
      }
    </doc-clinical-header>

    <section class="${CLINICAL_CARD}" aria-label="Recording controls" aria-live="polite">
      @if (state(); as rec) {
        @if (!rec.configured) {
          <sd-alert tone="info">Recording isn't configured on this environment.</sd-alert>
        } @else {
          <div class="flex flex-col gap-4 @xl:flex-row @xl:items-center @xl:justify-between">
            <div class="flex min-w-0 items-center gap-4">
              <span
                class="relative flex size-12 shrink-0 items-center justify-center rounded-full"
                [class]="rec.active ? 'bg-alert/10 text-alert' : 'bg-frost text-cerulean'"
              >
                @if (rec.active) {
                  <span class="absolute inset-0 rounded-full ring-4 ring-alert/15 motion-safe:animate-pulse" aria-hidden="true"></span>
                }
                <sd-icon [name]="rec.active ? 'mic' : 'circle-play'" [size]="22" />
              </span>
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="font-heading text-body font-semibold text-ink">{{ rec.active ? 'Recording in progress' : 'Not recording' }}</span>
                @if (rec.active && rec.recording) {
                  <p class="${CLINICAL_META}">
                    <span class="inline-flex items-center gap-1"><sd-icon name="clock" [size]="13" />Started {{ when(rec.recording.started_at) }}</span>
                    @if (rec.recording.started_by) {
                      <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />{{ rec.recording.started_by }}</span>
                    }
                  </p>
                } @else if (!rec.active) {
                  <span class="font-sans text-caption text-slate">Start when the patient is ready. Files appear below once you stop.</span>
                }
              </div>
            </div>
            @if (rec.active) {
              <sd-button variant="danger" [full]="true" class="shrink-0 @xl:w-auto" [disabled]="busy()" (click)="stopRecording.emit()">
                @if (busy()) {
                  <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Stopping…
                } @else {
                  <sd-icon name="circle-x" [size]="18" />Stop recording
                }
              </sd-button>
            } @else {
              <sd-button [full]="true" class="shrink-0 @xl:w-auto" [disabled]="busy()" (click)="startRecording.emit()">
                @if (busy()) {
                  <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Starting…
                } @else {
                  <sd-icon name="circle-play" [size]="18" />Start recording
                }
              </sd-button>
            }
          </div>
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
        }
      } @else {
        <div class="flex items-center gap-4" aria-busy="true">
          <span class="sr-only">Loading the recording state…</span>
          <div class="sd-shimmer size-12 shrink-0 rounded-full"></div>
          <div class="flex flex-1 flex-col gap-2">
            <div class="sd-shimmer h-4 w-40 rounded-pill"></div>
            <div class="sd-shimmer h-3 w-56 max-w-full rounded-pill"></div>
          </div>
        </div>
      }
    </section>

    <section class="flex flex-col gap-3" aria-label="Recorded files">
      <h3 class="${CLINICAL_H3}">
        Recorded files
        @if (files().length > 0) {
          <span class="${CLINICAL_COUNT}">{{ files().length }}</span>
        }
      </h3>
      @if (files().length === 0) {
        <doc-clinical-empty icon="file-text" message="No recorded files yet." />
      } @else {
        <ul class="flex flex-col divide-y divide-cloud rounded-card border border-cloud bg-white shadow-[0_1px_2px_rgba(10,22,40,0.04)]">
          @for (f of files(); track f.key) {
            <li class="flex flex-col gap-3 px-4 py-3.5 sm:px-5 @xl:flex-row @xl:items-center @xl:justify-between">
              <div class="flex min-w-0 items-center gap-3">
                <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cloud/60 text-slate">
                  <sd-icon name="file-text" [size]="18" />
                </span>
                <span class="min-w-0 truncate font-sans text-body-sm font-semibold text-ink" [attr.title]="f.name">{{ f.name }}</span>
              </div>
              @if (f.url) {
                <a [href]="f.url" target="_blank" rel="noopener" class="${CLINICAL_LINK_BUTTON} shrink-0" [attr.aria-label]="'Download ' + f.name">
                  <sd-icon name="download" [size]="16" />Download
                </a>
              } @else {
                <span class="inline-flex shrink-0 items-center gap-1.5 font-sans text-caption text-slate">
                  <sd-icon name="circle-alert" [size]="14" />Storage not configured
                </span>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ClinicalRecording {
  /** Null while loading. */
  readonly state = input<DoctorRecordingStateDto | null>(null);
  readonly files = input.required<RecordingFileDto[]>();
  readonly busy = input(false);
  readonly error = input('');

  readonly startRecording = output<void>();
  readonly stopRecording = output<void>();

  protected when(iso: string): string {
    return rxDateTime(iso);
  }
}
