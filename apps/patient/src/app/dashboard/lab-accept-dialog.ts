import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  linkedSignal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  apiErrorCode,
  apiErrorFields,
  apiErrorMessage,
  LabRequestsApi,
  todayLocal,
} from '@supadoc/data-access';
import type {
  AcceptLabRequestInput,
  LabConsentStatement,
  PatientLabRequestDto,
} from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { calendarDate, labDoctorCap } from './lab-ui';

/** The confirm dialog's own button look (`sd-confirm-dialog`). */
const BUTTON =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-field px-4 py-3 font-sans text-body font-semibold ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring) focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-(--sd-dialog-surface) aria-disabled:cursor-not-allowed aria-disabled:opacity-60';
const FIELD =
  'w-full rounded-[12px] border bg-(--sd-dialog-surface) px-3.5 py-2.5 font-sans text-body text-(--sd-dialog-text) ' +
  'placeholder:text-(--sd-dialog-muted) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--sd-dialog-ring)';

export const LAB_REQUIRED_TICKS = 'Tick the three required boxes to accept.';
export const LAB_CONSENT_CHANGED =
  'The consent wording has changed. Please review it again.';
const LAB_NAME_MAX = 120;

/**
 * "Accept this lab request?" (spec §4.4) — the consent the API serves,
 * versioned, in its order and as text: the three required statements start
 * unticked, the results share starts ticked. The optional lab and date are
 * sent only when given; the date is a calendar date between today and the
 * request's last valid day (`valid_until`, no zone conversion). A changed
 * consent wording (409 `consent_changed`) reloads the request and asks again.
 */
@Component({
  selector: 'pat-lab-accept-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  template: `
    <sd-dialog
      [open]="open()"
      title="Accept this lab request?"
      size="md"
      [busy]="saving()"
      (closed)="close()"
      (afterClose)="closed.emit()"
    >
      <form
        id="lab-accept-form"
        class="flex flex-col gap-5"
        novalidate
        (submit)="submit($event)"
      >
        @if (notice()) {
          <p
            class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-info-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-info-text)"
            role="alert"
          >
            <sd-icon name="info" [size]="18" class="mt-0.5 shrink-0" />{{
              notice()
            }}
          </p>
        }

        <fieldset
          class="flex flex-col gap-3"
          [attr.aria-describedby]="
            showRequired() ? 'lab-accept-required' : null
          "
        >
          <legend class="sr-only">Your consent</legend>
          <!-- A new wording (a 409 reload) draws new boxes from its served defaults; the same
               request reloaded (e.g. as the dialog closes) keeps its boxes. Keyed, not tracked by
               identity: Angular re-keys old items with today's state, and warns (NG0956) when an
               identity-tracked list is redrawn whole. -->
          @for (v of [consentVersion()]; track 'wording:' + v) {
          @for (s of statements(); track s.key) {
            <label
              class="flex cursor-pointer items-start gap-3 rounded-card border border-(--sd-dialog-border) p-3 hover:bg-(--sd-dialog-hover)"
            >
              <input
                type="checkbox"
                class="mt-0.5 size-5 shrink-0 accent-cerulean"
                [attr.data-key]="s.key"
                [checked]="!!ticks()[s.key]"
                [attr.aria-required]="s.required || null"
                [attr.aria-invalid]="
                  (showRequired() && s.required && !ticks()[s.key]) || null
                "
                [disabled]="saving()"
                (change)="tick(s.key, $any($event.target).checked)"
              />
              <span class="flex min-w-0 flex-col gap-1">
                <span class="font-sans text-body-sm text-(--sd-dialog-text)">
                  {{ s.text }}
                  @if (s.required) {
                    <span class="text-(--sd-dialog-muted)">(required)</span>
                  }
                </span>
                @if (s.key === 'share_results') {
                  <span class="font-sans text-caption text-(--sd-dialog-muted)"
                    >{{ doctor() }} can view and print the files in VideoMed,
                    but not download them.</span
                  >
                }
              </span>
            </label>
          }
          }
        </fieldset>
        @if (showRequired()) {
          <p
            id="lab-accept-required"
            class="font-sans text-body-sm text-(--sd-dialog-danger-text)"
            role="alert"
          >
            {{ requiredText }}
          </p>
        }

        <div class="flex flex-col gap-1.5">
          <label
            for="lab-accept-name"
            class="font-sans text-body-sm font-semibold text-(--sd-dialog-text)"
          >
            Lab or imaging centre
            <span class="font-normal text-(--sd-dialog-muted)">(optional)</span>
          </label>
          <input
            id="lab-accept-name"
            type="text"
            autocomplete="off"
            [class]="
              FIELD +
              (nameError()
                ? ' border-(--sd-dialog-danger)'
                : ' border-(--sd-dialog-field)')
            "
            [attr.maxlength]="nameMax"
            [attr.aria-invalid]="!!nameError() || null"
            [attr.aria-describedby]="
              nameError() ? 'lab-accept-name-error' : null
            "
            [value]="labName()"
            [readOnly]="saving()"
            (input)="labName.set($any($event.target).value)"
          />
          @if (nameError()) {
            <p
              id="lab-accept-name-error"
              class="font-sans text-caption text-(--sd-dialog-danger-text)"
            >
              {{ nameError() }}
            </p>
          }
        </div>

        <div class="flex flex-col gap-1.5">
          <label
            for="lab-accept-date"
            class="font-sans text-body-sm font-semibold text-(--sd-dialog-text)"
          >
            When are you going?
            <span class="font-normal text-(--sd-dialog-muted)">(optional)</span>
          </label>
          <input
            id="lab-accept-date"
            type="date"
            [class]="
              FIELD +
              ' min-h-11' +
              (dateError()
                ? ' border-(--sd-dialog-danger)'
                : ' border-(--sd-dialog-field)')
            "
            [attr.min]="minDate()"
            [attr.max]="maxDate()"
            [attr.aria-invalid]="!!dateError() || null"
            [attr.aria-describedby]="
              dateError()
                ? 'lab-accept-date-hint lab-accept-date-error'
                : 'lab-accept-date-hint'
            "
            [value]="labDate()"
            [readOnly]="saving()"
            (input)="labDate.set($any($event.target).value)"
          />
          <p
            id="lab-accept-date-hint"
            class="font-sans text-caption text-(--sd-dialog-muted)"
          >
            Before {{ validUntil() }}
          </p>
          @if (dateError()) {
            <p
              id="lab-accept-date-error"
              class="font-sans text-caption text-(--sd-dialog-danger-text)"
            >
              {{ dateError() }}
            </p>
          }
        </div>

        @if (error()) {
          <p
            class="flex items-start gap-2 rounded-[12px] bg-(--sd-dialog-danger-soft) px-3.5 py-2.5 font-sans text-body-sm text-(--sd-dialog-danger-text)"
            role="alert"
          >
            <sd-icon
              name="circle-alert"
              [size]="18"
              class="mt-0.5 shrink-0"
            />{{ error() }}
          </p>
        }
        <p class="sr-only" aria-live="polite">
          {{ saving() ? 'Accepting…' : '' }}
        </p>
      </form>

      <div
        dialogFooter
        class="flex shrink-0 flex-col-reverse gap-3 px-5 pt-4 pb-5 sm:flex-row sm:px-6 sm:pb-6"
      >
        <button
          type="button"
          [class]="cancelClass"
          [attr.aria-disabled]="saving() || null"
          (click)="close()"
        >
          Cancel
        </button>
        <button
          type="submit"
          form="lab-accept-form"
          [class]="confirmClass"
          [attr.aria-disabled]="saving() || null"
        >
          @if (saving()) {
            <sd-icon
              name="loader-circle"
              [size]="18"
              class="motion-safe:animate-spin"
            />
          }
          Accept request
        </button>
      </div>
    </sd-dialog>
  `,
})
export class LabAcceptDialog {
  private readonly api = inject(LabRequestsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** The request being answered (reloaded by the host after a 409). */
  readonly request = input.required<PatientLabRequestDto>();

  /** Accepted: the request as the API answered it. */
  readonly accepted = output<PatientLabRequestDto>();
  /** The request changed under the dialog (409): the host reloads it. */
  readonly stale = output<void>();
  /** It can no longer be accepted (409 `status_changed` / `expired`): the page says why and reloads. */
  readonly refused = output<string>();
  /** The dialog has closed (after its exit animation). */
  readonly closed = output<void>();

  protected readonly FIELD = FIELD;
  protected readonly cancelClass =
    `${BUTTON} border border-(--sd-dialog-border) bg-(--sd-dialog-surface) text-(--sd-dialog-muted) ` +
    'hover:bg-(--sd-dialog-hover) hover:text-(--sd-dialog-text)';
  protected readonly confirmClass = `${BUTTON} text-(--sd-dialog-on-accent) bg-(--sd-dialog-primary) hover:bg-(--sd-dialog-primary-hover) inset-shadow-rim shadow-control`;
  protected readonly requiredText = LAB_REQUIRED_TICKS;
  protected readonly nameMax = LAB_NAME_MAX;

  protected readonly open = signal(true);
  protected readonly saving = signal(false);
  protected readonly labName = signal('');
  protected readonly labDate = signal('');
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly nameError = signal('');
  protected readonly dateError = signal('');

  protected readonly statements = computed<readonly LabConsentStatement[]>(
    () => this.request().consent_statements ?? [],
  );
  protected readonly doctor = computed(() => labDoctorCap(this.request()));
  protected readonly validUntil = computed(() =>
    calendarDate(this.request().valid_until),
  );
  /** The raw `Y-m-d` (no conversion): the last day the server takes. */
  protected readonly maxDate = computed(() =>
    /^\d{4}-\d{2}-\d{2}$/.test(this.request().valid_until)
      ? this.request().valid_until
      : null,
  );
  /** Today on the device's calendar (never after the last valid day). */
  protected readonly minDate = computed(() => {
    const today = todayLocal();
    const max = this.maxDate();
    return max && today > max ? max : today;
  });
  /**
   * The wording shown. A computed, so the same request reloaded (a new object,
   * same version) is no change: a linkedSignal re-runs whenever a signal its
   * source reads changes, even when the source's value is equal.
   */
  protected readonly consentVersion = computed(
    () => this.request().consent_version,
  );
  /** The boxes: the served defaults, afresh for every consent wording shown (a 409 reload brings a new one). */
  protected readonly ticks = linkedSignal<string, Record<string, boolean>>({
    source: this.consentVersion,
    computation: () =>
      Object.fromEntries(
        untracked(this.statements).map((s) => [s.key, !!s.default]),
      ),
  });
  /** Accept was pressed (shows what is missing) — reset with the wording. */
  protected readonly tried = linkedSignal<string, boolean>({
    source: this.consentVersion,
    computation: () => false,
  });
  private readonly missingRequired = computed(() =>
    this.statements().some((s) => s.required && !this.ticks()[s.key]),
  );
  protected readonly showRequired = computed(
    () => this.tried() && this.missingRequired(),
  );

  protected tick(key: string, on: boolean): void {
    this.ticks.update((t) => ({ ...t, [key]: on }));
  }

  protected close(): void {
    if (this.saving()) return;
    this.open.set(false);
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    if (this.saving()) return;
    this.tried.set(true);
    this.error.set('');
    this.nameError.set('');
    this.dateError.set('');
    if (this.missingRequired()) return;

    const r = this.request();
    const name = this.labName().trim();
    const date = this.labDate().trim();
    const body: AcceptLabRequestInput = {
      consent_version: r.consent_version,
      agree_tests: true,
      agree_pays_lab: true,
      agree_disclosure: true,
      share_results: !!this.ticks()['share_results'],
      ...(name ? { lab_name: name } : {}),
      ...(date ? { lab_date: date } : {}),
    };
    this.saving.set(true);
    this.api
      .accept(r.id, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saving.set(false);
          this.accepted.emit(res.data);
          this.open.set(false);
        },
        error: (err: unknown) => {
          this.saving.set(false);
          const fields = apiErrorFields(err);
          if (apiErrorCode(err) === 'consent_changed') {
            // The host reloads; the new wording comes back through `request` and is asked again.
            this.notice.set(LAB_CONSENT_CHANGED);
            this.stale.emit();
            return;
          }
          if (fields['lab_date'] || fields['lab_name'] || fields['agree']) {
            this.dateError.set(fields['lab_date'] ?? '');
            this.nameError.set(fields['lab_name'] ?? '');
            if (fields['agree']) this.error.set(fields['agree']);
            return;
          }
          const message = apiErrorMessage(
            err,
            "We couldn't accept this request. Please try again.",
          );
          if (httpStatus(err) === 409) {
            // Cancelled or expired meanwhile: nothing to accept any more.
            this.refused.emit(message);
            this.open.set(false);
            return;
          }
          this.error.set(message);
        },
      });
  }
}

function httpStatus(err: unknown): number | null {
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : null;
}
