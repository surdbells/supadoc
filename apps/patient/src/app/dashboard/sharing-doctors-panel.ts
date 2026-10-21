import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { firstValueFrom, forkJoin } from 'rxjs';
import { apiErrorMessage, DocumentsApi, DocumentSharingApi } from '@supadoc/data-access';
import type {
  DocumentGrantDto,
  DocumentShareResultDto,
  RevokeResultDto,
  SharingAppointmentRefDto,
  SharingDoctorDto,
} from '@supadoc/models';
import { DialogService, EmptyStateComponent, IconComponent } from '@supadoc/ui';
import {
  accessUntilLabel,
  countNoun,
  doctorStatus,
  doctorSummary,
  drName,
  endedGrantSummary,
  endsBeforeCopy,
  endsBeforeNext,
  grantSummary,
  initials,
  isSharingUnavailable,
  lastOpenedLabel,
  mainGrant,
  shareResultLine,
  SHARING_UNAVAILABLE,
} from './document-sharing';
import { ExtendShareDialog } from './extend-share-dialog';
import { ShareDialog } from './share-dialog';

/** What the page learns from the panel. */
export interface SharingStats {
  /** Doctors who can see something now (paused ones included). */
  readonly activeDoctors: number;
  readonly unavailable: boolean;
}

/** A revoke, for the page's Undo bar. */
export interface RevokeNotice {
  readonly text: string;
  /** Any grant of the revoke batch (restore takes one). */
  readonly grantId: string | null;
  readonly restorableUntil: string | null;
}

interface ShareRequest {
  readonly mode: 'create' | 'edit';
  readonly doctorId: string | null;
  readonly grant: DocumentGrantDto | null;
  readonly documentIds: readonly string[];
  readonly scope: 'all' | 'selected' | null;
  readonly appointment: SharingAppointmentRefDto | null;
}

/**
 * Manage sharing › Doctors: one card per doctor the patient has booked —
 * who can see what and until when, when they last opened something, and the
 * actions (change, change the end, stop, share, allow requests again). Doctors
 * with access first, then "Other doctors you've booked"; "Shared before"
 * lists shares that ended in the last 90 days.
 */
@Component({
  selector: 'pat-sharing-doctors-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, ExtendShareDialog, IconComponent, NgTemplateOutlet, RouterLink, ShareDialog],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-4" [attr.aria-busy]="loading() || null">
      @if (loading() && !doctors()) {
        @for (i of [1, 2]; track i) { <div class="sd-shimmer h-36 rounded-card"></div> }
      } @else if (unavailable()) {
        <p class="flex items-start gap-2 rounded-card border border-haze bg-white p-5 font-sans text-body-sm text-slate shadow-card" role="status">
          <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
        </p>
      } @else if (loadError() && !doctors()) {
        <div class="flex flex-col items-start gap-3 rounded-card border border-haze bg-white p-5 shadow-card">
          <p class="flex items-start gap-2 font-sans text-body-sm text-alert-ink" role="alert">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />Could not load your sharing settings.
          </p>
          <button type="button" class="min-h-11 rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean" (click)="load()">Try again</button>
        </div>
      } @else if ((doctors() ?? []).length === 0) {
        <sd-empty-state icon="users" title="No doctors yet" message="You can share documents with doctors after you book a consultation.">
          <a routerLink="/dashboard/specialists" class="inline-flex min-h-11 items-center gap-2 rounded-field bg-cerulean px-6 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean">
            Find a specialist
          </a>
        </sd-empty-state>
      } @else {
        <p class="font-sans text-body-sm text-slate">Doctors only see what you share. You can change or stop sharing at any time.</p>
        @if (loadError()) {
          <!-- A reload failed (after a share, a stop or an Undo): what is shown may be out of date. -->
          <div class="flex flex-col gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink sm:flex-row sm:items-center sm:justify-between">
            <p class="flex items-start gap-2" role="alert">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />Could not refresh your sharing settings. What you see may be out of date.
            </p>
            <button type="button" class="inline-flex min-h-11 w-fit shrink-0 items-center rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="loading()" (click)="load()">Try again</button>
          </div>
        }
        @if (actionError()) {
          <p class="flex items-start gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink" role="alert">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ actionError() }}
          </p>
        }

        <ul class="flex flex-col gap-4" aria-label="Doctors who can see your documents">
          @for (d of withAccess(); track d.specialist.id) {
            <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: d }" />
          }
        </ul>

        @if (others().length > 0) {
          <h2 class="mt-2 font-sans text-body font-semibold text-ink">Other doctors you've booked</h2>
          <ul class="flex flex-col gap-4" aria-label="Other doctors you've booked">
            @for (d of others(); track d.specialist.id) {
              <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ $implicit: d }" />
            }
          </ul>
        }

        <!-- Shares that ended (90 days) -->
        <div class="flex flex-col gap-2 rounded-card border border-haze bg-white p-4 shadow-card sm:p-5">
          <button type="button" class="inline-flex min-h-11 w-fit items-center gap-1.5 font-sans text-body-sm font-semibold text-ink" aria-controls="shared-before" [attr.aria-expanded]="endedOpen()" (click)="toggleEnded()">
            <sd-icon name="history" [size]="16" class="text-slate" />Shared before
            <sd-icon name="chevron-down" [size]="16" class="text-slate" [class.rotate-180]="endedOpen()" />
          </button>
          @if (endedOpen()) {
            <div id="shared-before">
              @if (endedLoading()) {
                <div class="sd-shimmer h-10 rounded-field"></div>
              } @else if (endedError()) {
                <p class="font-sans text-caption text-alert-ink" role="alert">{{ endedError() }}</p>
              } @else {
                <ul class="flex flex-col gap-2">
                  @for (g of ended(); track g.id) {
                    <li class="font-sans text-caption text-slate">{{ endedLine(g) }}</li>
                  } @empty {
                    <li class="font-sans text-caption text-slate">Nothing has ended in the last 90 days.</li>
                  }
                </ul>
              }
            </div>
          }
        </div>
      }
    </div>

    <ng-template #card let-d>
      <li [id]="'doctor-' + d.specialist.id" tabindex="-1" class="flex flex-col gap-4 rounded-card border border-haze bg-white p-4 shadow-card outline-none sm:p-5">
        <div class="flex flex-wrap items-start gap-3">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost font-sans text-body-sm font-semibold text-cerulean-dark" aria-hidden="true">{{ initialsOf(d.specialist.name) }}</span>
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="font-sans text-body font-semibold text-ink">{{ dr(d.specialist.name) }}</span>
            @if (d.specialist.specialty) { <span class="font-sans text-caption text-slate">{{ d.specialist.specialty }}</span> }
          </span>
          <span class="inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 font-sans text-caption font-medium inset-ring inset-ring-current/20" [class]="status(d).cls">
            <sd-icon [name]="status(d).icon" [size]="12" />{{ status(d).label }}
          </span>
        </div>

        <div class="flex flex-col gap-1 font-sans text-body-sm">
          <p class="text-ink">{{ summary(d) }}</p>
          @if (d.access.state !== 'none') {
            <p class="text-slate">{{ until(d) }}</p>
            <p class="text-slate">{{ opened(d.access.last_viewed_at) }}</p>
          }
        </div>

        @if (d.access.state === 'paused') {
          <p class="flex items-start gap-2 rounded-field bg-warning/15 px-4 py-3 font-sans text-body-sm text-warning-ink">
            <sd-icon name="hourglass" [size]="18" class="mt-0.5 shrink-0" />
            {{ dr(d.specialist.name) }} isn't practising on VideoMed right now, so they can't see anything. If they're away for more than 30 days, sharing with them ends.
          </p>
        }

        @if (endsBefore(d); as next) {
          <div class="flex flex-col gap-2 rounded-field bg-warning/15 px-4 py-3 font-sans text-body-sm text-warning-ink">
            <p class="flex items-start gap-2"><sd-icon name="calendar-clock" [size]="18" class="mt-0.5 shrink-0" />{{ endsBeforeText(d, next) }}</p>
            @if (next.after_options.after_24h) {
              <button type="button" class="ml-6 min-h-11 w-fit rounded-pill border border-current/30 px-3 font-sans text-caption font-semibold disabled:opacity-60" [disabled]="busyId() === d.specialist.id" (click)="anchorToNext(d, next)">
                Until 24 hours after that consultation
              </button>
            }
          </div>
        }

        @if (d.requests_blocked) {
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p class="flex items-start gap-2 font-sans text-body-sm text-slate">
              <sd-icon name="bell-off" [size]="18" class="mt-0.5 shrink-0" />You've stopped {{ dr(d.specialist.name) }} from asking for access.
            </p>
            <button type="button" class="inline-flex min-h-11 w-fit shrink-0 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="busyId() === d.specialist.id" (click)="allowRequests(d)">
              <sd-icon name="key-round" [size]="16" />Allow requests
            </button>
          </div>
        }

        <div class="flex flex-wrap gap-2">
          @if (d.access.state === 'none') {
            <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field bg-cerulean px-4 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="!d.can_share" (click)="shareWith(d)">
              <sd-icon name="share-2" [size]="16" />Share documents
            </button>
            @if (!d.can_share) {
              <p class="w-full font-sans text-caption text-slate">{{ dr(d.specialist.name) }} isn't practising on VideoMed right now.</p>
            }
          } @else {
            <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="!mainOf(d)" (click)="change(d)">
              <sd-icon name="pen-line" [size]="16" />Change
            </button>
            <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="!mainOf(d)" (click)="extend(d, mainOf(d))">
              <sd-icon name="calendar-clock" [size]="16" />Change end date
            </button>
            <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-alert px-4 font-sans text-body-sm font-semibold text-alert-ink transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="busyId() === d.specialist.id" (click)="stop(d)">
              <sd-icon name="user-x" [size]="16" />Stop sharing
            </button>
          }
        </div>

        @if (grantsOf(d).length > 0) {
          <div class="flex flex-col gap-2 border-t border-cloud pt-3">
            <button type="button" class="inline-flex min-h-11 w-fit items-center gap-1.5 font-sans text-body-sm font-semibold text-ink" [attr.aria-controls]="'grants-' + d.specialist.id" [attr.aria-expanded]="isOpen(d)" (click)="toggle(d)">
              Details
              <sd-icon name="chevron-down" [size]="16" class="text-slate" [class.rotate-180]="isOpen(d)" />
            </button>
            @if (isOpen(d)) {
              <ul [id]="'grants-' + d.specialist.id" class="flex flex-col gap-3">
                @for (g of grantsOf(d); track g.id) {
                  <li class="flex flex-col gap-2 rounded-field border border-cloud p-3">
                    <p class="font-sans text-body-sm text-ink">{{ grantLine(g) }}</p>
                    @if (g.scope === 'selected' && titlesOf(g).length > 0) {
                      <ul class="flex flex-col gap-0.5 pl-1 font-sans text-caption text-slate" [attr.aria-label]="'Documents in this share'">
                        @for (t of titlesOf(g); track $index) { <li class="truncate">{{ t }}</li> }
                      </ul>
                    }
                    <div class="flex flex-wrap gap-2">
                      <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-haze bg-white px-3 font-sans text-caption font-semibold text-cerulean shadow-control transition hover:border-cerulean" (click)="extend(d, g)">
                        <sd-icon name="calendar-clock" [size]="14" />Change end date
                      </button>
                      <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-field border border-alert px-3 font-sans text-caption font-semibold text-alert-ink transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="busyId() === g.id" (click)="stopGrant(d, g)">
                        <sd-icon name="user-x" [size]="14" />Stop
                      </button>
                    </div>
                  </li>
                }
              </ul>
            }
          </div>
        }
      </li>
    </ng-template>

    @if (shareReq(); as s) {
      <pat-share-dialog
        [mode]="s.mode"
        [grant]="s.grant"
        [preselectDoctorIds]="s.doctorId ? [s.doctorId] : []"
        [preselectDocumentIds]="s.documentIds"
        [initialScope]="s.scope"
        [lockDoctor]="!!s.doctorId"
        [appointment]="s.appointment"
        surface="manage_sharing"
        (done)="shared($event)"
        (closed)="shareReq.set(null)"
      />
    }
    @if (extendReq(); as e) {
      <pat-extend-share-dialog
        [grant]="e.grant"
        [doctor]="e.doctor"
        (done)="saved()"
        (shareAgain)="shareAgainFrom($event)"
        (closed)="extendReq.set(null)"
      />
    }
  `,
})
export class SharingDoctorsPanel {
  private readonly sharing = inject(DocumentSharingApi);
  private readonly documentsApi = inject(DocumentsApi);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);

  /** `?doctor=`: scroll to and expand this doctor. */
  readonly focusDoctorId = input<string | null>(null);
  /** Bump to reload (after a share or a revoke elsewhere on the page). */
  readonly version = input(0);

  readonly stats = output<SharingStats>();
  readonly revoked = output<RevokeNotice>();
  /** A success line for the page's live region. */
  readonly notice = output<string>();

  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly doctors = signal<SharingDoctorDto[] | null>(null);
  private readonly grants = signal<DocumentGrantDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly unavailable = signal(false);
  protected readonly actionError = signal('');
  protected readonly busyId = signal('');
  private readonly openIds = signal<readonly string[]>([]);
  /** The patient's document titles by id (for the selected shares' details), read once when needed. */
  private readonly titles = signal<ReadonlyMap<string, string>>(new Map());
  private titlesRequested = false;

  protected readonly ended = signal<DocumentGrantDto[]>([]);
  protected readonly endedOpen = signal(false);
  protected readonly endedLoading = signal(false);
  protected readonly endedError = signal('');

  protected readonly shareReq = signal<ShareRequest | null>(null);
  protected readonly extendReq = signal<{ grant: DocumentGrantDto; doctor: SharingDoctorDto | null } | null>(null);

  protected readonly withAccess = computed(() => (this.doctors() ?? []).filter((d) => d.access.state !== 'none'));
  protected readonly others = computed(() => (this.doctors() ?? []).filter((d) => d.access.state === 'none'));
  private focused = '';

  constructor() {
    effect(() => {
      this.version();
      untracked(() => this.load());
    });
    // `?doctor=`: once the cards exist, open that doctor's details and bring it into view.
    effect(() => {
      const id = this.focusDoctorId();
      const list = this.doctors();
      if (!id || !list || this.focused === id) return;
      this.focused = id;
      untracked(() => {
        if (!this.openIds().includes(id)) this.openIds.update((ids) => [...ids, id]);
        afterNextRender(
          () => {
            const el = this.doc.getElementById(`doctor-${id}`);
            el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            el?.focus({ preventScroll: true });
          },
          { injector: this.injector },
        );
      });
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    forkJoin({ doctors: this.sharing.doctors(), grants: this.sharing.grants({ status: 'active' }) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ doctors, grants }) => {
          const list = doctors.data ?? [];
          this.doctors.set(list);
          this.grants.set(grants.data ?? []);
          this.loading.set(false);
          this.unavailable.set(false);
          this.stats.emit({ activeDoctors: list.filter((d) => d.access.state !== 'none').length, unavailable: false });
          if (!this.titlesRequested && this.grants().some((g) => g.scope === 'selected')) this.loadTitles();
          if (this.endedOpen()) this.loadEnded();
        },
        error: (err: unknown) => {
          this.loading.set(false);
          if (isSharingUnavailable(err)) {
            this.unavailable.set(true);
            this.stats.emit({ activeDoctors: 0, unavailable: true });
          } else {
            this.loadError.set(apiErrorMessage(err, 'Could not load your sharing settings.'));
          }
        },
      });
  }

  /** Titles for the documents in selected shares (the newest 100; others are counted only). */
  private loadTitles(): void {
    this.titlesRequested = true;
    this.documentsApi
      .list({ page: 1, per_page: 100, sort_dir: 'desc' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.titles.set(new Map((res.data ?? []).map((d) => [d.id, d.title]))),
        error: () => {
          this.titlesRequested = false;
        },
      });
  }

  protected toggleEnded(): void {
    this.endedOpen.update((v) => !v);
    if (this.endedOpen()) this.loadEnded();
  }

  private loadEnded(): void {
    this.endedLoading.set(true);
    this.endedError.set('');
    this.sharing
      .grants({ status: 'ended' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.ended.set(res.data ?? []);
          this.endedLoading.set(false);
        },
        error: (err: unknown) => {
          this.endedLoading.set(false);
          this.endedError.set(apiErrorMessage(err, 'Could not load past shares.'));
        },
      });
  }

  // ----- Card data -----
  protected grantsOf(d: SharingDoctorDto): DocumentGrantDto[] {
    // Only shares that still stand: one that already ended (e.g. its
    // consultation was cancelled moments ago) can't be changed or stopped.
    return this.grants().filter(
      (g) => g.specialist.id === d.specialist.id && (g.status === 'active' || g.status === 'paused'),
    );
  }
  protected mainOf(d: SharingDoctorDto): DocumentGrantDto | null {
    return mainGrant(this.grantsOf(d));
  }
  protected status(d: SharingDoctorDto) {
    return doctorStatus(d);
  }
  protected summary(d: SharingDoctorDto): string {
    return doctorSummary(d, this.grants());
  }
  protected until(d: SharingDoctorDto): string {
    // A whole-folder holder: the folder share's own end (it decides whether
    // new uploads reach them), not the latest end of everything they can see.
    return accessUntilLabel(d.access) || 'No end date';
  }
  protected opened(iso: string | null): string {
    return lastOpenedLabel(iso);
  }
  protected endsBefore(d: SharingDoctorDto): SharingAppointmentRefDto | null {
    if (d.access.state !== 'active') return null;
    const folder = d.access.scope === 'all';
    if (folder ? d.access.folder_indefinite : d.access.indefinite) return null;
    const end = folder ? d.access.folder_until_label_at : d.access.until;
    return endsBeforeNext(end, d.next_appointment) ? d.next_appointment : null;
  }
  protected endsBeforeText(d: SharingDoctorDto, next: SharingAppointmentRefDto): string {
    return endsBeforeCopy(next, drName(d.specialist.name));
  }
  protected grantLine(g: DocumentGrantDto): string {
    return grantSummary(g);
  }
  protected endedLine(g: DocumentGrantDto): string {
    return endedGrantSummary(g);
  }
  protected titlesOf(g: DocumentGrantDto): string[] {
    const map = this.titles();
    return g.document_ids.map((id) => map.get(id)).filter((t): t is string => !!t);
  }
  protected isOpen(d: SharingDoctorDto): boolean {
    return this.openIds().includes(d.specialist.id);
  }
  protected toggle(d: SharingDoctorDto): void {
    const id = d.specialist.id;
    this.openIds.update((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }
  protected dr(name: string): string {
    return drName(name);
  }
  protected initialsOf(name: string): string {
    return initials(name);
  }

  // ----- Actions -----
  protected shareWith(d: SharingDoctorDto): void {
    this.shareReq.set({ mode: 'create', doctorId: d.specialist.id, grant: null, documentIds: [], scope: null, appointment: d.next_appointment });
  }

  protected change(d: SharingDoctorDto): void {
    const g = this.mainOf(d);
    if (g) this.shareReq.set({ mode: 'edit', doctorId: d.specialist.id, grant: g, documentIds: g.document_ids, scope: g.scope, appointment: g.appointment });
  }

  protected extend(d: SharingDoctorDto, g: DocumentGrantDto | null): void {
    if (g) this.extendReq.set({ grant: g, doctor: d });
  }

  /** The edited share had ended: the same choices as a new share. */
  protected shareAgainFrom(g: DocumentGrantDto): void {
    this.shareReq.set({
      mode: 'create',
      doctorId: g.specialist.id,
      grant: null,
      documentIds: g.document_ids,
      scope: g.scope,
      appointment: g.appointment,
    });
  }

  protected shared(result: DocumentShareResultDto | DocumentGrantDto): void {
    this.notice.emit('outcomes' in result ? shareResultLine(result) : 'Changes saved.');
    this.load();
  }

  protected saved(): void {
    this.notice.emit('Changes saved.');
    this.load();
  }

  protected anchorToNext(d: SharingDoctorDto, next: SharingAppointmentRefDto): void {
    const g = this.mainOf(d);
    if (!g || this.busyId()) return;
    this.busyId.set(d.specialist.id);
    this.actionError.set('');
    this.sharing
      .updateGrant(g.id, { duration: 'after_24h', appointment_id: next.id })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busyId.set('');
          this.notice.emit('Changes saved.');
          this.load();
        },
        error: (err: unknown) => {
          this.busyId.set('');
          this.actionError.set(apiErrorMessage(err, 'Could not change the end date. Please try again.'));
        },
      });
  }

  protected allowRequests(d: SharingDoctorDto): void {
    if (this.busyId()) return;
    this.busyId.set(d.specialist.id);
    this.actionError.set('');
    this.sharing
      .allowRequests(d.specialist.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busyId.set('');
          this.notice.emit(`${drName(d.specialist.name)} can ask for access again.`);
          this.load();
        },
        error: (err: unknown) => {
          this.busyId.set('');
          this.actionError.set(apiErrorMessage(err, 'Could not allow requests. Please try again.'));
        },
      });
  }

  protected async stop(d: SharingDoctorDto): Promise<void> {
    const doctor = drName(d.specialist.name);
    const what =
      d.access.scope === 'all' ? 'all your documents' : `these ${countNoun(d.access.document_count, 'document')}`;
    this.actionError.set('');
    let result: RevokeResultDto | null = null;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'user-x',
      title: `Stop sharing with ${doctor}?`,
      message: `They'll lose access to ${what} straight away. Copies they've already downloaded aren't affected.`,
      confirmLabel: 'Stop sharing',
      cancelLabel: 'Keep sharing',
      action: async () => {
        result = (await firstValueFrom(this.sharing.stopSharingWith(d.specialist.id))).data;
      },
      errorMessage: (err) =>
        isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not stop sharing. Please try again.'),
    });
    if (!confirmed || !result) return;
    const r = result as RevokeResultDto;
    this.revoked.emit({
      text: `Stopped sharing with ${doctor}.`,
      grantId: r.revoked[0]?.id ?? null,
      restorableUntil: r.restorable_until,
    });
    this.load();
  }

  protected async stopGrant(d: SharingDoctorDto, g: DocumentGrantDto): Promise<void> {
    const doctor = drName(d.specialist.name);
    const what = g.scope === 'all' ? 'your whole folder' : `these ${countNoun(g.document_count, 'document')}`;
    this.actionError.set('');
    let result: DocumentGrantDto | null = null;
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'user-x',
      title: 'Stop this share?',
      message: `They'll lose access to ${what} through this share straight away. Copies they've already downloaded aren't affected.`,
      confirmLabel: 'Stop this share',
      cancelLabel: 'Keep sharing',
      action: async () => {
        result = (await firstValueFrom(this.sharing.revokeGrant(g.id))).data;
      },
      errorMessage: (err) =>
        isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not stop this share. Please try again.'),
    });
    if (!confirmed || !result) return;
    const r = result as DocumentGrantDto;
    this.revoked.emit({ text: `Stopped sharing with ${doctor}.`, grantId: r.id, restorableUntil: r.restorable_until });
    this.load();
  }
}
