import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto, LabRequestSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { type Subscription } from 'rxjs';
import { DoctorClock } from '../doctor-clock';
import { firstName, LAB_PRIORITY_META, labDayLabel, labStatusMeta, numberParts } from './lab-ui';

/**
 * The appointment page's "Lab requests" tab: start a request for this
 * consultation (the composer opens with the patient and the appointment filled
 * in), the requests made from it, and — read-only — any lab orders placed
 * before lab requests existed.
 */
@Component({
  selector: 'doc-lab-requests-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 flex-col gap-0.5">
        <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink">
          <sd-icon name="flask-conical" [size]="18" class="shrink-0 text-cerulean" />Lab requests
        </h2>
        <p class="font-sans text-caption text-slate">Request tests for {{ first() }} from this consultation.</p>
      </div>
      <a
        routerLink="/prescriptions/labs/new"
        [queryParams]="{ patientId: patientId(), appointmentId: appointmentId() }"
        class="inline-flex w-fit items-center justify-center gap-2 rounded-field bg-cerulean px-4 py-3 font-sans text-body-sm font-medium text-white shadow-btn transition hover:bg-cerulean-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
      >
        <sd-icon name="plus" [size]="18" /> New lab request
      </a>
    </div>

    @if (loading() && requests().length === 0) {
      <div class="flex flex-col gap-3" aria-busy="true">
        <span class="sr-only">Loading lab requests…</span>
        <div class="sd-shimmer h-20 rounded-card"></div>
      </div>
    } @else if (error()) {
      <p class="flex items-center gap-2 font-sans text-body-sm text-alert-ink" role="alert">
        {{ error() }}
        <button type="button" class="font-medium text-cerulean-dark underline" (click)="load()">Try again</button>
      </p>
    } @else if (requests().length === 0) {
      <p class="rounded-card border border-dashed border-ash bg-white px-4 py-8 text-center font-sans text-body-sm text-slate">
        No lab requests from this consultation yet.
      </p>
    } @else {
      <ul class="flex flex-col gap-3">
        @for (r of requests(); track r.id) {
          @let chip = chipOf(r);
          <li>
            <a
              [routerLink]="['/prescriptions/labs', r.id]"
              class="flex flex-col gap-2 rounded-card border border-haze bg-white p-4 shadow-card transition hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 sm:flex-row sm:items-center sm:justify-between"
            >
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span class="font-sans text-body-sm font-semibold text-ink [overflow-wrap:anywhere]">@for (p of numberParts(r.number); track $index) {<span>{{ p }}</span><wbr />}</span>
                  <span class="font-sans text-caption font-medium" [class]="priorityOf(r).cls">{{ priorityOf(r).label }}</span>
                </span>
                <span class="font-sans text-body-sm text-slate [overflow-wrap:anywhere]">{{ r.tests_label }}</span>
                <span class="font-sans text-caption text-slate">Sent {{ day(r.sent_at) }}, {{ clock.time(r.sent_at) }}</span>
              </span>
              <span class="inline-flex w-fit shrink-0 rounded-xl px-4 py-1.5 font-sans text-caption font-medium" [class]="chip.cls">{{ chip.label }}</span>
            </a>
          </li>
        }
      </ul>
    }

    @if (legacy().length) {
      <section class="flex flex-col gap-3" aria-labelledby="lab-legacy-title">
        <div class="flex flex-col gap-0.5">
          <h3 id="lab-legacy-title" class="font-heading text-body font-semibold text-ink">Earlier lab orders</h3>
          <p class="font-sans text-caption text-slate">Ordered before lab requests. They can't be changed.</p>
        </div>
        <ul class="flex flex-col gap-2">
          @for (o of legacy(); track o.id) {
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-haze bg-white px-4 py-3">
              <span class="min-w-0 flex-1 font-sans text-body-sm text-ink [overflow-wrap:anywhere]">{{ o.tests.join(', ') }}</span>
              <span class="font-sans text-caption text-slate">{{ o.priority === 'urgent' ? 'Urgent' : 'Routine' }}</span>
              <span class="rounded-xl bg-cloud px-3 py-1 font-sans text-caption font-medium text-slate">Ordered</span>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class LabRequestsPanel {
  protected readonly clock = inject(DoctorClock);
  protected readonly numberParts = numberParts;
  private readonly api = inject(LabRequestsApi);
  private readonly doctorApi = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly appointmentId = input.required<string>();
  readonly patientId = input.required<string>();
  readonly patientName = input('');

  protected readonly requests = signal<LabRequestSummaryDto[]>([]);
  protected readonly legacy = signal<LabOrderDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  private subs: Subscription[] = [];

  constructor() {
    effect(() => {
      const id = this.appointmentId();
      untracked(() => this.load(id));
    });
    this.destroyRef.onDestroy(() => this.subs.forEach((s) => s.unsubscribe()));
  }

  protected first(): string {
    const n = this.patientName().trim();
    return n ? firstName(n) : 'the patient';
  }

  load(id = this.appointmentId()): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.loading.set(true);
    this.error.set('');
    this.subs = [
      this.api.list({ appointment_id: id, per_page: 50 }).subscribe({
        next: (res) => {
          this.requests.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.error.set('Could not load the lab requests.');
        },
      }),
      this.doctorApi.listLabOrders(id).subscribe({
        next: (res) => this.legacy.set(Array.isArray(res.data) ? res.data : []),
        error: () => this.legacy.set([]),
      }),
    ];
  }

  protected chipOf(r: LabRequestSummaryDto) {
    return labStatusMeta(r);
  }

  protected priorityOf(r: LabRequestSummaryDto) {
    return LAB_PRIORITY_META[r.priority] ?? LAB_PRIORITY_META.routine;
  }

  protected day(iso: string): string {
    return labDayLabel(iso, this.clock);
  }
}
