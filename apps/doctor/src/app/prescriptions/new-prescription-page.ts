import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, DoctorApi } from '@supadoc/data-access';
import type { DoctorPatientListItemDto, PrescriptionDto } from '@supadoc/models';
import { ConfirmDialogComponent, IconComponent } from '@supadoc/ui';
import { debounceTime, Subject, Subscription } from 'rxjs';
import { RxComposer } from './rx-composer';
import { rxDate } from './rx-shared';
import { CanLeave, LeavePrompt } from './unsaved-changes.guard';

const PER_PAGE = 20;

/**
 * Start a standalone prescription (route `/prescriptions/new`). With
 * `?patientId=` it goes straight to the composer; otherwise the doctor first
 * picks one of their patients.
 */
@Component({
  selector: 'doc-new-prescription-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ConfirmDialogComponent, IconComponent, RxComposer],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <a routerLink="/prescriptions" class="flex w-fit items-center gap-1 font-sans text-body-sm text-slate transition-colors hover:text-cerulean">
        <sd-icon name="chevron-right" [size]="16" class="rotate-180" /> Prescriptions
      </a>

      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">New prescription</h1>
        <p class="font-sans text-body text-slate">
          You can prescribe outside a consultation for patients you have seen before.
        </p>
      </header>

      @if (patientId(); as pid) {
        <div class="flex flex-col gap-3 rounded-card border border-cloud bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink">
            <sd-icon name="user" [size]="18" class="shrink-0 text-cerulean" />
            <span class="min-w-0">
              Prescribing for <strong class="font-semibold">{{ patientName() || 'the chosen patient' }}</strong>
            </span>
          </span>
          <button
            type="button"
            class="inline-flex w-fit items-center gap-1.5 rounded-field border border-cloud px-3 py-2 font-sans text-caption font-semibold text-cerulean transition-colors hover:border-cerulean"
            (click)="changePatient()"
          >
            <sd-icon name="users" [size]="14" /> Change patient
          </button>
        </div>

        <doc-rx-composer
          [patientId]="pid"
          (saved)="onSaved($event)"
          (sent)="onSent($event)"
          (closed)="onClosed()"
        />
      } @else {
        <section class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-4 sm:p-6" aria-labelledby="rx-pick-title">
          <div class="flex flex-col gap-1">
            <h2 id="rx-pick-title" class="font-heading text-body-lg text-ink">Choose a patient</h2>
            <p class="font-sans text-caption text-slate">Only patients you have consulted with are listed.</p>
          </div>

          <div class="relative max-w-md">
            <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <label for="rx-pick-search" class="sr-only">Search your patients</label>
            <input
              id="rx-pick-search"
              type="search"
              autocomplete="off"
              class="w-full rounded-field border border-cloud bg-white py-2.5 pl-9 pr-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20"
              placeholder="Search by name or email…"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
            />
          </div>

          @if (loading() && patients().length === 0) {
            <div class="flex flex-col gap-2" aria-busy="true">
              <span class="sr-only">Loading your patients…</span>
              <div class="sd-shimmer h-16 rounded-field"></div>
              <div class="sd-shimmer h-16 rounded-field"></div>
              <div class="sd-shimmer h-16 rounded-field"></div>
            </div>
          } @else if (error() && patients().length === 0) {
            <div class="flex flex-col items-center gap-3 py-10 text-center">
              <sd-icon name="wifi-off" [size]="30" class="text-alert" />
              <p class="font-sans text-body-sm text-slate">{{ error() }}</p>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-field border border-cloud px-4 py-2 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean"
                (click)="reload()"
              >
                <sd-icon name="refresh-cw" [size]="16" /> Try again
              </button>
            </div>
          } @else if (patients().length === 0) {
            <div class="flex flex-col items-center gap-3 py-10 text-center">
              <span class="flex size-16 items-center justify-center rounded-full bg-cloud/60 text-slate">
                <sd-icon name="users" [size]="28" />
              </span>
              <p class="max-w-sm font-sans text-body-sm text-slate">
                {{ search().trim() ? 'No patients match your search.' : 'No patients yet. Patients appear here after a consultation with you.' }}
              </p>
            </div>
          } @else {
            <ul class="flex flex-col gap-2">
              @for (p of patients(); track p.patient_id) {
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 rounded-field border border-cloud bg-white px-4 py-3 text-left transition-colors hover:border-cerulean/50 hover:bg-glacier"
                    (click)="choose(p)"
                  >
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-caption font-semibold text-cerulean" aria-hidden="true">
                      {{ initials(p) }}
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ p.first_name }} {{ p.last_name }}</span>
                      <span class="truncate font-sans text-caption text-slate">
                        {{ p.email }}{{ p.last_visit ? ' · Last visit ' + date(p.last_visit) : '' }}
                      </span>
                    </span>
                    <span class="hidden shrink-0 font-sans text-caption font-semibold text-cerulean sm:inline">Choose</span>
                    <sd-icon name="chevron-right" [size]="18" class="shrink-0 text-slate" />
                  </button>
                </li>
              }
            </ul>
            @if (error()) {
              <p class="text-center font-sans text-caption text-alert">{{ error() }}</p>
            }
            @if (hasMore()) {
              <button
                type="button"
                class="mx-auto rounded-field border border-cloud bg-white px-6 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60"
                [disabled]="loading()"
                (click)="loadMore()"
              >
                {{ loading() ? 'Loading…' : 'Load more' }}
              </button>
            }
          }
        </section>
      }
    </div>

    <sd-confirm-dialog
      [open]="confirmChange()"
      title="Change patient?"
      message="Your latest changes to this prescription have not been saved."
      confirmLabel="Change patient"
      cancelLabel="Keep editing"
      icon="triangle-alert"
      [danger]="true"
      (confirm)="confirmChange.set(false); clearPatient()"
      (cancel)="confirmChange.set(false)"
    />

    <sd-confirm-dialog
      [open]="leavePrompt.open()"
      title="Leave without saving?"
      message="Your latest changes to this prescription have not been saved."
      confirmLabel="Leave without saving"
      cancelLabel="Keep editing"
      icon="triangle-alert"
      [danger]="true"
      (confirm)="leavePrompt.answer(true)"
      (cancel)="leavePrompt.answer(false)"
    />
  `,
})
export class NewPrescriptionPage implements CanLeave {
  private readonly api = inject(DoctorApi);
  private readonly auth = inject(StaffAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly patientId = signal<string | null>(null);
  protected readonly patientName = signal('');
  protected readonly confirmChange = signal(false);
  protected readonly leavePrompt = new LeavePrompt();
  private readonly composer = viewChild(RxComposer);
  /** The doctor already confirmed (or nothing is unsaved): skip the leave prompt. */
  private leaving = false;
  private draftId: string | null = null;
  /** The patient picked from the list (so we already know their name). */
  private chosen: { id: string; name: string } | null = null;

  // Patient picker
  protected readonly search = signal('');
  protected readonly patients = signal<DoctorPatientListItemDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly error = signal('');
  private page = 1;
  private loaded = false;
  private fetchSub: Subscription | null = null;
  private nameSub: Subscription | null = null;
  private readonly search$ = new Subject<void>();

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((q) => {
      const id = (q.get('patientId') ?? '').trim() || null;
      if (id !== this.patientId()) {
        this.draftId = null;
        this.patientId.set(id);
        if (id && this.chosen?.id === id) {
          this.patientName.set(this.chosen.name);
        } else {
          this.patientName.set('');
          if (id) this.lookUpName(id);
        }
      }
      if (!id && !this.loaded) this.reload();
    });
    this.search$.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(() => this.reload());
    this.destroyRef.onDestroy(() => {
      this.fetchSub?.unsubscribe();
      this.nameSub?.unsubscribe();
      this.leavePrompt.answer(false);
    });
  }

  /** Route guard hook: ask before a navigation throws away unsaved edits. */
  canLeave(): boolean | Promise<boolean> {
    // A sign-out (idle timeout, session expiry, signed out elsewhere) must
    // still clear the screen — never hold patient details up behind a prompt.
    if (this.leaving || !this.auth.isAuthenticated()) return true;
    return this.composer()?.hasUnsavedChanges() ? this.leavePrompt.ask() : true;
  }

  /** Navigate without the leave prompt (the composer has already asked). */
  private leaveTo(commands: unknown[]): void {
    this.leaving = true;
    void this.router.navigate(commands).then(
      (ok) => {
        if (!ok) this.leaving = false;
      },
      () => {
        this.leaving = false;
      },
    );
  }

  // ----- composer -----

  /** First save: point the address bar at the draft so a reload reopens it. */
  protected onSaved(rx: PrescriptionDto): void {
    if (!this.draftId) {
      this.draftId = rx.id;
      this.location.replaceState(`/prescriptions/${encodeURIComponent(rx.id)}`);
    }
  }

  protected onSent(rx: PrescriptionDto): void {
    this.leaveTo(['/prescriptions', rx.id]);
  }

  /** The composer's Close — it already asked "Close without saving?" if needed. */
  protected onClosed(): void {
    this.leaveTo(['/prescriptions']);
  }

  protected changePatient(): void {
    if (this.composer()?.hasUnsavedChanges()) this.confirmChange.set(true);
    else this.clearPatient();
  }

  protected clearPatient(): void {
    this.chosen = null;
    void this.router.navigate(['/prescriptions/new']);
  }

  private lookUpName(id: string): void {
    this.nameSub?.unsubscribe();
    this.nameSub = this.api.patient(id).subscribe({
      next: (res) => {
        if (this.patientId() === id) this.patientName.set(res.data.patient.name);
      },
      // The composer's side panel still shows the patient; the name here is a convenience.
      error: () => undefined,
    });
  }

  // ----- patient picker -----

  protected choose(p: DoctorPatientListItemDto): void {
    this.chosen = { id: p.patient_id, name: `${p.first_name} ${p.last_name}`.trim() };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { patientId: p.patient_id },
    });
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
    this.fetchSub?.unsubscribe();
    this.loaded = true;
    this.loading.set(true);
    this.error.set('');
    const page = this.page;
    this.fetchSub = this.api
      .patients({ page, per_page: PER_PAGE, search: this.search().trim() || undefined })
      .subscribe({
        next: (res) => {
          this.patients.update((list) => (page === 1 ? res.data : [...list, ...res.data]));
          this.hasMore.set(!!res.meta && res.meta.page < res.meta.total_pages);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          if (this.page > 1) this.page -= 1;
          if (page === 1) this.patients.set([]);
          this.error.set(apiErrorMessage(err, 'Could not load your patients. Please try again.'));
          this.loading.set(false);
        },
      });
  }

  protected initials(p: DoctorPatientListItemDto): string {
    return `${p.first_name?.[0] ?? ''}${p.last_name?.[0] ?? ''}`.toUpperCase() || '?';
  }

  protected date(value: string | null): string {
    return rxDate(value);
  }
}
