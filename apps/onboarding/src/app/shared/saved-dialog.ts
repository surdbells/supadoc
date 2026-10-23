import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DialogComponent } from '@supadoc/ui';
import { ModalHeaderComponent } from './modal-header';
import { onbModalButton } from './ui-classes';

/** "Saved for later" (470px): where the resume link and code went, then Back to home / Keep going. */
@Component({
  selector: 'onb-saved-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, ModalHeaderComponent],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      [maxWidth]="470"
      labelledBy="onb-saved-title"
      describedBy="onb-saved-subtitle"
      (closed)="keepGoing.emit()"
    >
      <div class="p-6">
        <onb-modal-header baseId="onb-saved" title="Saved for later" [subtitle]="message()" (closed)="keepGoing.emit()" />
        <div class="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          <button type="button" [class]="homeClass" (click)="home.emit()">Back to home</button>
          <button type="button" [class]="goClass" data-autofocus (click)="keepGoing.emit()">Keep going</button>
        </div>
      </div>
    </sd-dialog>
  `,
})
export class SavedDialogComponent {
  readonly open = input(false);
  /** The masked address the link and code went to. */
  readonly sentTo = input('');
  /** A resume email went out less than a minute ago (429 resend_cooldown). */
  readonly cooldown = input(false);
  readonly home = output<void>();
  readonly keepGoing = output<void>();

  protected readonly homeClass = `${onbModalButton('neutral')} w-full`;
  protected readonly goClass = `${onbModalButton('primary')} w-full`;
  protected readonly message = computed(() =>
    this.cooldown()
      ? "We've just sent one. Check your inbox."
      : `We've emailed a link and a 6-character code to ${this.sentTo() || 'your email address'}. Use either to pick up where you left off within 30 days.`,
  );
}
