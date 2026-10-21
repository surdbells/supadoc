import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  apiErrorCode,
  apiErrorFields,
  apiErrorMessage,
  DocumentsApi,
  DocumentSharingApi,
} from '@supadoc/data-access';
import type {
  ApproveAccessRequestInput,
  DocumentAccessRequestDto,
  DocumentAccessRequestStatus,
  DocumentGrantDto,
  DocumentShareDuration,
  DocumentShareScope,
  MedicalDocumentDto,
  SharingDoctorDto,
} from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import {
  approvedLine,
  canSubmitShare,
  consultationDay,
  countNoun,
  defaultDuration,
  drName,
  durationChoices,
  durationError,
  durationText,
  isAfterDuration,
  isSharingUnavailable,
  possessive,
  requestStatusCopy,
  requestTitle,
  SHARING_CLASSES,
  SHARING_UNAVAILABLE,
  type SharingTheme,
  untilDateBounds,
  untilDateToExpiresAt,
  whatError,
} from './document-sharing';
import { DocumentPicker, loadPickerDocuments } from './share-dialog';

/** What the host learns when the dialog is done. */
export type ApproveOutcome =
  | {
      readonly kind: 'approved';
      readonly request: DocumentAccessRequestDto;
      /**
       * null when the server had already recorded this approval (a retry after
       * a lost answer, or another tab): a success all the same (§2.4).
       */
      readonly grant: DocumentGrantDto | null;
    }
  | { readonly kind: 'declined'; readonly request: DocumentAccessRequestDto }
  /** The request had already closed some other way (declined, withdrawn, expired). */
  | { readonly kind: 'stale'; readonly status: DocumentAccessRequestStatus };

/** The host's success line for an outcome ('' when there is nothing to say). */
export function approveOutcomeLine(outcome: ApproveOutcome): string {
  switch (outcome.kind) {
    case 'approved':
      return outcome.grant
        ? approvedLine(outcome.grant)
        : `You've already approved ${possessive(drName(outcome.request.specialist.name))} request.`;
    case 'declined':
      return 'Request declined.';
    default:
      return '';
  }
}

/**
 * A doctor's request to see the patient's documents — one screen: who asks,
 * their note (plain text), what the server suggests ("the 2 files you attached
 * for this consultation · until 7 days after it"), one-tap **Approve and
 * share**, **Decline** (optionally stopping further requests), and "Change
 * what or how long" for anything else. A request that is no longer pending
 * opens as a short info dialog instead.
 */
@Component({
  selector: 'pat-approve-request-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, DocumentPicker, IconComponent, RouterLink],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="md"
      labelledBy="approve-title"
      [busy]="busy()"
      (closed)="close()"
      (afterClose)="closed.emit()"
    >
      <div class="flex min-h-full flex-col gap-5 p-5 sm:p-6" [class]="c().body" [attr.aria-busy]="busy() || null">
        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ live() }}</p>
        <div class="flex items-start justify-between gap-3 border-b pb-4" [class]="c().divider">
          <div class="flex min-w-0 items-start gap-3">
            <span class="flex size-11 shrink-0 items-center justify-center rounded-full" [class]="c().warn" aria-hidden="true">
              <sd-icon name="key-round" [size]="20" />
            </span>
            <div class="flex min-w-0 flex-col gap-1">
              <h2 #heading id="approve-title" tabindex="-1" data-autofocus class="font-heading text-h5 outline-none" [class]="c().heading">{{ titleText() }}</h2>
              @if (request().appointment; as a) {
                <p class="font-sans text-body-sm" [class]="c().muted">For your {{ day(a.scheduled_at) }} consultation</p>
              }
            </div>
          </div>
          <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors" [class]="c().iconBtn" aria-label="Close" [disabled]="busy()" (click)="close()">
            <sd-icon name="x" [size]="22" />
          </button>
        </div>

        @if (unavailable()) {
          <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note" role="status">
            <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
          </p>
        } @else if (info()) {
          <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note" role="status">
            <sd-icon name="info" [size]="18" class="mt-0.5 shrink-0" />{{ info() }}
          </p>
          <a routerLink="/dashboard/documents/sharing" class="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-body-sm font-semibold" [class]="c().link" (click)="close()">
            Manage sharing<sd-icon name="chevron-right" [size]="16" />
          </a>
        } @else {
          @if (request().message) {
            <p class="rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note">Their note: “{{ request().message }}”</p>
          }

          <!-- What the server suggests (or the patient's own choice) -->
          <dl class="flex flex-col gap-3 rounded-card border p-4 font-sans text-body-sm" [class]="c().box">
            <div class="flex flex-col gap-0.5">
              <dt [class]="c().muted">They'll see</dt>
              <dd class="font-semibold" [class]="c().text">{{ seesText() }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt [class]="c().muted">Until</dt>
              <dd class="font-semibold" [class]="c().text">{{ untilText() }}</dd>
            </div>
          </dl>

          @if (scope() === 'all' && hiddenCount() > 0) {
            <div class="flex flex-col gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note">
              <p class="flex items-start gap-2"><sd-icon name="eye-off" [size]="18" class="mt-0.5 shrink-0" />{{ hiddenText() }}</p>
              <label class="ml-6 flex min-h-11 cursor-pointer items-center gap-2 font-semibold" [class]="c().text">
                <input type="checkbox" class="size-5 shrink-0 accent-cerulean" [checked]="showHidden()" (change)="showHidden.set($any($event.target).checked)" />
                Show them too
              </label>
            </div>
          }

          <!-- Change what or how long -->
          <div class="flex flex-col gap-3">
            <button type="button" class="inline-flex min-h-11 w-fit items-center gap-1.5 font-sans text-body-sm font-semibold" [class]="c().link" aria-controls="approve-change" [attr.aria-expanded]="changing()" (click)="toggleChange()">
              <sd-icon name="pen-line" [size]="16" />Change what or how long
              <sd-icon name="chevron-down" [size]="16" [class.rotate-180]="changing()" />
            </button>
            @if (changing()) {
              <div id="approve-change" class="flex flex-col gap-4">
                <fieldset class="flex flex-col gap-2">
                  <legend class="mb-2 font-sans text-body-sm font-semibold" [class]="c().text">What can they see?</legend>
                  <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 p-3 transition-colors" [class]="scope() === 'all' ? c().on : c().off">
                    <input type="radio" name="approve-scope" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="scope() === 'all'" (change)="scope.set('all')" />
                    <span class="flex flex-col gap-0.5">
                      <span class="font-sans text-body-sm font-semibold" [class]="c().text">All my documents</span>
                      <span class="font-sans text-caption" [class]="c().muted">Everything in your folder, including files you add while access lasts.</span>
                    </span>
                  </label>
                  <label class="flex min-h-11 items-start gap-3 rounded-card border-2 p-3 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60" [class]="(scope() === 'selected' ? c().on : c().off) + (noDocuments() ? '' : ' cursor-pointer')">
                    <input type="radio" name="approve-scope" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="scope() === 'selected'" [disabled]="noDocuments()" (change)="pickSelected()" />
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
                  @if (whatProblem()) {
                    <p class="font-sans text-caption" [class]="c().muted">{{ whatProblem() }}</p>
                  }
                </fieldset>

                <fieldset class="flex flex-col gap-2">
                  <legend class="mb-2 font-sans text-body-sm font-semibold" [class]="c().text">For how long?</legend>
                  @for (choice of choices(); track choice.value) {
                    <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 px-3 py-2.5 transition-colors" [class]="duration() === choice.value ? c().on : c().off">
                      <input type="radio" name="approve-duration" class="mt-1 size-5 shrink-0 accent-cerulean" [checked]="duration() === choice.value" (change)="duration.set(choice.value)" />
                      <span class="flex flex-col gap-0.5">
                        <span class="font-sans text-body-sm font-semibold" [class]="c().text">{{ choice.label }}</span>
                        @if (choice.hint) { <span class="font-sans text-caption" [class]="c().muted">{{ choice.hint }}</span> }
                      </span>
                    </label>
                  }
                  @if (duration() === 'until') {
                    <label class="flex flex-col gap-1.5">
                      <span class="font-sans text-caption font-semibold" [class]="c().text">End date</span>
                      <input type="date" class="min-h-11 rounded-field border px-4 font-sans text-body-sm outline-none" [class]="c().field" [min]="bounds.min" [max]="bounds.max" [value]="untilDate()" (input)="untilDate.set($any($event.target).value)" />
                    </label>
                    @if (howProblem() && untilDate()) {
                      <p class="font-sans text-caption" [class]="c().errText" role="alert">{{ howProblem() }}</p>
                    }
                  }
                </fieldset>
              </div>
            }
          </div>

          @if (error()) {
            <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().error" role="alert">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ error() }}
            </p>
          }

          <div class="mt-auto flex flex-col-reverse gap-3 sm:flex-row">
            <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold transition-colors disabled:opacity-60" [class]="c().danger" [disabled]="busy()" (click)="askDecline()">Decline</button>
            <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-field py-3 font-sans text-body font-semibold transition-colors disabled:opacity-60" [class]="c().primary" [disabled]="busy() || !valid()" (click)="approve()">
              @if (busy() && !declining()) { <sd-icon name="loader-circle" [size]="18" class="animate-spin" /> }
              {{ busy() && !declining() ? 'Sharing…' : 'Approve and share' }}
            </button>
          </div>
        }
      </div>
    </sd-dialog>

    <!-- Decline (small, on top) -->
    @if (declineOpen()) {
      <sd-dialog [open]="declineShown()" layout="plain" size="sm" labelledBy="decline-title" describedBy="decline-desc" [busy]="declining()" dialogRole="alertdialog" (closed)="cancelDecline()" (afterClose)="declineOpen.set(false)">
        <div class="flex flex-col gap-4 p-5 sm:p-6" [class]="c().body">
          <h2 id="decline-title" tabindex="-1" data-autofocus class="font-heading text-h5 outline-none" [class]="c().heading">Decline {{ possessiveDoctor() }} request?</h2>
          <p id="decline-desc" class="font-sans text-body-sm" [class]="c().muted">They won't see your documents.</p>
          <label class="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-cerulean" [checked]="block()" (change)="block.set($any($event.target).checked)" />
            <span class="flex flex-col gap-0.5">
              <span class="font-sans text-body-sm font-semibold" [class]="c().text">Don't let {{ doctor() }} ask again</span>
              <span class="font-sans text-caption" [class]="c().muted">If you leave this unticked, they can ask again after 3 days. You can change this in Manage sharing.</span>
            </span>
          </label>
          @if (declineError()) {
            <p class="font-sans text-caption" [class]="c().errText" role="alert">{{ declineError() }}</p>
          }
          <div class="flex flex-col-reverse gap-3 sm:flex-row">
            <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold" [class]="c().secondary" [disabled]="declining()" (click)="cancelDecline()">Go back</button>
            <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-field bg-(--sd-dialog-danger) py-3 font-sans text-body font-semibold text-white transition-colors hover:bg-(--sd-dialog-danger-hover) disabled:opacity-60" [disabled]="declining()" (click)="decline()">
              @if (declining()) { <sd-icon name="loader-circle" [size]="18" class="animate-spin" /> }
              Decline request
            </button>
          </div>
        </div>
      </sd-dialog>
    }
  `,
})
export class ApproveRequestDialog implements OnInit {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly documentsApi = inject(DocumentsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);
  private readonly headingEl = viewChild<ElementRef<HTMLElement>>('heading');

  readonly request = input.required<DocumentAccessRequestDto>();
  readonly theme = input<SharingTheme>('light');
  /** Open on the Decline question (the banner's Decline button); Go back shows the request. */
  readonly startWithDecline = input(false);

  readonly done = output<ApproveOutcome>();
  readonly closed = output<void>();

  protected readonly c = computed(() => SHARING_CLASSES[this.theme()]);
  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly bounds = untilDateBounds();

  protected readonly open = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly unavailable = signal(false);
  protected readonly live = signal('');
  /** Set for a request that is no longer pending (the info view). */
  protected readonly info = signal('');

  // ----- Choices (start from the server's suggestion) -----
  protected readonly scope = signal<DocumentShareScope | null>(null);
  protected readonly documentIds = signal<string[]>([]);
  protected readonly duration = signal<DocumentShareDuration>('7d');
  protected readonly untilDate = signal('');
  protected readonly showHidden = signal(false);
  protected readonly changing = signal(false);

  // ----- Data -----
  private readonly doctorRow = signal<SharingDoctorDto | null>(null);
  protected readonly docs = signal<MedicalDocumentDto[] | null>(null);
  protected readonly docsTotal = signal(0);
  protected readonly docsLoading = signal(false);
  protected readonly docsError = signal('');
  protected readonly noDocuments = computed(() => this.docs() !== null && this.docs()?.length === 0);

  // ----- Decline -----
  protected readonly declineOpen = signal(false);
  protected readonly declineShown = signal(false);
  protected readonly declining = signal(false);
  protected readonly declineError = signal('');
  protected readonly block = signal(false);

  protected readonly doctor = computed(() => drName(this.request().specialist.name));
  protected readonly possessiveDoctor = computed(() => possessive(this.doctor()));
  protected readonly titleText = computed(() => requestTitle(this.request()));
  protected readonly choices = computed(() => durationChoices(this.request().appointment));
  protected readonly hiddenCount = computed(() => this.doctorRow()?.access.hidden_count ?? 0);
  protected readonly hiddenText = computed(
    () => `${countNoun(this.hiddenCount(), 'document')} you hid from ${this.doctor()} stay hidden.`,
  );

  private readonly form = computed(() => ({
    doctorIds: [this.request().specialist.id],
    scope: this.scope(),
    documentIds: this.documentIds(),
    duration: this.duration(),
    untilDate: this.untilDate(),
    appointment: this.request().appointment,
  }));
  protected readonly whatProblem = computed(() => whatError(this.form()));
  protected readonly howProblem = computed(() => durationError(this.form(), this.bounds));
  protected readonly valid = computed(() => canSubmitShare(this.form(), this.bounds));

  protected readonly seesText = computed(() => {
    const scope = this.scope();
    if (scope === 'all') return 'All your documents, including new uploads';
    if (scope !== 'selected' || this.documentIds().length === 0) return 'Choose what they can see below';
    const suggested = this.request().suggestion.document_ids;
    const same =
      suggested.length === this.documentIds().length && suggested.every((id) => this.documentIds().includes(id));
    return same
      ? `The ${countNoun(suggested.length, 'file')} you attached for this consultation`
      : countNoun(this.documentIds().length, 'document');
  });
  protected readonly untilText = computed(() => {
    const text = durationText(this.duration(), this.request().appointment, Date.now(), undefined, this.untilDate());
    return text || 'Choose an end date below';
  });

  ngOnInit(): void {
    const r = this.request();
    if (r.status !== 'pending') {
      this.info.set(requestStatusCopy(r.status, r.specialist.name));
      return;
    }
    if (this.startWithDecline()) this.askDecline();
    const s = r.suggestion;
    const offered = durationChoices(r.appointment);
    this.scope.set(s.scope);
    this.documentIds.set(s.scope === 'selected' ? [...s.document_ids] : []);
    const suggested = offered.some((c) => c.value === s.duration) ? s.duration : defaultDuration(offered);
    this.duration.set(suggested);
    if (!s.scope) {
      // No sensible default: the patient picks — Selected documents, nothing chosen yet.
      this.scope.set('selected');
      this.changing.set(true);
      this.loadDocuments();
    }
    this.sharing
      .doctors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.doctorRow.set((res.data ?? []).find((d) => d.specialist.id === r.specialist.id) ?? null),
        error: (err: unknown) => {
          if (isSharingUnavailable(err)) this.unavailable.set(true);
        },
      });
  }

  protected toggleChange(): void {
    this.changing.update((v) => !v);
    if (this.changing() && this.docs() === null) this.loadDocuments();
  }

  protected pickSelected(): void {
    this.scope.set('selected');
    if (this.docs() === null) this.loadDocuments();
  }

  /** The picker's documents: the newest 200, as in the Share dialog. */
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
          // Nothing to pick: "Selected documents" is off, so nothing is chosen yet.
          if (list.length === 0 && this.scope() === 'selected') this.scope.set(null);
        },
        error: (err: unknown) => {
          this.docsLoading.set(false);
          this.docsError.set(apiErrorMessage(err, 'Could not load your documents.'));
        },
      });
  }

  protected close(): void {
    if (!this.busy()) this.open.set(false);
  }

  protected approve(): void {
    if (this.busy() || !this.valid()) return;
    const r = this.request();
    const scope = this.scope() ?? 'selected';
    const d = this.duration();
    const body: ApproveAccessRequestInput = { scope, duration: d };
    if (scope === 'selected') body.document_ids = [...this.documentIds()];
    if (d === 'until') body.expires_at = untilDateToExpiresAt(this.untilDate());
    if (isAfterDuration(d)) body.appointment_id = r.appointment?.id ?? r.suggestion.appointment_id;
    if (scope === 'all' && this.showHidden()) body.show_hidden = true;
    this.busy.set(true);
    this.error.set('');
    this.live.set('Sharing…');
    this.sharing
      .approveRequest(r.id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.live.set('Approved.');
          this.done.emit({ kind: 'approved', request: res.data.request, grant: res.data.grant });
          this.open.set(false);
        },
        error: (err: unknown) => this.failed(err, 'Could not approve the request. Please try again.', 'approve'),
      });
  }

  protected askDecline(): void {
    this.block.set(false);
    this.declineError.set('');
    this.declineOpen.set(true);
    this.declineShown.set(true);
  }

  protected cancelDecline(): void {
    if (!this.declining()) this.declineShown.set(false);
  }

  protected decline(): void {
    if (this.declining()) return;
    this.declining.set(true);
    this.busy.set(true);
    this.declineError.set('');
    this.sharing
      .declineRequest(this.request().id, { block_future_requests: this.block() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.declining.set(false);
          this.busy.set(false);
          this.live.set('Request declined.');
          this.declineShown.set(false);
          this.done.emit({ kind: 'declined', request: res.data });
          this.open.set(false);
        },
        error: (err: unknown) => {
          this.declining.set(false);
          this.busy.set(false);
          if (apiErrorCode(err) === 'request_not_pending' || isSharingUnavailable(err)) {
            this.declineShown.set(false);
            this.failed(err, '', 'decline');
            return;
          }
          this.declineError.set(apiErrorMessage(err, 'Could not decline the request. Please try again.'));
        },
      });
  }

  private failed(err: unknown, fallback: string, action: 'approve' | 'decline'): void {
    this.busy.set(false);
    const code = apiErrorCode(err);
    if (code === 'sharing_unavailable') {
      this.unavailable.set(true);
      this.live.set(SHARING_UNAVAILABLE);
      return;
    }
    if (code === 'request_not_pending') {
      const status = (apiErrorFields(err)['status'] ?? 'expired') as DocumentAccessRequestStatus;
      if (status === 'approved' && action === 'approve') {
        // The server already has this approval (e.g. a retry after the answer
        // was lost): that is the success the patient asked for (§2.4).
        this.live.set('Approved.');
        this.done.emit({ kind: 'approved', request: { ...this.request(), status: 'approved' }, grant: null });
        this.open.set(false);
        return;
      }
      this.info.set(requestStatusCopy(status, this.request().specialist.name) || requestStatusCopy('expired', ''));
      this.live.set(this.info());
      // An approval found while declining still changed what the doctor sees: the host refreshes for it.
      this.done.emit(
        status === 'approved'
          ? { kind: 'approved', request: { ...this.request(), status: 'approved' }, grant: null }
          : { kind: 'stale', status },
      );
      this.focusHeading();
      return;
    }
    if (code === 'doctor_unavailable' || code === 'doctor_not_eligible') {
      this.info.set(
        `${this.doctor()} can't receive documents right now, so this request has closed. Nothing was shared.`,
      );
      this.live.set(this.info());
      this.done.emit({ kind: 'stale', status: 'cancelled' });
      this.focusHeading();
      return;
    }
    this.error.set(apiErrorMessage(err, fallback || 'Something went wrong. Please try again.'));
    this.live.set(this.error());
  }

  protected day(iso: string): string {
    return consultationDay(iso);
  }

  private focusHeading(): void {
    afterNextRender(
      () => {
        const active = this.doc.activeElement;
        if (!active || active === this.doc.body) this.headingEl()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
}
