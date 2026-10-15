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
import { apiErrorMessage, AppointmentsApi, WalletApi } from '@supadoc/data-access';
import type { PatientGuestDto, PatientGuestListDto } from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import {
  addGuestErrors,
  cleanGuestName,
  copyText,
  GUEST_NAME_MAX,
  GUEST_STATUS,
  guestIsFree,
  guestMoney,
  money,
  newGuestProblems,
} from './guests';

/**
 * "Invite someone" during the call: who is invited already (and in the call
 * now), each guest's link to copy, and adding one more — free, or paid from
 * the wallet (a card checkout would take the patient away from the call, so
 * card payment is on the appointment page, opened in a new tab). Shows the new
 * guest's personal link to copy as well as emailing it. Rendered while open,
 * on the shared dialog (top layer, focus to its heading, Esc, focus back to
 * the button that opened it) in the call's dark colours.
 */
@Component({
  selector: 'pat-invite-guest-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  template: `
    <!-- The call's dark theme, painted over the shared dialog's surface -->
    <sd-dialog
      [open]="true"
      layout="plain"
      size="sm"
      labelledBy="invite-title"
      describedBy="invite-desc"
      [busy]="busy()"
      (closed)="close()"
    >
      <div class="flex min-h-full flex-col gap-4 bg-abyss p-5 text-white sm:p-6">
        <div class="flex items-center justify-between gap-3">
          <h2 #title id="invite-title" tabindex="-1" data-autofocus class="flex items-center gap-2 font-heading text-h5 text-white outline-none">
            <sd-icon name="user-plus" [size]="22" class="text-frost" />
            Invite someone
          </h2>
          <button
            type="button"
            class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close"
            (click)="close()"
          >
            <sd-icon name="x" [size]="22" />
          </button>
        </div>
        <p id="invite-desc" class="font-sans text-body-sm text-white/70">
          They’ll get an email with their own link to this consultation, and can join from 15 minutes before the
          start until an hour after it ends. Guests see and hear the call — never your health records.
        </p>

        @if (loading() && !list()) {
          <div class="flex items-center gap-2 font-sans text-body-sm text-white/70" role="status">
            <sd-icon name="loader-circle" [size]="18" class="animate-spin" /> Loading your guests…
          </div>
        } @else if (loadError() && !list()) {
          <p class="flex items-start gap-2 font-sans text-body-sm text-alert" role="alert">
            <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0" />{{ loadError() }}
          </p>
          <button
            type="button"
            class="min-h-11 w-fit rounded-field border border-white/15 px-4 font-sans text-body-sm font-semibold text-white/85 transition-colors hover:bg-white/10"
            (click)="load()"
          >
            Try again
          </button>
        } @else if (list(); as l) {
          <!-- Just invited: their link, to copy -->
          @if (justAdded(); as g) {
            <div class="flex flex-col gap-2 rounded-2xl border border-success/40 bg-success/10 p-3" role="status">
              <p class="flex items-start gap-2 font-sans text-body-sm text-white">
                <sd-icon name="circle-check" [size]="18" class="mt-0.5 shrink-0 text-success" />
                {{ g.name }} is invited — we’ve emailed them their link.
              </p>
              @if (g.join_url) {
                <label class="flex flex-col gap-1">
                  <span class="font-sans text-caption text-white/60">Their personal link — share it with {{ g.name }} only</span>
                  <span class="flex items-center gap-2">
                    <input
                      type="text"
                      readonly
                      class="min-h-11 min-w-0 flex-1 rounded-field border border-white/15 bg-white/5 px-3 font-mono text-caption text-white focus:border-sky focus:outline-none"
                      [value]="g.join_url"
                      (focus)="$any($event.target).select()"
                    />
                    <button
                      type="button"
                      class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-field bg-white/15 px-3 font-sans text-caption font-semibold text-white transition-colors hover:bg-white/25"
                      (click)="copy(g)"
                    >
                      <sd-icon [name]="copied() === g.id ? 'check' : 'copy'" [size]="16" />
                      {{ copied() === g.id ? 'Copied' : 'Copy' }}
                    </button>
                  </span>
                </label>
              }
            </div>
          }

          <!-- Already invited -->
          @if (l.guests.length) {
            <ul class="flex flex-col divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.04]">
              @for (g of l.guests; track g.id ?? g.email) {
                <li class="flex items-center gap-3 px-3 py-2.5">
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-sans text-body-sm font-medium text-white">{{ g.name }}</span>
                    <span class="flex items-center gap-1 font-sans text-caption text-white/60">
                      @if (inCall(g)) {
                        <span class="size-1.5 rounded-full bg-success" aria-hidden="true"></span>In the call
                      } @else {
                        <sd-icon [name]="statusOf(g).icon" [size]="12" />{{ statusOf(g).label }}
                      }
                    </span>
                  </span>
                  @if (g.join_url && g.id !== justAdded()?.id) {
                    <button
                      type="button"
                      class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-field border border-white/15 px-3 font-sans text-caption font-semibold text-white/85 transition-colors hover:bg-white/10"
                      [attr.aria-label]="(copied() === g.id ? 'Copied link for ' : 'Copy link for ') + g.name"
                      (click)="copy(g)"
                    >
                      <sd-icon [name]="copied() === g.id ? 'check' : 'copy'" [size]="16" />
                      {{ copied() === g.id ? 'Copied' : 'Copy link' }}
                    </button>
                  }
                </li>
              }
            </ul>
          }

          @if (l.can_add) {
            <form class="flex flex-col gap-3" novalidate (submit)="$event.preventDefault(); submit()">
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-white/70">Their full name</span>
                <input
                  #nameField
                  type="text"
                  autocomplete="off"
                  [attr.maxlength]="nameMax"
                  class="min-h-11 w-full rounded-field border bg-white/5 px-3 font-sans text-body-sm text-white placeholder:text-white/40 focus:border-sky focus:outline-none"
                  [class]="nameError() ? 'border-alert' : 'border-white/15'"
                  [attr.aria-invalid]="!!nameError()"
                  [attr.aria-describedby]="nameError() ? 'invite-name-error' : null"
                  [value]="name()"
                  [disabled]="busy()"
                  (input)="setName($any($event.target).value)"
                />
                @if (nameError()) {
                  <span id="invite-name-error" class="font-sans text-caption text-alert">{{ nameError() }}</span>
                }
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-white/70">Their email address</span>
                <input
                  #emailField
                  type="email"
                  autocomplete="off"
                  inputmode="email"
                  maxlength="190"
                  class="min-h-11 w-full rounded-field border bg-white/5 px-3 font-sans text-body-sm text-white placeholder:text-white/40 focus:border-sky focus:outline-none"
                  [class]="emailError() ? 'border-alert' : 'border-white/15'"
                  [attr.aria-invalid]="!!emailError()"
                  [attr.aria-describedby]="emailError() ? 'invite-email-error' : null"
                  [value]="email()"
                  [disabled]="busy()"
                  (input)="setEmail($any($event.target).value)"
                />
                @if (emailError()) {
                  <span id="invite-email-error" class="font-sans text-caption text-alert">{{ emailError() }}</span>
                }
              </label>

              <div class="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-3 py-2.5">
                <span class="font-sans text-body-sm text-white/70">Guest fee</span>
                <span class="text-right font-sans text-body-sm font-semibold text-white">
                  {{ feeLabel() }}
                  @if (!free()) {
                    <span class="block font-normal text-caption text-white/60">from your wallet · {{ walletCaption() }}</span>
                  }
                </span>
              </div>

              <!-- In the call: the wallet (or free) only — a card checkout would leave the call -->
              @if (!free() && (walletShort() || walletFailed())) {
                <p class="flex items-start gap-2 rounded-2xl bg-warning/15 px-3 py-2.5 font-sans text-caption text-white/85">
                  <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0 text-warning" />
                  <span>
                    {{ walletShort() ? 'Your wallet doesn’t cover the guest fee.' : 'We couldn’t check your wallet balance.' }}
                    <a [href]="walletUrl()" target="_blank" rel="noopener" class="font-semibold text-sky underline">Top up your wallet</a>
                    or
                    <a [href]="detailsUrl()" target="_blank" rel="noopener" class="font-semibold text-sky underline">pay by card on the appointment page</a>
                    (both open in a new tab, so your call keeps running).
                  </span>
                </p>
              }

              @if (formError()) {
                <p class="flex items-start gap-2 rounded-2xl bg-alert/15 px-3 py-2.5 font-sans text-body-sm text-white" role="alert">
                  <sd-icon name="triangle-alert" [size]="16" class="mt-0.5 shrink-0 text-alert" />{{ formError() }}
                </p>
              }

              <button
                type="submit"
                class="flex min-h-11 w-full items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-cerulean-dark disabled:cursor-not-allowed disabled:opacity-60"
                [disabled]="!canSubmit()"
              >
                <sd-icon [name]="busy() ? 'loader-circle' : 'send'" [size]="18" [class.animate-spin]="busy()" />
                {{ submitLabel() }}
              </button>
            </form>
          } @else {
            <p class="flex items-start gap-2 font-sans text-body-sm text-white/70">
              <sd-icon name="info" [size]="16" class="mt-0.5 shrink-0" />
              {{
                l.can_manage
                  ? 'You’ve invited the most guests a consultation can have (' + l.max_guests + '). Remove one on the appointment page to invite someone else.'
                  : (l.manage_problem || 'Guests can’t be added to this consultation now.')
              }}
            </p>
          }
        }

        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveStatus() }}</p>
      </div>
    </sd-dialog>
  `,
})
export class InviteGuestDialog implements OnInit {
  private readonly appointments = inject(AppointmentsApi);
  private readonly walletApi = inject(WalletApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  readonly appointmentId = input.required<string>();
  /** The appointment page (card payment, removing guests) — opened in a new tab. */
  readonly detailsUrl = input.required<string>();
  readonly walletUrl = input('/dashboard/wallet');
  /** Guest ids in the call right now (from the call's own presence). */
  readonly liveGuestIds = input<readonly string[]>([]);
  readonly closed = output<void>();
  /** A guest was invited (so the call can name their tile straight away). */
  readonly added = output<PatientGuestDto>();

  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  private readonly nameField = viewChild<ElementRef<HTMLInputElement>>('nameField');
  private readonly emailField = viewChild<ElementRef<HTMLInputElement>>('emailField');

  protected readonly nameMax = GUEST_NAME_MAX;
  protected readonly list = signal<PatientGuestListDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly nameError = signal('');
  protected readonly emailError = signal('');
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly justAdded = signal<PatientGuestDto | null>(null);
  protected readonly copied = signal('');
  protected readonly liveStatus = signal('');
  private readonly walletBalance = signal<number | null>(null);
  protected readonly walletFailed = signal(false);
  private copiedTimer?: ReturnType<typeof setTimeout>;

  protected readonly free = computed(() => guestIsFree(this.list()));
  protected readonly feeLabel = computed(() => {
    const l = this.list();
    return l ? guestMoney(l.guest_fee, l.currency) : '…';
  });
  protected readonly walletCaption = computed(() => {
    const b = this.walletBalance();
    if (this.walletFailed()) return 'balance unavailable';
    return b === null ? 'balance …' : `balance ${money(b, this.list()?.currency)}`;
  });
  protected readonly walletShort = computed(() => {
    const b = this.walletBalance();
    return b !== null && b < Number(this.list()?.guest_fee ?? 0);
  });
  protected readonly canSubmit = computed(() => {
    if (this.busy() || !this.list()) return false;
    if (this.free()) return true;
    // Wallet only here: once the balance is known to cover it (or couldn't be read — the server decides).
    return this.walletFailed() || (this.walletBalance() !== null && !this.walletShort());
  });
  protected readonly submitLabel = computed(() => {
    if (this.busy()) return 'Inviting…';
    return this.free() ? 'Send invite' : `Pay ${this.feeLabel()} from wallet & invite`;
  });

  constructor() {
    // Back from topping up the wallet (or paying by card on the appointment
    // page) in the other tab: read the balance and the guests again.
    const onVisible = (): void => {
      if (this.document.visibilityState !== 'visible' || this.busy()) return;
      if (!this.loading()) this.load();
      if (this.list() && !this.free()) this.loadWallet();
    };
    this.document.addEventListener('visibilitychange', onVisible);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(this.copiedTimer);
    });
  }

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.appointments
      .guests(this.appointmentId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.list.set(res.data);
          this.loading.set(false);
          if (!guestIsFree(res.data) && this.walletBalance() === null) this.loadWallet();
        },
        error: (err: unknown) => {
          this.loading.set(false);
          this.loadError.set(apiErrorMessage(err, 'Could not load your guests.'));
        },
      });
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

  protected statusOf(g: PatientGuestDto): { label: string; icon: string } {
    return GUEST_STATUS[g.status] ?? GUEST_STATUS.invited;
  }

  /** In the call now: the call's own live presence only (`in_call` is a snapshot from when the list loaded). */
  protected inCall(g: PatientGuestDto): boolean {
    return !!g.id && this.liveGuestIds().includes(g.id);
  }

  protected setName(v: string): void {
    this.name.set(v);
    if (this.nameError()) this.nameError.set('');
  }

  protected setEmail(v: string): void {
    this.email.set(v);
    if (this.emailError()) this.emailError.set('');
  }

  protected async copy(g: PatientGuestDto): Promise<void> {
    if (!g.id || !g.join_url) return;
    const ok = await copyText(g.join_url);
    clearTimeout(this.copiedTimer);
    this.copied.set(ok ? g.id : '');
    this.liveStatus.set(ok ? `${g.name}’s link copied. Share it with them only.` : 'Couldn’t copy — select the link and copy it.');
    if (ok) this.copiedTimer = setTimeout(() => this.copied.set(''), 3000);
  }

  protected submit(): void {
    const l = this.list();
    if (!l || !this.canSubmit()) return;
    const name = cleanGuestName(this.name());
    const email = this.email().trim();
    const problems = newGuestProblems(name, email, l.guests);
    this.nameError.set(problems.name ?? '');
    this.emailError.set(problems.email ?? '');
    if (problems.name || problems.email) {
      (problems.name ? this.nameField() : this.emailField())?.nativeElement.focus();
      return;
    }
    this.busy.set(true);
    this.formError.set('');
    this.appointments
      .addGuest(this.appointmentId(), this.free() ? { name, email } : { name, email, payment_method: 'wallet' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.list.set(res.data);
          this.justAdded.set(res.data.guest);
          this.name.set('');
          this.email.set('');
          this.liveStatus.set(`${res.data.guest.name} is invited.`);
          if (!this.free()) this.loadWallet();
          this.added.emit(res.data.guest);
          afterNextRender(() => this.title()?.nativeElement.focus(), { injector: this.injector });
        },
        error: (err: unknown) => {
          this.busy.set(false);
          const e = addGuestErrors(err);
          this.nameError.set(e.name ?? '');
          this.emailError.set(e.email ?? '');
          this.formError.set(
            e.walletShort ? 'Your wallet balance is too low to pay the guest fee. Top up your wallet, or pay by card on the appointment page.' : e.general,
          );
          if (e.walletShort) this.loadWallet();
          if (e.stale) this.load();
          if (e.name) this.nameField()?.nativeElement.focus();
          else if (e.email) this.emailField()?.nativeElement.focus();
        },
      });
  }

  protected close(): void {
    if (this.busy()) return; // let the request finish first
    this.closed.emit();
  }
}
