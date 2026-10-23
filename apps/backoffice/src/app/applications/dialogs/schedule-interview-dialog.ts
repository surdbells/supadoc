import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminDoctorApplicationsApi, apiErrorFields, apiErrorMessage } from '@supadoc/data-access';
import type { DoctorApplicationDetailDto, ScheduleInterviewInput } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import { DIALOG_FOOTER, FIELD, FIELD_ERROR, FIELD_INVALID, HINT, LABEL } from '../../shared/layout';
import { BTN_GHOST, BTN_PRIMARY } from '../../specialists/specialist-ui';
import {
  clinicDateTime,
  clinicLocalToIso,
  isoToClinicLocal,
  meetingHost,
  viewerDateTime,
  viewerTimeDiffers,
} from '../application-ui';
import { isConflict } from './request-info-dialog';

export const INTERVIEW_LENGTHS: readonly ScheduleInterviewInput['duration_minutes'][] = [15, 30, 45, 60];
export const INTERVIEW_NOTE_MAX = 500;
const MIN_LEAD_MS = 15 * 60_000;
const MAX_AHEAD_MS = 90 * 86_400_000;

/**
 * Schedule (or move) the interview: a date and time on the clinic's clock
 * (Lagos, WAT — sent with its offset, so the server never reads it as its own
 * time), its length, the https meeting link (Meet, Zoom, Teams…) and an
 * optional note. A preview line says what the applicant will see, and the
 * reviewer's own time when it differs. The applicant is emailed and texted.
 */
@Component({
  selector: 'bo-schedule-interview-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, DialogComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      [title]="reschedule() ? 'Reschedule the interview' : 'Schedule an interview'"
      [subtitle]="detail().full_name + ' · ' + detail().reference"
      size="md"
      [busy]="saving()"
      (closed)="close()"
    >
      <form id="bo-interview-form" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); submit()">
        <label class="flex flex-col gap-1.5">
          <span class="${LABEL}">Date and time (Lagos time) <span aria-hidden="true">*</span></span>
          <input
            id="bo-iv-when"
            type="datetime-local"
            required
            class="${FIELD} min-h-12"
            [class]="err('starts_at') ? '${FIELD_INVALID}' : ''"
            [min]="minLocal()"
            [max]="maxLocal()"
            [value]="local()"
            (input)="local.set($any($event.target).value); clearErr('starts_at')"
            [attr.aria-invalid]="err('starts_at') ? 'true' : null"
            [attr.aria-describedby]="err('starts_at') ? 'bo-iv-when-hint bo-iv-when-err' : 'bo-iv-when-hint'"
            data-autofocus
          />
          <span id="bo-iv-when-hint" class="${HINT}">West Africa Time (WAT), as the applicant sees it.</span>
          @if (err('starts_at'); as e) { <span id="bo-iv-when-err" class="${FIELD_ERROR}">{{ e }}</span> }
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="${LABEL}">Length</span>
          <select id="bo-iv-length" class="${FIELD}" (change)="setDuration($any($event.target).value)">
            @for (m of lengths; track m) {
              <option [value]="m" [selected]="m === duration()">{{ m }} minutes</option>
            }
          </select>
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="${LABEL}">Meeting link <span aria-hidden="true">*</span></span>
          <input
            id="bo-iv-url"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            maxlength="500"
            required
            class="${FIELD}"
            [class]="err('meeting_url') ? '${FIELD_INVALID}' : ''"
            placeholder="https://meet.google.com/…"
            [value]="url()"
            (input)="url.set($any($event.target).value); clearErr('meeting_url')"
            [attr.aria-invalid]="err('meeting_url') ? 'true' : null"
            [attr.aria-describedby]="err('meeting_url') ? 'bo-iv-url-hint bo-iv-url-err' : 'bo-iv-url-hint'"
          />
          <span id="bo-iv-url-hint" class="${HINT}">Paste the Google Meet, Zoom or Teams link.</span>
          @if (err('meeting_url'); as e) { <span id="bo-iv-url-err" class="${FIELD_ERROR}">{{ e }}</span> }
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="${LABEL}">Note to the applicant (optional)</span>
          <textarea
            id="bo-iv-note"
            rows="3"
            [attr.maxlength]="noteMax"
            class="${FIELD}"
            [class]="err('note') ? '${FIELD_INVALID}' : ''"
            [value]="note()"
            (input)="note.set($any($event.target).value); clearErr('note')"
            [attr.aria-invalid]="err('note') ? 'true' : null"
            [attr.aria-describedby]="err('note') ? 'bo-iv-note-count bo-iv-note-err' : 'bo-iv-note-count'"
          ></textarea>
          <span id="bo-iv-note-count" class="${HINT} self-end tabular-nums">{{ note().length }} / {{ noteMax }}</span>
          @if (err('note'); as e) { <span id="bo-iv-note-err" class="${FIELD_ERROR}">{{ e }}</span> }
        </label>

        @if (preview(); as p) {
          <div class="flex flex-col gap-1 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-ink" aria-live="polite">
            <span><span class="font-semibold">Applicant sees:</span> {{ p.applicant }}</span>
            @if (p.viewer) {
              <span class="text-caption text-slate">Your time: {{ p.viewer }}</span>
            }
          </div>
        }

        <div aria-live="assertive">
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
        </div>
      </form>
      <div dialogFooter class="${DIALOG_FOOTER}">
        <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="close()">Cancel</button>
        <button type="submit" form="bo-interview-form" class="${BTN_PRIMARY}" [disabled]="saving()">
          <sd-icon [name]="saving() ? 'loader-circle' : 'calendar-plus'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Saving…' : reschedule() ? 'Save new time' : 'Schedule interview' }}
        </button>
      </div>
    </sd-dialog>
  `,
})
export class ScheduleInterviewDialog {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild(DialogComponent);

  readonly open = input(false);
  readonly detail = input.required<DoctorApplicationDetailDto>();
  readonly closed = output<void>();
  /** Saved — the application as it is now. */
  readonly done = output<DoctorApplicationDetailDto>();
  /** The application moved on meanwhile (409): the page re-reads it. */
  readonly stale = output<void>();

  protected readonly lengths = INTERVIEW_LENGTHS;
  protected readonly noteMax = INTERVIEW_NOTE_MAX;
  /** A clock the tests can set. */
  protected now: () => number = () => Date.now();

  protected readonly local = signal('');
  protected readonly duration = signal<ScheduleInterviewInput['duration_minutes']>(30);
  protected readonly url = signal('');
  protected readonly note = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly errors = signal<Record<string, string>>({});
  /** The bounds the API checks, on the clinic's clock (refreshed each open). */
  protected readonly minLocal = signal('');
  protected readonly maxLocal = signal('');

  protected readonly reschedule = computed(() => this.detail().status === 'interview_scheduled' && !!this.detail().interview);

  /** What the applicant is told, and the reviewer's own time when it reads differently. */
  protected readonly preview = computed(() => {
    const iso = clinicLocalToIso(this.local());
    if (!iso) return null;
    const host = meetingHost(this.url());
    return {
      applicant: `${clinicDateTime(iso)} · video call${host ? ` (${host})` : ''}`,
      viewer: viewerTimeDiffers(iso) ? viewerDateTime(iso) : null,
    };
  });

  constructor() {
    // Each open: today's bounds, and the interview as it stands (a reschedule) or blanks.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        const iv = this.detail().interview;
        const now = this.now();
        this.minLocal.set(isoToClinicLocal(new Date(now + MIN_LEAD_MS).toISOString()));
        this.maxLocal.set(isoToClinicLocal(new Date(now + MAX_AHEAD_MS).toISOString()));
        this.local.set(iv ? isoToClinicLocal(iv.starts_at) : '');
        this.duration.set(iv?.duration_minutes ?? 30);
        this.url.set(iv?.meeting_url ?? '');
        this.note.set(iv?.note ?? '');
        this.error.set('');
        this.errors.set({});
      });
    });
  }

  protected close(): void {
    if (!this.saving()) this.closed.emit();
  }

  protected setDuration(value: string): void {
    const m = INTERVIEW_LENGTHS.find((n) => n === Number(value));
    if (m) this.duration.set(m);
  }

  protected err(key: string): string {
    return this.errors()[key] ?? '';
  }

  protected clearErr(key: string): void {
    if (!this.errors()[key]) return;
    this.errors.update((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  protected submit(): void {
    if (this.saving()) return;
    const errors: Record<string, string> = {};
    const iso = clinicLocalToIso(this.local());
    if (!this.local().trim()) errors['starts_at'] = 'Choose the date and time.';
    else if (!iso) errors['starts_at'] = 'Enter a full date and time.';
    else {
      const at = new Date(iso).getTime();
      const now = this.now();
      if (at < now + MIN_LEAD_MS) errors['starts_at'] = 'Choose a time at least 15 minutes from now.';
      else if (at > now + MAX_AHEAD_MS) errors['starts_at'] = 'Choose a time within the next 90 days.';
    }
    const url = this.url().trim();
    if (!meetingHost(url)) errors['meeting_url'] = 'Paste the full https:// meeting link.';
    const note = this.note().trim();
    if (note.length > INTERVIEW_NOTE_MAX) errors['note'] = `Keep the note to ${INTERVIEW_NOTE_MAX} characters.`;
    this.errors.set(errors);
    this.error.set('');
    if (Object.keys(errors).length > 0 || !iso) {
      this.focusFirstError();
      return;
    }
    this.saving.set(true);
    this.api
      .scheduleInterview(this.detail().id, {
        expected_status: this.detail().status,
        starts_at: iso,
        duration_minutes: this.duration(),
        meeting_url: url,
        note: note || null,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.done.emit(res.data);
        },
        error: (err: unknown) => {
          this.saving.set(false);
          const fields = apiErrorFields(err);
          const known = ['starts_at', 'duration_minutes', 'meeting_url', 'note'];
          this.errors.set(Object.fromEntries(Object.entries(fields).filter(([k]) => known.includes(k))));
          this.error.set(apiErrorMessage(err, 'Could not save the interview.'));
          if (isConflict(err)) this.stale.emit();
          this.dialog()?.refocus();
          this.focusFirstError();
        },
      });
  }

  private focusFirstError(): void {
    const ids: Record<string, string> = { starts_at: 'bo-iv-when', duration_minutes: 'bo-iv-length', meeting_url: 'bo-iv-url', note: 'bo-iv-note' };
    const first = Object.keys(ids).find((k) => this.errors()[k]);
    if (!first) return;
    afterNextRender(() => document.getElementById(ids[first])?.focus(), { injector: this.injector });
  }
}
