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
import type { ApplicationDocumentSlot, DoctorApplicationDetailDto, RequestInfoInput } from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import {
  CHECK_ROW,
  CHECKBOX,
  DIALOG_FOOTER,
  FIELD,
  FIELD_ERROR,
  FIELD_INVALID,
  HINT,
  LABEL,
} from '../../shared/layout';
import { BTN_GHOST, BTN_PRIMARY } from '../../specialists/specialist-ui';
import { REQUESTABLE_SECTIONS, routeSlots, slotLabel } from '../application-ui';

export const REQUEST_MESSAGE_MAX = 2000;
export const REQUEST_ITEMS_MAX = 10;

type SectionKey = (typeof REQUESTABLE_SECTIONS)[number]['key'];
type Item = RequestInfoInput['items'][number];

/** Is a 409 (the application moved on): the page re-reads it. */
export function isConflict(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number } | null;
  return (e?.statusCode ?? e?.status) === 409;
}

/**
 * Ask the applicant for more: the sections to change and the documents to
 * send (the route's slots, or "Another document" in the reviewer's words),
 * and a message they see on their status page and in the email. From an
 * interview it cancels the interview. At least one item and a message.
 */
@Component({
  selector: 'bo-request-info-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, DialogComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      title="Request more information"
      [subtitle]="detail().full_name + ' · ' + detail().reference"
      size="lg"
      [busy]="saving()"
      (closed)="close()"
    >
      <form id="bo-request-info-form" class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); submit()">
        @if (detail().status === 'interview_scheduled') {
          <sd-alert tone="warning">This cancels the scheduled interview. The applicant is told in the email.</sd-alert>
        }
        <div class="grid gap-5 sm:grid-cols-2">
          <fieldset class="flex min-w-0 flex-col" [attr.aria-describedby]="err('items') ? 'bo-ri-items-err' : null">
            <legend class="${LABEL} mb-1">Sections</legend>
            @for (s of sections; track s.key; let first = $first) {
              <label class="${CHECK_ROW}">
                <input type="checkbox" class="${CHECKBOX}" [checked]="pickedSections().has(s.key)" (change)="toggleSection(s.key, $any($event.target).checked)" [attr.data-autofocus]="first ? '' : null" />
                <span class="font-sans text-body-sm text-ink">{{ s.label }}</span>
              </label>
            }
          </fieldset>
          <fieldset class="flex min-w-0 flex-col" [attr.aria-describedby]="err('items') ? 'bo-ri-items-err' : null">
            <legend class="${LABEL} mb-1">Documents</legend>
            @for (slot of slots(); track slot) {
              <label class="${CHECK_ROW}">
                <input type="checkbox" class="${CHECKBOX}" [checked]="pickedSlots().has(slot)" (change)="toggleSlot(slot, $any($event.target).checked)" />
                <span class="font-sans text-body-sm text-ink">{{ label(slot) }}</span>
              </label>
            }
            <label class="${CHECK_ROW}">
              <input type="checkbox" class="${CHECKBOX}" [checked]="another()" (change)="setAnother($any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Another document</span>
            </label>
            @if (another()) {
              <label class="ml-7 flex flex-col gap-1.5">
                <span class="${LABEL}">Which document? <span aria-hidden="true">*</span></span>
                <input
                  id="bo-ri-another"
                  type="text"
                  maxlength="120"
                  required
                  class="${FIELD}"
                  [class]="err('label') ? '${FIELD_INVALID}' : ''"
                  placeholder="e.g. Specialist registration certificate"
                  [value]="anotherLabel()"
                  (input)="anotherLabel.set($any($event.target).value); clearErr('label')"
                  [attr.aria-invalid]="err('label') ? 'true' : null"
                  [attr.aria-describedby]="err('label') ? 'bo-ri-another-err' : null"
                />
                @if (err('label'); as e) { <span id="bo-ri-another-err" class="${FIELD_ERROR}">{{ e }}</span> }
              </label>
            }
          </fieldset>
        </div>
        @if (err('items'); as e) {
          <p id="bo-ri-items-err" class="${FIELD_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ e }}</p>
        }

        <label class="flex flex-col gap-1.5">
          <span class="${LABEL}">Message to the applicant <span aria-hidden="true">*</span></span>
          <textarea
            id="bo-ri-message"
            rows="5"
            [attr.maxlength]="messageMax"
            required
            class="${FIELD}"
            [class]="err('message') ? '${FIELD_INVALID}' : ''"
            [value]="message()"
            (input)="message.set($any($event.target).value); clearErr('message')"
            [attr.aria-invalid]="err('message') ? 'true' : null"
            [attr.aria-describedby]="err('message') ? 'bo-ri-msg-hint bo-ri-msg-err' : 'bo-ri-msg-hint'"
          ></textarea>
          <span class="flex flex-wrap items-start justify-between gap-2">
            <span id="bo-ri-msg-hint" class="${HINT}">Shown on their status page and in the email. Don't include internal notes.</span>
            <span class="${HINT} tabular-nums">{{ message().length }} / {{ messageMax }}</span>
          </span>
          @if (err('message'); as e) { <span id="bo-ri-msg-err" class="${FIELD_ERROR}">{{ e }}</span> }
        </label>

        <div aria-live="assertive">
          @if (error()) {
            <sd-alert tone="error">{{ error() }}</sd-alert>
          }
        </div>
      </form>
      <div dialogFooter class="${DIALOG_FOOTER}">
        <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="close()">Cancel</button>
        <button type="submit" form="bo-request-info-form" class="${BTN_PRIMARY}" [disabled]="saving()">
          <sd-icon [name]="saving() ? 'loader-circle' : 'send'" [size]="18" [class.animate-spin]="saving()" />{{ saving() ? 'Sending…' : 'Send request' }}
        </button>
      </div>
    </sd-dialog>
  `,
})
export class RequestInfoDialog {
  private readonly api = inject(AdminDoctorApplicationsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild(DialogComponent);

  readonly open = input(false);
  readonly detail = input.required<DoctorApplicationDetailDto>();
  readonly closed = output<void>();
  /** Sent — the application as it is now. */
  readonly done = output<DoctorApplicationDetailDto>();
  /** The application moved on meanwhile (409): the page re-reads it. */
  readonly stale = output<void>();

  protected readonly sections = REQUESTABLE_SECTIONS;
  protected readonly messageMax = REQUEST_MESSAGE_MAX;
  protected readonly slots = computed(() => routeSlots(this.detail().licence_route));

  protected readonly pickedSections = signal<ReadonlySet<SectionKey>>(new Set());
  protected readonly pickedSlots = signal<ReadonlySet<ApplicationDocumentSlot>>(new Set());
  protected readonly another = signal(false);
  protected readonly anotherLabel = signal('');
  protected readonly message = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly errors = signal<Record<string, string>>({});

  constructor() {
    // Each open starts afresh.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.pickedSections.set(new Set());
        this.pickedSlots.set(new Set());
        this.another.set(false);
        this.anotherLabel.set('');
        this.message.set('');
        this.error.set('');
        this.errors.set({});
      });
    });
  }

  protected close(): void {
    if (!this.saving()) this.closed.emit();
  }

  protected label(slot: ApplicationDocumentSlot): string {
    return slotLabel(slot, this.detail().licence_route);
  }

  protected toggleSection(key: SectionKey, on: boolean): void {
    this.pickedSections.update((s) => toggled(s, key, on));
    this.clearErr('items');
  }

  protected toggleSlot(slot: ApplicationDocumentSlot, on: boolean): void {
    this.pickedSlots.update((s) => toggled(s, slot, on));
    this.clearErr('items');
  }

  protected setAnother(on: boolean): void {
    this.another.set(on);
    this.clearErr('items');
    if (!on) this.clearErr('label');
    else afterNextRender(() => document.getElementById('bo-ri-another')?.focus(), { injector: this.injector });
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

  /** What is being asked for, in the order shown. */
  private items(): Item[] {
    const out: Item[] = [];
    for (const s of REQUESTABLE_SECTIONS) if (this.pickedSections().has(s.key)) out.push({ kind: 'section', key: s.key });
    for (const slot of this.slots()) if (this.pickedSlots().has(slot)) out.push({ kind: 'document', key: slot });
    if (this.another()) out.push({ kind: 'document', key: 'additional', label: this.anotherLabel().trim() });
    return out;
  }

  protected submit(): void {
    if (this.saving()) return;
    const items = this.items();
    const message = this.message().trim();
    const errors: Record<string, string> = {};
    if (items.length === 0) errors['items'] = 'Choose at least one section or document.';
    else if (items.length > REQUEST_ITEMS_MAX) errors['items'] = `Ask for at most ${REQUEST_ITEMS_MAX} items at a time.`;
    if (this.another()) {
      const len = this.anotherLabel().trim().length;
      if (len < 2 || len > 120) errors['label'] = 'Say which document you need (2–120 characters).';
    }
    if (!message) errors['message'] = 'Write a message to the applicant.';
    else if (message.length > REQUEST_MESSAGE_MAX) errors['message'] = `Keep the message to ${REQUEST_MESSAGE_MAX.toLocaleString('en-GB')} characters.`;
    this.errors.set(errors);
    this.error.set('');
    if (Object.keys(errors).length > 0) {
      this.focusFirstError();
      return;
    }
    this.saving.set(true);
    this.api
      .requestInfo(this.detail().id, { expected_status: this.detail().status, message, items })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.done.emit(res.data);
        },
        error: (err: unknown) => {
          this.saving.set(false);
          const fields = apiErrorFields(err);
          const mapped: Record<string, string> = {};
          for (const [key, msg] of Object.entries(fields)) {
            if (key === 'message') mapped['message'] = msg;
            else if (/^items\.\d+\.label$/.test(key)) mapped['label'] = msg;
            else if (key === 'items' || key.startsWith('items.')) mapped['items'] = msg;
          }
          this.errors.set(mapped);
          this.error.set(apiErrorMessage(err, 'Could not send the request.'));
          if (isConflict(err)) this.stale.emit();
          this.dialog()?.refocus();
        },
      });
  }

  private focusFirstError(): void {
    const e = this.errors();
    const id = e['items'] ? null : e['label'] ? 'bo-ri-another' : e['message'] ? 'bo-ri-message' : null;
    afterNextRender(
      () => {
        if (id) document.getElementById(id)?.focus();
        else document.querySelector<HTMLInputElement>('#bo-request-info-form input[type="checkbox"]')?.focus();
      },
      { injector: this.injector },
    );
  }
}

function toggled<T>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}
