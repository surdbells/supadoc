import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { AdminDoctorApplicationsApi, apiErrorFields, apiErrorMessage } from '@supadoc/data-access';
import type { DoctorApplicationNoteDto } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { FIELD, FIELD_INVALID, HINT, LABEL, PANEL_STATE, SECTION, SECTION_TITLE } from '../../shared/layout';
import { BTN_PRIMARY, BTN_SECONDARY, dateTime } from '../../specialists/specialist-ui';

export const NOTE_MAX = 4000;

/**
 * Internal notes on an application — staff only, never shown to the applicant
 * and never part of what they are sent. Newest first; add one below the
 * banner. Read when the tab opens.
 */
@Component({
  selector: 'bo-application-notes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, IconComponent],
  template: `
    <div class="flex flex-col gap-6">
      <sd-alert tone="info">Only staff can see notes.</sd-alert>

      <section class="${SECTION} !gap-4" aria-labelledby="bo-app-notes-add-title">
        <h2 id="bo-app-notes-add-title" class="${SECTION_TITLE}"><sd-icon name="message-square" [size]="20" class="text-cerulean" />Add a note</h2>
        <form class="flex flex-col gap-3" novalidate (submit)="$event.preventDefault(); add()">
          <label class="flex flex-col gap-1.5">
            <span class="${LABEL}">Note</span>
            <textarea
              #bodyInput
              rows="4"
              [attr.maxlength]="max"
              class="${FIELD}"
              [class]="error() ? '${FIELD_INVALID}' : ''"
              [value]="body()"
              (input)="body.set($any($event.target).value); error.set('')"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? 'bo-app-note-count bo-app-note-err' : 'bo-app-note-count'"
            ></textarea>
            <span id="bo-app-note-count" class="${HINT} self-end tabular-nums">{{ body().length }} / {{ max }}</span>
            @if (error(); as e) { <span id="bo-app-note-err" class="font-sans text-caption text-alert" role="alert">{{ e }}</span> }
          </label>
          <button type="submit" class="${BTN_PRIMARY} w-full sm:w-fit" [disabled]="saving()">
            <sd-icon [name]="saving() ? 'loader-circle' : 'send'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Adding…' : 'Add note' }}
          </button>
        </form>
      </section>

      @if (loading() && notes().length === 0) {
        <div class="sd-shimmer h-32 rounded-card" aria-busy="true"><span class="sr-only" role="status">Loading notes…</span></div>
      } @else if (loadError()) {
        <div class="${PANEL_STATE}">
          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ loadError() }}</p>
          <button type="button" class="${BTN_SECONDARY}" (click)="load()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
        </div>
      } @else {
        <section class="${SECTION} !gap-4" aria-labelledby="bo-app-notes-title">
          <h2 id="bo-app-notes-title" class="${SECTION_TITLE}"><sd-icon name="history" [size]="20" class="text-cerulean" />Notes ({{ notes().length }})</h2>
          <ol class="flex flex-col divide-y divide-cloud" aria-live="polite">
            @for (n of notes(); track n.id) {
              <li class="flex flex-col gap-1 py-3">
                <span class="font-sans text-caption text-slate">{{ n.author_name || 'Staff' }} · {{ when(n.created_at) }}</span>
                <span class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ n.body }}</span>
              </li>
            } @empty {
              <li class="py-3 font-sans text-body-sm text-slate">No notes yet.</li>
            }
          </ol>
        </section>
      }
    </div>
  `,
})
export class ApplicationNotesTab {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly applicationId = input.required<string>();
  /** The number of notes now (the tab's count). */
  readonly countChange = output<number>();

  protected readonly max = NOTE_MAX;
  protected readonly notes = signal<DoctorApplicationNoteDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly body = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  private readonly bodyInput = viewChild<ElementRef<HTMLTextAreaElement>>('bodyInput');
  private sub?: Subscription;

  constructor() {
    effect(() => {
      this.applicationId();
      untracked(() => this.load());
    });
  }

  protected load(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    this.sub = this.api
      .notes(this.applicationId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const list = [...(res.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
          this.notes.set(list);
          this.loading.set(false);
          this.countChange.emit(list.length);
        },
        error: (err: unknown) => {
          this.loadError.set(apiErrorMessage(err, 'Could not load the notes.'));
          this.loading.set(false);
        },
      });
  }

  protected add(): void {
    if (this.saving()) return;
    const body = this.body().trim();
    if (!body) {
      this.error.set('Write the note first.');
      this.bodyInput()?.nativeElement.focus();
      return;
    }
    if (body.length > NOTE_MAX) {
      this.error.set(`Keep the note to ${NOTE_MAX.toLocaleString('en-GB')} characters.`);
      this.bodyInput()?.nativeElement.focus();
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.api
      .addNote(this.applicationId(), body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.body.set('');
          this.notes.update((list) => [res.data, ...list]);
          this.countChange.emit(this.notes().length);
          // The field stays where it was: ready for another note.
          this.bodyInput()?.nativeElement.focus();
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.error.set(apiErrorFields(err)['body'] ?? apiErrorMessage(err, 'Could not add the note.'));
          this.bodyInput()?.nativeElement.focus();
        },
      });
  }

  protected when(iso: string): string {
    return dateTime(iso);
  }
}
