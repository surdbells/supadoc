import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { LabRequestContextDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { ageSex } from './lab-ui';

/** The composer's "Patient Details" card: who the request is for (STAT badge when STAT). */
@Component({
  selector: 'doc-lab-patient-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex flex-col gap-4 rounded-2xl border border-haze bg-snow p-4 shadow-card' },
  styles: `
    .pc-avatar {
      width: 80px;
      height: 80px;
    }
  `,
  template: `
    @let p = patient();
    <h2 class="font-sans text-body font-semibold text-ink">Patient Details</h2>
    <div class="flex min-w-0 items-center gap-4">
      @if (p.avatar_url) {
        <img [src]="p.avatar_url" alt="" class="pc-avatar shrink-0 rounded-full object-cover" />
      } @else {
        <span class="pc-avatar flex shrink-0 items-center justify-center rounded-full bg-cerulean/10 text-cerulean-dark" aria-hidden="true">
          <sd-icon name="user-round" [size]="36" />
        </span>
      }
      <div class="flex min-w-0 flex-col gap-1">
        <p class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span class="font-sans text-body-lg text-ink [overflow-wrap:anywhere]">{{ p.name }}</span>
          @if (p.reference) {
            <span class="font-sans text-body-sm text-slate">· Ref {{ p.reference }}</span>
          }
          @if (stat()) {
            <span class="rounded-xl bg-alert/10 px-2 font-sans text-caption font-medium text-alert-ink">STAT</span>
          }
        </p>
        @if (meta()) {
          <p class="font-sans text-body-sm text-slate [overflow-wrap:anywhere]">{{ meta() }}</p>
        }
      </div>
    </div>
  `,
})
export class LabPatientCard {
  readonly patient = input.required<LabRequestContextDto['patient']>();
  readonly stat = input(false);

  /** "{email} · {age} years · {Sex}" (parts omitted when unknown). */
  protected readonly meta = computed(() => {
    const p = this.patient();
    return [p.email, ageSex(p.age, p.sex)].filter((x) => !!x).join(' · ');
  });
}
