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
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, debounceTime, map, type Observable, of, Subject, switchMap, tap } from 'rxjs';
import { apiErrorFields, apiErrorMessage, DoctorApi, localSlotDays, SpecialistsApi, todayLocal } from '@supadoc/data-access';
import type {
  ApiAppointmentStatus,
  DayAvailability,
  DoctorFollowUpDto,
  FollowUpQuoteDto,
} from '@supadoc/models';
import { AlertComponent, ButtonComponent, IconComponent, SlotPickerComponent } from '@supadoc/ui';
import { isoToLocalInput } from '../prescriptions/rx-shared';
import {
  CLINICAL_CARD,
  CLINICAL_COUNT,
  CLINICAL_H3,
  CLINICAL_HINT,
  CLINICAL_INPUT,
  CLINICAL_LABEL,
  CLINICAL_LINK_BUTTON,
  CLINICAL_LIST_ITEM,
  CLINICAL_META,
  CLINICAL_TEXTAREA,
  ClinicalBadge,
  ClinicalEmpty,
  ClinicalHeader,
} from './clinical/clinical-ui';
import {
  dateLabel,
  dayLabel,
  followUpPriceLabel,
  followUpState,
  IN_CALL_LEAD_MINUTES,
  isOpenProposal,
  moneyLabel,
  PROPOSAL_MIN_LEAD_MINUTES,
  proposalExpiry,
  priceRuleText,
  whenLabel,
  withdrewProposal,
  type FollowUpState,
} from './follow-ups';

/** The doctor's note to the patient (`FollowUpService::MAX_NOTE_LENGTH`). */
const MAX_NOTE = 1000;
/** The slot pills cover what the public slots endpoint returns at most. */
const SLOT_DAYS = 14;
const MINUTE = 60_000;

let nextUid = 0;

/** The slots a proposal can use: local days, only times at least 2½ hours ahead. */
function proposableDays(days: readonly DayAvailability[]): DayAvailability[] {
  const earliest = Date.now() + PROPOSAL_MIN_LEAD_MINUTES * MINUTE;
  return localSlotDays(days)
    .map((d) => ({ ...d, slots: d.slots.filter((s) => new Date(s.iso).getTime() >= earliest) }))
    .filter((d) => d.slots.length > 0);
}

/** A local `YYYY-MM-DD` after the days the slot pills cover. */
function beyondSlotWindow(ymd: string): boolean {
  return ymd > todayLocal(SLOT_DAYS - 1);
}

/** The typed time's earliest value: 2½ hours from now, on the half hour (local datetime-local). */
function earliestManualInput(): string {
  const d = new Date(Date.now() + PROPOSAL_MIN_LEAD_MINUTES * MINUTE);
  d.setSeconds(0, 0);
  const over = d.getMinutes() % 30;
  if (over !== 0) d.setMinutes(d.getMinutes() + 30 - over);
  return isoToLocalInput(d.toISOString());
}

const byStart = (a: DoctorFollowUpDto, b: DoctorFollowUpDto): number =>
  new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();

/**
 * Follow-ups of one consultation: "Schedule follow-up" (one of the doctor's
 * own open slots, an optional note shown to the patient in the app only, an
 * optional fee waiver and a live price from the quote endpoint) plus every
 * follow-up of it so far, with Withdraw for an unanswered proposal. Used by
 * the appointment record (Clinical tools → Follow-ups) and the call cockpit's
 * Follow-ups tab, which keeps it mounted while hidden (`active` false) and
 * refreshes it on return. Owns its own loading and API calls.
 *
 * Usage: `<doc-follow-up-planner [appointmentId]="id" [specialistId]="a.specialist.id"
 *   [parentStatus]="a.status" [parentScheduledAt]="a.scheduled_at" />`
 */
@Component({
  selector: 'doc-follow-up-planner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    ButtonComponent,
    IconComponent,
    SlotPickerComponent,
    ClinicalBadge,
    ClinicalEmpty,
    ClinicalHeader,
  ],
  host: { class: 'flex flex-col gap-6 @container' },
  template: `
    <doc-clinical-header
      icon="calendar-plus"
      heading="Follow-ups"
      helper="Offer the patient a video follow-up at one of your open slots. They accept it (paying any fee) or decline."
    />

    <section class="${CLINICAL_CARD}" [attr.aria-labelledby]="uid + '-title'">
      <h3 class="${CLINICAL_H3}" [id]="uid + '-title'"><sd-icon name="calendar-plus" [size]="18" class="text-cerulean" />Schedule follow-up</h3>

      @if (blockedReason(); as why) {
        <p class="font-sans text-body-sm text-slate">{{ why }}</p>
      } @else if (listState() === 'loading') {
        <div class="sd-shimmer h-28 rounded-field" aria-hidden="true"></div>
        <span class="sr-only" role="status">Loading follow-ups…</span>
      } @else if (openProposal(); as p) {
        <sd-alert tone="info">
          A follow-up on <strong>{{ when(p.scheduled_at) }}</strong> is waiting for the patient's reply
          (until {{ when(p.expires_at) }}). Withdraw it below to propose another time.
        </sd-alert>
      } @else {
        <!-- When: the doctor's own open slots (local time), or a typed time on their availability. -->
        <fieldset class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" [attr.aria-describedby]="fieldError('scheduled_at') ? uid + '-when-error' : null">
          <legend class="mb-1 ${CLINICAL_LABEL}">Date &amp; time <span class="text-alert">*</span></legend>
          @if (slotsState() === 'loading' && days().length === 0) {
            <div class="sd-shimmer h-24 rounded-field" aria-hidden="true"></div>
            <span class="sr-only" role="status">Loading your open slots…</span>
          } @else if (!useManual()) {
            <sd-slot-picker [days]="days()" [value]="slot()" (valueChange)="pickSlot($event)" />
          } @else {
            @if (slotsError()) {
              <p class="flex items-start gap-1.5 font-sans text-caption text-alert"><sd-icon name="triangle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ slotsError() }}</p>
            } @else if (days().length === 0) {
              <p class="${CLINICAL_HINT}">You have no open slots in the next two weeks.</p>
            }
            <label class="flex flex-col gap-1.5" [for]="uid + '-manual'">
              <span class="font-sans text-caption font-semibold text-slate">Date &amp; time</span>
              <input
                type="datetime-local"
                step="1800"
                class="${CLINICAL_INPUT}"
                [id]="uid + '-manual'"
                [min]="manualMin()"
                [value]="manualAt()"
                [attr.aria-invalid]="fieldError('scheduled_at') ? 'true' : null"
                (input)="typeTime($any($event.target).value)"
              />
              <span class="${CLINICAL_HINT}">Must be on your availability, at least 2½ hours from now.</span>
            </label>
          }
          @if (suggestionHint()) {
            <p class="flex items-start gap-1.5 font-sans text-caption text-slate"><sd-icon name="pill" [size]="14" class="mt-0.5 shrink-0 text-cerulean" />{{ suggestionHint() }}</p>
          }
          @if (slotsState() !== 'loading' && days().length > 0) {
            <button type="button" class="min-h-11 w-fit font-sans text-caption font-semibold text-cerulean transition-colors hover:text-ocean focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40" (click)="toggleManual()">
              {{ manual() ? 'Choose from your open slots' : 'Enter another time' }}
            </button>
          }
          @if (fieldError('scheduled_at'); as m) {
            <p class="font-sans text-caption text-alert" role="alert" [id]="uid + '-when-error'">{{ m }}</p>
          }
        </fieldset>

        <!-- Price: live from the quote endpoint for the chosen time and waiver. -->
        <div class="flex flex-col gap-3 rounded-field bg-glacier p-4 @md:flex-row @md:items-center @md:justify-between">
          <div class="flex min-w-0 flex-col gap-0.5" aria-live="polite">
            <span class="font-sans text-caption text-slate">{{ chosenIso() ? 'Patient pays for ' + when(chosenIso()) : 'Patient pays' }}</span>
            @if (quote(); as q) {
              <span class="font-heading text-h5 text-ink" [class.opacity-60]="quoteLoading()">{{ money(q.amount, q.currency) }}</span>
              <span class="font-sans text-caption text-slate">{{ ruleText(q) }}{{ q.free && !q.waived ? ' — nothing to pay' : '' }}</span>
              @if (!chosenIso() && !waive() && q.within_window && (q.rule === 'percent' || q.rule === 'free')) {
                <span class="font-sans text-caption text-slate">For a follow-up starting by {{ date(q.window_ends_at) }}; {{ money(q.base_fee, q.currency) }} after that.</span>
              }
            } @else if (quoteLoading()) {
              <span class="font-sans text-body-sm text-slate">Working out the price…</span>
            } @else if (quoteError()) {
              <span class="font-sans text-caption text-alert">{{ quoteError() }}</span>
            }
          </div>
          <!-- A labelled native switch (sd-toggle's button can't take a label), drawn like sd-toggle. -->
          <label class="relative flex min-h-11 shrink-0 cursor-pointer items-center gap-3">
            <span class="flex flex-col">
              <span class="font-sans text-body-sm font-semibold text-ink">Waive the fee</span>
              <span class="font-sans text-caption text-slate">Free for the patient</span>
            </span>
            <input type="checkbox" role="switch" class="peer sr-only" [checked]="waive()" (change)="waive.set($any($event.target).checked)" />
            <span
              aria-hidden="true"
              class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-cerulean/40 peer-focus-visible:ring-offset-2"
              [class]="waive() ? 'bg-cerulean' : 'bg-ash/60'"
            >
              <span class="inline-block size-5 rounded-full bg-white shadow transition-transform" [class]="waive() ? 'translate-x-[22px]' : 'translate-x-0.5'"></span>
            </span>
          </label>
        </div>

        <div class="flex flex-col gap-2">
          <label class="${CLINICAL_LABEL}" [for]="uid + '-note'">
            Note to the patient <span class="font-normal text-slate">(optional)</span>
          </label>
          <textarea
            rows="3"
            class="${CLINICAL_TEXTAREA}"
            [id]="uid + '-note'"
            [attr.maxlength]="maxNote"
            placeholder="e.g. We'll go over your new readings and how you're getting on."
            [value]="note()"
            [attr.aria-invalid]="fieldError('note') ? 'true' : null"
            [attr.aria-describedby]="uid + '-note-hint'"
            (input)="typeNote($any($event.target).value)"
          ></textarea>
          <p class="flex flex-wrap justify-between gap-x-3 ${CLINICAL_HINT}" [id]="uid + '-note-hint'">
            <span>Shown in the patient's VideoMed app only — never in emails or notifications.</span>
            <span>{{ note().length }}/{{ maxNote }}</span>
          </p>
          @if (fieldError('note'); as m) {
            <p class="font-sans text-caption text-alert" role="alert">{{ m }}</p>
          }
        </div>

        @if (error()) {
          <sd-alert tone="error">{{ error() }}</sd-alert>
        }

        <div class="flex flex-col gap-3 border-t border-cloud pt-5 @md:flex-row @md:items-center @md:justify-between">
          <p class="${CLINICAL_HINT}">{{ expiryHint() }}</p>
          <sd-button [full]="true" class="w-full shrink-0 @md:w-auto" [disabled]="busy()" (click)="propose()">
            @if (busy()) {
              <sd-icon name="loader-circle" [size]="18" class="motion-safe:animate-spin" />Proposing…
            } @else {
              <sd-icon name="send" [size]="18" />Propose follow-up
            }
          </sd-button>
        </div>
      }
    </section>

    <section class="flex flex-col gap-3" [attr.aria-labelledby]="uid + '-list'">
      <h3 class="${CLINICAL_H3}" [id]="uid + '-list'">
        This consultation's follow-ups
        @if (followUps().length > 0) {
          <span class="${CLINICAL_COUNT}">{{ followUps().length }}</span>
        }
      </h3>

      <!-- Proposed / withdrawn / already closed: announced, and focused when the control that did it goes away. -->
      <div aria-live="polite">
        @if (notice(); as n) {
          <p
            #noticeEl
            tabindex="-1"
            class="flex items-start gap-2 rounded-field px-4 py-3 font-sans text-body-sm font-semibold outline-none"
            [class]="n.tone === 'success' ? 'bg-sage/10 text-sage' : 'bg-frost/50 text-cerulean'"
          >
            <sd-icon [name]="n.tone === 'success' ? 'circle-check' : 'info'" [size]="18" class="mt-0.5 shrink-0" />{{ n.text }}
          </p>
        }
      </div>
      @if (withdrawError()) {
        <!-- Focused when the confirm step it came from goes away. -->
        <div #withdrawErrorEl tabindex="-1" class="outline-none">
          <sd-alert tone="error">{{ withdrawError() }}</sd-alert>
        </div>
      }

      @if (listState() === 'loading') {
        <div class="sd-shimmer h-20 rounded-card" aria-hidden="true"></div>
      } @else if (listState() === 'error') {
        <div class="flex flex-col items-start gap-2">
          <sd-alert tone="error">{{ listError() }}</sd-alert>
          <button type="button" class="${CLINICAL_LINK_BUTTON} min-h-11" (click)="retryList()">
            <sd-icon name="refresh-cw" [size]="16" />Try again
          </button>
        </div>
      } @else if (followUps().length === 0) {
        <doc-clinical-empty icon="calendar-plus" message="No follow-ups yet for this consultation." />
      } @else {
        <ul class="flex flex-col gap-3">
          @for (f of followUps(); track f.id) {
            @let s = state(f);
            <li class="flex flex-col gap-3 ${CLINICAL_LIST_ITEM}">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="flex min-w-0 flex-col gap-1">
                  <span class="font-heading text-body font-semibold text-ink">{{ when(f.scheduled_at) }}</span>
                  <p class="${CLINICAL_META}">
                    <span class="inline-flex items-center gap-1"><sd-icon name="banknote" [size]="13" />{{ priceLabel(f) }}</span>
                    @if (s.open) {
                      <span class="inline-flex items-center gap-1"><sd-icon name="hourglass" [size]="13" />Patient can reply until {{ when(f.expires_at) }}</span>
                    }
                    @if (f.proposed_by === 'patient') {
                      <span class="inline-flex items-center gap-1"><sd-icon name="user" [size]="13" />Booked by the patient</span>
                    }
                  </p>
                </div>
                <doc-clinical-badge [tone]="s.tone" [icon]="s.icon" [label]="s.label" />
              </div>
              @if (f.follow_up_note) {
                <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink"><span class="font-semibold text-slate">Your note:</span> {{ f.follow_up_note }}</p>
              }
              @if (f.decline_reason) {
                <p class="whitespace-pre-wrap break-words font-sans text-body-sm text-ink"><span class="font-semibold text-slate">Patient's reason:</span> {{ f.decline_reason }}</p>
              }
              <div class="flex flex-wrap gap-2">
                <a
                  [routerLink]="['/appointments', f.id]"
                  [target]="newTab() ? '_blank' : '_self'"
                  [attr.rel]="newTab() ? 'noopener' : null"
                  class="${CLINICAL_LINK_BUTTON} min-h-11"
                >
                  Open record
                  @if (newTab()) { <sd-icon name="external-link" [size]="14" /><span class="sr-only">(opens in a new tab)</span> }
                  @else { <sd-icon name="chevron-right" [size]="14" /> }
                </a>
                @if (s.open && confirmId() !== f.id) {
                  <button
                    type="button"
                    [id]="uid + '-withdraw-' + f.id"
                    class="inline-flex min-h-11 items-center justify-center gap-2 rounded-field border border-alert/50 px-3 py-2 font-sans text-[14px] font-semibold text-alert transition-colors hover:bg-alert/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-alert/40"
                    (click)="askWithdraw(f)"
                  >
                    <sd-icon name="undo-2" [size]="16" />Withdraw
                  </button>
                }
              </div>
              @if (confirmId() === f.id) {
                <div
                  class="flex flex-col gap-3 rounded-field border border-cloud bg-glacier p-3"
                  role="group"
                  [attr.aria-labelledby]="uid + '-wd-title'"
                  [attr.aria-describedby]="uid + '-wd-desc'"
                  (keydown.escape)="keepProposal(f)"
                >
                  <p #withdrawTitle tabindex="-1" class="font-sans text-body-sm font-semibold text-ink outline-none" [id]="uid + '-wd-title'">Withdraw this proposal?</p>
                  <p class="${CLINICAL_HINT}" [id]="uid + '-wd-desc'">The patient is told it was withdrawn, and {{ when(f.scheduled_at) }} opens again on your schedule.</p>
                  <div class="flex flex-wrap gap-2">
                    <button
                      type="button"
                      class="min-h-11 flex-1 rounded-field bg-alert px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-alert/90 disabled:opacity-60"
                      [disabled]="withdrawingId() === f.id"
                      (click)="withdraw(f)"
                    >{{ withdrawingId() === f.id ? 'Withdrawing…' : 'Withdraw proposal' }}</button>
                    <button
                      type="button"
                      class="min-h-11 flex-1 rounded-field border border-cloud bg-white px-4 py-2 font-sans text-caption font-semibold text-slate transition-colors hover:border-cerulean hover:text-cerulean disabled:opacity-60"
                      [disabled]="withdrawingId() === f.id"
                      (click)="keepProposal(f)"
                    >Keep it</button>
                  </div>
                </div>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class FollowUpPlanner {
  private readonly api = inject(DoctorApi);
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The consultation the follow-ups follow on from. */
  readonly appointmentId = input.required<string>();
  /** The doctor's specialist id (their open slots); looked up from their profile when empty. */
  readonly specialistId = input('');
  /** The consultation's status and start, when known ('' = unknown: the API decides). */
  readonly parentStatus = input<ApiAppointmentStatus | ''>('');
  readonly parentScheduledAt = input('');
  /** On screen. The call keeps this mounted while hidden, and it refreshes each time it shows again. */
  readonly active = input(true);
  /** Open follow-up records in a new tab (the call cockpit must never navigate away). */
  readonly newTab = input(false);

  protected readonly uid = `follow-up-${++nextUid}`;
  protected readonly maxNote = MAX_NOTE;
  /** Ticks so open / expired proposals re-evaluate without a reload. */
  private readonly now = signal(Date.now());

  // ----- Slots -----
  private readonly profileSpecialistId = signal('');
  protected readonly days = signal<DayAvailability[]>([]);
  protected readonly slotsState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  protected readonly slotsError = signal('');
  /** The picked slot's ISO start. */
  protected readonly slot = signal('');
  /** Typing a time instead (e.g. beyond the two weeks the pills cover). */
  protected readonly manual = signal(false);
  /** The typed time — a local datetime-local value. */
  protected readonly manualAt = signal('');
  protected readonly manualMin = signal('');
  /** The typed input shows when chosen, or when there are no slots to pick. */
  protected readonly useManual = computed(
    () => this.manual() || this.slotsState() === 'error' || (this.slotsState() === 'ready' && this.days().length === 0),
  );
  /** The chosen start as ISO ('' = none yet). */
  protected readonly chosenIso = computed(() => {
    if (!this.useManual()) return this.slot();
    const raw = this.manualAt().trim();
    const d = raw ? new Date(raw) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : '';
  });

  /**
   * The follow-up date on this consultation's prescription (local `YYYY-MM-DD`),
   * if one was set. It only suggests the day — the doctor always picks the time.
   */
  protected readonly suggestedDate = signal('');
  /** The suggestion was acted on for this date (only once — never over the doctor's choice). */
  private suggestionApplied = '';
  protected readonly suggestionHint = computed(() => {
    const date = this.suggestedDate();
    if (!date || this.slotsState() !== 'ready' || date < todayLocal()) return '';
    const asks = `This consultation's prescription asks for a follow-up on ${dayLabel(date)}`;
    if (beyondSlotWindow(date)) {
      return `${asks}, after the two weeks of open slots shown here — enter a time that day that is on your availability.`;
    }
    if (this.useManual()) return `${asks}.`;
    return this.days().some((d) => d.date === date)
      ? `${asks} — tap that day to see your times.`
      : `${asks}, but you have no open slot that day here — choose another day or enter a time.`;
  });

  // ----- Form -----
  protected readonly note = signal('');
  protected readonly waive = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly fieldErrors = signal<Record<string, string>>({});

  // ----- Price -----
  protected readonly quote = signal<FollowUpQuoteDto | null>(null);
  protected readonly quoteLoading = signal(false);
  protected readonly quoteError = signal('');
  private readonly quoteRequests = new Subject<{ at: string; waive: boolean }>();

  // ----- Follow-ups of this consultation -----
  protected readonly followUps = signal<DoctorFollowUpDto[]>([]);
  protected readonly listState = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly listError = signal('');
  private listLoading = false;
  protected readonly notice = signal<{ text: string; tone: 'success' | 'info' } | null>(null);
  protected readonly confirmId = signal<string | null>(null);
  protected readonly withdrawingId = signal<string | null>(null);
  protected readonly withdrawError = signal('');
  /** Proposals withdrawn here — the payload doesn't say how a closed proposal closed. */
  private readonly withdrawn = signal<ReadonlySet<string>>(new Set());
  private readonly noticeEl = viewChild<ElementRef<HTMLElement>>('noticeEl');
  private readonly withdrawTitle = viewChild<ElementRef<HTMLElement>>('withdrawTitle');
  private readonly withdrawErrorEl = viewChild<ElementRef<HTMLElement>>('withdrawErrorEl');

  /** Why this consultation can't have a follow-up proposed now ('' = it can, or the API decides). */
  protected readonly blockedReason = computed(() => {
    const status = this.parentStatus();
    if (status === '' || status === 'completed') return '';
    if (status === 'confirmed') {
      const start = new Date(this.parentScheduledAt()).getTime();
      return !isNaN(start) && start > this.now() + IN_CALL_LEAD_MINUTES * MINUTE
        ? `This consultation starts ${whenLabel(this.parentScheduledAt())}. You can propose a follow-up from two hours before then, or once it's over.`
        : '';
    }
    return 'A follow-up can be proposed from a consultation that is in progress or completed.';
  });
  /** The unanswered proposal for this consultation (only one may be open at a time). */
  protected readonly openProposal = computed(
    () => this.followUps().find((f) => isOpenProposal(f, this.now())) ?? null,
  );
  private readonly formVisible = computed(
    () => !this.blockedReason() && this.listState() !== 'loading' && this.openProposal() === null,
  );
  protected readonly expiryHint = computed(() => {
    const iso = this.chosenIso();
    const start = iso ? new Date(iso).getTime() : NaN;
    if (isNaN(start)) return 'Pick a time. The patient is notified and has up to 72 hours to accept.';
    return `The patient is notified in the app and by email, and has until ${whenLabel(new Date(proposalExpiry(start, this.now())).toISOString())} to accept.`;
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(tick));

    // The price for the chosen time + waiver; a newer request cancels an older one.
    this.quoteRequests
      .pipe(
        debounceTime(200),
        switchMap(({ at, waive }) => {
          this.quoteLoading.set(true);
          return this.api.followUpQuote(this.appointmentId(), { scheduledAt: at || undefined, waive }).pipe(
            map((r) => ({ quote: r.data, error: '' })),
            catchError((err: unknown) => of({ quote: null, error: apiErrorMessage(err, 'Could not work out the price.') })),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe(({ quote, error }) => {
        this.quote.set(quote);
        this.quoteError.set(error);
        this.quoteLoading.set(false);
      });

    effect(() => {
      if (!this.formVisible()) return;
      const at = this.chosenIso();
      const waive = this.waive();
      untracked(() => this.quoteRequests.next({ at, waive }));
    });

    // Load when shown, and refresh each time it is shown again (slots and replies move on).
    effect(() => {
      if (!this.active()) return;
      this.appointmentId();
      untracked(() => this.refresh());
    });

    // A prescription follow-up day past the slot pills opens the typed time (the hint names the day).
    effect(() => {
      const date = this.suggestedDate();
      if (this.slotsState() !== 'ready') return;
      untracked(() => this.applySuggestion(date));
    });
  }

  private refresh(): void {
    this.now.set(Date.now());
    this.loadFollowUps();
    this.loadSlots();
    this.loadSuggestion();
  }

  // ----- Loading -----

  private loadFollowUps(): void {
    if (this.listLoading) return;
    this.listLoading = true;
    // A refresh keeps the list on screen; only a first (or failed) load shows the placeholder.
    if (this.listState() !== 'ready') this.listState.set('loading');
    this.api
      .followUps(this.appointmentId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.followUps.set([...r.data].sort(byStart));
          this.listState.set('ready');
          this.listLoading = false;
        },
        error: (err: unknown) => {
          this.listLoading = false;
          if (this.listState() === 'ready') return;
          this.listError.set(apiErrorMessage(err, "Could not load this consultation's follow-ups."));
          this.listState.set('error');
        },
      });
  }

  protected retryList(): void {
    this.loadFollowUps();
  }

  /** The doctor's open slots — the ones a patient could book, less those under 2½ hours away. */
  private loadSlots(): void {
    if (this.slotsState() === 'loading') return;
    this.slotsState.set('loading');
    this.slotsError.set('');
    this.manualMin.set(earliestManualInput());
    const known = this.specialistId() || this.profileSpecialistId();
    const specialist$: Observable<string> = known
      ? of(known)
      : this.api.getProfile().pipe(
          map((r) => r.data.id),
          tap((id) => this.profileSpecialistId.set(id)),
        );
    specialist$
      .pipe(
        switchMap((id) => this.specialistsApi.slots(id, SLOT_DAYS)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (r) => {
          const days = proposableDays(r.data);
          this.days.set(days);
          // A picked slot that has gone (taken, blocked, or now too soon) is dropped.
          const picked = this.slot();
          if (picked && !days.some((d) => d.slots.some((s) => s.iso === picked))) this.slot.set('');
          this.slotsState.set('ready');
        },
        error: (err: unknown) => {
          this.days.set([]);
          this.slotsError.set(
            apiErrorMessage(err, 'Could not load your open slots.') + ' Enter a time that is on your availability.',
          );
          this.slotsState.set('error');
        },
      });
  }

  /** The follow-up date on this consultation's prescription (video first, newest first). */
  private loadSuggestion(): void {
    this.api
      .listPrescriptions(this.appointmentId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const dated = r.data
            .filter((rx) => !!rx.follow_up_date && rx.status !== 'cancelled')
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
          const pick = dated.find((rx) => rx.follow_up_mode === 'video') ?? dated[0];
          this.suggestedDate.set((pick?.follow_up_date ?? '').slice(0, 10));
        },
        // Only a convenience: the doctor picks the day either way.
        error: () => undefined,
      });
  }

  /**
   * Never picks a time: within the pills the hint points at the day; past them
   * the typed time opens, left empty (a datetime-local can't hold a day alone).
   */
  private applySuggestion(date: string): void {
    if (!date || this.suggestionApplied === date) return;
    this.suggestionApplied = date;
    if (this.chosenIso() || this.manual() || date < todayLocal() || !beyondSlotWindow(date)) return;
    this.manual.set(true);
    this.manualMin.set(earliestManualInput());
  }

  // ----- The form -----

  protected fieldError(key: string): string {
    return this.fieldErrors()[key] ?? '';
  }

  private clearField(key: string): void {
    if (!this.fieldErrors()[key]) return;
    this.fieldErrors.update((errs) => {
      const next = { ...errs };
      delete next[key];
      return next;
    });
  }

  protected pickSlot(iso: string): void {
    this.slot.set(iso);
    this.clearField('scheduled_at');
  }

  protected typeTime(value: string): void {
    this.manualAt.set(value);
    this.clearField('scheduled_at');
  }

  protected typeNote(value: string): void {
    this.note.set(value);
    this.clearField('note');
  }

  protected toggleManual(): void {
    this.manual.update((v) => !v);
    this.manualMin.set(earliestManualInput());
    this.clearField('scheduled_at');
  }

  protected propose(): void {
    if (this.busy()) return;
    this.error.set('');
    this.notice.set(null);
    const errs: Record<string, string> = {};
    const iso = this.chosenIso();
    if (!iso) {
      errs['scheduled_at'] = this.useManual() ? 'Choose a date and time.' : 'Pick one of your open slots.';
    } else if (new Date(iso).getTime() < Date.now() + PROPOSAL_MIN_LEAD_MINUTES * MINUTE) {
      errs['scheduled_at'] = 'Choose a time at least 2½ hours from now, so the patient has time to accept.';
    }
    const note = this.note().trim();
    if (note.length > MAX_NOTE) errs['note'] = `Keep the note to ${MAX_NOTE} characters or fewer.`;
    this.fieldErrors.set(errs);
    if (Object.keys(errs).length > 0) return;

    this.busy.set(true);
    this.api
      .proposeFollowUp(this.appointmentId(), {
        scheduled_at: iso,
        ...(note ? { note } : {}),
        ...(this.waive() ? { waive_fee: true } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const f = r.data;
          this.followUps.update((list) => [...list.filter((x) => x.id !== f.id), f].sort(byStart));
          this.listState.set('ready');
          this.slot.set('');
          this.manualAt.set('');
          this.manual.set(false);
          this.note.set('');
          this.waive.set(false);
          this.busy.set(false);
          // The form gives way to "waiting for the patient" — say what happened, and focus it.
          this.announce(
            `Follow-up proposed for ${whenLabel(f.scheduled_at)}. ${f.patient_name || 'The patient'} has been told and has until ${whenLabel(f.expires_at)} to accept.`,
          );
          this.loadSlots(); // that time is now held
        },
        error: (err: unknown) => {
          const fields = apiErrorFields(err);
          const mine: Record<string, string> = {};
          if (fields['scheduled_at']) mine['scheduled_at'] = fields['scheduled_at'];
          if (fields['note']) mine['note'] = fields['note'];
          this.fieldErrors.set(mine);
          this.error.set(Object.keys(mine).length > 0 ? '' : apiErrorMessage(err, 'Could not propose the follow-up.'));
          this.busy.set(false);
          if (fields['follow_up']) this.loadFollowUps(); // another proposal is open — show it
          if (fields['scheduled_at']) this.loadSlots(); // that time went meanwhile
        },
      });
  }

  // ----- Withdraw (asks first) -----

  protected askWithdraw(f: DoctorFollowUpDto): void {
    this.withdrawError.set('');
    this.confirmId.set(f.id);
    afterNextRender(() => this.withdrawTitle()?.nativeElement.focus(), { injector: this.injector });
  }

  protected keepProposal(f: DoctorFollowUpDto): void {
    if (this.withdrawingId()) return;
    this.confirmId.set(null);
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>(`#${CSS.escape(`${this.uid}-withdraw-${f.id}`)}`)?.focus(),
      { injector: this.injector },
    );
  }

  protected withdraw(f: DoctorFollowUpDto): void {
    if (this.withdrawingId()) return;
    this.withdrawingId.set(f.id);
    this.withdrawError.set('');
    this.notice.set(null);
    this.api
      .withdrawFollowUp(f.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.followUps.update((list) => list.map((x) => (x.id === f.id ? { ...x, ...r.data } : x)));
          this.confirmId.set(null);
          this.withdrawingId.set(null);
          if (withdrewProposal(r)) {
            this.withdrawn.update((ids) => new Set(ids).add(f.id));
            this.announce(`Proposal withdrawn. The patient has been told, and ${whenLabel(f.scheduled_at)} is open again.`);
          } else {
            // The patient declined it, or it expired, a moment before — nobody was told anything new.
            this.announce('This proposal had already closed — the patient declined it or it expired.', 'info');
            this.loadFollowUps();
          }
          this.loadSlots();
        },
        error: (err: unknown) => {
          this.withdrawError.set(apiErrorMessage(err, 'Could not withdraw the proposal.'));
          this.withdrawingId.set(null);
          this.confirmId.set(null);
          // The confirm step (and the focus in it) went away: move focus to the error.
          afterNextRender(() => this.withdrawErrorEl()?.nativeElement.focus(), { injector: this.injector });
          this.loadFollowUps(); // e.g. the patient accepted it a moment ago
        },
      });
  }

  private announce(text: string, tone: 'success' | 'info' = 'success'): void {
    this.notice.set({ text, tone });
    afterNextRender(() => this.noticeEl()?.nativeElement.focus(), { injector: this.injector });
  }

  // ----- Display -----

  protected state(f: DoctorFollowUpDto): FollowUpState {
    return followUpState(f, this.now(), this.withdrawn());
  }
  protected when(iso: string | null | undefined): string {
    return whenLabel(iso);
  }
  protected date(iso: string): string {
    return dateLabel(iso);
  }
  protected money(amount: string, currency: string): string {
    return moneyLabel(amount, currency);
  }
  protected ruleText(q: FollowUpQuoteDto): string {
    return priceRuleText(q);
  }
  protected priceLabel(f: DoctorFollowUpDto): string {
    return followUpPriceLabel(f);
  }
}
