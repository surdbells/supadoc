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
import { AdminPatientsApi } from '@supadoc/data-access';
import type { PatientAccountDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

/** Patient administration (route `/patients`) — browse the patient base. */
@Component({
  selector: 'bo-patients',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Patients</h1>
        <p class="font-sans text-body text-slate">Browse registered patients and open a record.</p>
      </header>

      <div class="flex items-center gap-2 rounded-field border border-cloud bg-white px-4 py-2">
        <sd-icon name="search" [size]="18" class="text-slate" />
        <input
          type="search"
          [value]="search()"
          (input)="onSearch($any($event.target).value)"
          placeholder="Search by name, email or phone"
          class="w-full bg-transparent font-sans text-body-sm text-ink placeholder:text-slate/60 focus:outline-none"
        />
      </div>

      @if (loading() && items().length === 0) {
        <div class="sd-shimmer h-40 rounded-card"></div>
      } @else if (error()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
        </div>
      } @else {
        <div class="overflow-x-auto rounded-card border border-cloud bg-white">
          <table class="w-full min-w-[640px] text-left">
            <thead class="border-b border-cloud font-sans text-caption text-slate">
              <tr>
                <th class="px-4 py-3">Name</th>
                <th class="px-4 py-3">Email</th>
                <th class="px-4 py-3">Phone</th>
                <th class="px-4 py-3">Joined</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              @for (p of items(); track p.id) {
                <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                  <td class="px-4 py-3 font-medium">{{ fullName(p) }}</td>
                  <td class="px-4 py-3 text-slate">{{ p.email }}</td>
                  <td class="px-4 py-3 text-slate">{{ p.phone || '—' }}</td>
                  <td class="px-4 py-3 text-slate">{{ when(p.created_at) }}</td>
                  <td class="px-4 py-3 text-right">
                    <a [routerLink]="['/patients', p.id]" class="font-sans text-caption font-semibold text-cerulean hover:underline">Open</a>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No patients found.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>

        @if (hasMore()) {
          <button type="button" class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="loadMore()">
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </div>
  `,
})
export class AdminPatients implements OnInit {
  private readonly api = inject(AdminPatientsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly items = signal<PatientAccountDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly hasMore = signal(false);
  protected readonly search = signal('');
  private page = 1;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.fetch();
  }

  protected onSearch(term: string): void {
    this.search.set(term);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page = 1;
      this.items.set([]);
      this.fetch();
    }, 250);
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.loading.set(true);
    this.error.set('');
    const term = this.search().trim();
    this.api
      .list({ page: this.page, per_page: 25, search: term || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.items.update((list) => (this.page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: () => {
          if (this.page > 1) this.page -= 1;
          this.error.set('Could not load patients. Please try again.');
          this.loading.set(false);
        },
      });
  }

  protected fullName(p: PatientAccountDto): string {
    return `${p.first_name} ${p.last_name}`.trim() || '—';
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
}
