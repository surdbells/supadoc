import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { LabRequestsApi } from '@supadoc/data-access';
import type { LabPatientPickDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { debounceTime, Subject, type Subscription } from 'rxjs';
import { DoctorClock } from '../doctor-clock';

const PER_PAGE = 20;
const LOAD_ERROR = 'Could not load your patients. Please try again.';

/**
 * [B] "Choose a patient": only patients this doctor has consulted, last visit
 * first. Each card is one button named by its content (name, reference, email,
 * last visit, "Choose"), so two patients with the same name stay distinct.
 */
@Component({
  selector: 'doc-lab-patient-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: 'flex flex-col gap-10' },
  styles: `
    .pp-card {
      border-radius: 24px;
    }
    .pp-shimmer {
      height: 88px;
    }
    @media (min-width: 64rem) {
      .pp-search {
        width: 460px;
      }
    }
  `,
  template: `
    <div class="flex items-start justify-between gap-4">
      <div class="flex flex-col gap-1">
        <h1 class="font-heading text-h2 text-ink">New request</h1>
        <p class="font-sans text-body text-slate">You can request outside a consultation for patients you have seen before.</p>
      </div>
      <a
        routerLink="/prescriptions/labs"
        class="flex shrink-0 items-center gap-1 rounded-field font-sans text-h5 font-medium text-slate transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
      >
        <sd-icon name="arrow-left" [size]="24" /> Back
      </a>
    </div>

    <section class="flex flex-col gap-10" aria-labelledby="lab-pick-title">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex flex-col gap-1">
          <h2 id="lab-pick-title" class="font-sans text-h5 font-semibold text-ink">Choose a patient</h2>
          <p class="font-sans text-caption text-slate">Choose who this investigation request is for</p>
        </div>
        <div class="pp-search relative">
          <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate" />
          <input
            type="search"
            autocomplete="off"
            aria-label="Search your patients"
            placeholder="Search name or email..."
            class="h-12 w-full rounded-[24px] border-[0.5px] border-ash bg-white pl-10 pr-4 font-sans text-body-sm text-ink placeholder:text-slate focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
            [value]="search()"
            (input)="onSearch($any($event.target).value)"
          />
        </div>
      </div>

      @if (loading() && patients().length === 0) {
        <div class="flex flex-col gap-4" aria-busy="true">
          <span class="sr-only">Loading your patients…</span>
          <div class="pp-shimmer sd-shimmer rounded-[24px]"></div>
          <div class="pp-shimmer sd-shimmer rounded-[24px]"></div>
          <div class="pp-shimmer sd-shimmer rounded-[24px]"></div>
        </div>
      } @else if (error() && patients().length === 0) {
        <div class="flex flex-col items-center gap-3 py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-field border border-haze bg-white px-4 py-2 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean"
            (click)="reload()"
          >
            <sd-icon name="refresh-cw" [size]="16" /> Try again
          </button>
        </div>
      } @else if (patients().length === 0) {
        <p class="py-16 text-center font-sans text-body-sm text-slate">
          @if (search().trim()) {
            No patients match “{{ search().trim() }}”.
          } @else {
            You haven't consulted any patients yet. Patients appear here after a consultation with you.
          }
        </p>
      } @else {
        <ul class="flex flex-col gap-4">
          @for (p of patients(); track p.patient_id) {
            <li>
              <button
                type="button"
                class="pp-card flex w-full items-center gap-5 border-[0.5px] border-haze bg-white px-6 py-4 text-left shadow-card transition hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
                (click)="chosen.emit(p)"
              >
                @if (p.avatar_url) {
                  <img [src]="p.avatar_url" alt="" class="size-14 shrink-0 rounded-full object-cover" />
                } @else {
                  <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-cerulean/10 font-sans text-body font-semibold text-cerulean-dark" aria-hidden="true">
                    {{ initials(p.name) }}
                  </span>
                }
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="truncate font-sans text-body-lg text-ink">{{ p.name }}</span>
                  <span class="font-sans text-body-sm text-slate [overflow-wrap:anywhere]">{{ line2(p) }}</span>
                </span>
                <span class="hidden shrink-0 font-sans text-body-sm text-cerulean-dark sm:inline">Choose</span>
                <sd-icon name="chevron-right" [size]="24" class="shrink-0 text-slate" />
              </button>
            </li>
          }
        </ul>
        @if (error()) {
          <p class="text-center font-sans text-caption text-alert-ink" role="alert">{{ error() }}</p>
        }
        @if (hasMore()) {
          <button
            type="button"
            class="mx-auto rounded-field border border-haze bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60"
            [disabled]="loading()"
            (click)="loadMore()"
          >
            {{ loading() ? 'Loading…' : 'Load more' }}
          </button>
        }
      }
    </section>
  `,
})
export class LabPatientPicker implements OnInit {
  private readonly clock = inject(DoctorClock);
  private readonly api = inject(LabRequestsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly chosen = output<LabPatientPickDto>();

  protected readonly search = signal('');
  protected readonly patients = signal<LabPatientPickDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly hasMore = signal(false);
  protected readonly error = signal('');
  private page = 1;
  private sub: Subscription | null = null;
  private readonly search$ = new Subject<void>();

  constructor() {
    this.search$.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(() => this.reload());
  }

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
    this.fetch();
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    this.search$.next();
  }

  protected reload(): void {
    this.page = 1;
    this.fetch();
  }

  protected loadMore(): void {
    this.page += 1;
    this.fetch();
  }

  private fetch(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    const page = this.page;
    this.sub = this.api.patients({ page, per_page: PER_PAGE, search: this.search().trim() || undefined }).subscribe({
      next: (res) => {
        this.patients.update((list) => (page === 1 ? res.data : [...list, ...res.data]));
        this.hasMore.set(!!res.meta && res.meta.page < res.meta.total_pages);
        this.loading.set(false);
      },
      error: () => {
        if (this.page > 1) this.page -= 1;
        if (page === 1) this.patients.set([]);
        this.error.set(LOAD_ERROR);
        this.loading.set(false);
      },
    });
  }

  /** "Ref P-1A2B3C4D · email · Last visit 26 Oct 2026" ("Last visit" left out when unknown). */
  protected line2(p: LabPatientPickDto): string {
    return [
      p.reference ? `Ref ${p.reference}` : '',
      p.email,
      p.last_visit ? `Last visit ${this.clock.shortDate(p.last_visit)}` : '',
    ]
      .filter((x) => !!x)
      .join(' · ');
  }

  protected initials(name: string): string {
    const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase() || '?';
  }
}
