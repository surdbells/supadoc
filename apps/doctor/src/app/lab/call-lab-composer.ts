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
  linkedSignal,
  type OnInit,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { apiErrorMessage, doctorStandingCode, LabRequestsApi } from '@supadoc/data-access';
import type { LabOptionsDto, LabRequestContextDto, LabRequestDto } from '@supadoc/models';
import { DialogService, EmptyStateComponent, IconComponent, warnBeforeUnload } from '@supadoc/ui';
import { forkJoin, map, type Subscription } from 'rxjs';
import { standingText } from '../call-workspace/call-workspace-copy';
import { LabComposer, labOpenRefusal, OPEN_ERROR, UNSAVED_LAB_LEAVE } from './lab-composer';
import { LabSentDialog } from './lab-sent-dialog';

type ComposerState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly context: LabRequestContextDto; readonly options: LabOptionsDto; readonly key: number }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'signed-out' };

const CARD_BTN =
  'inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean';

/**
 * The lab request composer inside the call's Lab requests tab: this patient
 * and this consultation, fixed (no picker, no route, no router). It reads the
 * form's options and the patient's context afresh for every form, hosts
 * `doc-lab-composer` in its embedded layout and the "Request Sent" dialog, and
 * asks before Back / Cancel throws away an unsent request. Signed out, the
 * form stays as it is (disabled) and a load in progress waits for the sign-in.
 */
@Component({
  selector: 'doc-call-lab-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, IconComponent, LabComposer, LabSentDialog],
  host: { class: 'block' },
  styles: `
    .np-shimmer {
      height: 154px;
    }
  `,
  template: `
    <section class="flex flex-col gap-10" aria-labelledby="call-lab-compose-title">
      <div class="flex items-center justify-between gap-4">
        <h2 id="call-lab-compose-title" tabindex="-1" data-ws-focus class="font-heading text-h5 text-ink outline-none">New request</h2>
        <button
          type="button"
          aria-label="Back to lab requests"
          class="flex min-h-11 items-center gap-1 rounded-field px-2 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          (click)="requestClose()"
        >
          <sd-icon name="arrow-left" [size]="20" /> Back
        </button>
      </div>
      @switch (state().kind) {
        @case ('ready') {
          @if (ready(); as r) {
            <!-- Keyed: every form ("+ New Request" included) is a new composer with a fresh client key. -->
            @for (k of [r.key]; track 'form:' + k) {
              <doc-lab-composer
                [embedded]="true"
                [disabled]="disabled()"
                [context]="r.context"
                [options]="r.options"
                [appointmentId]="appointmentId()"
                [duplicate]="dupForForm()"
                (back)="requestClose()"
                (cancelled)="requestClose()"
                (sent)="onSent($event)"
              />
            }
          }
        }
        @case ('refused') {
          <sd-empty-state icon="user-x" tone="error" [title]="message()">
            <button type="button" class="${CARD_BTN}" (click)="closed.emit()">
              <sd-icon name="arrow-left" [size]="16" /> Back to lab requests
            </button>
          </sd-empty-state>
        }
        @case ('error') {
          <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-16 text-center shadow-card">
            <sd-icon name="wifi-off" [size]="32" class="text-alert" />
            <p class="font-sans text-body-sm text-slate">{{ message() }}</p>
            <div class="flex flex-wrap justify-center gap-2">
              <button type="button" class="${CARD_BTN}" (click)="retry()">
                <sd-icon name="refresh-cw" [size]="16" /> Try again
              </button>
              <button type="button" class="${CARD_BTN}" (click)="closed.emit()">
                <sd-icon name="arrow-left" [size]="16" /> Back to lab requests
              </button>
            </div>
          </div>
        }
        @case ('signed-out') {
          <p class="font-sans text-body-sm text-slate" role="status">Sign in again to open the request form. This call keeps going.</p>
        }
        @default {
          <div class="flex flex-col gap-8" aria-busy="true">
            <span class="sr-only">Loading the request form…</span>
            <div class="np-shimmer sd-shimmer rounded-2xl"></div>
            <div class="np-shimmer sd-shimmer rounded-2xl"></div>
          </div>
        }
      }
    </section>

    <doc-lab-sent-dialog
      [open]="sentOpen()"
      [request]="sentRequest()"
      backLabel="Back to lab requests"
      (newRequest)="newRequest()"
      (back)="finish()"
    />
  `,
})
export class CallLabComposer implements OnInit {
  private readonly api = inject(LabRequestsApi);
  private readonly dialogs = inject(DialogService);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  readonly patientId = input.required<string>();
  readonly appointmentId = input.required<string>();
  /** A request to copy (from the drill-in's Duplicate). Used only when it is this patient's. */
  readonly duplicate = input<LabRequestDto | null>(null);
  /** Signed out, or another doctor signed in: edits stay possible, nothing is sent. */
  readonly disabled = input(false);

  /** Back / Cancel, after the unsaved question when needed. Nothing was sent. */
  readonly closed = output<void>();
  /** The request was sent and the doctor left the Sent dialog with "Back to lab requests" (or Esc). */
  readonly done = output<LabRequestDto>();

  protected readonly state = signal<ComposerState>({ kind: 'loading' });
  protected readonly ready = computed(() => {
    const s = this.state();
    return s.kind === 'ready' ? s : null;
  });
  protected readonly message = computed(() => {
    const s = this.state();
    return s.kind === 'refused' || s.kind === 'error' ? s.text : '';
  });
  /** Only ever this patient's request (the page's rule): another patient's is ignored. "+ New Request" clears it. */
  protected readonly dupForForm = linkedSignal(() => {
    const d = this.duplicate();
    return d && d.patient?.id === this.patientId() ? d : null;
  });
  protected readonly sentOpen = signal(false);
  protected readonly sentRequest = signal<LabRequestDto | null>(null);

  private readonly composer = viewChild(LabComposer);
  /** A request is being written and has not been sent. */
  readonly unsent = computed(() => this.state().kind === 'ready' && !!this.composer()?.dirty() && !this.sentRequest());
  /** "Send to Patient" is waiting for the server (it may already be there). */
  readonly sending = computed(() => !!this.composer()?.inFlight());

  private key = 0;
  private loadSub: Subscription | null = null;

  constructor() {
    // After the call ends the cockpit's own unload prompt no longer covers this form.
    warnBeforeUnload(() => this.unsent() || this.sending());
    effect(() => {
      const off = this.disabled();
      untracked(() => {
        const kind = this.state().kind;
        if (off) {
          if (kind === 'loading') {
            this.loadSub?.unsubscribe();
            this.loadSub = null;
            this.state.set({ kind: 'signed-out' });
          }
          // The confirmation holds nothing to lose and shows patient details: back to the (hidden) list.
          if (this.sentOpen()) this.finish();
        } else if (kind === 'signed-out') {
          this.load();
        }
      });
    });
    this.destroyRef.onDestroy(() => this.loadSub?.unsubscribe());
  }

  ngOnInit(): void {
    this.load();
  }

  /** The form's options (never cached: a signature saved with the last one, a newer catalogue) and the patient's context. */
  protected load(): void {
    this.loadSub?.unsubscribe();
    this.loadSub = null;
    if (this.disabled()) {
      this.state.set({ kind: 'signed-out' });
      return;
    }
    this.state.set({ kind: 'loading' });
    this.loadSub = forkJoin({
      options: this.api.options().pipe(map((r) => r.data)),
      context: this.api.context(this.patientId(), this.appointmentId()).pipe(map((r) => r.data)),
    }).subscribe({
      next: ({ options, context }) => {
        this.loadSub = null;
        this.state.set({ kind: 'ready', context, options, key: ++this.key });
      },
      error: (err: unknown) => {
        this.loadSub = null;
        const code = doctorStandingCode(err);
        if (code) {
          this.state.set({ kind: 'refused', text: standingText(code, apiErrorMessage(err, '')) });
          return;
        }
        const refusal = labOpenRefusal(err);
        this.state.set(refusal ? { kind: 'refused', text: refusal } : { kind: 'error', text: OPEN_ERROR });
      },
    });
  }

  /** The error card's Try again: the card (and the pressed button) gives way to the shimmer, so focus goes to the title. */
  protected retry(): void {
    this.load();
    afterNextRender(
      () => {
        const active = this.doc.activeElement;
        if (!active || active === this.doc.body) this.doc.getElementById('call-lab-compose-title')?.focus();
      },
      { injector: this.injector },
    );
  }

  /** Back and the footer's Cancel: nothing while sending; an unsent request is asked about first. */
  async requestClose(): Promise<void> {
    if (this.sending()) return;
    if (this.unsent() && !(await this.dialogs.confirmLeave(UNSAVED_LAB_LEAVE))) return;
    this.closed.emit();
  }

  protected onSent(r: LabRequestDto): void {
    this.sentRequest.set(r);
    this.sentOpen.set(true);
  }

  /** The Sent dialog's "Back to lab requests" (or Esc). */
  protected finish(): void {
    const r = this.sentRequest();
    this.sentOpen.set(false);
    if (r) this.done.emit(r);
  }

  /** "+ New Request": a fresh, empty form for the same patient and consultation. */
  protected newRequest(): void {
    this.sentOpen.set(false);
    this.sentRequest.set(null);
    this.dupForForm.set(null);
    this.load();
    // The button that was pressed is gone with the dialog.
    afterNextRender(() => this.doc.getElementById('call-lab-compose-title')?.focus(), { injector: this.injector });
  }
}
