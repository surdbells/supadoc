import { Directive, inject, input, type OnInit, type Type, ViewContainerRef } from '@angular/core';
import type { RecordTab } from './call-record-copy';

/**
 * Shows the record's zone component (loaded by the call page on first open)
 * with its `kind`, once. A few lines of core API instead of NgComponentOutlet,
 * which would add its code to the initial bundle (it shares a module with
 * NgTemplateOutlet there).
 */
@Directive({ selector: '[patRecordOutlet]' })
export class CallRecordOutlet implements OnInit {
  readonly component = input.required<Type<unknown>>({ alias: 'patRecordOutlet' });
  readonly kind = input.required<RecordTab>({ alias: 'patRecordOutletKind' });
  private readonly vcr = inject(ViewContainerRef);

  ngOnInit(): void {
    this.vcr.createComponent(this.component()).setInput('kind', this.kind());
  }
}
