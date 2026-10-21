import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorCode, apiErrorMessage, DocumentSharingApi } from '@supadoc/data-access';
import type {
  DocumentGrantDto,
  DocumentShareDuration,
  SharingAppointmentRefDto,
  SharingDoctorDto,
  UpdateDocumentGrantInput,
} from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import {
  defaultDuration,
  drName,
  durationChoices,
  durationError,
  endLabel,
  endsBeforeCopy,
  endsBeforeNext,
  grantIndefinite,
  isAfterDuration,
  laterEnd,
  SHARING_CLASSES,
  SHARING_UNAVAILABLE,
  shareEnd,
  type SharingTheme,
  untilDateBounds,
  untilDateToExpiresAt,
  untilPhrase,
  ymdOf,
} from './document-sharing';

/**
 * "Change how long Dr X can see …": one share's end, longer or shorter
 * (PATCH). The current end is shown, the new one is spelled out, and a
 * shorter end says so. A share that ended meanwhile hands back to the host
 * (`shareAgain`) to offer the same choices as a new share.
 */
@Component({
  selector: 'pat-extend-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="md"
      labelledBy="extend-title"
      describedBy="extend-now"
      [busy]="busy()"
      (closed)="close()"
      (afterClose)="closed.emit()"
    >
      <div class="flex min-h-full flex-col gap-5 p-5 sm:p-6" [class]="c().body" [attr.aria-busy]="busy() || null">
        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ live() }}</p>
        <div class="flex items-start justify-between gap-3 border-b pb-4" [class]="c().divider">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 id="extend-title" tabindex="-1" data-autofocus class="font-heading text-h5 outline-none" [class]="c().heading">{{ title() }}</h2>
            <p id="extend-now" class="font-sans text-body-sm" [class]="c().muted">{{ nowLine() }}</p>
          </div>
          <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors" [class]="c().iconBtn" aria-label="Close" [disabled]="busy()" (click)="close()">
            <sd-icon name="x" [size]="22" />
          </button>
        </div>

        @if (unavailable()) {
          <p class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().note" role="status">
            <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
          </p>
        } @else {
          <fieldset class="flex flex-col gap-2">
            <legend class="mb-2 font-sans text-body font-semibold" [class]="c().text">For how long?</legend>
            @for (choice of choices(); track choice.value) {
              <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border-2 px-4 py-3 transition-colors" [class]="duration() === choice.value ? c().on : c().off">
                <input type="radio" name="extend-duration" class="mt-1 size-5 shrink-0 accent-cerulean" [value]="choice.value" [checked]="duration() === choice.value" (change)="duration.set(choice.value)" />
                <span class="flex flex-col gap-0.5">
                  <span class="font-sans text-body-sm font-semibold" [class]="c().text">{{ choice.label }}</span>
                  @if (choice.hint) { <span class="font-sans text-caption" [class]="c().muted">{{ choice.hint }}</span> }
                </span>
              </label>
            }
          </fieldset>
          @if (duration() === 'until') {
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold" [class]="c().text">End date</span>
              <input type="date" class="min-h-11 rounded-field border px-4 font-sans text-body-sm outline-none" [class]="c().field" [min]="bounds.min" [max]="bounds.max" [value]="untilDate()" (input)="untilDate.set($any($event.target).value)" />
            </label>
          }
          @if (problem() && touched()) {
            <p class="font-sans text-caption" [class]="c().errText" role="alert">{{ problem() }}</p>
          }

          <p class="font-sans text-body-sm font-semibold" [class]="c().text" aria-live="polite">New end: {{ newLabel() }}</p>
          @if (shorter()) {
            <p class="flex items-start gap-2 font-sans text-caption" [class]="c().muted">
              <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0" />They'll lose access sooner.
            </p>
          }
          @if (endsBefore(); as w) {
            <div class="flex flex-col gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().warn">
              <p class="flex items-start gap-2"><sd-icon name="calendar-clock" [size]="18" class="mt-0.5 shrink-0" />{{ w.text }}</p>
              @if (w.next) {
                <button type="button" class="ml-6 min-h-11 w-fit rounded-pill border border-current/30 px-3 font-sans text-caption font-semibold" (click)="anchorTo(w.next)">
                  Until 24 hours after that consultation
                </button>
              }
            </div>
          }
        }

        @if (error()) {
          <div class="flex flex-col gap-2 rounded-field px-4 py-3 font-sans text-body-sm" [class]="c().error" role="alert">
            <p class="flex items-start gap-2"><sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ error() }}</p>
            @if (ended()) {
              <button type="button" class="ml-6 min-h-11 w-fit rounded-field px-4 font-sans text-body-sm font-semibold" [class]="c().primary" (click)="again()">Share again</button>
            }
          </div>
        }

        <div class="mt-auto flex gap-3">
          <button type="button" class="min-h-11 flex-1 rounded-field py-3 font-sans text-body font-semibold transition-colors" [class]="c().secondary" [disabled]="busy()" (click)="close()">Cancel</button>
          @if (!unavailable()) {
            <button type="button" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-field py-3 font-sans text-body font-semibold transition-colors disabled:opacity-60" [class]="c().primary" [disabled]="busy() || ended()" (click)="save()">
              @if (busy()) { <sd-icon name="loader-circle" [size]="18" class="animate-spin" /> }
              {{ busy() ? 'Saving…' : 'Save' }}
            </button>
          }
        </div>
      </div>
    </sd-dialog>
  `,
})
export class ExtendShareDialog implements OnInit {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly grant = input.required<DocumentGrantDto>();
  /** The doctor's sharing summary (for their next consultation), when known. */
  readonly doctor = input<SharingDoctorDto | null>(null);
  readonly theme = input<SharingTheme>('light');

  readonly done = output<DocumentGrantDto>();
  /** The share ended meanwhile: the host offers it again as a new share. */
  readonly shareAgain = output<DocumentGrantDto>();
  readonly closed = output<void>();

  protected readonly c = computed(() => SHARING_CLASSES[this.theme()]);
  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly bounds = untilDateBounds();

  protected readonly open = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly ended = signal(false);
  protected readonly unavailable = signal(false);
  protected readonly touched = signal(false);
  protected readonly live = signal('');

  protected readonly duration = signal<DocumentShareDuration>('7d');
  protected readonly untilDate = signal('');
  private readonly anchor = signal<SharingAppointmentRefDto | null>(null);

  protected readonly title = computed(() => {
    const g = this.grant();
    const what = g.scope === 'all' ? 'your whole folder' : 'these documents';
    return `Change how long ${drName(g.specialist.name)} can see ${what}`;
  });
  protected readonly nowLine = computed(() => {
    const g = this.grant();
    const tail = untilPhrase(g.until_label_at, grantIndefinite(g));
    return grantIndefinite(g) ? 'Now: no end date' : `Now: ${tail || 'no end date'}`;
  });
  protected readonly choices = computed(() => durationChoices(this.anchor()));
  private readonly end = computed(() =>
    shareEnd(this.duration(), { appointment: this.anchor(), untilDate: this.untilDate() }),
  );
  protected readonly newLabel = computed(() => {
    const end = this.end();
    return end === undefined ? '—' : endLabel(this.duration(), end);
  });
  protected readonly problem = computed(() =>
    durationError({ duration: this.duration(), untilDate: this.untilDate(), appointment: this.anchor() }, this.bounds),
  );
  /** The new end comes before the current one. */
  protected readonly shorter = computed(() => {
    const end = this.end();
    const g = this.grant();
    return end !== undefined && laterEnd(grantIndefinite(g) ? null : g.expires_at, end) === 'a';
  });
  protected readonly endsBefore = computed(() => {
    const next = this.doctor()?.next_appointment ?? null;
    if (!next || !endsBeforeNext(this.end(), next)) return null;
    return {
      text: endsBeforeCopy(next, drName(this.grant().specialist.name)),
      next: next.after_options.after_24h ? next : null,
    };
  });

  ngOnInit(): void {
    const g = this.grant();
    this.anchor.set(g.appointment);
    const offered = durationChoices(g.appointment);
    this.duration.set(offered.some((c) => c.value === g.duration) ? g.duration : defaultDuration(offered));
    if (g.duration === 'until') this.untilDate.set(ymdOf(g.until_label_at));
  }

  protected anchorTo(next: SharingAppointmentRefDto): void {
    this.anchor.set(next);
    this.duration.set('after_24h');
  }

  protected close(): void {
    if (!this.busy()) this.open.set(false);
  }

  protected save(): void {
    if (this.busy()) return;
    this.touched.set(true);
    if (this.problem()) return;
    const d = this.duration();
    const body: UpdateDocumentGrantInput = { duration: d };
    if (d === 'until') body.expires_at = untilDateToExpiresAt(this.untilDate());
    if (isAfterDuration(d)) body.appointment_id = this.anchor()?.id ?? null;
    this.busy.set(true);
    this.error.set('');
    this.live.set('Saving…');
    this.sharing
      .updateGrant(this.grant().id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.live.set('Changes saved.');
          this.done.emit(res.data);
          this.open.set(false);
        },
        error: (err: unknown) => {
          this.busy.set(false);
          const code = apiErrorCode(err);
          if (code === 'sharing_unavailable') {
            this.unavailable.set(true);
            this.live.set(SHARING_UNAVAILABLE);
          } else if (code === 'grant_ended') {
            this.ended.set(true);
            this.error.set('This access already ended. Share again to give access.');
          } else {
            this.error.set(apiErrorMessage(err, 'Could not save the new end. Please try again.'));
          }
          this.live.set(this.error() || this.live());
        },
      });
  }

  protected again(): void {
    this.shareAgain.emit(this.grant());
    this.open.set(false);
  }
}
