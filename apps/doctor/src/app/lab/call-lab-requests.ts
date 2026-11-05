import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { DoctorApi, LabRequestsApi } from '@supadoc/data-access';
import type { LabOrderDto, LabRequestSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import type { Subscription } from 'rxjs';
import { labStatusMeta, numberParts } from './lab-ui';

export const CALL_LAB_CAPTION = 'Opens in a new tab. Your call stays connected.';
export const CALL_LAB_CAPTION_NARROW =
  "Opens in a new tab. Your call stays connected, but your video may pause while you're in the other tab.";

/**
 * The call cockpit's "Lab requests" tab. "New lab request" opens the composer
 * in a NEW TAB (navigating this tab would drop the call; the portal session is
 * shared through localStorage), with the patient and the consultation filled
 * in. Lists this consultation's requests — refreshed when the doctor comes back
 * to this tab — and, read-only, any earlier lab orders.
 */
@Component({
  selector: 'doc-call-lab-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'flex flex-col gap-4',
    '(window:focus)': 'refresh()',
    '(document:visibilitychange)': 'onVisibility()',
  },
  styles: `
    /* White on cerulean in both cockpit themes (the light theme remaps .text-white to ink). */
    .cl-cta {
      background: var(--color-cerulean);
      color: #fff;
    }
    .cl-cta:hover {
      background: var(--color-cerulean-dark);
    }
    .cl-cta[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
  template: `
    @if (!signedIn()) {
      <p class="rounded-2xl bg-warning/10 px-3 py-2 font-sans text-caption text-warning">Sign in to the doctor portal to request tests.</p>
    } @else {
      <div class="flex flex-col gap-1.5">
        <button
          type="button"
          class="cl-cta flex w-fit items-center gap-1.5 rounded-field px-4 py-2 font-sans text-body-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost"
          [disabled]="!patientId()"
          (click)="newRequest()"
        >
          <sd-icon name="external-link" [size]="16" /> New lab request
        </button>
        @if (!patientId()) {
          <p class="font-sans text-caption text-white/60" role="status">Loading the patient…</p>
        } @else {
          <p class="font-sans text-caption text-white/60">{{ narrow() ? captionNarrow : caption }}</p>
        }
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <p class="font-sans text-caption font-semibold text-white/60">From this consultation</p>
          <button type="button" class="rounded-field px-2 py-1 font-sans text-caption font-semibold text-frost hover:underline" (click)="refresh()">Refresh</button>
        </div>
        @if (error()) {
          <p class="font-sans text-caption text-alert" role="alert">{{ error() }}</p>
        }
        @if (requests().length) {
          <ul class="flex flex-col gap-2">
            @for (r of requests(); track r.id) {
              <li class="flex flex-wrap items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="font-sans text-caption font-semibold text-white/85 [overflow-wrap:anywhere]">@for (p of numberParts(r.number); track $index) {<span>{{ p }}</span><wbr />}</span>
                  <span class="font-sans text-caption text-white/60 [overflow-wrap:anywhere]">{{ r.tests_label }}</span>
                </span>
                <span class="rounded-pill px-2 py-0.5 font-sans text-caption" [class]="chipClass(r)">{{ chipLabel(r) }}</span>
                <button
                  type="button"
                  class="rounded-field px-2 py-1 font-sans text-caption font-semibold text-frost hover:underline"
                  [attr.aria-label]="'Open ' + r.number + ' in a new tab'"
                  (click)="openRequest(r.id)"
                >
                  Open
                </button>
              </li>
            }
          </ul>
        } @else if (!loading()) {
          <p class="font-sans text-caption text-white/60">No lab requests from this consultation yet.</p>
        }
      </div>

      @if (legacy().length) {
        <div class="flex flex-col gap-2 border-t border-white/10 pt-3">
          <p class="font-sans text-caption font-semibold text-white/60">Earlier lab orders</p>
          <p class="font-sans text-caption text-white/60">Ordered before lab requests. They can't be changed.</p>
          <ul class="flex flex-col gap-2">
            @for (o of legacy(); track o.id) {
              <li class="flex items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2">
                <sd-icon name="clipboard-list" [size]="16" class="text-frost" />
                <span class="flex-1 font-sans text-body-sm text-white/85">{{ o.tests.join(', ') }}</span>
                <span class="font-sans text-caption text-white/60">{{ o.priority === 'urgent' ? 'Urgent' : 'Routine' }}</span>
                <span class="rounded-pill bg-white/[0.06] px-2 py-0.5 font-sans text-caption text-white/60">Ordered</span>
              </li>
            }
          </ul>
        </div>
      }
    }
  `,
})
export class CallLabRequests {
  private readonly api = inject(LabRequestsApi);
  private readonly doctorApi = inject(DoctorApi);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly appointmentId = input<string | null>(null);
  readonly patientId = input<string | null>(null);
  /** Signed in to the doctor portal in this browser (as this call's doctor). */
  readonly signedIn = input(false);
  /** The cockpit's theme. */
  readonly tone = input<'dark' | 'light'>('dark');
  /** Phone / tablet layout: a background tab may pause the camera. */
  readonly narrow = input(false);

  protected readonly numberParts = numberParts;
  protected readonly caption = CALL_LAB_CAPTION;
  protected readonly captionNarrow = CALL_LAB_CAPTION_NARROW;
  protected readonly requests = signal<LabRequestSummaryDto[]>([]);
  protected readonly legacy = signal<LabOrderDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  private subs: Subscription[] = [];

  constructor() {
    effect(() => {
      const ready = this.signedIn() && !!this.appointmentId();
      untracked(() => (ready ? this.refresh() : this.clear()));
    });
    this.destroyRef.onDestroy(() => this.subs.forEach((s) => s.unsubscribe()));
  }

  /** Opens the composer in a new tab, with the patient and this consultation filled in. */
  protected newRequest(): void {
    const pid = this.patientId();
    if (!pid) return;
    const aid = this.appointmentId();
    if (aid) {
      window.open(
        `/prescriptions/labs/new?patientId=${encodeURIComponent(pid)}&appointmentId=${encodeURIComponent(aid)}`,
        '_blank',
        'noopener',
      );
    } else {
      window.open(`/prescriptions/labs/new?patientId=${encodeURIComponent(pid)}`, '_blank', 'noopener');
    }
  }

  protected openRequest(id: string): void {
    window.open(`/prescriptions/labs/${encodeURIComponent(id)}`, '_blank', 'noopener');
  }

  protected onVisibility(): void {
    if (this.doc.visibilityState === 'visible') this.refresh();
  }

  /** Reload this consultation's requests (and the legacy orders). */
  refresh(): void {
    const id = this.appointmentId();
    if (!this.signedIn() || !id) return;
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
        error: () => undefined,
      }),
    ];
  }

  private clear(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.subs = [];
    this.requests.set([]);
    this.legacy.set([]);
  }

  protected chipLabel(r: LabRequestSummaryDto): string {
    return labStatusMeta(r).label;
  }

  /** The light cockpit uses the portal's chips; the dark one a neutral pill (the text names the state). */
  protected chipClass(r: LabRequestSummaryDto): string {
    return this.tone() === 'light' ? labStatusMeta(r).cls : 'bg-white/10 text-white/85';
  }
}
