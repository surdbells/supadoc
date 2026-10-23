import { inject, Injectable, signal } from '@angular/core';
import { ReferenceApi } from '@supadoc/data-access';
import { firstValueFrom } from 'rxjs';

/** The specialty list (GET /api/public/reference/specialty), loaded once. */
@Injectable({ providedIn: 'root' })
export class SpecialtyOptions {
  private readonly api = inject(ReferenceApi);
  /** Labels in list order; null until loaded (or when the list could not be loaded). */
  readonly labels = signal<string[] | null>(null);
  readonly failed = signal(false);
  private loading: Promise<void> | null = null;

  load(): Promise<void> {
    this.loading ??= firstValueFrom(this.api.publicList('specialty'))
      .then((res) => {
        this.labels.set(res.data.map((i) => i.label));
        this.failed.set(false);
      })
      .catch(() => {
        this.failed.set(true);
        this.loading = null;
      });
    return this.loading;
  }
}
