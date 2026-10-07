import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { AllergySeverity, ClinicalSummaryDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { Subscription } from 'rxjs';
import { rxShortDateTime, withUnit } from './rx-shared';

interface SeverityMeta {
  readonly label: string;
  readonly icon: string;
  readonly cls: string;
}

const SEVERITY: Record<AllergySeverity, SeverityMeta> = {
  'life-threatening': {
    label: 'Life-threatening',
    icon: 'shield-alert',
    cls: 'bg-alert/10 text-alert',
  },
  severe: { label: 'Severe', icon: 'circle-alert', cls: 'bg-alert/10 text-alert' },
  moderate: { label: 'Moderate', icon: 'triangle-alert', cls: 'bg-warning/15 text-ink' },
  mild: { label: 'Mild', icon: 'info', cls: 'bg-cloud text-slate' },
  unknown: { label: 'Severity not known', icon: 'info', cls: 'bg-cloud text-slate' },
};

/**
 * Read-only clinical context shown beside the prescription form (GVM-RX-02):
 * allergies (most serious first), the pregnancy reminder, latest health
 * readings, medicines they already take and conditions. It never edits.
 *
 * Usage: `<doc-rx-side-panel [patientId]="id" (loaded)="summary.set($event)" />`.
 */
@Component({
  selector: 'doc-rx-side-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <section
      class="flex flex-col gap-5 rounded-card border border-cloud bg-white p-4"
      aria-label="Patient information"
    >
      @if (loading()) {
        <div class="flex flex-col gap-3" aria-busy="true">
          <span class="sr-only">Loading patient information…</span>
          <div class="sd-shimmer h-12 rounded-field"></div>
          <div class="sd-shimmer h-20 rounded-field"></div>
          <div class="sd-shimmer h-24 rounded-field"></div>
        </div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 py-6 text-center">
          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-cloud px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean"
            (click)="load()"
          >
            <sd-icon name="refresh-cw" [size]="14" /> Try again
          </button>
        </div>
      } @else if (summary(); as s) {
        <!-- Patient -->
        <header class="flex items-center gap-3">
          <span
            class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-sm font-semibold text-cerulean"
            aria-hidden="true"
            >{{ initials(s.patient.name) }}</span
          >
          <div class="flex min-w-0 flex-col">
            <span class="truncate font-heading text-body font-semibold text-ink">{{ s.patient.name }}</span>
            <span class="font-sans text-caption text-slate">{{ patientLine(s) }}</span>
          </div>
        </header>

        <!-- Allergies -->
        <div class="flex flex-col gap-2">
          <h3 class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
            <sd-icon name="shield-alert" [size]="16" class="text-alert" /> Allergies
          </h3>
          @if (!s.allergies_recorded) {
            <div
              class="flex items-start gap-2 rounded-field border border-warning/60 bg-warning/15 px-3 py-2.5 font-sans text-body-sm text-ink"
              role="note"
            >
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0 text-warning" />
              <span>Allergies not recorded. Ask the patient before you prescribe.</span>
            </div>
          } @else if (s.allergies.length === 0) {
            <p class="font-sans text-body-sm text-slate">No known allergies.</p>
          } @else {
            <ul class="flex flex-col gap-2">
              @for (a of s.allergies; track $index) {
                <li class="flex flex-col gap-1 rounded-field bg-glacier px-3 py-2">
                  <span class="font-sans text-body-sm text-ink"
                    >{{ a.substance }}{{ a.reaction ? ' — ' + a.reaction : '' }}</span
                  >
                  <span
                    class="inline-flex w-fit items-center gap-1 rounded-pill px-2 py-0.5 font-sans text-caption font-semibold"
                    [class]="severity(a.severity).cls"
                  >
                    <sd-icon [name]="severity(a.severity).icon" [size]="12" />
                    {{ severity(a.severity).label }}
                  </span>
                </li>
              }
            </ul>
          }
        </div>

        @if (s.ask_pregnancy) {
          <div
            class="flex items-start gap-2 rounded-field bg-frost/50 px-3 py-2.5 font-sans text-body-sm text-ocean"
            role="note"
          >
            <sd-icon name="baby" [size]="18" class="mt-0.5 shrink-0" />
            <span>Remember to answer the pregnant or breastfeeding question on the form.</span>
          </div>
        }

        <!-- Latest readings -->
        <div class="flex flex-col gap-2">
          <h3 class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
            <sd-icon name="heart-pulse" [size]="16" class="text-cerulean" /> Latest health readings
          </h3>
          @if (s.vitals.length === 0) {
            <p class="font-sans text-body-sm text-slate">No readings recorded yet</p>
          } @else {
            <ul class="flex flex-col gap-1.5">
              @for (v of s.vitals; track v.key) {
                <li class="flex flex-col gap-0.5 font-sans text-body-sm text-ink">
                  <span>
                    {{ v.label }} <span class="font-semibold">{{ unit(v.value, v.unit) }}</span>
                    @if (v.taken_at) {
                      <span class="text-slate"> — {{ when(v.taken_at) }}</span>
                    }
                  </span>
                  @if (v.stale) {
                    <span
                      class="inline-flex w-fit items-center gap-1 rounded-pill bg-warning/15 px-2 py-0.5 font-sans text-caption font-semibold text-ink"
                    >
                      <sd-icon name="hourglass" [size]="12" class="text-warning" /> May be out of date
                    </span>
                  }
                </li>
              }
            </ul>
          }
        </div>

        <!-- Medicines they already take -->
        <div class="flex flex-col gap-2">
          <h3 class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
            <sd-icon name="pill-bottle" [size]="16" class="text-cerulean" /> Medicines they already take
          </h3>
          @if (s.medicines.length === 0) {
            <p class="font-sans text-body-sm text-slate">No medicines recorded</p>
          } @else {
            <div class="flex flex-col gap-3">
              @for (g of s.medicines; track $index) {
                <div class="flex flex-col gap-1">
                  <h4 class="font-sans text-caption font-semibold uppercase tracking-wide text-slate">
                    {{ g.for || 'Other' }}
                  </h4>
                  <ul class="flex flex-col gap-1">
                    @for (m of g.items; track $index) {
                      <li class="flex flex-wrap items-center gap-1.5 font-sans text-body-sm text-ink">
                        <span>{{ medicineLine(m) }}</span>
                        @if (m.herbal) {
                          <span
                            class="inline-flex items-center gap-1 rounded-pill bg-sage/15 px-2 py-0.5 font-sans text-caption font-semibold text-sage"
                          >
                            <sd-icon name="leaf" [size]="12" /> Herbal
                          </span>
                        }
                      </li>
                    }
                  </ul>
                </div>
              }
            </div>
          }
        </div>

        @if (s.conditions.length > 0) {
          <div class="flex flex-col gap-2">
            <h3 class="flex items-center gap-2 font-sans text-body-sm font-semibold text-ink">
              <sd-icon name="clipboard-list" [size]="16" class="text-cerulean" /> Conditions
            </h3>
            <ul class="flex flex-wrap gap-1.5">
              @for (c of s.conditions; track $index) {
                <li class="rounded-pill bg-glacier px-2.5 py-1 font-sans text-caption text-ink">{{ c }}</li>
              }
            </ul>
          </div>
        }
      }
    </section>
  `,
})
export class RxSidePanel {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly patientId = input.required<string>();
  /** Fires once the summary has loaded (the composer reads `ask_pregnancy`). */
  readonly loaded = output<ClinicalSummaryDto>();

  protected readonly summary = signal<ClinicalSummaryDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  private sub: Subscription | null = null;

  constructor() {
    effect(() => {
      this.patientId();
      untracked(() => this.load());
    });
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
  }

  protected load(): void {
    const id = this.patientId();
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.sub = this.api.clinicalSummary(id).subscribe({
      next: (res) => {
        this.summary.set(res.data);
        this.loading.set(false);
        this.loaded.emit(res.data);
      },
      error: (err: unknown) => {
        this.error.set(apiErrorMessage(err, 'Could not load the patient’s information.'));
        this.loading.set(false);
      },
    });
  }

  protected severity(s: AllergySeverity): SeverityMeta {
    return SEVERITY[s] ?? SEVERITY.unknown;
  }

  protected initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }

  protected patientLine(s: ClinicalSummaryDto): string {
    const parts: string[] = [];
    if (s.patient.gender) parts.push(s.patient.gender.charAt(0).toUpperCase() + s.patient.gender.slice(1));
    if (s.patient.age !== null && s.patient.age !== undefined) parts.push(`${s.patient.age} yrs`);
    return parts.join(' · ') || 'Patient';
  }

  protected unit(value: string, unit: string): string {
    return withUnit(value, unit);
  }

  protected when(iso: string): string {
    return rxShortDateTime(iso);
  }

  protected medicineLine(m: { name: string; amount: string; frequency: string }): string {
    return [m.name, m.amount, m.frequency].filter((p) => !!p && p.trim() !== '').join(' · ');
  }
}
