import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { catchError, distinctUntilChanged, map, of, switchMap, tap } from 'rxjs';
import { AdminAppointmentsApi, apiErrorMessage } from '@supadoc/data-access';
import { StaffAuthService } from '@supadoc/auth';
import type { AppointmentDto, FollowUpPriceDto } from '@supadoc/models';
import { AlertComponent, DialogService, IconComponent } from '@supadoc/ui';
import {
  appointmentBadge,
  appointmentClosureLabel,
  appointmentPhase,
  appointmentWhen,
  ATTENTION_BADGE,
  hasRefund,
  naira,
  NO_SHOW_LABEL,
  refundableAmount,
  relativeTime,
  RESCHEDULED_BY_LABEL,
} from '../shared/appointment-status';
import { afterDialogCloses, focusIfLost } from '../shared/after-dialog';
import { BTN_DANGER_OUTLINE, BTN_PRIMARY, BTN_SECONDARY, PILL } from '../specialists/specialist-ui';
import { AppointmentResolveDialog, ResolveMode, ResolveOutcome } from './resolve-dialog';

type ActionKey = 'confirm' | 'reschedule' | 'held' | 'no_show' | 'refund' | 'cancel' | 'withdraw';

interface ManageAction {
  readonly key: ActionKey;
  readonly label: string;
  readonly icon: string;
  readonly style: 'primary' | 'secondary' | 'danger';
}

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Not paid',
  pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
};

/**
 * One appointment (route `/appointments/:id`): its state in time (upcoming,
 * in progress, past — and "needs attention" when it ended still open), the
 * money (paid, refunded), who joined the call, and what staff may do now —
 * confirm, cancel with the refund choice, mark it held or missed, refund more.
 * Every change asks first and is audited server-side.
 */
@Component({
  selector: 'bo-appointment-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, AlertComponent, AppointmentResolveDialog],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/appointments" [queryParams]="backParams" class="flex min-h-11 w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Appointments
      </a>

      @if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-16 text-center">
          <sd-icon name="calendar-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else if (appt(); as a) {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 sm:p-6" aria-labelledby="bo-appt-title">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex min-w-0 flex-col gap-1.5">
              <h1 id="bo-appt-title" class="break-words font-heading text-h5 text-ink">{{ a.specialist.name }}</h1>
              @if (a.specialist.specialty) {
                <span class="font-sans text-body-sm text-slate">{{ a.specialist.specialty }}</span>
              }
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="${PILL}" [class]="badge().cls">
                  @if (badge().live) {
                    <span class="size-2 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true"></span>
                  } @else {
                    <sd-icon [name]="badge().icon" [size]="13" />
                  }
                  {{ badge().label }}
                </span>
                @if (a.needs_attention) {
                  <span class="${PILL} ${ATTENTION_BADGE.cls}"><sd-icon name="${ATTENTION_BADGE.icon}" [size]="13" />{{ attention.label }}</span>
                }
              </div>
              @if (badge().detail; as d) {
                <span class="font-sans text-body-sm text-slate">{{ d }}</span>
              }
            </div>
            <span class="font-heading text-h5 text-ink">{{ money(a.amount) }}</span>
          </div>

          @if (a.needs_attention) {
            <sd-alert tone="warning">
              <span class="block font-semibold">It ended {{ endedAgo() }} and is still {{ a.status_label.toLowerCase() }}.</span>
              <span class="block">{{ autoCloseNote() }}</span>
            </sd-alert>
          }

          <dl class="grid grid-cols-1 gap-x-8 gap-y-2 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex justify-between gap-4"><dt class="text-slate">Patient</dt><dd class="text-right text-ink">{{ a.patient?.name || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Patient email</dt><dd class="min-w-0 break-all text-right text-ink">{{ a.patient?.email || '—' }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">When</dt><dd class="text-right text-ink">{{ when(a) }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Type</dt><dd class="text-right text-ink">{{ a.type_label }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Payment</dt><dd class="text-right text-ink">{{ paymentLabel(a) }}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-slate">Guests</dt><dd class="text-right text-ink">{{ a.guests?.length || 0 }}</dd></div>
            @if (a.rescheduled_by) {
              <div class="flex justify-between gap-4"><dt class="text-slate">Last moved by</dt><dd class="text-right text-ink">{{ rescheduledBy(a) }}</dd></div>
            }
            @if (a.closed_at) {
              <div class="flex justify-between gap-4"><dt class="text-slate">Closed</dt><dd class="text-right text-ink">{{ dateTime(a.closed_at) }}</dd></div>
            }
            @if (a.closure_reason) {
              <div class="flex justify-between gap-4 sm:col-span-2"><dt class="shrink-0 text-slate">How it closed</dt><dd class="text-right text-ink">{{ closureLabel(a) }}</dd></div>
            }
            @if (a.status === 'missed' && a.no_show) {
              <div class="flex justify-between gap-4"><dt class="text-slate">Who didn't come</dt><dd class="text-right font-semibold text-ink">{{ noShowLabel(a) }}</dd></div>
            }
          </dl>

          <!-- Follow-ups: the consultation it follows, who created it, how it was priced -->
          @if (a.parent_appointment_id) {
            <div class="flex flex-col gap-2 rounded-field border border-teal/30 bg-teal/5 px-4 py-3 font-sans text-body-sm">
              <a [routerLink]="['/appointments', a.parent_appointment_id]" class="flex min-h-11 w-fit items-center gap-2 font-semibold text-cerulean hover:underline">
                <sd-icon name="refresh-cw" [size]="16" />
                Follow-up of the {{ a.parent ? dateTime(a.parent.scheduled_at) : 'earlier' }} consultation
              </a>
              <dl class="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                <div class="flex justify-between gap-4"><dt class="text-slate">Created by</dt><dd class="text-ink">{{ proposedByLabel(a) }}</dd></div>
                @if (a.follow_up_pricing; as fp) {
                  <div class="flex justify-between gap-4"><dt class="text-slate">Pricing</dt><dd class="text-right text-ink">{{ pricingLabel(fp) }}</dd></div>
                }
                @if (a.status === 'proposed' && a.expires_at) {
                  <div class="flex justify-between gap-4"><dt class="text-slate">Patient must answer by</dt><dd class="text-ink">{{ dateTime(a.expires_at) }}</dd></div>
                }
              </dl>
            </div>
          }

          @if (a.notes) {
            <div class="rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-ink">
              <span class="font-semibold text-slate">Notes: </span>{{ a.notes }}
            </div>
          }
        </section>

        @if (showAttendance()) {
          <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 sm:p-6" aria-labelledby="bo-appt-attendance">
            <div class="flex flex-col gap-1">
              <h2 id="bo-appt-attendance" class="font-heading text-body-lg text-ink">Who joined the call</h2>
              <p class="font-sans text-caption text-slate">The first time each side joined, from 15 minutes before the start to 30 minutes after the end.</p>
            </div>
            <dl class="grid grid-cols-1 gap-x-8 gap-y-2 font-sans text-body-sm sm:grid-cols-2">
              <div class="flex items-center justify-between gap-4">
                <dt class="text-slate">Doctor</dt>
                <dd class="flex items-center gap-1.5 text-right" [class]="a.doctor_first_joined_at ? 'text-ink' : 'text-slate'">
                  <sd-icon [name]="a.doctor_first_joined_at ? 'user-check' : 'user-x'" [size]="16" />{{ joined(a.doctor_first_joined_at) }}
                </dd>
              </div>
              <div class="flex items-center justify-between gap-4">
                <dt class="text-slate">Patient</dt>
                <dd class="flex items-center gap-1.5 text-right" [class]="a.patient_first_joined_at ? 'text-ink' : 'text-slate'">
                  <sd-icon [name]="a.patient_first_joined_at ? 'user-check' : 'user-x'" [size]="16" />{{ joined(a.patient_first_joined_at) }}
                </dd>
              </div>
            </dl>
          </section>
        }

        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 sm:p-6" aria-labelledby="bo-appt-manage">
          <h2 #manageHeading id="bo-appt-manage" tabindex="-1" class="font-heading text-body-lg text-ink">Manage</h2>
          @if (!canUpdate()) {
            <p class="font-sans text-body-sm text-slate">Your account can view but not change appointments.</p>
          } @else if (actions().length === 0) {
            <p class="font-sans text-body-sm text-slate">{{ finalNote() }}</p>
          } @else {
            @if (manageHint(); as hint) {
              <p class="font-sans text-body-sm text-slate">{{ hint }}</p>
            }
            <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              @for (act of actions(); track act.key) {
                <button type="button" [class]="buttonClass(act)" (click)="run(act.key)">
                  <sd-icon [name]="act.icon" [size]="18" />{{ act.label }}
                </button>
              }
            </div>
          }
          <div aria-live="polite">
            @if (notice()) {
              <sd-alert [tone]="noticeOk() ? 'success' : 'error'">{{ notice() }}</sd-alert>
            }
          </div>
        </section>

        <!-- The kind stays set while it plays its exit animation, so the copy doesn't flip as it closes. -->
        <bo-appointment-resolve-dialog
          [open]="resolveOpen()"
          [mode]="resolveKind()"
          [appointment]="resolveTarget() ?? a"
          (closed)="resolveOpen.set(false)"
          (resolved)="onResolved($event)"
        />
      } @else {
        <div class="sd-shimmer h-40 rounded-card"></div>
      }
    </div>
  `,
})
export class AdminAppointmentDetail implements OnInit {
  private readonly api = inject(AdminAppointmentsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly dialogs = inject(DialogService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);

  private id = '';
  protected readonly appt = signal<AppointmentDto | null>(null);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);
  protected readonly resolveOpen = signal(false);
  protected readonly resolveKind = signal<ResolveMode>('cancel');
  /** The appointment as it was when the dialog opened (its copy must not change under the exit animation). */
  protected readonly resolveTarget = signal<AppointmentDto | null>(null);
  private readonly manageHeading = viewChild<ElementRef<HTMLElement>>('manageHeading');
  protected readonly attention = ATTENTION_BADGE;

  /** The list's filters, handed over by its row link, so "Appointments" returns to them. */
  protected readonly backParams: Params =
    (this.router.currentNavigation()?.extras.state?.['listQuery'] as Params | undefined) ??
    (history.state?.listQuery as Params | undefined) ??
    {};

  protected readonly canUpdate = computed(() => this.auth.hasPermission('appointments.update'));
  protected readonly badge = computed(() => {
    const a = this.appt();
    return a ? appointmentBadge(a) : appointmentBadge({ status: 'pending', status_label: '' });
  });
  private readonly phase = computed(() => {
    const a = this.appt();
    return a ? appointmentPhase(a) : 'upcoming';
  });

  /** Join records matter once the consultation's time has come (not for a proposal or a cancelled booking). */
  protected readonly showAttendance = computed(() => {
    const a = this.appt();
    if (!a || a.status === 'proposed' || this.phase() === 'upcoming') return false;
    return a.status !== 'cancelled' || !!a.doctor_first_joined_at || !!a.patient_first_joined_at;
  });

  /** What staff may do now, by status and time (the API's state machine and time rules). */
  protected readonly actions = computed<ManageAction[]>(() => {
    const a = this.appt();
    if (!a) return [];
    const phase = this.phase();
    const refundable = refundableAmount(a) > 0;
    const out: ManageAction[] = [];
    switch (a.status) {
      case 'proposed':
        out.push({ key: 'withdraw', label: 'Withdraw proposal', icon: 'calendar-x', style: 'danger' });
        break;
      case 'pending':
      case 'rescheduled':
      case 'confirmed':
        if (a.status !== 'confirmed' && phase !== 'past') out.push({ key: 'confirm', label: 'Confirm', icon: 'calendar-check', style: 'primary' });
        if (a.status !== 'rescheduled' && phase === 'upcoming') out.push({ key: 'reschedule', label: 'Mark rescheduled', icon: 'calendar-clock', style: 'secondary' });
        if (phase !== 'upcoming') out.push({ key: 'held', label: 'Mark held', icon: 'circle-check', style: phase === 'past' ? 'primary' : 'secondary' });
        if (phase === 'past') out.push({ key: 'no_show', label: 'Mark missed', icon: 'user-x', style: 'secondary' });
        out.push({ key: 'cancel', label: 'Cancel appointment', icon: 'calendar-x', style: 'danger' });
        break;
      case 'missed':
        out.push({ key: 'held', label: 'Mark held', icon: 'circle-check', style: 'secondary' });
        out.push({ key: 'no_show', label: "Change who didn't come", icon: 'user-x', style: 'secondary' });
        if (refundable) out.push({ key: 'refund', label: 'Refund more', icon: 'wallet', style: 'secondary' });
        out.push({ key: 'cancel', label: 'Cancel it instead', icon: 'calendar-x', style: 'danger' });
        break;
      case 'completed':
      case 'cancelled':
        if (refundable) out.push({ key: 'refund', label: 'Refund more', icon: 'wallet', style: 'secondary' });
        break;
    }
    return out;
  });

  protected readonly manageHint = computed(() => {
    const a = this.appt();
    if (!a) return '';
    if (a.needs_attention) return "Mark it held if the consultation took place, or missed if it didn't.";
    if (a.status === 'missed') return 'Settle a disputed no-show: it took place after all, someone else was absent, or more should be refunded.';
    if (this.phase() === 'live') return 'This consultation is in progress.';
    return '';
  });

  protected readonly finalNote = computed(() => {
    const a = this.appt();
    if (!a) return '';
    if (a.status === 'completed' || a.status === 'cancelled') {
      const wasPaid = Number(a.amount) > 0 && (a.payment_status === 'paid' || a.payment_status === 'refunded');
      return wasPaid ? 'This consultation is closed and nothing is left to refund.' : 'This consultation is closed.';
    }
    return 'Nothing to change.';
  });

  /**
   * What the automatic check will do with it if staff don't (the API's
   * PastAppointmentCloser rules). A confirmed visit both sides joined, with
   * nothing proving it took place, may be left for staff (the closer skips it
   * when their times in the call overlapped); an unconfirmed one both sides
   * joined is never expired, so it is always left for staff.
   */
  protected readonly autoCloseNote = computed(() => {
    const a = this.appt();
    if (!a) return '';
    if (a.doctor_first_joined_at && a.patient_first_joined_at) {
      return a.status === 'confirmed'
        ? 'Both sides joined but nothing shows it took place, so the automatic check may leave it for you. Mark it held or missed.'
        : 'Both sides joined but the doctor never confirmed it and nothing shows it took place, so the automatic check leaves it for you. Mark it held or cancel it.';
    }
    const left = refundableAmount(a);
    const otherwise =
      a.status === 'confirmed'
        ? left > 0
          ? 'marked missed, with refunds by the no-show rules.'
          : 'marked missed.'
        : left > 0
          ? `cancelled with a full refund of ${naira(left)} (the doctor never confirmed it).`
          : 'cancelled (the doctor never confirmed it; nothing was paid).';
    return `Unless you settle it below, the automatic check closes it: completed if there's proof the consultation took place, otherwise ${otherwise}`;
  });

  protected readonly endedAgo = computed(() => {
    const a = this.appt();
    return a?.ends_at ? relativeTime(a.ends_at) : 'a while ago';
  });

  ngOnInit(): void {
    // The follow-up -> parent link stays on this route, so the component is
    // reused: follow the param rather than reading the snapshot once.
    this.route.paramMap
      .pipe(
        map((p) => p.get('id') ?? ''),
        distinctUntilChanged(),
        tap((id) => {
          this.id = id;
          this.appt.set(null);
          this.error.set('');
          this.notice.set('');
          this.resolveOpen.set(false);
          this.resolveTarget.set(null);
        }),
        switchMap((id) =>
          this.api.get(id).pipe(
            map((res) => ({ appt: res.data, error: '' })),
            catchError((err: unknown) => of({ appt: null, error: apiErrorMessage(err, 'Appointment not found.') })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ appt, error }) => {
        this.appt.set(appt);
        this.error.set(error);
      });
  }

  protected run(key: ActionKey): void {
    const a = this.appt();
    if (!a) return;
    this.notice.set('');
    switch (key) {
      case 'confirm':
        void this.confirmAppointment(a);
        break;
      case 'reschedule':
        void this.markRescheduled(a);
        break;
      case 'withdraw':
        void this.withdrawProposal(a);
        break;
      default:
        this.resolveTarget.set(a);
        this.resolveKind.set(key);
        this.resolveOpen.set(true);
    }
  }

  protected onResolved(outcome: ResolveOutcome): void {
    this.resolveOpen.set(false);
    if (outcome.appointment.id !== this.id) return; // moved to another appointment meanwhile
    this.applied(this.id, outcome.appointment, outcome.message);
  }

  private async confirmAppointment(a: AppointmentDto): Promise<void> {
    const patient = a.patient?.name || 'The patient';
    await this.dialogs.confirm({
      tone: 'info',
      icon: 'calendar-check',
      title: 'Confirm this appointment?',
      message: `Only once ${a.specialist.name} has agreed to the time. ${patient} is emailed that it's confirmed.`,
      details: [
        { label: 'When', value: appointmentWhen(a) },
        { label: 'Patient', value: a.patient?.name || '—' },
      ],
      confirmLabel: 'Confirm appointment',
      cancelLabel: 'Not now',
      busyLabel: 'Confirming…',
      action: () => this.api.updateStatus(a.id, 'confirmed').pipe(tap((res) => this.applied(a.id, res.data, 'Appointment confirmed.'))),
    });
  }

  private async markRescheduled(a: AppointmentDto): Promise<void> {
    const patient = a.patient?.name || 'the patient';
    const left = refundableAmount(a);
    const lapse =
      left > 0
        ? `If ${a.specialist.name} doesn't confirm it again before it ends, it's cancelled automatically and ${patient} is refunded in full (${naira(left)}).`
        : `If ${a.specialist.name} doesn't confirm it again before it ends, it's cancelled automatically.`;
    await this.dialogs.confirm({
      tone: 'warning',
      icon: 'calendar-clock',
      title: 'Mark as rescheduled?',
      message: `The time stays the same, but it waits for ${a.specialist.name} to confirm it again, and ${patient} is emailed. ${lapse} To move it to another time, the patient or the doctor reschedules it.`,
      details: [{ label: 'When', value: appointmentWhen(a) }],
      confirmLabel: 'Mark rescheduled',
      cancelLabel: 'Not now',
      action: () => this.api.updateStatus(a.id, 'rescheduled').pipe(tap((res) => this.applied(a.id, res.data, 'Marked rescheduled — waiting for the doctor to confirm.'))),
    });
  }

  private async withdrawProposal(a: AppointmentDto): Promise<void> {
    const patient = a.patient?.name || 'The patient';
    await this.dialogs.confirm({
      tone: 'danger',
      icon: 'calendar-x',
      title: 'Withdraw this follow-up proposal?',
      message: `${patient} can no longer accept it and the time is freed. Nothing was paid, so there's nothing to refund. ${patient} and ${a.specialist.name} are told. This can't be undone.`,
      details: [{ label: 'Proposed for', value: appointmentWhen(a) }],
      confirmLabel: 'Withdraw proposal',
      cancelLabel: 'Keep it',
      busyLabel: 'Withdrawing…',
      action: () => this.api.updateStatus(a.id, 'cancelled').pipe(tap((res) => this.applied(a.id, res.data, 'Proposal withdrawn.'))),
    });
  }

  private applied(id: string, next: AppointmentDto, message: string): void {
    if (id !== this.id) return;
    this.appt.set(next);
    this.noticeOk.set(true);
    this.notice.set(message);
    // The button that opened the dialog has usually gone with the change: once
    // the dialog has closed, land on the Manage section (the notice is announced).
    afterDialogCloses(() => focusIfLost(this.manageHeading()?.nativeElement, this.doc), this.doc);
  }

  protected buttonClass(act: ManageAction): string {
    return act.style === 'primary' ? BTN_PRIMARY : act.style === 'danger' ? BTN_DANGER_OUTLINE : BTN_SECONDARY;
  }

  protected when(a: AppointmentDto): string {
    return appointmentWhen(a);
  }
  protected dateTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
  protected joined(iso: string | null | undefined): string {
    return iso ? `First joined ${this.dateTime(iso)}` : 'No sign of joining';
  }
  protected money(amount: string): string {
    return naira(amount);
  }
  protected paymentLabel(a: AppointmentDto): string {
    if (!(Number(a.amount) > 0)) return 'Free';
    const base = PAYMENT_LABEL[a.payment_status ?? ''] ?? (a.payment_status || '—');
    return hasRefund(a) && a.payment_status !== 'refunded' ? `${base} · ${naira(a.refunded_amount)} refunded` : base;
  }
  protected closureLabel(a: AppointmentDto): string {
    return appointmentClosureLabel(a);
  }
  protected noShowLabel(a: AppointmentDto): string {
    return a.no_show ? NO_SHOW_LABEL[a.no_show] : '—';
  }
  protected rescheduledBy(a: AppointmentDto): string {
    return a.rescheduled_by ? (RESCHEDULED_BY_LABEL[a.rescheduled_by] ?? a.rescheduled_by) : '—';
  }
  protected proposedByLabel(a: AppointmentDto): string {
    if (a.proposed_by === 'doctor') return a.status === 'proposed' ? 'Doctor (awaiting patient)' : 'Doctor';
    return a.proposed_by === 'patient' ? 'Patient' : '—';
  }
  /** "50% off ₦10,000.00 (within 14 days)", "Waived by the doctor", … */
  protected pricingLabel(p: FollowUpPriceDto): string {
    switch (p.rule) {
      case 'waived':
        return 'Waived by the doctor';
      case 'free':
        return `Free (within ${p.window_days} days)`;
      case 'percent':
        return `${p.discount_percent}% off ${naira(p.base_fee)} (within ${p.window_days} days)`;
      case 'full':
        return `Full fee (within ${p.window_days} days)`;
      case 'outside_window':
        return `Full fee (after the ${p.window_days}-day window)`;
      default:
        return '—';
    }
  }
}
