import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, startWith, switchMap } from 'rxjs';
import { AppointmentsApi, openClinicalDocument } from '@supadoc/data-access';
import type {
  AppointmentDto,
  ClinicalDocumentKind,
  ConsultationSummaryDto,
  LabOrderDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface DocItem {
  readonly kind: ClinicalDocumentKind;
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

const NAIRA = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  confirmed: 'bg-sage/15 text-sage',
  rescheduled: 'bg-cloud text-slate',
  completed: 'bg-sage/15 text-sage',
  cancelled: 'bg-alert/10 text-alert',
};

/** Consultation details (Figma 808:13576) — wired to GET /api/portal/appointments/{id}. */
@Component({
  selector: 'pat-history-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Consultation Details</h1>
          <p class="font-sans text-body text-slate">See your consultation full information.</p>
        </div>
        <a routerLink="/dashboard/history" class="flex shrink-0 items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" />
          Back
        </a>
      </div>

      @switch (viewState()) {
        @case ('loading') {
          <div class="flex flex-col gap-6">
            <div class="h-28 animate-pulse rounded-card bg-cloud"></div>
            <div class="h-40 animate-pulse rounded-card bg-cloud"></div>
          </div>
        }
        @case ('error') {
          <div class="flex flex-col items-center gap-5 py-24 text-center">
            <span class="flex size-20 items-center justify-center rounded-full bg-alert/10 text-alert"><sd-icon name="calendar-off" [size]="36" /></span>
            <div class="flex max-w-sm flex-col gap-2">
              <h2 class="font-heading text-h5 text-ink">Consultation not found</h2>
              <p class="font-sans text-body-sm text-slate">This consultation doesn't exist or is no longer available.</p>
            </div>
            <a routerLink="/dashboard/history" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white">Back to history</a>
          </div>
        }
        @default {
          @if (appt(); as a) {
            <!-- Summary -->
            <section class="flex flex-col gap-6 rounded-card border border-cloud bg-white p-6 md:flex-row md:items-center md:justify-between">
              <div class="flex items-center gap-4">
                <span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h5 font-semibold text-cerulean">{{ initials(a.specialist.name) }}</span>
                <div class="flex flex-col gap-1">
                  <p class="font-sans text-body-lg font-semibold text-ink">{{ a.specialist.name }}</p>
                  <p class="font-sans text-caption text-slate">{{ a.specialist.specialty }}</p>
                </div>
              </div>
              <div class="flex items-start justify-between gap-8 md:items-center">
                <div class="flex flex-col gap-2 font-sans text-caption text-slate">
                  <span class="flex items-center gap-2"><sd-icon name="calendar-days" [size]="16" />{{ dateLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2"><sd-icon name="clock" [size]="16" />{{ timeLabel(a.scheduled_at) }}</span>
                  <span class="flex items-center gap-2"><sd-icon name="video" [size]="16" />{{ a.type_label }}</span>
                </div>
                <span class="shrink-0 rounded-lg px-4 py-1.5 font-sans text-body-sm font-medium" [class]="statusClass(a.status)">{{ a.status_label }}</span>
              </div>
            </section>

            <!-- Summary + Note -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="clipboard-list" [size]="20" />Consultation Summary</h2>
                @if (summary()?.available) {
                  <div class="flex flex-col gap-3 font-sans text-body-sm text-slate">
                    @if (summary()?.subjective) { <p>{{ summary()?.subjective }}</p> }
                    @if (summary()?.assessment) { <p><span class="font-semibold text-ink">Assessment: </span>{{ summary()?.assessment }}</p> }
                  </div>
                } @else {
                  <p class="font-sans text-body-sm text-slate">The consultation summary isn't available yet.</p>
                }
              </section>

              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="clipboard-list" [size]="20" />Care Plan</h2>
                @if (summary()?.plan) {
                  <p class="font-sans text-body-sm text-ink">{{ summary()?.plan }}</p>
                } @else {
                  <p class="font-sans text-body-sm text-slate">No care plan was recorded for this consultation.</p>
                }
              </section>
            </div>

            <!-- Documents + payment -->
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="file-text" [size]="20" />Documents</h2>
                @if (docs().length > 0 || labs().length > 0) {
                  <ul class="flex flex-col gap-2.5">
                    @for (doc of docs(); track doc.kind + doc.id) {
                      <li class="flex items-center gap-3">
                        <sd-icon name="file-text" [size]="20" class="shrink-0 text-slate" />
                        <span class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate font-sans text-body-sm font-medium text-ink">{{ doc.title }}</span>
                          @if (doc.meta) { <span class="truncate font-sans text-caption text-slate">{{ doc.meta }}</span> }
                        </span>
                        <button type="button" class="flex size-8 items-center justify-center rounded-field border border-cloud text-slate transition-colors hover:bg-glacier" aria-label="Open document" (click)="openDoc(a.id, doc)">
                          <sd-icon name="eye" [size]="16" />
                        </button>
                      </li>
                    }
                    @for (lab of labs(); track lab.id) {
                      <li class="flex items-center gap-3">
                        <sd-icon name="clipboard-list" [size]="20" class="shrink-0 text-slate" />
                        <span class="min-w-0 flex-1 truncate font-sans text-body-sm text-ink">Lab order: {{ lab.tests.join(', ') }}</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="font-sans text-body-sm text-slate">No documents were shared for this consultation.</p>
                }
              </section>

              <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-6">
                <h2 class="flex items-center gap-2 font-sans text-body font-semibold text-cerulean"><sd-icon name="credit-card" [size]="20" />Payment Status</h2>
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="credit-card" [size]="20" class="text-slate" />Amount: ₦{{ money(a.amount) }}</span>
                  <span class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1 font-sans text-caption font-medium" [class]="a.payment_status === 'paid' ? 'bg-sage/15 text-sage' : a.payment_status === 'refunded' ? 'bg-frost text-cerulean' : 'bg-warning/15 text-warning'">
                    <sd-icon [name]="a.payment_status === 'paid' ? 'circle-check' : 'clock'" [size]="14" />
                    {{ paymentLabel(a.payment_status) }}
                  </span>
                </div>
              </section>
            </div>
          }
        }
      }
    </div>
  `,
})
export class HistoryDetails {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AppointmentsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly summary = signal<ConsultationSummaryDto | null>(null);
  protected readonly docs = signal<DocItem[]>([]);
  protected readonly labs = signal<LabOrderDto[]>([]);

  private readonly result = toSignal(
    this.route.paramMap.pipe(
      map((p) => p.get('id') ?? ''),
      switchMap((id) => {
        if (id !== '') this.loadExtras(id);
        return this.api.getMine(id).pipe(
          map((res) => ({ state: 'loaded' as const, appt: res.data })),
          catchError(() => of({ state: 'error' as const, appt: null })),
          startWith({ state: 'loading' as const, appt: null }),
        );
      }),
    ),
    { initialValue: { state: 'loading' as const, appt: null } },
  );

  protected readonly viewState = computed(() => this.result().state);
  protected readonly appt = computed<AppointmentDto | null>(() => this.result().appt);

  private loadExtras(id: string): void {
    this.api
      .consultationSummary(id)
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => this.summary.set(res?.data ?? null));

    forkJoin({
      prescriptions: this.api.prescriptions(id).pipe(catchError(() => of(null))),
      referrals: this.api.referrals(id).pipe(catchError(() => of(null))),
      certificates: this.api.certificates(id).pipe(catchError(() => of(null))),
      labOrders: this.api.labOrders(id).pipe(catchError(() => of(null))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ prescriptions, referrals, certificates, labOrders }) => {
        const docs: DocItem[] = [];
        for (const rx of prescriptions?.data ?? []) {
          const names = rx.items.map((i) => i.medication).filter(Boolean);
          docs.push({
            kind: 'prescription',
            id: rx.id,
            title: 'Prescription',
            meta: names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : ''),
          });
        }
        for (const r of referrals?.data ?? []) {
          docs.push({ kind: 'referral', id: r.id, title: `Referral · ${r.target}`, meta: r.reason });
        }
        for (const c of certificates?.data ?? []) {
          docs.push({
            kind: 'certificate',
            id: c.id,
            title: c.type_label,
            meta: c.from_date && c.to_date ? `${c.from_date} → ${c.to_date}` : new Date(c.created_at).toLocaleDateString('en-GB'),
          });
        }
        this.docs.set(docs);
        this.labs.set(labOrders?.data ?? []);
      });
  }

  protected openDoc(id: string, doc: DocItem): void {
    openClinicalDocument(this.api.document(id, doc.kind, doc.id));
  }

  protected initials(name: string): string {
    return name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }
  protected dateLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  }
  protected timeLabel(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  }
  protected statusClass(status: string): string {
    return STATUS_CLASS[status] ?? 'bg-cloud text-slate';
  }
  protected money(amount: string): string {
    return NAIRA.format(Number(amount) || 0);
  }
  protected paymentLabel(status: string | undefined): string {
    switch (status) {
      case 'paid': return 'Paid';
      case 'refunded': return 'Refunded';
      case 'pending': return 'Pending';
      default: return 'Unpaid';
    }
  }
}
