import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { CredentialStatus } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** A document's state, or 'missing' when none has been uploaded. */
export type CredentialChipState = CredentialStatus | 'missing';

const CHIPS: Record<CredentialChipState, { label: string; icon: string; tone: string }> = {
  pending: { label: 'Waiting for verification', icon: 'hourglass', tone: 'bg-warning/15 text-ink' },
  verified: { label: 'Verified', icon: 'badge-check', tone: 'bg-sage/15 text-sage' },
  rejected: { label: 'Not accepted', icon: 'circle-x', tone: 'bg-alert/10 text-alert' },
  expired: { label: 'Expired', icon: 'badge-alert', tone: 'bg-alert/10 text-alert' },
  superseded: { label: 'Replaced', icon: 'history', tone: 'bg-cloud text-slate' },
  missing: { label: 'Not uploaded', icon: 'circle-alert', tone: 'bg-cloud text-slate' },
};

/**
 * A licensing document's status chip — icon + words, never colour alone.
 * Usage: `<doc-credential-status [status]="c.status" />`.
 */
@Component({
  selector: 'doc-credential-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'inline-flex shrink-0' },
  template: `
    <span class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="chip().tone">
      <sd-icon [name]="chip().icon" [size]="13" />{{ chip().label }}
    </span>
  `,
})
export class CredentialStatusChip {
  readonly status = input.required<CredentialChipState>();
  protected readonly chip = computed(() => CHIPS[this.status()] ?? CHIPS.missing);
}
