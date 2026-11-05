import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { LabRequestDto } from '@supadoc/models';
import { DialogComponent, IconComponent } from '@supadoc/ui';
import { DoctorClock } from '../doctor-clock';
import { LAB_PRIORITY_META } from './lab-ui';

const KINDS = [
  { kind: 'lab', title: 'Laboratory' },
  { kind: 'imaging', title: 'Imaging' },
  { kind: 'physiological', title: 'Physiological' },
] as const;

/** "Request Sent": the number, patient and priority, when it went, and what was requested. */
@Component({
  selector: 'doc-lab-sent-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent],
  styles: `
    .sd-ok {
      width: 80px;
      height: 80px;
    }
    .sd-btn {
      min-width: 154px;
      height: 48px;
    }
  `,
  template: `
    <sd-dialog [open]="open()" [maxWidth]="769" layout="plain" labelledBy="lab-sent-title" (closed)="back.emit()">
      @if (request(); as r) {
        <div class="flex flex-col gap-6 px-6 pb-6 pt-10">
          <div class="flex flex-col items-center gap-2 text-center">
            <span class="sd-ok flex items-center justify-center rounded-full bg-sage/10 text-sage-ink" aria-hidden="true">
              <sd-icon name="circle-check" [size]="48" />
            </span>
            <h2 id="lab-sent-title" tabindex="-1" data-autofocus class="font-sans text-h4 text-ink outline-none">Request Sent</h2>
            <p class="font-sans text-body-sm text-slate [overflow-wrap:anywhere]">{{ r.number }} · {{ r.patient.name }} · {{ priority() }}</p>
            <p class="font-sans text-body-sm text-slate">Sent today at {{ clock.time(r.sent_at) }}</p>
          </div>

          <section class="flex flex-col gap-4 border-t border-haze pt-6" aria-labelledby="lab-sent-summary">
            <h3 id="lab-sent-summary" class="font-sans text-body-lg font-semibold text-ink">Request Summary</h3>
            <div class="flex flex-col gap-0.5">
              <p class="font-sans text-caption text-slate">Provisional diagnosis / clinical question</p>
              <p class="font-sans text-body text-ink [overflow-wrap:anywhere]">{{ r.clinical_question }}</p>
            </div>
            <div class="flex flex-col gap-3">
              <p class="font-sans text-body font-semibold text-ink">Investigations</p>
              @for (g of groups(); track g.title) {
                <div class="flex flex-col gap-0.5">
                  <p class="font-sans text-caption text-slate">{{ g.title }}</p>
                  <p class="font-sans text-body text-ink [overflow-wrap:anywhere]">{{ g.line }}</p>
                </div>
              }
            </div>
          </section>

          <div class="flex flex-col-reverse items-center justify-center gap-4 sm:flex-row">
            <button
              type="button"
              class="sd-btn rounded-field border border-cerulean bg-white px-4 font-sans text-body-sm font-medium text-cerulean-dark transition-colors hover:bg-glacier focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              (click)="newRequest.emit()"
            >
              + New Request
            </button>
            <button
              type="button"
              class="sd-btn rounded-field bg-cerulean px-4 font-sans text-body-sm font-medium text-white transition-colors hover:bg-cerulean-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 focus-visible:ring-offset-2"
              (click)="back.emit()"
            >
              Back to Laboratory &amp; Diagnostics
            </button>
          </div>
        </div>
      }
    </sd-dialog>
  `,
})
export class LabSentDialog {
  protected readonly clock = inject(DoctorClock);

  readonly open = input(false);
  readonly request = input<LabRequestDto | null>(null);
  /** "+ New Request". */
  readonly newRequest = output<void>();
  /** "Back to Laboratory & Diagnostics" (also Esc). */
  readonly back = output<void>();

  protected readonly priority = computed(() => {
    const r = this.request();
    return r ? (LAB_PRIORITY_META[r.priority]?.label ?? r.priority) : '';
  });

  /** "Laboratory (2)" → "FBC · Gram stain - Blood", one row per tab that has tests. */
  protected readonly groups = computed(() => {
    const items = [...(this.request()?.items ?? [])].sort((a, b) => a.position - b.position);
    return KINDS.map((k) => {
      const list = items.filter((i) => i.kind === k.kind);
      return { title: `${k.title} (${list.length})`, line: list.map((i) => i.short).join(' · '), n: list.length };
    }).filter((g) => g.n > 0);
  });
}
