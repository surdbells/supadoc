import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { type CanLeave, StaffAuthService } from '@supadoc/auth';
import { LabRequestsApi } from '@supadoc/data-access';
import type { LabOptionsDto, LabPatientPickDto, LabRequestContextDto, LabRequestDto } from '@supadoc/models';
import { DialogService, EmptyStateComponent, IconComponent, warnBeforeUnload } from '@supadoc/ui';
import { catchError, forkJoin, map, type Observable, of, type Subscription } from 'rxjs';
import { LabComposer, labOpenRefusal, OPEN_ERROR, UNSAVED_LAB_LEAVE } from './lab-composer';
import { LabPatientPicker } from './lab-patient-picker';
import { LabSentDialog } from './lab-sent-dialog';
import { firstName } from './lab-ui';

/** "Leave without sending?" (now shared with the call's composer; kept exported here for the page's importers). */
export { UNSAVED_LAB_LEAVE } from './lab-composer';

interface Ready {
  readonly context: LabRequestContextDto;
  readonly options: LabOptionsDto;
  readonly appointmentId: string | null;
  readonly duplicate: LabRequestDto | null;
}

/**
 * New lab request (route `/prescriptions/labs/new`): without `?patientId=` the
 * patient picker; with it, the composer for that patient (`appointmentId` from
 * a consultation, `from` to duplicate one of their requests). Owns leaving:
 * the unsaved-changes guard (`canLeave`, also on query-param-only moves such
 * as browser Back to the picker), `leaveTo` for moves that already asked, and
 * the browser's own prompt while the form is dirty.
 */
@Component({
  selector: 'doc-new-lab-request-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, IconComponent, LabComposer, LabPatientPicker, LabSentDialog],
  host: { class: 'block' },
  styles: `
    .np-shimmer {
      height: 154px;
    }
  `,
  template: `
    <div class="py-2">
      @if (!patientId()) {
        <doc-lab-patient-picker (chosen)="choose($event)" />
      } @else if (ready(); as r) {
        <!-- Keyed (not tracked by identity): a new form key remounts the composer without the NG0956 dev warning. -->
        @for (k of [formKey()]; track 'form:' + k) {
          <doc-lab-composer
            [context]="r.context"
            [options]="r.options"
            [appointmentId]="r.appointmentId"
            [duplicate]="r.duplicate"
            (back)="changePatient()"
            (cancelled)="cancel()"
            (sent)="onSent($event)"
          />
        }
      } @else if (refusal(); as msg) {
        <sd-empty-state icon="user-x" tone="error" [title]="msg">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean"
            (click)="leaveTo(['/prescriptions/labs/new'])"
          >
            <sd-icon name="users" [size]="16" /> Choose another patient
          </button>
        </sd-empty-state>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-haze bg-white px-4 py-16 text-center shadow-card">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean"
            (click)="load()"
          >
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </button>
        </div>
      } @else {
        <div class="flex flex-col gap-8" aria-busy="true">
          <span class="sr-only">Loading the request form…</span>
          <div class="sd-shimmer h-10 w-64 rounded-field"></div>
          <div class="np-shimmer sd-shimmer rounded-2xl"></div>
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <div class="np-shimmer sd-shimmer rounded-2xl"></div>
            <div class="np-shimmer sd-shimmer rounded-2xl"></div>
          </div>
        </div>
      }
    </div>

    <doc-lab-sent-dialog [open]="sentOpen()" [request]="sentRequest()" (newRequest)="newRequest()" (back)="backToList()" />
  `,
})
export class NewLabRequestPage implements CanLeave {
  private readonly api = inject(LabRequestsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly composer = viewChild(LabComposer);

  protected readonly patientId = signal<string | null>(null);
  private appointmentId: string | null = null;
  private fromId: string | null = null;

  protected readonly ready = signal<Ready | null>(null);
  protected readonly error = signal('');
  protected readonly refusal = signal('');
  /** Bumped per load: a new composer (fresh form and client key) for every patient. */
  protected readonly formKey = signal(0);

  protected readonly sent = signal(false);
  protected readonly sentOpen = signal(false);
  protected readonly sentRequest = signal<LabRequestDto | null>(null);

  private options: LabOptionsDto | null = null;
  /** The doctor already confirmed (or nothing is unsaved): skip the leave prompt. */
  private leaving = false;
  private loadSub: Subscription | null = null;

  /** The form holds unsent selections. */
  protected readonly dirty = computed(() => !!this.composer()?.dirty() && !this.sent());
  /** "Send to Patient" is waiting for the server (an unchanged duplicate can be sent while not dirty). */
  private readonly sending = computed(() => !!this.composer()?.inFlight());

  constructor() {
    warnBeforeUnload(() => this.dirty() || this.sending());
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((q) => {
      const pid = (q.get('patientId') ?? '').trim() || null;
      const aid = (q.get('appointmentId') ?? '').trim() || null;
      const from = (q.get('from') ?? '').trim() || null;
      if (pid === this.patientId() && aid === this.appointmentId && from === this.fromId && (this.ready() || this.loadSub)) return;
      this.patientId.set(pid);
      this.appointmentId = aid;
      this.fromId = from;
      this.sent.set(false);
      this.sentOpen.set(false);
      this.sentRequest.set(null);
      this.ready.set(null);
      if (pid) this.load();
      else {
        this.loadSub?.unsubscribe();
        this.loadSub = null;
      }
    });
    this.destroyRef.onDestroy(() => this.loadSub?.unsubscribe());
  }

  /** Route guard hook: ask before a navigation throws away unsent selections. */
  canLeave(): boolean | Promise<boolean> {
    // A sign-out must still clear the screen — never hold patient details up behind a prompt.
    if (this.leaving || !this.auth.isAuthenticated()) return true;
    // A create in flight may already have reached the server: never say "Nothing has been sent"
    // and never drop the answer. Stay; the Sent dialog (or the send error) follows in Preview.
    if (this.sending()) return false;
    return this.dirty() ? this.dialogs.confirmLeave(UNSAVED_LAB_LEAVE) : true;
  }

  hasUnsavedChanges(): boolean {
    return this.dirty();
  }

  /** Navigate without the leave prompt (already asked, or nothing to lose). */
  protected leaveTo(commands: unknown[]): void {
    this.leaving = true;
    // This page is reused for query-param-only moves: reset the flag either way.
    void this.router.navigate(commands).then(
      () => (this.leaving = false),
      () => (this.leaving = false),
    );
  }

  protected load(): void {
    const pid = this.patientId();
    if (!pid) return;
    const aid = this.appointmentId;
    const from = this.fromId;
    this.loadSub?.unsubscribe();
    this.error.set('');
    this.refusal.set('');
    this.ready.set(null);
    const options$: Observable<LabOptionsDto> = this.options ? of(this.options) : this.api.options().pipe(map((r) => r.data));
    const duplicate$: Observable<LabRequestDto | null> = from
      ? this.api.get(from).pipe(
          map((r) => r.data),
          catchError(() => of(null)),
        )
      : of(null);
    this.loadSub = forkJoin({
      options: options$,
      context: this.api.context(pid, aid).pipe(map((r) => r.data)),
      duplicate: duplicate$,
    }).subscribe({
      next: ({ options, context, duplicate }) => {
        this.options = options;
        this.formKey.update((k) => k + 1);
        this.ready.set({
          context,
          options,
          appointmentId: aid,
          // Only ever this patient's request: another patient's is ignored (no copy, no duplicated_from).
          duplicate: duplicate && duplicate.patient?.id === pid ? duplicate : null,
        });
      },
      error: (err: unknown) => {
        const refusal = labOpenRefusal(err);
        if (refusal) this.refusal.set(refusal);
        else this.error.set(OPEN_ERROR);
      },
    });
  }

  // ----- picker -----

  protected choose(p: LabPatientPickDto): void {
    // Only patientId: a stale appointmentId or `from` never carries over to another patient.
    void this.router.navigate([], { relativeTo: this.route, queryParams: { patientId: p.patient_id } });
  }

  // ----- composer -----

  /** Back to the picker, asking first when there is something to lose. */
  protected async changePatient(): Promise<void> {
    if (this.dirty()) {
      const ok = await this.dialogs.confirmLeave({
        tone: 'warning',
        title: 'Change patient?',
        message: `Your selections for ${firstName(this.ready()?.context.patient.first_name || this.ready()?.context.patient.name)} will be lost.`,
        confirmLabel: 'Change patient',
        cancelLabel: 'Keep editing',
      });
      if (!ok) return;
    }
    // No query params at all: the appointment and `from` go with the patient.
    this.leaveTo(['/prescriptions/labs/new']);
  }

  /** Cancel: to the list (the unsaved guard asks). */
  protected cancel(): void {
    void this.router.navigate(['/prescriptions/labs']);
  }

  protected onSent(r: LabRequestDto): void {
    // The next form reads the options afresh (a signature saved with this one; a newer catalogue).
    this.options = null;
    this.sent.set(true);
    this.sentRequest.set(r);
    this.sentOpen.set(true);
  }

  protected newRequest(): void {
    this.sentOpen.set(false);
    this.leaveTo(['/prescriptions/labs/new']);
  }

  protected backToList(): void {
    this.sentOpen.set(false);
    this.leaveTo(['/prescriptions/labs']);
  }
}

