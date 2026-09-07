import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { DoctorPatientListItemDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Doctor's patients (route `/patients`) — directory with search. */
@Component({
  selector: 'doc-patients',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Patients</h1>
        <p class="font-sans text-body text-slate">Everyone you've consulted with.</p>
      </header>

      <div class="relative max-w-sm">
        <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
        <input class="w-full rounded-field border border-cloud bg-white py-2 pl-9 pr-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none" placeholder="Search by name or email…" [value]="search()" (input)="search.set($any($event.target).value)" (keydown.enter)="apply()" />
      </div>

      <div class="overflow-x-auto rounded-card border border-cloud bg-white">
        <table class="w-full min-w-[560px] text-left">
          <thead class="border-b border-cloud font-sans text-caption text-slate">
            <tr>
              <th class="px-4 py-3">Patient</th>
              <th class="px-4 py-3">Email</th>
              <th class="px-4 py-3 text-right">Visits</th>
              <th class="px-4 py-3">Last visit</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            @for (p of items(); track p.patient_id) {
              <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                <td class="px-4 py-3 font-medium">{{ p.first_name }} {{ p.last_name }}</td>
                <td class="px-4 py-3 text-slate">{{ p.email }}</td>
                <td class="px-4 py-3 text-right text-slate">{{ p.visit_count }}</td>
                <td class="px-4 py-3 text-slate">{{ p.last_visit ? date(p.last_visit) : '—' }}</td>
                <td class="px-4 py-3 text-right"><a [routerLink]="['/patients', p.patient_id]" class="font-sans text-caption font-semibold text-cerulean hover:underline">Open</a></td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No patients yet.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>

      @if (hasMore()) {
        <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">{{ loading() ? 'Loading…' : 'Load more' }}</button>
      }
    </div>
  `,
})
export class DoctorPatients implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = signal<DoctorPatientListItemDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly search = signal('');
  private page = 1;

  ngOnInit(): void {
    this.fetch();
  }

  protected apply(): void {
    this.page = 1;
    this.items.set([]);
    this.fetch();
  }
  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.api
      .patients({ page: this.page, per_page: 20, search: this.search().trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected date(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
}
