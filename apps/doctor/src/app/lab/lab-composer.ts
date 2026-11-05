import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { apiErrorCode, apiErrorMessage, LabRequestsApi } from '@supadoc/data-access';
import type {
  CreateLabRequestInput,
  LabOptionsDto,
  LabRequestContextDto,
  LabRequestDto,
} from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import type { Subscription } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { type LabClinicalEdit, LabClinicalCard } from './lab-clinical-card';
import {
  addItem,
  emptyForm,
  fastingShortfall,
  fromRequest,
  isDirty,
  type LabFormState,
  newClientKey,
  preflight,
  type PreflightIssue,
  removeItem,
  revalidate,
  safetyComplete,
  setFasting,
  setFastingHours,
  setPregnant,
  setPreparation,
  setSpecimen,
  setSpecimenMode,
  setText,
  tabCount,
  toCreateBody,
  toggleInfectionAlert,
} from './lab-composer-state';
import { type LabAddEvent, type LabInvestigationsEdit, LabInvestigationsCard } from './lab-investigations-card';
import { LabPatientCard } from './lab-patient-card';
import { LabPreflightDialog } from './lab-preflight-dialog';
import { LabPreviewDialog } from './lab-preview-dialog';
import { LabPriorityCard } from './lab-priority-card';
import { summaryFromForm } from './lab-request-summary';
import { countLabel, httpStatusOf } from './lab-ui';

export const SEND_FAILED = "Couldn't send the request. Check your connection and try again.";
export const NOT_CONSULTED = 'You can request tests only for patients you have consulted.';
export const CATALOGUE_CHANGED = 'The test list was updated. Check the request and preview it again.';
export const IDEMPOTENCY_CONFLICT = 'This form was already sent with different details. Check it and send again.';

/** Appended when the same announcement repeats, so screen readers say it again (a no-break space). */
const REPEAT = String.fromCharCode(0xa0);

/**
 * The new lab request form ([C]): Patient Details, Priority, Clinical
 * Information and Select investigations, with the sticky Cancel / Preview
 * Request footer. Preview Request stays clickable while something is missing
 * (`aria-disabled`) and opens the validation modal; Preview signs and sends.
 * State is one `LabFormState` signal changed only through the pure functions
 * of `lab-composer-state.ts`. The page around it asks before leaving.
 */
@Component({
  selector: 'doc-lab-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    IconComponent,
    LabClinicalCard,
    LabInvestigationsCard,
    LabPatientCard,
    LabPreflightDialog,
    LabPreviewDialog,
    LabPriorityCard,
  ],
  host: { class: 'flex flex-col' },
  styles: `
    .cp-footer {
      box-shadow: 0 -4px 6px 4px rgba(21, 101, 192, 0.1);
      margin-inline: -1.25rem;
      padding: 24px 20px;
      gap: 12px;
    }
    /* Below sm the two buttons share the row: 2 × 160 px + the gap overflowed a 320 px screen. */
    .cp-btn {
      flex: 1 1 0%;
      min-width: 0;
      height: 48px;
    }
    @media (min-width: 40rem) {
      .cp-footer {
        margin-inline: -1.5rem;
        padding: 24px 32px;
        gap: 16px;
      }
      .cp-btn {
        flex: none;
        min-width: 160px;
      }
    }
    /*
     * The TestLoop feedback button (index.html) floats 20 px from the
     * bottom-right corner (40 px tall, about 120 px wide), over this footer.
     * While it is on the page the buttons stay clear of it: above it on a
     * phone, to its left from sm up. Without it nothing changes.
     */
    :host-context(body:has(testloop-widget)) .cp-footer {
      padding-bottom: 76px;
    }
    @media (min-width: 40rem) {
      :host-context(body:has(testloop-widget)) .cp-footer {
        padding-bottom: 24px;
        padding-right: 168px;
      }
    }
    @media (min-width: 64rem) {
      .cp-patient {
        width: 456px;
        flex: none;
      }
    }
  `,
  template: `
    @let s = state();
    @let ctx = context();
    <div class="flex flex-col gap-10 pb-6">
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-heading text-h2 text-ink">New request</h1>
        <button
          type="button"
          class="flex items-center gap-1 rounded-field font-sans text-h5 font-medium text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          (click)="back.emit()"
        >
          <sd-icon name="arrow-left" [size]="24" /> Back
        </button>
      </div>

      @if (droppedNotice()) {
        <sd-alert tone="info">{{ droppedNotice() }}</sd-alert>
      }

      <div class="flex flex-col gap-8 lg:flex-row lg:items-start">
        <doc-lab-patient-card class="cp-patient" [patient]="ctx.patient" [stat]="s.priority === 'stat'" />
        <doc-lab-priority-card class="min-w-0 flex-1" [priorities]="opts().priorities" [value]="s.priority" (valueChange)="patch({ priority: $event })" />
      </div>

      <div class="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <doc-lab-clinical-card
          [state]="s"
          [askPregnancy]="ctx.ask_pregnancy"
          [alerts]="opts().infection_alerts"
          [limits]="opts().limits"
          [errors]="inlineErrors()"
          [shortfall]="shortfall()"
          (edit)="onClinical($event)"
        />
        <doc-lab-investigations-card
          [state]="s"
          [options]="opts()"
          [askPregnancy]="ctx.ask_pregnancy"
          [safetyComplete]="safetyDone()"
          [errors]="inlineErrors()"
          (add)="onAdd($event)"
          (remove)="onRemove($event)"
          (edit)="onInvestigations($event)"
        />
      </div>
    </div>

    <div class="cp-footer sticky bottom-0 z-10 flex justify-end border-t border-haze bg-snow">
      <button
        type="button"
        class="cp-btn rounded-field border-[0.5px] border-ash bg-white px-4 font-sans text-body-sm font-medium text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
        (click)="cancelled.emit()"
      >
        Cancel
      </button>
      <button
        type="button"
        id="lab-preview-button"
        class="cp-btn rounded-field px-4 font-sans text-body-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
        [class]="issues().length ? 'bg-cerulean/40' : 'bg-cerulean hover:bg-cerulean-dark'"
        [attr.aria-disabled]="issues().length ? true : null"
        [attr.aria-describedby]="issues().length ? 'lab-preview-missing' : null"
        (click)="requestPreview()"
      >
        Preview Request
      </button>
      <span id="lab-preview-missing" class="sr-only">Some required items are missing. Activate to see them.</span>
    </div>

    <p class="sr-only" role="status" aria-live="polite">{{ announce() }}</p>

    <doc-lab-preflight-dialog [open]="preflightOpen()" [issues]="issues()" (fix)="fix($event)" (closed)="closePreflight()" />
    <doc-lab-preview-dialog
      [open]="previewOpen()"
      [session]="previewSeq()"
      [view]="previewView()"
      [hasSignature]="opts().has_signature"
      [doctorName]="clock.profile()?.name ?? null"
      [busy]="sending()"
      [error]="sendError()"
      [notice]="previewNotice()"
      (send)="send($event)"
      (closed)="closePreview()"
    />
  `,
})
export class LabComposer {
  protected readonly clock = inject(DoctorClock);
  private readonly api = inject(LabRequestsApi);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly context = input.required<LabRequestContextDto>();
  readonly options = input.required<LabOptionsDto>();
  /** The consultation it is requested from (null outside one). */
  readonly appointmentId = input<string | null>(null);
  /** Duplicate: the request to copy (already checked to be this patient's). */
  readonly duplicate = input<LabRequestDto | null>(null);

  /** "Back": the page asks "Change patient?" when there is something to lose. */
  readonly back = output<void>();
  /** "Cancel": the page leaves to the list (its unsaved guard asks). Not `cancel`: a DOM event name. */
  readonly cancelled = output<void>();
  readonly sent = output<LabRequestDto>();

  /** The options in use (replaced after `catalogue_changed`). */
  protected readonly opts = linkedSignal(() => this.options());

  private readonly init = computed(() => {
    const dup = this.duplicate();
    return dup ? fromRequest(dup, this.options(), this.context()) : { state: emptyForm(this.context()), dropped: [] as string[] };
  });
  /** The form. */
  readonly state = linkedSignal(() => this.init().state);
  private readonly initial = computed(() => this.init().state);

  /** Leaving now would lose something the doctor entered. */
  readonly dirty = computed(() => isDirty(this.state(), this.initial()));

  protected readonly droppedNotice = linkedSignal(() => {
    const { dropped } = this.init();
    const number = this.duplicate()?.number ?? '';
    return dropped.length ? `Some tests from ${number} are no longer in the list and weren't copied: ${dropped.join(', ')}.` : '';
  });

  protected readonly issues = computed(() => preflight(this.state(), this.context(), this.opts()));
  protected readonly shortfall = computed(() => fastingShortfall(this.state(), this.opts()));
  protected readonly safetyDone = computed(() => safetyComplete(this.state(), this.context().ask_pregnancy));
  /** Shown under their fields after the first failed Preview. */
  private readonly attempted = signal(false);
  protected readonly inlineErrors = computed<Record<string, string>>(() => {
    if (!this.attempted()) return {};
    const out: Record<string, string> = {};
    for (const i of this.issues()) out[i.key === 'specimen' ? `specimen:${i.code}` : i.key] = i.label;
    return out;
  });

  protected readonly announce = signal('');
  protected readonly preflightOpen = signal(false);
  protected readonly previewOpen = signal(false);
  protected readonly previewNotice = signal<string | null>(null);
  protected readonly previewSeq = signal(0);
  protected readonly previewView = computed(() => summaryFromForm(this.state(), this.context(), this.opts()));
  protected readonly sending = signal(false);
  /** A create is in flight: it may already be on the server, so the page holds navigation until it settles. */
  readonly inFlight = this.sending.asReadonly();
  protected readonly sendError = signal<string | null>(null);
  private sendSub: Subscription | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.sendSub?.unsubscribe());
  }

  // ----- edits -----

  protected patch(p: Partial<LabFormState>): void {
    this.state.update((s) => ({ ...s, ...p }));
  }

  protected onClinical(e: LabClinicalEdit): void {
    this.state.update((s) => {
      switch (e.field) {
        case 'question':
        case 'history':
        case 'medication':
        case 'allergies':
          return setText(s, e.field, e.value);
        case 'fasting':
          return setFasting(s, e.value);
        case 'fastingHours':
          return setFastingHours(s, e.value);
        case 'pregnant':
          return setPregnant(s, e.value);
        case 'weeksPregnant':
          return { ...s, weeksPregnant: e.value };
        case 'transfusion':
          return { ...s, transfusion: e.value };
        case 'alert':
          return toggleInfectionAlert(s, e.value, this.opts().infection_alerts.map((a) => a.value));
      }
    });
  }

  protected onInvestigations(e: LabInvestigationsEdit): void {
    this.state.update((s) => {
      switch (e.kind) {
        case 'tab':
          return { ...s, tab: e.value };
        case 'category':
          return { ...s, category: e.value };
        case 'site':
          return { ...s, site: e.value };
        case 'modality':
          return { ...s, modality: e.value };
        case 'purpose':
          return { ...s, purpose: e.value };
        case 'specimenMode':
          return setSpecimenMode(s, e.code, e.value);
        case 'specimen':
          return setSpecimen(s, e.code, e.value);
        case 'preparation':
          return setPreparation(s, e.code, e.value);
        case 'activate': {
          const item = s.items.find((i) => i.code === e.code);
          if (!item) return s;
          return item.kind === 'lab' ? { ...s, activeLabCode: e.code } : item.kind === 'imaging' ? { ...s, activeImagingCode: e.code } : s;
        }
        case 'safety': {
          const x = e.edit;
          if (x.field === 'pregnant') return setPregnant(s, x.value);
          return { ...s, safety: { ...s.safety, [x.field]: x.value } };
        }
      }
    });
  }

  /** Every add path: Quick add, panels, single tests, microbiology, studies, physiological and the search. */
  protected onAdd(e: LabAddEvent): void {
    const s = this.state();
    const max = this.opts().limits?.max_items ?? 20;
    if (s.items.some((i) => i.code === e.item.code)) {
      this.state.set(addItem(s, e.item, e.source));
      this.say(`${e.item.label} is already added.`);
      return;
    }
    if (s.items.length >= max) {
      this.say(`You can add up to ${max} tests.`);
      return;
    }
    const next = addItem(s, e.item, e.source);
    this.state.set(next);
    this.say(`${e.item.label} added. ${countLabel(tabCount(next, e.item.kind), 'test')} on this tab.`);
  }

  protected onRemove(code: string): void {
    const item = this.state().items.find((i) => i.code === code);
    if (!item) return;
    this.state.update((s) => removeItem(s, code));
    this.say(`${item.label} removed.`);
  }

  /** Polite announcement (re-announced when the same text repeats). */
  private say(text: string): void {
    this.announce.set(this.announce() === text ? `${text}${REPEAT}` : text);
  }

  // ----- preflight / preview / send -----

  protected requestPreview(): void {
    if (this.issues().length) {
      this.attempted.set(true);
      this.preflightOpen.set(true);
      return;
    }
    this.previewNotice.set(null);
    this.sendError.set(null);
    this.showPreview();
  }

  private showPreview(): void {
    this.previewSeq.update((n) => n + 1);
    this.previewOpen.set(true);
  }

  protected closePreflight(): void {
    this.preflightOpen.set(false);
  }

  protected closePreview(): void {
    if (this.sending()) return;
    this.previewOpen.set(false);
  }

  /** Fix: close the modal, show the field's tab and focus the field. */
  protected fix(issue: PreflightIssue): void {
    this.preflightOpen.set(false);
    const s = this.state();
    let target = '';
    switch (issue.key) {
      case 'tests':
        target = s.tab === 'physiological' ? 'lab-physio-select' : `lab-search-${s.tab}`;
        break;
      case 'indication':
        target = 'lab-question';
        break;
      case 'safety':
        this.patch({ tab: 'imaging' });
        target =
          this.context().ask_pregnancy && s.pregnant === null
            ? 'lab-safety-pregnant'
            : s.safety.contrastAllergy === null
              ? 'lab-safety-contrast'
              : 'lab-safety-mobility';
        break;
      case 'fasting_hours':
        target = 'lab-fasting-hours';
        break;
      case 'weeks':
        target = 'lab-weeks';
        break;
      case 'specimen':
        this.patch({ tab: 'lab', activeLabCode: issue.code ?? s.activeLabCode });
        target = 'lab-specimen-manual';
        break;
    }
    this.focusLater(target);
  }

  /** Focus once the modal has closed and the tab is shown (the page behind a modal is inert until then). */
  private focusLater(id: string, tries = 5): void {
    setTimeout(() => {
      const el = this.doc.getElementById(id);
      if (el) {
        el.scrollIntoView?.({ block: 'center' });
        el.focus();
      } else if (tries > 0) {
        this.focusLater(id, tries - 1);
      }
    }, 0);
  }

  protected send(signature: CreateLabRequestInput['signature']): void {
    if (this.sending()) return;
    const body = toCreateBody(
      this.state(),
      this.context(),
      this.appointmentId(),
      this.duplicate()?.id ?? null,
      signature,
      this.opts().catalogue_version,
    );
    this.sending.set(true);
    this.sendError.set(null);
    this.sendSub?.unsubscribe();
    this.sendSub = this.api.create(body).subscribe({
      next: (res) => {
        this.sending.set(false);
        this.previewOpen.set(false);
        this.sent.emit(res.data);
      },
      error: (err: unknown) => {
        this.sending.set(false);
        this.onSendError(err);
      },
    });
  }

  private onSendError(err: unknown): void {
    const status = httpStatusOf(err);
    const code = apiErrorCode(err);
    if (status === 409) {
      // Any 409: this key is spent (or tied to other details) — the next send uses a new one.
      this.patch({ clientKey: newClientKey() });
      if (code === 'catalogue_changed') {
        this.reloadCatalogue();
        return;
      }
      this.sendError.set(code === 'idempotency_conflict' ? IDEMPOTENCY_CONFLICT : apiErrorMessage(err, SEND_FAILED));
      return;
    }
    if (status === 422) {
      this.attempted.set(true);
      this.sendError.set(code === 'not_consulted' ? NOT_CONSULTED : apiErrorMessage(err, SEND_FAILED));
      return;
    }
    if (status === 0 || status === null || status >= 500) {
      this.sendError.set(SEND_FAILED);
      return;
    }
    this.sendError.set(apiErrorMessage(err, SEND_FAILED));
  }

  /** `catalogue_changed`: reload the list, drop what left it, and preview again. */
  private reloadCatalogue(): void {
    this.previewOpen.set(false);
    this.api.options().subscribe({
      next: (res) => {
        this.opts.set(res.data);
        const { state, dropped } = revalidate(this.state(), res.data);
        this.state.set(state);
        if (dropped.length) this.droppedNotice.set(`Some tests are no longer in the list and were removed: ${dropped.join(', ')}.`);
        if (this.issues().length) {
          this.attempted.set(true);
          this.preflightOpen.set(true);
          return;
        }
        this.sendError.set(null);
        this.previewNotice.set(CATALOGUE_CHANGED);
        this.showPreview();
      },
      error: () => {
        this.previewNotice.set(null);
        this.sendError.set(CATALOGUE_CHANGED);
        this.showPreview();
      },
    });
  }
}
