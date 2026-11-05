import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DialogComponent } from '@supadoc/ui';
import type { PreflightIssue } from './lab-composer-state';

/**
 * "A few things are needed before Previewing": only the rules that fail, each
 * with a Fix that closes this and focuses the field. Nothing has been sent.
 */
@Component({
  selector: 'doc-lab-preflight-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent],
  styles: `
    .pf-row:not(:last-child) {
      border-bottom: 1px solid var(--color-haze);
    }
    .pf-fix {
      min-width: 58px;
      height: 28px;
    }
    .pf-cancel {
      width: 162px;
      height: 40px;
    }
  `,
  template: `
    <sd-dialog
      [open]="open()"
      [maxWidth]="488"
      dialogRole="alertdialog"
      title="A few things are needed before Previewing"
      subtitle="Nothing has been sent yet. Your selections are saved."
      (closed)="closed.emit()"
    >
      <ul class="flex flex-col">
        @for (issue of issues(); track issue.key + (issue.code ?? '')) {
          <li class="pf-row flex items-center justify-between gap-4 py-3">
            <span class="font-sans text-body-sm text-ink">{{ issue.label }}</span>
            <button
              type="button"
              class="pf-fix shrink-0 rounded-lg border border-cerulean bg-white px-3 font-sans text-caption font-medium text-cerulean-dark transition-colors hover:bg-glacier focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [attr.aria-label]="'Fix: ' + issue.label"
              [attr.data-autofocus]="$first ? '' : null"
              (click)="fix.emit(issue)"
            >
              Fix
            </button>
          </li>
        }
      </ul>
      <div class="flex justify-center pt-6">
        <button
          type="button"
          class="pf-cancel rounded-field border-[0.5px] border-ash bg-white font-sans text-body-sm font-medium text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
          (click)="closed.emit()"
        >
          Cancel
        </button>
      </div>
    </sd-dialog>
  `,
})
export class LabPreflightDialog {
  readonly open = input(false);
  readonly issues = input<readonly PreflightIssue[]>([]);
  readonly fix = output<PreflightIssue>();
  readonly closed = output<void>();
}
