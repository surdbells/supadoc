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
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { firstValueFrom, Subscription } from 'rxjs';
import {
  apiErrorFields,
  apiErrorMessage,
  AppointmentsApi,
  WalletApi,
} from '@supadoc/data-access';
import type {
  AddGuestParams,
  PatientGuestDto,
  PatientGuestListDto,
} from '@supadoc/models';
import {
  AlertComponent,
  ButtonComponent,
  ConfirmDetail,
  ConfirmDialogComponent,
  IconComponent,
} from '@supadoc/ui';
import { httpStatus } from '../call/call-helpers';
import {
  addGuestErrors,
  cleanGuestName,
  copyText,
  GUEST_NAME_MAX,
  GUEST_STATUS,
  guestInitials,
  guestIsFree,
  guestMoney,
  money,
  newGuestProblems,
  removalRefundNote,
  resendWait,
} from './guests';
import { loadPaystack } from './paystack';

/** How long "Link copied" stays on a button (ms). */
const COPIED_MS = 3000;

/**
 * The Guests panel on an appointment (GET/POST/DELETE .../guests): who is
 * invited, their status (invited / ready to join / joined) and whether they
 * are in the call now, each guest's personal link to copy, Resend (at most
 * every 2 minutes), Remove (confirmed first — their link stops working at once,
 * and a paid fee goes back to the wallet before the consultation starts), and
 * Add a guest (max 3; the guest fee from the wallet or by card, or free).
 * Guests can be changed while the consultation is pending, confirmed or
 * rescheduled and its join window hasn't closed (`can_manage`).
 */
@Component({
  selector: 'pat-guests-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AlertComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    IconComponent,
  ],
  host: { class: 'block' },
  template: `
    <section
      class="flex flex-col gap-4 rounded-card border border-haze bg-white p-6 shadow-card"
      aria-labelledby="guests-title"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h2
            id="guests-title"
            tabindex="-1"
            class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean outline-none"
          >
            <sd-icon name="users" [size]="20" />
            Guests
          </h2>
          <p class="font-sans text-caption text-slate">
            Invite up to {{ list()?.max_guests ?? 3 }} people to join this video
            consultation, each with their own link. Guests never see your health
            records.
          </p>
        </div>
        @if (list()?.can_add && !formOpen()) {
          <button
            type="button"
            class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
            [attr.aria-expanded]="formOpen()"
            aria-controls="add-guest-form"
            (click)="openForm()"
          >
            <sd-icon name="user-plus" [size]="18" />
            Add a guest
          </button>
        }
      </div>

      @if (notice(); as n) {
        <sd-alert [tone]="n.ok ? 'success' : 'error'">{{ n.text }}</sd-alert>
      }

      @if (loading() && !list()) {
        <div class="sd-shimmer h-16 rounded-field"></div>
      } @else if (loadError() && !list()) {
        <p
          class="flex items-start gap-2 font-sans text-caption text-alert"
          role="alert"
        >
          <sd-icon
            name="triangle-alert"
            [size]="16"
            class="mt-0.5 shrink-0"
          />{{ loadError() }}
        </p>
        <button
          type="button"
          class="min-h-11 w-fit rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
          (click)="load()"
        >
          Try again
        </button>
      } @else if (list(); as l) {
        @if (l.guests.length) {
          <ul class="flex flex-col gap-3">
            @for (g of l.guests; track g.id ?? g.email) {
              <li
                class="flex flex-col gap-3 rounded-field border border-cloud px-4 py-3 md:flex-row md:items-center md:justify-between"
              >
                <div class="flex min-w-0 items-start gap-3">
                  <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-frost/60 font-heading text-body-sm font-semibold text-cerulean-dark"
                    aria-hidden="true"
                  >
                    {{ initials(g.name) }}
                  </span>
                  <div class="flex min-w-0 flex-col gap-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span
                        class="min-w-0 break-words font-sans text-body-sm font-semibold text-ink"
                        >{{ g.name }}</span
                      >
                      <span
                        class="inline-flex items-center gap-1 rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-medium text-slate inset-ring inset-ring-current/20"
                      >
                        <sd-icon [name]="statusOf(g).icon" [size]="12" />{{
                          statusOf(g).label
                        }}
                      </span>
                      @if (inCall(g)) {
                        <span
                          class="inline-flex items-center gap-1 rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-caption font-medium text-sage-ink inset-ring inset-ring-current/20"
                        >
                          <span
                            class="size-1.5 rounded-full bg-sage"
                            aria-hidden="true"
                          ></span
                          >In the call
                        </span>
                      }
                    </span>
                    <span class="break-all font-sans text-caption text-slate">{{
                      g.email
                    }}</span>
                    @if (g.display_name && g.display_name !== g.name) {
                      <span class="font-sans text-caption text-slate"
                        >Shows in the call as “{{ g.display_name }}”</span
                      >
                    }
                    <span class="font-sans text-caption text-slate"
                      >Guest fee: {{ feeText(g, l) }}</span
                    >
                    @if (revealed() === g.id && g.join_url) {
                      <label class="mt-1 flex flex-col gap-1">
                        <span
                          class="font-sans text-caption font-semibold text-slate"
                          >Their personal link — share it with
                          {{ g.name }} only</span
                        >
                        <input
                          #revealedLink
                          type="text"
                          readonly
                          class="min-h-11 w-full rounded-field border border-cloud bg-glacier px-3 font-mono text-caption text-ink focus:border-cerulean focus:outline-none"
                          [value]="g.join_url"
                          (focus)="$any($event.target).select()"
                        />
                      </label>
                    }
                  </div>
                </div>
                @if (l.can_manage && g.id) {
                  <div
                    class="flex flex-wrap items-center gap-2 pl-[3.25rem] md:shrink-0 md:pl-0"
                  >
                    @if (g.join_url) {
                      <button
                        type="button"
                        class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-3 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:shadow-none"
                        [attr.aria-label]="
                          (copied() === g.id
                            ? 'Copied link for '
                            : 'Copy link for ') + g.name
                        "
                        (click)="copy(g)"
                      >
                        <sd-icon
                          [name]="copied() === g.id ? 'check' : 'copy'"
                          [size]="16"
                        />
                        {{ copied() === g.id ? 'Copied' : 'Copy link' }}
                      </button>
                    }
                    <button
                      type="button"
                      class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-3 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
                      [attr.aria-label]="
                        resendWaitOf(g)
                          ? 'Resend in ' + resendWaitOf(g) + ' to ' + g.name
                          : 'Resend invitation to ' + g.name
                      "
                      [disabled]="resending() === g.id || !!resendWaitOf(g)"
                      (click)="resend(g)"
                    >
                      <sd-icon
                        [name]="resending() === g.id ? 'loader-circle' : 'send'"
                        [size]="16"
                        [class.animate-spin]="resending() === g.id"
                      />
                      {{
                        resendWaitOf(g)
                          ? 'Resend in ' + resendWaitOf(g)
                          : 'Resend'
                      }}
                    </button>
                    <button
                      type="button"
                      class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-alert/40 px-3 font-sans text-caption font-semibold text-alert shadow-control transition hover:bg-alert/5 active:shadow-none disabled:shadow-none"
                      [attr.aria-label]="'Remove ' + g.name"
                      (click)="askRemove(g)"
                    >
                      <sd-icon name="user-minus" [size]="16" />Remove
                    </button>
                  </div>
                }
              </li>
            }
          </ul>
        } @else if (l.can_manage) {
          <p class="font-sans text-body-sm text-slate">No guests yet.</p>
        }

        @if (!l.can_manage && l.manage_problem && l.guests.length > 0) {
          <p class="flex items-start gap-2 font-sans text-caption text-slate">
            <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />{{
              l.manage_problem
            }}
          </p>
        }
        @if (l.can_manage && !l.can_add && l.guests.length >= l.max_guests) {
          <p class="flex items-start gap-2 font-sans text-caption text-slate">
            <sd-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
            You’ve invited the most guests a consultation can have ({{
              l.max_guests
            }}). Remove one to invite someone else.
          </p>
        }

        <!-- Add a guest -->
        @if (formOpen() && l.can_add) {
          <form
            id="add-guest-form"
            class="flex flex-col gap-4 rounded-card border border-cloud bg-glacier/50 p-4"
            novalidate
            (submit)="$event.preventDefault(); submit()"
          >
            <h3 class="font-sans text-body-sm font-semibold text-ink">
              Invite a guest
            </h3>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate"
                  >Full name</span
                >
                <input
                  #nameField
                  type="text"
                  autocomplete="off"
                  [attr.maxlength]="nameMax"
                  class="min-h-11 w-full rounded-field border bg-white px-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
                  [class]="nameError() ? 'border-alert' : 'border-cloud'"
                  [attr.aria-invalid]="!!nameError()"
                  [attr.aria-describedby]="
                    nameError() ? 'guest-name-error' : null
                  "
                  [value]="name()"
                  [disabled]="busy()"
                  (input)="setName($any($event.target).value)"
                />
                @if (nameError()) {
                  <span
                    id="guest-name-error"
                    class="font-sans text-caption text-alert"
                    >{{ nameError() }}</span
                  >
                }
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate"
                  >Email address</span
                >
                <input
                  #emailField
                  type="email"
                  autocomplete="off"
                  inputmode="email"
                  maxlength="190"
                  class="min-h-11 w-full rounded-field border bg-white px-3 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none"
                  [class]="emailError() ? 'border-alert' : 'border-cloud'"
                  [attr.aria-invalid]="!!emailError()"
                  [attr.aria-describedby]="
                    emailError() ? 'guest-email-error' : null
                  "
                  [value]="email()"
                  [disabled]="busy()"
                  (input)="setEmail($any($event.target).value)"
                />
                @if (emailError()) {
                  <span
                    id="guest-email-error"
                    class="font-sans text-caption text-alert"
                    >{{ emailError() }}</span
                  >
                }
              </label>
            </div>

            <div
              class="flex items-center justify-between gap-3 border-t border-cloud pt-3"
            >
              <span class="font-sans text-body-sm text-slate">Guest fee</span>
              <span class="font-heading text-h5 text-ink">{{
                feeLabel()
              }}</span>
            </div>

            @if (!free()) {
              <div
                class="flex flex-col gap-3"
                role="group"
                aria-labelledby="guest-pay-title"
              >
                <h4
                  id="guest-pay-title"
                  class="font-sans text-body-sm font-semibold text-ink"
                >
                  Pay with
                </h4>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    class="flex min-h-11 items-center gap-3 rounded-card border-2 bg-white p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                    [class]="
                      payMethod() === 'card'
                        ? 'border-cerulean bg-frost/30'
                        : 'border-cloud hover:border-cerulean/40'
                    "
                    [attr.aria-pressed]="payMethod() === 'card'"
                    [disabled]="busy()"
                    (click)="payMethod.set('card')"
                  >
                    <sd-icon
                      name="credit-card"
                      [size]="22"
                      class="shrink-0 text-cerulean"
                    />
                    <span class="flex min-w-0 flex-col">
                      <span
                        class="font-sans text-body-sm font-semibold text-ink"
                        >Card</span
                      >
                      <span class="font-sans text-caption text-slate"
                        >Secure checkout via Paystack</span
                      >
                    </span>
                    @if (payMethod() === 'card') {
                      <sd-icon
                        name="circle-check"
                        [size]="20"
                        class="ml-auto shrink-0 text-cerulean"
                      />
                    }
                  </button>
                  <!-- Not once the card has been charged: the wallet would pay twice. -->
                  <button
                    type="button"
                    class="flex min-h-11 items-center gap-3 rounded-card border-2 bg-white p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 disabled:cursor-not-allowed disabled:opacity-50"
                    [class]="
                      payMethod() === 'wallet'
                        ? 'border-cerulean bg-frost/30'
                        : 'border-cloud hover:border-cerulean/40'
                    "
                    [attr.aria-pressed]="payMethod() === 'wallet'"
                    [disabled]="busy() || !!paidRef()"
                    (click)="payMethod.set('wallet')"
                  >
                    <sd-icon
                      name="wallet"
                      [size]="22"
                      class="shrink-0 text-cerulean"
                    />
                    <span class="flex min-w-0 flex-col">
                      <span
                        class="font-sans text-body-sm font-semibold text-ink"
                        >Wallet</span
                      >
                      <span class="font-sans text-caption text-slate">{{
                        walletCaption()
                      }}</span>
                    </span>
                    @if (payMethod() === 'wallet') {
                      <sd-icon
                        name="circle-check"
                        [size]="20"
                        class="ml-auto shrink-0 text-cerulean"
                      />
                    }
                  </button>
                </div>
                @if (payMethod() === 'wallet' && walletShort()) {
                  <p
                    class="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-card bg-alert/5 px-4 py-3 font-sans text-caption text-alert"
                  >
                    <sd-icon
                      name="triangle-alert"
                      [size]="16"
                      class="mt-0.5 shrink-0"
                    />
                    <span class="min-w-0 flex-1">
                      Your wallet doesn’t cover the guest fee. Pay by card, or
                      <a
                        routerLink="/dashboard/wallet"
                        class="font-semibold text-cerulean underline"
                        >top up your wallet</a
                      >
                      and come back.
                    </span>
                  </p>
                }
                @if (payMethod() === 'card' && paidRef()) {
                  <p
                    class="flex items-start gap-2 rounded-card bg-glacier px-4 py-3 font-sans text-caption text-slate"
                  >
                    <sd-icon
                      name="info"
                      [size]="16"
                      class="mt-0.5 shrink-0 text-cerulean"
                    />
                    Your card payment went through, but the guest wasn’t added.
                    Fix what’s shown and try again — you won’t be charged twice.
                  </p>
                }
              </div>
            }

            @if (formError()) {
              <sd-alert tone="error">{{ formError() }}</sd-alert>
            }

            <p class="font-sans text-caption text-slate">
              We’ll email them their personal link, saying you invited them to
              your consultation with
              {{ doctorName() }}. They can join from 15 minutes before it
              starts.
            </p>

            <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                class="inline-flex min-h-11 items-center justify-center rounded-field border border-cloud px-5 font-sans text-body-sm font-semibold text-slate transition-colors hover:bg-glacier disabled:opacity-60"
                [disabled]="busy()"
                (click)="closeForm()"
              >
                Cancel
              </button>
              <sd-button type="submit" [disabled]="!canSubmit()">
                @if (busy()) {
                  <sd-icon
                    name="loader-circle"
                    [size]="18"
                    class="animate-spin"
                  />
                } @else {
                  <sd-icon name="send" [size]="18" />
                }
                {{ submitLabel() }}
              </sd-button>
            </div>
          </form>
        }
      }

      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {{ liveStatus() }}
      </p>
    </section>

    <!-- Remove a guest: confirmed first, with what happens to their fee -->
    <sd-confirm-dialog
      [open]="removeOpen()"
      tone="danger"
      icon="user-x"
      [title]="'Remove ' + (removing()?.name ?? 'this guest') + '?'"
      [message]="removeMessage()"
      [details]="removeDetails()"
      confirmLabel="Remove guest"
      cancelLabel="Keep guest"
      busyLabel="Removing…"
      [busy]="removeBusy()"
      [error]="removeError() || null"
      (confirm)="confirmRemove()"
      (cancel)="closeRemove()"
      (afterClose)="afterRemoveClosed()"
    />
  `,
})
export class GuestsPanel {
  private readonly appointments = inject(AppointmentsApi);
  private readonly walletApi = inject(WalletApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  /** The appointment whose guests these are. */
  readonly appointmentId = input.required<string>();
  /** "Dr Ada Obi" — named in the form's note. */
  readonly doctorName = input('your doctor');
  /** Guest ids in the call right now (the page's presence poll). */
  readonly liveGuestIds = input<readonly string[]>([]);
  /** Changes when the appointment does (status, time) — the list is read again. */
  readonly version = input('');
  /** A guest was added or removed (the page re-reads the appointment's guest names). */
  readonly changed = output<void>();

  private readonly nameField =
    viewChild<ElementRef<HTMLInputElement>>('nameField');
  private readonly emailField =
    viewChild<ElementRef<HTMLInputElement>>('emailField');
  private readonly revealedLink =
    viewChild<ElementRef<HTMLInputElement>>('revealedLink');

  protected readonly nameMax = GUEST_NAME_MAX;
  protected readonly list = signal<PatientGuestListDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly notice = signal<{ ok: boolean; text: string } | null>(
    null,
  );
  protected readonly liveStatus = signal('');
  /** Ticks every second: resend countdowns, and whether a removal still refunds. */
  private readonly clock = signal(Date.now());
  private loadSub?: Subscription;

  // Copy / reveal a guest's link
  protected readonly copied = signal('');
  protected readonly revealed = signal('');
  private copiedTimer?: ReturnType<typeof setTimeout>;

  // Resend
  protected readonly resending = signal('');

  // Add
  protected readonly formOpen = signal(false);
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly nameError = signal('');
  protected readonly emailError = signal('');
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly payMethod = signal<'card' | 'wallet'>('card');
  /** A card payment that went through for a guest the server then refused — reused, never charged twice. */
  protected readonly paidRef = signal('');
  private readonly walletBalance = signal<number | null>(null);
  private readonly walletFailed = signal(false);
  private opener: HTMLElement | null = null;

  // Remove
  /** The guest being asked about (kept while the dialog animates out). */
  protected readonly removing = signal<PatientGuestDto | null>(null);
  protected readonly removeOpen = signal(false);
  /** The removal went through: their row (the dialog's opener) is gone. */
  private removeGone = false;
  protected readonly removeBusy = signal(false);
  protected readonly removeError = signal('');

  protected readonly free = computed(() => guestIsFree(this.list()));
  protected readonly feeLabel = computed(() => {
    const l = this.list();
    return l ? guestMoney(l.guest_fee, l.currency) : '…';
  });
  protected readonly walletCaption = computed(() => {
    if (this.walletFailed()) return 'Balance unavailable';
    const b = this.walletBalance();
    return b === null
      ? 'Balance …'
      : `Balance ${money(b, this.list()?.currency)}`;
  });
  protected readonly walletShort = computed(() => {
    const b = this.walletBalance();
    return b !== null && b < Number(this.list()?.guest_fee ?? 0);
  });
  protected readonly canSubmit = computed(() => {
    if (this.busy()) return false;
    if (this.free() || this.payMethod() === 'card') return true;
    return (
      this.walletFailed() ||
      (this.walletBalance() !== null && !this.walletShort())
    );
  });
  protected readonly submitLabel = computed(() => {
    if (this.busy()) return 'Inviting…';
    if (this.free()) return 'Send invite';
    if (this.payMethod() === 'wallet')
      return `Pay ${this.feeLabel()} from wallet & invite`;
    return this.paidRef()
      ? 'Finish inviting'
      : `Pay ${this.feeLabel()} by card & invite`;
  });
  /** What removing them does — with what happens to a paid fee (refunded before the consultation starts). */
  protected readonly removeMessage = computed(() => {
    const g = this.removing();
    const l = this.list();
    const refund = g && l ? removalRefundNote(g, l, this.clock()) : '';
    return `Their link stops working straight away, and we’ll email them that the invitation was withdrawn.${refund ? ` ${refund}` : ''}`;
  });
  /** The guest, and their fee when they paid one. */
  protected readonly removeDetails = computed<ConfirmDetail[]>(() => {
    const g = this.removing();
    const l = this.list();
    if (!g) return [];
    const details: ConfirmDetail[] = [
      { label: 'Guest', value: g.email ? `${g.name} (${g.email})` : g.name },
    ];
    if (l && Number(g.fee) > 0 && g.paid_by !== 'free') {
      details.push({
        label: 'Guest fee',
        value: guestMoney(g.fee, l.currency),
      });
    }
    return details;
  });

  constructor() {
    // (Re)load whenever the appointment — or its status / time — changes.
    effect(() => {
      const id = this.appointmentId();
      this.version();
      if (!id) return;
      untracked(() => this.load());
    });
    const tick = setInterval(() => this.clock.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      clearTimeout(this.copiedTimer);
      this.loadSub?.unsubscribe();
    });
  }

  protected load(): void {
    const id = this.appointmentId();
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.loadError.set('');
    this.loadSub = this.appointments
      .guests(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.list.set(res.data);
          this.loading.set(false);
          if (!res.data.can_add && this.formOpen() && !this.busy())
            this.closeStaleForm();
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.loadError.set(
            apiErrorMessage(err, 'Could not load your guests.'),
          );
        },
      });
  }

  protected statusOf(g: PatientGuestDto): { label: string; icon: string } {
    return GUEST_STATUS[g.status] ?? GUEST_STATUS.invited;
  }

  protected initials(name: string): string {
    return guestInitials(name);
  }

  /**
   * In the call now: the page's live presence poll only (`in_call` is a
   * snapshot from when the list loaded, and would stay on after they leave).
   */
  protected inCall(g: PatientGuestDto): boolean {
    return !!g.id && this.liveGuestIds().includes(g.id);
  }

  protected feeText(g: PatientGuestDto, l: PatientGuestListDto): string {
    const money = guestMoney(g.fee, l.currency);
    if (money === 'Free' || g.paid_by === 'free') return 'Free';
    const how = {
      booking: 'paid with your booking',
      wallet: 'paid from your wallet',
      card: 'paid by card',
    }[g.paid_by];
    return how ? `${money}, ${how}` : money;
  }

  protected resendWaitOf(g: PatientGuestDto): string {
    return resendWait(g, this.clock());
  }

  // ---- Copy a link ----

  protected async copy(g: PatientGuestDto): Promise<void> {
    if (!g.id || !g.join_url) return;
    const ok = await copyText(g.join_url);
    clearTimeout(this.copiedTimer);
    if (ok) {
      this.copied.set(g.id);
      this.liveStatus.set(`${g.name}’s link copied. Share it with them only.`);
      this.copiedTimer = setTimeout(() => this.copied.set(''), COPIED_MS);
      return;
    }
    // No clipboard: show the link to copy by hand.
    this.revealed.set(g.id);
    this.liveStatus.set(
      'Couldn’t copy automatically — the link is shown to copy.',
    );
    afterNextRender(() => this.revealedLink()?.nativeElement.select(), {
      injector: this.injector,
    });
  }

  // ---- Resend ----

  protected resend(g: PatientGuestDto): void {
    if (!g.id || this.resending() || this.resendWaitOf(g)) return;
    const name = g.name;
    this.resending.set(g.id);
    this.notice.set(null);
    this.appointments
      .resendGuestInvite(this.appointmentId(), g.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.resending.set('');
          this.list.set(res.data);
          this.notice.set({
            ok: true,
            text: `We’ve emailed ${name} their invitation again.`,
          });
        },
        error: (err: unknown) => {
          this.resending.set('');
          this.notice.set({
            ok: false,
            text: apiErrorMessage(
              err,
              'Could not resend the invitation. Please try again.',
            ),
          });
          // Too soon (429) or the list changed: show when it can be sent.
          if (
            httpStatus(err) === 429 ||
            httpStatus(err) === 404 ||
            apiErrorFields(err)['status']
          )
            this.load();
        },
      });
  }

  // ---- Add ----

  protected openForm(): void {
    this.rememberOpener();
    this.formOpen.set(true);
    this.formError.set('');
    this.notice.set(null);
    if (!this.free() && this.walletBalance() === null) this.loadWallet();
    afterNextRender(() => this.nameField()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected closeForm(): void {
    if (this.busy()) return;
    this.formOpen.set(false);
    this.resetForm();
    const back = this.opener;
    this.opener = null;
    afterNextRender(
      () =>
        (back?.isConnected
          ? back
          : this.document.getElementById('guests-title')
        )?.focus(),
      {
        injector: this.injector,
      },
    );
  }

  protected setName(v: string): void {
    this.name.set(v);
    if (this.nameError()) this.nameError.set('');
  }

  protected setEmail(v: string): void {
    this.email.set(v);
    if (this.emailError()) this.emailError.set('');
  }

  private resetForm(): void {
    this.name.set('');
    this.email.set('');
    this.nameError.set('');
    this.emailError.set('');
    this.formError.set('');
  }

  /**
   * No guest can be added any more (the list is full — e.g. from the in-call
   * dialog — or the window closed): the form goes, but not its last error, nor
   * a card payment that went through for the refused guest. Those move to the
   * panel's notice, with the payment reference. The reference is kept, so a
   * guest added later uses it instead of charging the card again.
   */
  private closeStaleForm(): void {
    const error = this.formError();
    const ref = this.paidRef();
    // Focus in the form (or lost to the page while a refused add was busy) goes to the heading.
    const active = this.document.activeElement;
    const moveFocus =
      !!active?.closest('#add-guest-form') ||
      ((!active || active === this.document.body) && !!(error || ref));
    this.formOpen.set(false);
    this.resetForm();
    this.opener = null;
    if (error || ref) {
      const paid = ref
        ? ` Your card payment (reference ${ref}) went through, but the guest wasn’t added — contact support with this reference if it isn’t back in your wallet.`
        : '';
      this.notice.set({
        ok: false,
        text: `${error || 'The guest couldn’t be added.'}${paid}`,
      });
    }
    if (moveFocus) {
      afterNextRender(
        () => this.document.getElementById('guests-title')?.focus(),
        { injector: this.injector },
      );
    }
  }

  private loadWallet(): void {
    this.walletApi
      .wallet()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.walletBalance.set(Number(res.data.balance));
          this.walletFailed.set(false);
        },
        error: () => this.walletFailed.set(true),
      });
  }

  /** Free → straight away; wallet → debited by the server; card → Paystack, then the reference. */
  protected async submit(): Promise<void> {
    const l = this.list();
    if (!l || !this.canSubmit()) return;
    const name = cleanGuestName(this.name());
    const email = this.email().trim();
    const problems = newGuestProblems(name, email, l.guests);
    this.nameError.set(problems.name ?? '');
    this.emailError.set(problems.email ?? '');
    if (problems.name || problems.email) {
      (problems.name
        ? this.nameField()
        : this.emailField()
      )?.nativeElement.focus();
      return;
    }
    this.busy.set(true);
    this.formError.set('');
    if (this.free()) return this.send({ name, email });
    if (this.payMethod() === 'wallet')
      return this.send({ name, email, payment_method: 'wallet' });
    const kept = this.paidRef();
    if (kept)
      return this.send({
        name,
        email,
        payment_method: 'card',
        payment_reference: kept,
      });
    try {
      const init = await firstValueFrom(
        this.appointments.payInitForGuest(this.appointmentId()),
      );
      const Pop = await loadPaystack();
      new Pop().resumeTransaction(init.data.access_code, {
        onSuccess: () => {
          this.paidRef.set(init.data.reference);
          this.send({
            name,
            email,
            payment_method: 'card',
            payment_reference: init.data.reference,
          });
        },
        onCancel: () => {
          this.busy.set(false);
          this.formError.set(
            'Payment cancelled — nothing was charged. Try again when you’re ready.',
          );
        },
        onError: () => {
          this.busy.set(false);
          this.formError.set(
            'The payment could not be completed. Please try again.',
          );
        },
      });
    } catch (err) {
      // `payment: free` is a flag: nothing to pay after all.
      if (apiErrorFields(err)['payment'] === 'free') {
        this.send({ name, email });
        return;
      }
      this.busy.set(false);
      this.formError.set(
        apiErrorMessage(
          err,
          'Could not start the card payment. Please try again.',
        ),
      );
      if (apiErrorFields(err)['status'] || apiErrorFields(err)['guests'])
        this.load();
    }
  }

  private send(params: AddGuestParams): void {
    this.appointments
      .addGuest(this.appointmentId(), params)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.paidRef.set('');
          this.list.set(res.data);
          const g = res.data.guest;
          this.formOpen.set(false);
          this.resetForm();
          this.opener = null;
          this.notice.set({
            ok: true,
            text: `${g.name} is invited — we’ve emailed them their personal link. You can also copy it here.`,
          });
          if (params.payment_method === 'wallet') this.loadWallet();
          this.changed.emit();
          afterNextRender(
            () => this.document.getElementById('guests-title')?.focus(),
            { injector: this.injector },
          );
        },
        error: (err: unknown) => {
          this.busy.set(false);
          const e = addGuestErrors(err);
          this.nameError.set(e.name ?? '');
          this.emailError.set(e.email ?? '');
          this.formError.set(e.general);
          if (e.walletShort) {
            this.walletBalance.set(
              Math.max(0, Number(this.list()?.guest_fee ?? 0) - 0.01),
            );
            this.loadWallet();
          }
          if (e.credited) {
            // The payment is in the wallet now; the wallet can pay next time.
            this.paidRef.set('');
            this.payMethod.set('wallet');
            this.loadWallet();
          } else if (params.payment_reference && e.paymentRefused) {
            this.paidRef.set('');
            this.formError.set(
              `${e.paymentRefused} Your card payment (reference ${params.payment_reference}) couldn’t be used — contact support about it.`,
            );
          }
          if (e.stale) this.load();
          if (e.name) this.nameField()?.nativeElement.focus();
          else if (e.email) this.emailField()?.nativeElement.focus();
        },
      });
  }

  // ---- Remove (the shared confirm dialog: focus, Esc, busy and errors are its own) ----

  protected askRemove(g: PatientGuestDto): void {
    this.removeError.set('');
    this.removeGone = false;
    this.removing.set(g);
    this.removeOpen.set(true);
  }

  protected closeRemove(): void {
    if (this.removeBusy()) return;
    this.removeOpen.set(false);
  }

  protected confirmRemove(): void {
    const g = this.removing();
    if (!g?.id || this.removeBusy()) return;
    const currency = this.list()?.currency;
    this.removeBusy.set(true);
    this.removeError.set('');
    this.appointments
      .removeGuest(this.appointmentId(), g.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.removeBusy.set(false);
          this.list.set(res.data);
          const refunded =
            res.data.refunded && Number(res.data.refunded) > 0
              ? guestMoney(res.data.refunded, currency)
              : '';
          this.notice.set({
            ok: true,
            text: refunded
              ? `${res.data.removed.name} was removed and ${refunded} was refunded to your wallet. Their link no longer works.`
              : `${res.data.removed.name} was removed. Their link no longer works.`,
          });
          // Their row (and its Remove button, which opened the dialog) is gone.
          this.removeGone = true;
          this.removeOpen.set(false);
          this.changed.emit();
        },
        error: (err: unknown) => {
          this.removeBusy.set(false);
          this.removeError.set(
            apiErrorMessage(
              err,
              'Could not remove the guest. Please try again.',
            ),
          );
          if (httpStatus(err) === 404 || apiErrorFields(err)['status'])
            this.load();
        },
      });
  }

  /** The dialog has gone: forget the guest, and say where things are when their row went with it. */
  protected afterRemoveClosed(): void {
    this.removing.set(null);
    if (!this.removeGone) return;
    this.removeGone = false;
    setTimeout(() => {
      const active = this.document.activeElement;
      if (!active || active === this.document.body)
        this.document.getElementById('guests-title')?.focus();
    });
  }

  private rememberOpener(): void {
    const active = this.document.activeElement;
    this.opener =
      active instanceof HTMLElement && active !== this.document.body
        ? active
        : null;
  }
}
