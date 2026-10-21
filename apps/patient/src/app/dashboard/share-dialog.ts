import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  OnInit,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { map, type Observable, of, switchMap } from 'rxjs';
import { apiErrorCode, apiErrorMessage, DocumentsApi, DocumentSharingApi } from '@supadoc/data-access';
import type {
  DocumentAccessRequestDto,
  DocumentGrantDto,
  DocumentShareDuration,
  DocumentShareResultDto,
  DocumentShareScope,
  DocumentShareSurface,
  MedicalDocumentDto,
  SharingAppointmentRefDto,
  SharingDoctorDto,
  UpdateDocumentGrantInput,
} from '@supadoc/models';
import { DialogComponent, DialogService, IconComponent, StepperComponent } from '@supadoc/ui';
import {
  accessUntilLabel,
  canSubmitShare,
  countNoun,
  dateLabel,
  defaultDuration,
  doctorSummary,
  drName,
  durationChoices,
  durationError,
  endLabel,
  endsBeforeCopy,
  endsBeforeNext,
  folderNotice,
  grantIndefinite,
  initials,
  isAfterDuration,
  isSharingUnavailable,
  labelAt,
  MAX_SHARE_DOCTORS,
  MAX_SHARE_DOCUMENTS,
  newKey,
  possessive,
  SHARE_NOTE,
  SHARING_CLASSES,
  SHARING_UNAVAILABLE,
  shareEnd,
  shareInput,
  type SharingTheme,
  untilDateBounds,
  untilDateToExpiresAt,
  whatError,
  ymdOf,
} from './document-sharing';

type Step = 'who' | 'what' | 'how' | 'review';

const STEP_TITLE: Record<Step, string> = {
  who: 'Who can see them?',
  what: 'What can they see?',
  how: 'For how long?',
  review: 'Check and share',
};

/** Documents per page when filling a picker (two pages = the most one share can hold). */
const PICKER_PAGE = MAX_SHARE_DOCUMENTS / 2;

/** The patient's newest documents for a picker (up to 200), and how many they have in all. */
export function loadPickerDocuments(api: DocumentsApi): Observable<{ list: MedicalDocumentDto[]; total: number }> {
  return api.list({ page: 1, per_page: PICKER_PAGE, sort_dir: 'desc' }).pipe(
    switchMap((first) =>
      first.meta.total_pages > 1
        ? api
            .list({ page: 2, per_page: PICKER_PAGE, sort_dir: 'desc' })
            .pipe(map((second) => ({ list: [...first.data, ...second.data], total: first.meta.total })))
        : of({ list: first.data, total: first.meta.total }),
    ),
  );
}

/**
 * The "Selected documents" checklist (§6.4 "What"), shared by the Share
 * dialog and the approve dialog: search, Select all / Clear (of what the
 * search shows), a live count, and a note when only the newest documents are
 * listed. The host loads the documents (`loadPickerDocuments`).
 */
@Component({
  selector: 'pat-document-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-3 rounded-card border p-3" [class]="c().box">
      @if (loading()) {
        @for (i of [1, 2, 3]; track i) { <div class="sd-shimmer h-11 rounded-field"></div> }
      } @else if (error()) {
        <p class="flex items-start gap-2 font-sans text-caption" [class]="c().errText" role="alert">
          <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ error() }}
        </p>
        <button type="button" class="min-h-11 w-fit rounded-field px-4 font-sans text-caption font-semibold" [class]="c().secondary" (click)="retry.emit()">Try again</button>
      } @else {
        <label class="flex items-center gap-2 rounded-field border px-3" [class]="c().field">
          <sd-icon name="search" [size]="16" [class]="c().muted" />
          <span class="sr-only">Search your documents</span>
          <input type="search" class="min-h-11 min-w-0 flex-1 bg-transparent font-sans text-body-sm outline-none" placeholder="Search your documents" [value]="search()" (input)="search.set($any($event.target).value)" />
        </label>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-sans text-caption" [class]="c().muted" aria-live="polite">{{ selected().length }} selected</span>
          <span class="flex gap-3">
            <button type="button" class="min-h-11 font-sans text-caption font-semibold" [class]="c().link" (click)="selectAll()">Select all</button>
            <button type="button" class="min-h-11 font-sans text-caption font-semibold" [class]="c().link" (click)="selected.set([])">Clear</button>
          </span>
        </div>
        @if (partial()) {
          <p class="flex items-start gap-2 font-sans text-caption" [class]="c().muted">
            <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />Showing your {{ listed() }} newest documents.
          </p>
        }
        <ul class="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="Your documents">
          @for (doc of filtered(); track doc.id) {
            <li>
              <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-field px-2 py-1.5">
                <input type="checkbox" class="size-5 shrink-0 accent-cerulean" [checked]="selected().includes(doc.id)" (change)="toggle(doc.id, $any($event.target).checked)" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-sans text-body-sm font-medium" [class]="c().text" [title]="doc.title">{{ doc.title }}</span>
                  <span class="truncate font-sans text-caption" [class]="c().muted">{{ doc.type_label }} · {{ dateOf(doc.created_at) }}</span>
                </span>
              </label>
            </li>
          } @empty {
            <li class="px-2 py-3 font-sans text-caption" [class]="c().muted">
              {{ (documents() ?? []).length === 0 ? "You haven't uploaded any documents yet." : 'No documents match your search.' }}
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class DocumentPicker {
  /** null until loaded. */
  readonly documents = input<readonly MedicalDocumentDto[] | null>(null);
  /** How many documents the patient has in all. */
  readonly total = input(0);
  readonly loading = input(false);
  readonly error = input('');
  readonly theme = input<SharingTheme>('light');
  /** The chosen document ids. */
  readonly selected = model<string[]>([]);
  /** "Try again" after a failed load. */
  readonly retry = output<void>();

  protected readonly c = computed(() => SHARING_CLASSES[this.theme()]);
  protected readonly search = signal('');
  protected readonly listed = computed(() => (this.documents() ?? []).length);
  /** Only the newest documents are listed (the patient has more). */
  protected readonly partial = computed(() => this.documents() !== null && this.total() > this.listed());
  protected readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.documents() ?? [];
    return q ? list.filter((d) => `${d.title} ${d.type_label}`.toLowerCase().includes(q)) : list;
  });

  protected toggle(id: string, on: boolean): void {
    this.selected.update((ids) => (on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id)));
  }

  protected selectAll(): void {
    const visible = this.filtered().map((d) => d.id);
    this.selected.update((ids) => [...new Set([...ids, ...visible])]);
  }

  protected dateOf(iso: string): string {
    return dateLabel(iso);
  }
}

/**
 * The Share dialog, reused everywhere a patient shares documents (Manage
 * sharing, a document's access dialog, appointment details, the call, a
 * doctor's request): Who → What → How long → Review. Nothing is preselected
 * that the patient didn't ask for; the review says exactly what an existing
 * folder share, hidden documents or a pending request mean for this share.
 *
 * Edit mode (`grant`) changes one existing share (PATCH); a share that ended
 * meanwhile offers "Share again" with the same choices. Every result line is
 * built by the host from the response (`done`).
 */
@Component({
  selector: 'pat-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, DocumentPicker, IconComponent, RouterLink, StepperComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="md"
      labelledBy="share-dialog-title"
      describedBy="share-dialog-step"
      [busy]="busy()"
      (closed)="requestClose()"
      (afterClose)="closed.emit()"
    >
      <div #body class="flex min-h-full flex-col gap-5 p-5 sm:p-6" [class]="c().body" [attr.aria-busy]="busy() || null">
        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ live() }}</p>
        <div class="flex items-start justify-between gap-3 border-b pb-4" [class]="c().divider">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 #heading id="share-dialog-title" tabindex="-1" data-autofocus class="font-heading text-h5 outline-none" [class]="c().heading">
              {{ title() }}
            </h2>
            <p id="share-dialog-step" class="font-sans text-body-sm" [class]="c().muted">
              Step {{ stepIndex() + 1 }} of {{ steps().length }} · {{ stepTitle() }}
            </p>
          </div>
          <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors" [class]="c().iconBtn" aria-label="Close" [disabled]="busy()" (click)="requestClose()">
            <sd-icon name="x" [size]="22" />
          </button>
        </div>

        @if (unavailable()) {
          <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note" role="status">
            <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
          </p>
          <div class="flex gap-3">
            <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold transition-colors" [class]="c().secondary" (click)="close()">Close</button>
          </div>
        } @else {
          <sd-stepper [count]="steps().length" [current]="stepIndex() + 1" />

          @switch (step()) {
            @case ('who') {
              <fieldset class="flex flex-col gap-3">
                <legend class="mb-3 font-sans text-body font-semibold" [class]="c().text">Who can see them?</legend>
                @if (doctorsLoading()) {
                  @for (i of [1, 2]; track i) { <div class="sd-shimmer h-16 rounded-card"></div> }
                } @else if (doctorsError()) {
                  <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().error" role="alert">
                    <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ doctorsError() }}
                  </p>
                  <button type="button" class="min-h-11 w-fit rounded-field px-5 font-sans text-body-sm font-semibold" [class]="c().secondary" (click)="loadDoctors()">Try again</button>
                } @else if ((doctors() ?? []).length === 0) {
                  <p class="font-sans text-body-sm" [class]="c().muted">
                    You can share with doctors you've booked. Book a consultation first.
                  </p>
                  <a routerLink="/dashboard/specialists" class="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-body-sm font-semibold" [class]="c().link" (click)="close()">
                    Find a specialist<sd-icon name="chevron-right" [size]="16" />
                  </a>
                } @else {
                  <ul class="flex flex-col gap-2">
                    @for (d of doctors(); track d.specialist.id) {
                      <li>
                        <label
                          class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 p-3 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                          [class]="isChosen(d) ? c().on : c().off"
                        >
                          <input
                            type="checkbox"
                            class="mt-1 size-5 shrink-0 accent-cerulean"
                            [checked]="isChosen(d)"
                            [disabled]="whoDisabled(d)"
                            (change)="toggleDoctor(d, $any($event.target).checked)"
                          />
                          <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-frost font-sans text-caption font-semibold text-cerulean-dark" aria-hidden="true">{{ initialsOf(d.specialist.name) }}</span>
                          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span class="font-sans text-body-sm font-semibold" [class]="c().text">{{ dr(d.specialist.name) }}</span>
                            @if (d.specialist.specialty) {
                              <span class="font-sans text-caption" [class]="c().muted">{{ d.specialist.specialty }}</span>
                            }
                            @if (unavailableFor(d)) {
                              <span class="font-sans text-caption" [class]="c().muted">Not available — not practising on VideoMed right now</span>
                            } @else {
                              <span class="font-sans text-caption" [class]="c().muted">{{ accessLine(d) }}</span>
                            }
                          </span>
                        </label>
                      </li>
                    }
                  </ul>
                  @if (doctorIds().length >= maxDoctors) {
                    <p class="font-sans text-caption" [class]="c().muted">You can share with up to 5 doctors at a time.</p>
                  }
                }
              </fieldset>
            }

            @case ('what') {
              <fieldset class="flex flex-col gap-3">
                <legend class="mb-3 font-sans text-body font-semibold" [class]="c().text">What can they see?</legend>
                <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 p-4 transition-colors" [class]="scope() === 'all' ? c().on : c().off">
                  <input type="radio" name="share-scope" value="all" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="scope() === 'all'" (change)="setScope('all')" />
                  <span class="flex flex-col gap-0.5">
                    <span class="font-sans text-body-sm font-semibold" [class]="c().text">All my documents</span>
                    <span class="font-sans text-caption" [class]="c().muted">Everything in your folder, including files you add while access lasts.</span>
                  </span>
                </label>
                <label class="flex min-h-11 items-start gap-3 rounded-card border-2 p-4 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60" [class]="(scope() === 'selected' ? c().on : c().off) + (noDocuments() ? '' : ' cursor-pointer')">
                  <input type="radio" name="share-scope" value="selected" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="scope() === 'selected'" [disabled]="noDocuments()" (change)="setScope('selected')" />
                  <span class="flex flex-col gap-0.5">
                    <span class="font-sans text-body-sm font-semibold" [class]="c().text">Selected documents</span>
                    <span class="font-sans text-caption" [class]="c().muted">{{ noDocuments() ? "You haven't uploaded any documents yet." : 'Only the documents you pick.' }}</span>
                  </span>
                </label>

                @if (scope() === 'selected') {
                  <pat-document-picker
                    [documents]="docs()"
                    [total]="docsTotal()"
                    [loading]="docsLoading()"
                    [error]="docsError()"
                    [theme]="theme()"
                    [(selected)]="documentIds"
                    (retry)="loadDocuments()"
                  />
                }
                @if (showErrors() && whatProblem()) {
                  <p class="font-sans text-caption" [class]="c().errText" role="alert">{{ whatProblem() }}</p>
                }
              </fieldset>
            }

            @case ('how') {
              <fieldset class="flex flex-col gap-3">
                <legend class="mb-3 font-sans text-body font-semibold" [class]="c().text">For how long?</legend>
                <div class="flex flex-col gap-2">
                  @for (choice of choices(); track choice.value) {
                    <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 px-4 py-3 transition-colors" [class]="duration() === choice.value ? c().on : c().off">
                      <input type="radio" name="share-duration" class="mt-1 size-5 shrink-0 accent-cerulean" [value]="choice.value" [checked]="duration() === choice.value" (change)="setDuration(choice.value)" />
                      <span class="flex flex-col gap-0.5">
                        <span class="font-sans text-body-sm font-semibold" [class]="c().text">{{ choice.label }}</span>
                        @if (choice.hint) {
                          <span class="font-sans text-caption" [class]="c().muted">{{ choice.hint }}</span>
                        }
                      </span>
                    </label>
                  }
                </div>
                @if (duration() === 'until') {
                  <label class="flex flex-col gap-1.5">
                    <span class="font-sans text-caption font-semibold" [class]="c().text">End date</span>
                    <input
                      type="date"
                      class="min-h-11 rounded-field border px-4 font-sans text-body-sm outline-none"
                      [class]="c().field"
                      [min]="bounds.min"
                      [max]="bounds.max"
                      [value]="untilDate()"
                      [attr.aria-invalid]="showErrors() && !!howProblem() ? true : null"
                      (input)="untilDate.set($any($event.target).value)"
                    />
                  </label>
                }
                @if (showErrors() && howProblem()) {
                  <p class="font-sans text-caption" [class]="c().errText" role="alert">{{ howProblem() }}</p>
                }
                @for (w of endsBeforeWarnings(); track w.id) {
                  <div class="flex flex-col gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().warn">
                    <p class="flex items-start gap-2"><sd-icon name="calendar-clock" [size]="18" class="mt-0.5 shrink-0" />{{ w.text }}</p>
                    @if (w.next) {
                      <button type="button" class="ml-6 min-h-11 w-fit rounded-pill border border-current/30 px-3 font-sans text-caption font-semibold" (click)="anchorTo(w.id, w.next)">
                        Until 24 hours after that consultation
                      </button>
                    }
                  </div>
                }
              </fieldset>
            }

            @case ('review') {
              <div class="flex flex-col gap-4">
                <dl class="flex flex-col gap-3 rounded-card border p-4 font-sans text-body-sm" [class]="c().box">
                  <div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
                    <dt [class]="c().muted">{{ doctorIds().length === 1 ? 'Doctor' : 'Doctors' }}</dt>
                    <dd class="font-semibold sm:text-right" [class]="c().text">{{ chosenNames() }}</dd>
                  </div>
                  <div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
                    <dt [class]="c().muted">Can see</dt>
                    <dd class="font-semibold sm:text-right" [class]="c().text">
                      @if (scope() === 'all') {
                        All your documents, including new uploads
                      } @else {
                        <button type="button" class="min-h-11 font-semibold underline-offset-2 hover:underline" [class]="c().text" [attr.aria-expanded]="showTitles()" (click)="showTitles.set(!showTitles())">
                          {{ countDocs(documentIds().length) }}
                        </button>
                      }
                    </dd>
                  </div>
                  @if (scope() === 'selected' && showTitles()) {
                    <ul class="flex flex-col gap-1 font-sans text-caption" [class]="c().muted">
                      @for (t of chosenTitles(); track $index) { <li class="truncate">{{ t }}</li> }
                    </ul>
                  }
                  <div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
                    <dt [class]="c().muted">Until</dt>
                    <dd class="font-semibold sm:text-right" [class]="c().text">{{ endText() }}</dd>
                  </div>
                </dl>

                @for (n of folderNotices(); track n.id) {
                  <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note">
                    <sd-icon name="folder-open" [size]="18" class="mt-0.5 shrink-0" />{{ n.text }}
                  </p>
                }
                @for (h of hiddenNotices(); track h.id) {
                  <div class="flex flex-col gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note">
                    <p class="flex items-start gap-2"><sd-icon name="eye-off" [size]="18" class="mt-0.5 shrink-0" />{{ h.text }}</p>
                    <label class="ml-6 flex min-h-11 cursor-pointer items-center gap-2 font-semibold" [class]="c().text">
                      <input type="checkbox" class="size-5 shrink-0 accent-cerulean" [checked]="showHidden().includes(h.id)" (change)="toggleShowHidden(h.id, $any($event.target).checked)" />
                      Show them too
                    </label>
                  </div>
                }
                @if (answerable(); as r) {
                  <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-field px-4 py-3 font-sans text-body-sm font-semibold" [class]="c().note">
                    <input type="checkbox" class="size-5 shrink-0 accent-cerulean" [checked]="answers()" (change)="answers.set($any($event.target).checked)" />
                    This answers {{ possessiveOf(r.specialist.name) }} request
                  </label>
                }
                <p class="flex items-start gap-2 font-sans text-caption" [class]="c().muted">
                  <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0" />{{ note }}
                </p>
              </div>
            }
          }

          @if (error()) {
            <div class="flex flex-col gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().error" role="alert">
              <p class="flex items-start gap-2"><sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ error() }}</p>
              @if (grantEnded()) {
                <button type="button" class="ml-6 min-h-11 w-fit rounded-field px-4 font-sans text-body-sm font-semibold" [class]="c().primary" (click)="shareAgain()">Share again</button>
              }
            </div>
          }

          <div class="mt-auto flex gap-3">
            @if (stepIndex() > 0) {
              <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold transition-colors" [class]="c().secondary" [disabled]="busy()" (click)="back()">Back</button>
            } @else {
              <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold transition-colors" [class]="c().secondary" [disabled]="busy()" (click)="requestClose()">Cancel</button>
            }
            @if (step() === 'review') {
              <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-field py-3 font-sans text-body font-semibold transition-colors disabled:opacity-60" [class]="c().primary" [disabled]="busy() || grantEnded() || (isEdit() && !dirty())" (click)="submit()">
                @if (busy()) { <sd-icon name="loader-circle" [size]="18" class="animate-spin" /> }
                {{ busy() ? (isEdit() ? 'Saving…' : 'Sharing…') : isEdit() ? 'Save changes' : 'Share' }}
              </button>
            } @else {
              <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold transition-colors disabled:opacity-60" [class]="c().primary" [disabled]="step() === 'who' && doctorIds().length === 0" (click)="next()">Continue</button>
            }
          </div>
        }
      </div>
    </sd-dialog>
  `,
})
export class ShareDialog implements OnInit {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly documentsApi = inject(DocumentsApi);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');

  /** `edit` changes `grant`; `create` makes a new share. */
  readonly mode = input<'create' | 'edit'>('create');
  readonly preselectDoctorIds = input<readonly string[]>([]);
  readonly preselectDocumentIds = input<readonly string[]>([]);
  /** The doctor is fixed (from their appointment, a request or a grant): no Who step. */
  readonly lockDoctor = input(false);
  readonly grant = input<DocumentGrantDto | null>(null);
  /** Enables "after the consultation" ends from its `after_options`. */
  readonly appointment = input<SharingAppointmentRefDto | null>(null);
  readonly answersRequest = input<DocumentAccessRequestDto | null>(null);
  readonly surface = input<DocumentShareSurface>('manage_sharing');
  readonly theme = input<SharingTheme>('light');
  /** Start on this "For how long?" choice (when offered). */
  readonly initialDuration = input<DocumentShareDuration | null>(null);
  /** Start on this scope (e.g. `selected` with a preselected document). */
  readonly initialScope = input<DocumentShareScope | null>(null);

  /** A create answered (`DocumentShareResultDto`) or an edit saved (`DocumentGrantDto`). */
  readonly done = output<DocumentShareResultDto | DocumentGrantDto>();
  /** The dialog has closed (after its exit animation): remove it. */
  readonly closed = output<void>();

  protected readonly c = computed(() => SHARING_CLASSES[this.theme()]);
  protected readonly note = SHARE_NOTE;
  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly maxDoctors = MAX_SHARE_DOCTORS;
  protected readonly bounds = untilDateBounds();

  protected readonly open = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly grantEnded = signal(false);
  protected readonly unavailable = signal(false);
  protected readonly showErrors = signal(false);
  protected readonly live = signal('');

  /** Create once "Share again" was chosen for an ended grant. */
  private readonly modeNow = signal<'create' | 'edit'>('create');
  protected readonly isEdit = computed(() => this.modeNow() === 'edit');

  // ----- Data -----
  protected readonly doctors = signal<SharingDoctorDto[] | null>(null);
  protected readonly doctorsLoading = signal(false);
  protected readonly doctorsError = signal('');
  protected readonly docs = signal<MedicalDocumentDto[] | null>(null);
  /** How many documents the patient has in all (the picker lists the newest 200). */
  protected readonly docsTotal = signal(0);
  protected readonly docsLoading = signal(false);
  protected readonly docsError = signal('');
  /** Doctors the API just said can't receive shares. */
  private readonly refused = signal<readonly string[]>([]);

  // ----- Choices -----
  protected readonly doctorIds = signal<string[]>([]);
  protected readonly scope = signal<DocumentShareScope | null>(null);
  protected readonly documentIds = signal<string[]>([]);
  protected readonly duration = signal<DocumentShareDuration | null>(null);
  protected readonly untilDate = signal('');
  /** The consultation `after_*` ends are anchored to, and its doctor. */
  private readonly anchor = signal<{ appointment: SharingAppointmentRefDto; doctorId: string | null } | null>(null);
  protected readonly showHidden = signal<string[]>([]);
  protected readonly answers = signal(true);
  protected readonly showTitles = signal(false);
  private initial = '';
  private clientKey = newKey();

  // ----- Steps -----
  /** No Who step when the doctor is fixed (locked, or the share being changed / shared again). */
  protected readonly steps = computed<Step[]>(() =>
    this.lockDoctor() || this.grant() ? ['what', 'how', 'review'] : ['who', 'what', 'how', 'review'],
  );
  protected readonly stepIndex = signal(0);
  protected readonly step = computed<Step>(() => this.steps()[Math.min(this.stepIndex(), this.steps().length - 1)]);
  protected readonly stepTitle = computed(() => STEP_TITLE[this.step()]);

  protected readonly title = computed(() => {
    if (this.isEdit()) return `Change what ${this.dr(this.grant()?.specialist.name)} can see`;
    return 'Share documents';
  });

  /** The anchor applies when exactly its doctor is chosen. */
  private readonly anchorNow = computed(() => {
    const a = this.anchor();
    const ids = this.doctorIds();
    if (!a || ids.length !== 1) return null;
    return !a.doctorId || ids[0] === a.doctorId ? a : null;
  });
  protected readonly choices = computed(() => durationChoices(this.anchorNow()?.appointment ?? null));
  /**
   * Edit mode with the end left as it was: the PATCH sends no duration and the
   * share keeps its real end, so the review shows that end (`until_label_at`),
   * not one worked out again from now.
   */
  private readonly endUnchanged = computed(() => {
    const grant = this.grant();
    const d = this.duration();
    if (!this.isEdit() || !grant || !d) return false;
    if (d !== grant.duration) return false;
    if (d === 'until') return this.untilDate() === ymdOf(grant.until_label_at);
    if (isAfterDuration(d)) return this.anchorNow()?.appointment.id === grant.appointment?.id;
    return true;
  });
  /** The exclusive end (null = no end date, undefined = not known yet). */
  private readonly end = computed(() => {
    const grant = this.grant();
    if (grant && this.endUnchanged()) return grantIndefinite(grant) ? null : (grant.expires_at ?? undefined);
    return shareEnd(this.duration(), { appointment: this.anchorNow()?.appointment ?? null, untilDate: this.untilDate() });
  });
  protected readonly endText = computed(() => {
    const grant = this.grant();
    if (grant && this.endUnchanged()) return grantIndefinite(grant) ? 'No end date' : labelAt(grant.until_label_at) || '—';
    const end = this.end();
    return end === undefined ? '—' : endLabel(this.duration(), end);
  });

  protected readonly noDocuments = computed(() => this.docs() !== null && this.docs()?.length === 0);
  protected readonly chosenTitles = computed(() => {
    const byId = new Map((this.docs() ?? []).map((d) => [d.id, d.title]));
    return this.documentIds().map((id) => byId.get(id) ?? 'A document');
  });
  private readonly chosenDoctors = computed(() => {
    const ids = this.doctorIds();
    return (this.doctors() ?? []).filter((d) => ids.includes(d.specialist.id));
  });
  protected readonly chosenNames = computed(() => {
    const ids = this.doctorIds();
    const byId = new Map((this.doctors() ?? []).map((d) => [d.specialist.id, d.specialist.name]));
    const grantDoctor = this.grant()?.specialist;
    if (grantDoctor) byId.set(grantDoctor.id, grantDoctor.name);
    return ids.map((id) => this.dr(byId.get(id))).join(', ');
  });

  private readonly form = computed(() => ({
    doctorIds: this.doctorIds(),
    scope: this.scope(),
    documentIds: this.documentIds(),
    duration: this.duration(),
    untilDate: this.untilDate(),
    appointment: this.anchorNow()?.appointment ?? null,
  }));
  protected readonly whatProblem = computed(() => whatError(this.form()));
  protected readonly howProblem = computed(() => durationError(this.form(), this.bounds));
  protected readonly dirty = computed(() => this.snapshot() !== this.initial);

  protected readonly endsBeforeWarnings = computed(() => {
    const end = this.end();
    const one = this.doctorIds().length === 1;
    return this.chosenDoctors()
      .filter((d) => endsBeforeNext(end, d.next_appointment))
      .map((d) => {
        const next = d.next_appointment as SharingAppointmentRefDto;
        return {
          id: d.specialist.id,
          text: endsBeforeCopy(next, this.dr(d.specialist.name)),
          next: one && next.after_options.after_24h ? next : null,
        };
      });
  });

  protected readonly folderNotices = computed(() => {
    if (this.scope() !== 'all' || this.isEdit()) return [];
    const end = this.end();
    const label = end === undefined ? '' : endLabel(this.duration(), end);
    return this.chosenDoctors()
      .map((d) => ({ id: d.specialist.id, text: folderNotice(d, end, label) }))
      .filter((n) => n.text);
  });

  protected readonly hiddenNotices = computed(() => {
    if (this.scope() !== 'all' || this.isEdit()) return [];
    return this.chosenDoctors()
      .filter((d) => d.access.hidden_count > 0)
      .map((d) => ({
        id: d.specialist.id,
        text: `${countNoun(d.access.hidden_count, 'document')} you hid from ${this.dr(d.specialist.name)} stay hidden.`,
      }));
  });

  /** The request this share can answer: the one passed in, else a chosen doctor's pending one. */
  protected readonly answerable = computed<DocumentAccessRequestDto | null>(() => {
    if (this.isEdit()) return null;
    const ids = this.doctorIds();
    const given = this.answersRequest();
    if (given && given.status === 'pending' && ids.includes(given.specialist.id)) return given;
    for (const d of this.chosenDoctors()) {
      if (d.pending_request?.status === 'pending') return d.pending_request;
    }
    return null;
  });

  constructor() {
    // A step change destroys the control that was used: the new step's heading takes focus.
    effect(() => {
      this.step();
      untracked(() => this.focusHeading());
    });
    // An `after_*` end that is no longer offered (another doctor chosen) falls back to the default.
    effect(() => {
      const offered = this.choices();
      const d = this.duration();
      if (d && isAfterDuration(d) && !offered.some((c) => c.value === d)) {
        untracked(() => this.duration.set(defaultDuration(offered)));
      }
    });
  }

  ngOnInit(): void {
    const grant = this.grant();
    this.modeNow.set(this.mode() === 'edit' && grant ? 'edit' : 'create');
    if (this.isEdit() && grant) {
      this.doctorIds.set([grant.specialist.id]);
      this.scope.set(grant.scope);
      this.documentIds.set([...grant.document_ids]);
      if (grant.appointment) this.anchor.set({ appointment: grant.appointment, doctorId: grant.specialist.id });
      this.duration.set(grant.duration);
      if (grant.duration === 'until') this.untilDate.set(ymdOf(grant.until_label_at));
    } else {
      const ids = [...new Set(this.preselectDoctorIds())].slice(0, MAX_SHARE_DOCTORS);
      this.doctorIds.set(ids);
      const appt = this.appointment();
      // A consultation belongs to one doctor: its ends apply only with that doctor chosen.
      if (appt && ids.length === 1) this.anchor.set({ appointment: appt, doctorId: ids[0] });
      const docIds = [...new Set(this.preselectDocumentIds())];
      this.documentIds.set(docIds);
      this.scope.set(this.initialScope() ?? (docIds.length > 0 ? 'selected' : null));
      const offered = this.choices();
      const wanted = this.initialDuration();
      this.duration.set(wanted && offered.some((c) => c.value === wanted) ? wanted : defaultDuration(offered));
    }
    this.initial = this.snapshot();
    this.loadDoctors();
    this.loadDocuments();
  }

  // ----- Loading -----
  protected loadDoctors(): void {
    this.doctorsLoading.set(true);
    this.doctorsError.set('');
    this.sharing
      .doctors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.doctors.set(res.data ?? []);
          this.doctorsLoading.set(false);
        },
        error: (err: unknown) => {
          this.doctorsLoading.set(false);
          if (isSharingUnavailable(err)) {
            this.unavailable.set(true);
            return;
          }
          this.doctorsError.set(apiErrorMessage(err, 'Could not load your doctors.'));
        },
      });
  }

  /** The patient's documents for the checklist (the newest 200). */
  protected loadDocuments(): void {
    this.docsLoading.set(true);
    this.docsError.set('');
    loadPickerDocuments(this.documentsApi)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ list, total }) => {
          this.docs.set(list);
          this.docsTotal.set(total);
          this.docsLoading.set(false);
        },
        error: (err: unknown) => {
          this.docsLoading.set(false);
          this.docsError.set(apiErrorMessage(err, 'Could not load your documents.'));
        },
      });
  }

  // ----- Who -----
  protected isChosen(d: SharingDoctorDto): boolean {
    return this.doctorIds().includes(d.specialist.id);
  }
  protected unavailableFor(d: SharingDoctorDto): boolean {
    return !d.can_share || this.refused().includes(d.specialist.id);
  }
  protected whoDisabled(d: SharingDoctorDto): boolean {
    if (this.unavailableFor(d)) return !this.isChosen(d);
    return !this.isChosen(d) && this.doctorIds().length >= MAX_SHARE_DOCTORS;
  }
  protected toggleDoctor(d: SharingDoctorDto, on: boolean): void {
    const id = d.specialist.id;
    this.doctorIds.update((ids) =>
      on ? (ids.includes(id) || ids.length >= MAX_SHARE_DOCTORS ? ids : [...ids, id]) : ids.filter((x) => x !== id),
    );
    this.error.set('');
  }
  protected accessLine(d: SharingDoctorDto): string {
    const summary = doctorSummary(d);
    // "All your documents, including new uploads" runs to the folder share's
    // own end — not the latest end of everything they can see.
    const until = accessUntilLabel(d.access);
    return d.access.state === 'none' ? summary : [summary, until].filter(Boolean).join(' · ');
  }

  // ----- What -----
  protected setScope(s: DocumentShareScope): void {
    this.scope.set(s);
    this.error.set('');
  }

  // ----- How long -----
  protected setDuration(d: DocumentShareDuration): void {
    this.duration.set(d);
    if (d === 'until' && !this.untilDate()) this.untilDate.set('');
  }
  /** "Until 24 hours after that consultation": anchor the end to the doctor's next consultation. */
  protected anchorTo(doctorId: string, next: SharingAppointmentRefDto): void {
    this.anchor.set({ appointment: next, doctorId });
    this.duration.set('after_24h');
  }

  // ----- Review -----
  protected toggleShowHidden(id: string, on: boolean): void {
    this.showHidden.update((ids) => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)));
  }

  // ----- Navigation -----
  protected next(): void {
    const step = this.step();
    if (step === 'who' && this.doctorIds().length === 0) return;
    if (step === 'what' && this.whatProblem()) {
      this.showErrors.set(true);
      return;
    }
    if (step === 'how' && this.howProblem()) {
      this.showErrors.set(true);
      return;
    }
    this.showErrors.set(false);
    this.error.set('');
    this.stepIndex.update((i) => Math.min(i + 1, this.steps().length - 1));
  }

  protected back(): void {
    this.error.set('');
    this.grantEnded.set(false);
    this.showErrors.set(false);
    this.stepIndex.update((i) => Math.max(0, i - 1));
  }

  protected async requestClose(): Promise<void> {
    if (this.busy()) return;
    if (this.dirty() && !this.unavailable()) {
      const { confirmed } = await this.dialogs.confirm({
        tone: 'warning',
        icon: 'trash-2',
        title: this.isEdit() ? 'Discard these changes?' : 'Discard this share?',
        message: this.isEdit() ? 'Nothing has been changed yet.' : 'Nothing has been shared yet.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
      });
      if (!confirmed) return;
    }
    this.close();
  }

  protected close(): void {
    this.open.set(false);
  }

  // ----- Submit -----
  protected submit(): void {
    if (this.busy()) return;
    if (!canSubmitShare(this.form(), this.bounds)) {
      this.showErrors.set(true);
      this.stepIndex.set(this.steps().indexOf(this.whatProblem() ? 'what' : 'how'));
      return;
    }
    this.error.set('');
    this.busy.set(true);
    this.live.set(this.isEdit() ? 'Saving…' : 'Sharing…');
    if (this.isEdit()) this.saveEdit();
    else this.create();
  }

  private create(): void {
    const answer = this.answerable();
    const input = shareInput(this.form(), {
      clientKey: this.clientKey,
      surface: this.surface(),
      answersRequestId: answer && this.answers() ? answer.id : null,
      showHiddenFor: this.showHidden(),
    });
    this.sharing
      .share(input)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.live.set('Shared.');
          this.done.emit(res.data);
          this.close();
        },
        error: (err: unknown) => this.failed(err),
      });
  }

  private saveEdit(): void {
    const grant = this.grant();
    if (!grant) return;
    const body: UpdateDocumentGrantInput = {};
    const scope = this.scope();
    if (scope && scope !== grant.scope) body.scope = scope;
    if (scope === 'selected') {
      const before = [...grant.document_ids].sort().join(',');
      const after = [...this.documentIds()].sort().join(',');
      if (before !== after || body.scope) body.document_ids = [...this.documentIds()];
    }
    const duration = this.duration();
    const until = duration === 'until' ? untilDateToExpiresAt(this.untilDate()) : null;
    if (duration && !this.endUnchanged()) {
      body.duration = duration;
      if (duration === 'until') body.expires_at = until;
      if (isAfterDuration(duration)) body.appointment_id = this.anchorNow()?.appointment.id ?? null;
    }
    this.sharing
      .updateGrant(grant.id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.live.set('Changes saved.');
          this.done.emit(res.data);
          this.close();
        },
        error: (err: unknown) => this.failed(err),
      });
  }

  private failed(err: unknown): void {
    this.busy.set(false);
    const code = apiErrorCode(err);
    if (code === 'sharing_unavailable') {
      this.unavailable.set(true);
      this.live.set(SHARING_UNAVAILABLE);
      return;
    }
    if (code === 'grant_ended') {
      this.grantEnded.set(true);
      this.error.set('This access already ended. Share again to give access.');
      this.live.set(this.error());
      return;
    }
    if (code === 'idempotency_conflict') {
      this.clientKey = newKey();
      this.error.set('Something changed. Check your choices and try again.');
      this.live.set(this.error());
      return;
    }
    if (code === 'doctor_unavailable' || code === 'doctor_not_eligible') {
      // Back to Who with the doctor(s) the server refused marked (fresh list).
      this.error.set(apiErrorMessage(err, 'One of these doctors can’t receive documents right now.'));
      this.live.set(this.error());
      this.sharing
        .doctors()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            const list = res.data ?? [];
            this.doctors.set(list);
            const blocked = list.filter((d) => !d.can_share).map((d) => d.specialist.id);
            this.refused.set(blocked);
            this.doctorIds.update((ids) => ids.filter((id) => !blocked.includes(id)));
          },
        });
      const who = this.steps().indexOf('who');
      if (who >= 0) this.stepIndex.set(who);
      return;
    }
    this.error.set(apiErrorMessage(err, this.isEdit() ? 'Could not save your changes. Please try again.' : 'Could not share. Please try again.'));
    this.live.set(this.error());
  }

  /** The edited share ended meanwhile: offer the same choices as a new share. */
  protected shareAgain(): void {
    this.modeNow.set('create');
    this.grantEnded.set(false);
    this.error.set('');
    this.clientKey = newKey();
    this.stepIndex.set(this.steps().indexOf('review'));
    this.focusHeading();
  }

  // ----- Display -----
  protected dr(name: string | null | undefined): string {
    return drName(name);
  }
  protected possessiveOf(name: string): string {
    return possessive(drName(name));
  }
  protected initialsOf(name: string): string {
    return initials(name);
  }
  protected countDocs(n: number): string {
    return countNoun(n, 'document');
  }

  private snapshot(): string {
    return JSON.stringify([
      this.doctorIds(),
      this.scope(),
      [...this.documentIds()].sort(),
      this.duration(),
      this.untilDate(),
      this.anchor()?.appointment.id ?? null,
    ]);
  }

  /** Focus the dialog's heading once the new step has rendered (unless focus left the dialog). */
  private focusHeading(): void {
    afterNextRender(
      () => {
        const root = this.body()?.nativeElement;
        const active = this.doc.activeElement;
        if (!root || (active && active !== this.doc.body && !root.contains(active))) return;
        this.heading()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
}
