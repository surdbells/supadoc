import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import { apiErrorFields, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type {
  AdminSpecialistsQuery,
  CreateSpecialistParams,
  DoctorInviteResultDto,
  SpecialistAdminDto,
  SpecialistAdminFilter,
  SpecialistAdminRowDto,
  SpecialistReviewQueueDto,
} from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { BoDialog } from '../shared/dialog';
import { ReviewQueue } from './review-queue';
import {
  Badge,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  calendarDay,
  FIELD,
  FIELD_INVALID,
  FOCUS_RING,
  initials,
  LABEL,
  licenceBadge,
  loginBadge,
  PILL,
  plural,
  statusBadge,
} from './specialist-ui';

interface FilterDef {
  readonly value: SpecialistAdminFilter;
  readonly label: string;
  /** Which review-queue count to show on the chip. */
  readonly count?: keyof SpecialistReviewQueueDto;
  /** Highlight the chip while its count is above zero. */
  readonly attention?: boolean;
}

const FILTERS: readonly FilterDef[] = [
  { value: 'all', label: 'All' },
  { value: 'review', label: 'Needs review', count: 'pending_review', attention: true },
  { value: 'changes', label: 'Changes pending', count: 'pending_changes', attention: true },
  { value: 'credentials_pending', label: 'Documents to verify', count: 'credentials_pending', attention: true },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'approved', label: 'Approved' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'licence_expiring', label: 'Licence expiring', count: 'licences_expiring', attention: true },
  { value: 'licence_expired', label: 'Licence expired', count: 'licences_expired', attention: true },
  { value: 'credentials_missing', label: 'Credentials missing', count: 'credentials_missing', attention: true },
];

type SortKey = NonNullable<AdminSpecialistsQuery['sort_by']>;

const SORTS: readonly { value: string; label: string; sort_by: SortKey; sort_dir: 'asc' | 'desc' }[] = [
  { value: 'name', label: 'Name (A–Z)', sort_by: 'name', sort_dir: 'asc' },
  { value: 'specialty', label: 'Speciality', sort_by: 'specialty', sort_dir: 'asc' },
  { value: 'newest', label: 'Newest first', sort_by: 'created_at', sort_dir: 'desc' },
  { value: 'submitted', label: 'Recently submitted', sort_by: 'submitted_at', sort_dir: 'desc' },
  { value: 'licence', label: 'Licence expiry (soonest)', sort_by: 'licence_expires_at', sort_dir: 'asc' },
];

const PER_PAGE = 20;

interface ListState {
  q: string;
  filter: SpecialistAdminFilter;
  sort: string;
  page: number;
}

/** The list's URL query (?q=&filter=&sort=&page=), defaults left out. */
function listParams(s: ListState): Params {
  const p: Params = {};
  const q = s.q.trim();
  if (q) p['q'] = q;
  if (s.filter !== 'all') p['filter'] = s.filter;
  if (s.sort !== 'name') p['sort'] = s.sort;
  if (s.page > 1) p['page'] = s.page;
  return p;
}

/** A comparable form of a list query, to tell our own URL writes from real changes. */
function urlKey(s: ListState): string {
  return JSON.stringify(listParams(s));
}

interface Draft {
  name: string;
  specialty: string;
  email: string;
  consultation_fee: string;
  location: string;
  years_experience: string;
  bio: string;
  available: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  specialty: '',
  email: '',
  consultation_fee: '',
  location: '',
  years_experience: '',
  bio: '',
  available: true,
};

/**
 * Specialists (route `/specialists`, needs `specialists.manage`) — the doctor
 * list, paged on the server: search, a filter (needs review, changes pending,
 * documents to verify, onboarding, rejected, approved, suspended, licence
 * expiring / expired, credentials missing) and sort, all in the URL. Each row
 * opens the doctor page. "New specialist" creates one and offers the invite.
 */
@Component({
  selector: 'bo-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, AlertComponent, BoDialog],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-5 py-2">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Specialists</h1>
          <p class="font-sans text-body text-slate">Find a doctor, review their profile and documents, and manage their standing.</p>
        </div>
        <button type="button" class="${BTN_PRIMARY}" (click)="openCreate()">
          <sd-icon name="plus" [size]="18" />New specialist
        </button>
      </header>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span class="${LABEL}">Search</span>
          <span class="relative block">
            <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input
              type="search"
              class="${FIELD} min-h-11 pl-9"
              placeholder="Name, speciality, email or MDCN number"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
            />
          </span>
        </label>
        <label class="flex flex-col gap-1.5 sm:hidden">
          <span class="${LABEL}">Show</span>
          <select class="${FIELD} min-h-11" (change)="setFilter($any($event.target).value)">
            @for (f of filterChips(); track f.value) {
              <option [value]="f.value" [selected]="f.value === filter()">{{ f.label }}{{ f.count !== null ? ' (' + f.count + ')' : '' }}</option>
            }
          </select>
        </label>
        <label class="flex flex-col gap-1.5 sm:w-56">
          <span class="${LABEL}">Sort by</span>
          <select class="${FIELD} min-h-11" (change)="setSort($any($event.target).value)">
            @for (s of sorts; track s.value) {
              <option [value]="s.value" [selected]="s.value === sort()">{{ s.label }}</option>
            }
          </select>
        </label>
      </div>

      <div class="hidden flex-wrap gap-2 sm:flex" role="group" aria-label="Filter specialists">
        @for (f of filterChips(); track f.value) {
          <button
            type="button"
            [attr.aria-pressed]="filter() === f.value"
            class="inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 py-2 font-sans text-body-sm transition-colors ${FOCUS_RING}"
            [class]="filter() === f.value ? 'bg-cerulean text-white' : (f.hot ? 'bg-warning/10 text-ink ring-1 ring-warning/40 hover:bg-warning/20' : 'bg-white text-slate ring-1 ring-cloud hover:text-ink')"
            (click)="setFilter(f.value)"
          >
            @if (filter() === f.value) {
              <sd-icon name="check" [size]="14" />
            }
            {{ f.label }}
            @if (f.count !== null) {
              <span class="rounded-pill px-1.5 text-caption font-semibold" [class]="filter() === f.value ? 'bg-white/20' : (f.hot ? 'bg-warning/20' : 'bg-glacier')">{{ f.count }}</span>
            }
          </button>
        }
      </div>

      <p #summary tabindex="-1" class="font-sans text-body-sm text-slate focus:outline-none" aria-live="polite">
        @if (loading()) {
          Loading specialists…
        } @else if (!listError()) {
          {{ summaryText() }}
        }
      </p>

      @if (loading() && rows().length === 0) {
        <div class="flex flex-col gap-3" aria-hidden="true">
          <div class="sd-shimmer h-24 rounded-card"></div>
          <div class="sd-shimmer h-24 rounded-card"></div>
          <div class="sd-shimmer h-24 rounded-card"></div>
        </div>
      } @else if (listError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white px-5 py-14 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate" role="alert">{{ listError() }}</p>
          <button type="button" class="${BTN_SECONDARY}" (click)="fetch()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
        </div>
      } @else {
        <ul class="flex flex-col gap-3" [attr.aria-busy]="loading() || null" [class.opacity-60]="loading()">
          @for (s of rows(); track s.id) {
            <li>
              <a
                [routerLink]="['/specialists', s.id]"
                [state]="{ listQuery: queryParams() }"
                class="group flex flex-col gap-3 rounded-card border border-cloud bg-white p-4 transition-colors hover:border-cerulean sm:flex-row sm:items-center sm:gap-4 sm:p-5 ${FOCUS_RING}"
              >
                <span class="flex min-w-0 flex-1 items-center gap-3">
                  @if (photoSrc(s.photo_url); as src) {
                    <img [src]="src" alt="" class="size-11 shrink-0 rounded-full border border-cloud object-cover" />
                  } @else {
                    <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-sans text-caption font-semibold text-cerulean" aria-hidden="true">{{ initialsOf(s.name) }}</span>
                  }
                  <span class="flex min-w-0 flex-col">
                    <span class="break-words font-heading text-body font-semibold text-ink group-hover:text-cerulean">{{ s.name }}</span>
                    <span class="font-sans text-caption text-cerulean">{{ s.specialty }}</span>
                    <span class="truncate font-sans text-caption text-slate">{{ s.email || 'No contact email' }}</span>
                  </span>
                </span>
                <span class="flex flex-wrap items-center gap-1.5 sm:max-w-[60%] sm:justify-end">
                  @for (b of badgesFor(s); track b.label) {
                    <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                  }
                </span>
                <sd-icon name="chevron-right" [size]="20" class="hidden shrink-0 text-slate group-hover:text-cerulean sm:block" />
              </a>
            </li>
          } @empty {
            <li class="flex flex-col items-center gap-2 rounded-card border border-cloud bg-white px-5 py-12 text-center">
              <sd-icon name="stethoscope" [size]="28" class="text-slate" />
              <p class="font-sans text-body-sm text-slate">{{ emptyText() }}</p>
              @if (search() || filter() !== 'all') {
                <button type="button" class="${BTN_GHOST}" (click)="clearFilters()">Clear search and filter</button>
              }
            </li>
          }
        </ul>

        @if (totalPages() > 1) {
          <nav class="flex items-center justify-between gap-3" aria-label="Specialist pages">
            <button type="button" class="${BTN_SECONDARY}" [disabled]="page() <= 1 || loading()" (click)="goPage(page() - 1)">
              <sd-icon name="chevron-left" [size]="18" />Previous
            </button>
            <span class="font-sans text-body-sm text-slate">Page {{ page() }} of {{ totalPages() }}</span>
            <button type="button" class="${BTN_SECONDARY}" [disabled]="page() >= totalPages() || loading()" (click)="goPage(page() + 1)">
              Next<sd-icon name="chevron-right" [size]="18" />
            </button>
          </nav>
        }
      }
    </div>

    <!-- New specialist → invite -->
    <bo-dialog
      [open]="createOpen()"
      [title]="createTitle()"
      [subtitle]="created() ? 'They set their password from the link, then complete their profile and documents.' : 'They are not listed until they complete their profile and a reviewer approves it.'"
      size="lg"
      [busy]="creating() || inviting()"
      (closed)="closeCreate()"
    >
      @if (created(); as c) {
        <div class="flex flex-col gap-4">
          <sd-alert tone="success">{{ c.name }} was created.</sd-alert>
          @if (inviteResult(); as r) {
            <div class="flex flex-col gap-1 rounded-field bg-sage/10 px-4 py-3 font-sans text-body-sm text-ink" role="status">
              <span>{{ r.email_sent ? 'Invite sent to ' + (r.login?.email ?? c.email) + '. The link expires in 7 days.' : 'The invite link was created, but the email to ' + (r.login?.email ?? c.email) + ' could not be sent. Resend it from the doctor page shortly.' }}</span>
              @if (r.dev_link) {
                <span class="break-all text-caption text-slate">Testing only — set-password link: <span class="select-all font-mono text-ink">{{ r.dev_link }}</span></span>
              }
            </div>
          } @else if (c.email) {
            <p class="font-sans text-body-sm text-ink">Send the invite to <span class="font-semibold">{{ c.email }}</span> now, or later from the doctor page.</p>
          } @else {
            <sd-alert tone="info">Add the doctor's email on their page, then send the invite from there.</sd-alert>
          }
          @if (inviteError()) {
            <sd-alert tone="error">{{ inviteError() }}</sd-alert>
          }
        </div>
      } @else {
        <form id="bo-create-specialist" class="flex flex-col gap-4" novalidate (submit)="$event.preventDefault(); submitCreate()">
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Full name (required)</span>
              <input type="text" class="${FIELD}" [class]="createErrors()['name'] ? '${FIELD_INVALID}' : ''" autocomplete="off" [value]="draft().name" (input)="setDraft('name', $any($event.target).value)" placeholder="Dr Jane Doe" [attr.aria-invalid]="createErrors()['name'] ? 'true' : null" [attr.aria-describedby]="createErrors()['name'] ? 'bo-new-name-err' : null" />
              @if (createErrors()['name']; as e) { <span id="bo-new-name-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Speciality (required)</span>
              <input type="text" class="${FIELD}" [class]="createErrors()['specialty'] ? '${FIELD_INVALID}' : ''" [value]="draft().specialty" (input)="setDraft('specialty', $any($event.target).value)" placeholder="Cardiology" [attr.aria-invalid]="createErrors()['specialty'] ? 'true' : null" [attr.aria-describedby]="createErrors()['specialty'] ? 'bo-new-spec-err' : null" />
              @if (createErrors()['specialty']; as e) { <span id="bo-new-spec-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Contact email</span>
              <input type="email" class="${FIELD}" [class]="createErrors()['email'] ? '${FIELD_INVALID}' : ''" [value]="draft().email" (input)="setDraft('email', $any($event.target).value)" placeholder="doctor@example.com" [attr.aria-invalid]="createErrors()['email'] ? 'true' : null" [attr.aria-describedby]="createErrors()['email'] ? 'bo-new-email-err' : null" />
              @if (createErrors()['email']; as e) { <span id="bo-new-email-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Consultation fee (₦)</span>
              <input type="number" min="0" step="500" inputmode="decimal" class="${FIELD}" [value]="draft().consultation_fee" (input)="setDraft('consultation_fee', $any($event.target).value)" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Location</span>
              <input type="text" class="${FIELD}" [value]="draft().location" (input)="setDraft('location', $any($event.target).value)" placeholder="Lagos, Nigeria" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Years of experience</span>
              <input type="number" min="0" max="80" inputmode="numeric" class="${FIELD}" [value]="draft().years_experience" (input)="setDraft('years_experience', $any($event.target).value)" />
            </label>
          </div>
          <label class="flex flex-col gap-1.5">
            <span class="${LABEL}">Short bio</span>
            <textarea rows="3" class="${FIELD}" [value]="draft().bio" (input)="setDraft('bio', $any($event.target).value)"></textarea>
          </label>
          <label class="flex min-h-11 cursor-pointer items-center gap-2">
            <input type="checkbox" class="size-5 accent-cerulean" [checked]="draft().available" (change)="setDraft('available', $any($event.target).checked)" />
            <span class="font-sans text-body-sm text-ink">Taking bookings once approved</span>
          </label>
          @if (createError()) {
            <sd-alert tone="error">{{ createError() }}</sd-alert>
          }
        </form>
      }
      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        @if (created(); as c) {
          <a [routerLink]="['/specialists', c.id]" class="${BTN_GHOST}" (click)="closeCreate()">Open doctor page</a>
          @if (c.email && !inviteResult()) {
            <button type="button" class="${BTN_PRIMARY}" [disabled]="inviting()" (click)="inviteCreated()" data-autofocus>
              <sd-icon [name]="inviting() ? 'loader-circle' : 'mail'" [size]="18" [class.animate-spin]="inviting()" />{{ inviting() ? 'Sending…' : 'Send invite' }}
            </button>
          } @else {
            <button type="button" class="${BTN_PRIMARY}" (click)="closeCreate()" data-autofocus>Done</button>
          }
        } @else {
          <button type="button" class="${BTN_GHOST}" [disabled]="creating()" (click)="closeCreate()">Cancel</button>
          <button type="submit" form="bo-create-specialist" class="${BTN_PRIMARY}" [disabled]="creating()">
            {{ creating() ? 'Creating…' : 'Create specialist' }}
          </button>
        }
      </div>
    </bo-dialog>
  `,
})
export class AdminSpecialists implements OnInit {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly reviewQueue = inject(ReviewQueue);

  protected readonly sorts = SORTS;

  // List state (mirrored in the URL: ?q=&filter=&sort=&page=)
  protected readonly search = signal('');
  protected readonly filter = signal<SpecialistAdminFilter>('all');
  protected readonly sort = signal('name');
  protected readonly page = signal(1);
  protected readonly rows = signal<SpecialistAdminRowDto[]>([]);
  protected readonly total = signal(0);
  protected readonly totalPages = signal(1);
  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  private listSub?: Subscription;
  /** The list query last read from or written to the URL (see `urlKey`). */
  private urlState = '';
  private searchTimer?: ReturnType<typeof setTimeout>;
  private readonly summaryEl = viewChild<ElementRef<HTMLElement>>('summary');
  private readonly createDialog = viewChild(BoDialog);

  // New specialist → invite
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createError = signal('');
  protected readonly createErrors = signal<Record<string, string>>({});
  protected readonly draft = signal<Draft>({ ...EMPTY_DRAFT });
  protected readonly created = signal<SpecialistAdminDto | null>(null);
  protected readonly inviting = signal(false);
  protected readonly inviteError = signal('');
  protected readonly inviteResult = signal<DoctorInviteResultDto | null>(null);

  protected readonly filterChips = computed(() => {
    const counts = this.reviewQueue.counts();
    return FILTERS.map((f) => {
      const count = f.count && counts ? Math.max(0, Number(counts[f.count]) || 0) : null;
      return { ...f, count, hot: !!f.attention && (count ?? 0) > 0 };
    });
  });

  protected readonly createTitle = computed(() => {
    const c = this.created();
    return c ? `Invite ${c.name}` : 'New specialist';
  });

  protected readonly summaryText = computed(() => {
    const n = this.total();
    const label = FILTERS.find((f) => f.value === this.filter())?.label ?? '';
    const what = plural(n, 'doctor');
    const q = this.search().trim();
    return (this.filter() === 'all' ? what : `${what} · ${label}`) + (q ? ` matching “${q}”` : '');
  });

  protected readonly emptyText = computed(() =>
    this.search().trim() || this.filter() !== 'all'
      ? 'No specialists match this search and filter.'
      : 'No specialists yet. Create one to get started.',
  );

  /** The list's query params, carried to the doctor page so "Back" returns here. */
  protected readonly queryParams = computed<Params>(() => listParams(this.listState()));

  private listState(): ListState {
    return { q: this.search(), filter: this.filter(), sort: this.sort(), page: this.page() };
  }

  ngOnInit(): void {
    // The URL drives the list: on arrival, and whenever it changes while the
    // list is open (the sidebar link, a `?filter=review` link — the one in the
    // "doctor ready for review" email). Our own URL writes are skipped. (The
    // review badge is refreshed by the shell on every navigation.)
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((qp) => {
      const wanted = qp.get('filter') as SpecialistAdminFilter | null;
      const sort = qp.get('sort');
      const page = Number(qp.get('page'));
      const next: ListState = {
        q: qp.get('q') ?? '',
        filter: wanted && FILTERS.some((f) => f.value === wanted) ? wanted : 'all',
        sort: sort && SORTS.some((s) => s.value === sort) ? sort : 'name',
        page: Number.isInteger(page) && page > 1 ? page : 1,
      };
      if (this.urlState !== '' && urlKey(next) === this.urlState) return;
      this.search.set(next.q);
      this.filter.set(next.filter);
      this.sort.set(next.sort);
      this.page.set(next.page);
      this.urlState = urlKey(next);
      this.fetch();
    });
  }

  protected onSearch(term: string): void {
    this.search.set(term);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.fetch();
    }, 300);
  }

  protected setFilter(value: string): void {
    if (!FILTERS.some((f) => f.value === value)) return;
    this.filter.set(value as SpecialistAdminFilter);
    this.page.set(1);
    this.fetch();
  }

  protected setSort(value: string): void {
    if (!SORTS.some((s) => s.value === value)) return;
    this.sort.set(value);
    this.page.set(1);
    this.fetch();
  }

  protected clearFilters(): void {
    this.search.set('');
    this.filter.set('all');
    this.page.set(1);
    this.fetch();
  }

  protected goPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.page.set(page);
    this.fetch(true);
  }

  /** Load the current page (and mirror the state in the URL). */
  protected fetch(moveFocus = false): void {
    clearTimeout(this.searchTimer);
    this.syncUrl();
    this.listSub?.unsubscribe();
    this.loading.set(true);
    this.listError.set('');
    const sort = SORTS.find((s) => s.value === this.sort()) ?? SORTS[0];
    const q = this.search().trim();
    this.listSub = this.api
      .listAdminPage({
        q: q || undefined,
        filter: this.filter() === 'all' ? undefined : this.filter(),
        page: this.page(),
        per_page: PER_PAGE,
        sort_by: sort.sort_by,
        sort_dir: sort.sort_dir,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.rows.set(res.data ?? []);
          this.total.set(res.meta?.total ?? res.data.length);
          this.totalPages.set(Math.max(1, res.meta?.total_pages ?? 1));
          this.loading.set(false);
          // A page past the end (e.g. an old link): go to the last one.
          if (this.page() > this.totalPages()) {
            this.page.set(this.totalPages());
            this.fetch();
            return;
          }
          if (moveFocus) {
            afterNextRender(() => this.summaryEl()?.nativeElement.focus(), { injector: this.injector });
          }
        },
        error: (err: unknown) => {
          this.listError.set(apiErrorMessage(err, 'Could not load specialists.'));
          this.loading.set(false);
        },
      });
  }

  /** Mirror the state in the URL — unless it already says this (e.g. it was just read from it). */
  private syncUrl(): void {
    const key = urlKey(this.listState());
    if (key === this.urlState) return;
    this.urlState = key;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.queryParams(),
      replaceUrl: true,
    });
  }

  /** Status, licence, login and what needs attention — icon + words each. */
  protected badgesFor(s: SpecialistAdminRowDto): Badge[] {
    const out: Badge[] = [statusBadge(s.status)];
    const live = !s.status || s.status === 'approved' || s.status === 'suspended';
    if (live || s.licence_status !== 'missing') out.push(licenceBadge(s.licence_status, s.licence_expires_at));
    out.push(loginBadge(s.login));
    if (s.credentials_pending > 0) {
      out.push({ label: plural(s.credentials_pending, 'document') + ' to verify', icon: 'file-check', cls: 'bg-warning/15 text-ink' });
    }
    if (s.has_pending_changes) {
      out.push({ label: 'Changes pending', icon: 'square-pen', cls: 'bg-warning/15 text-ink' });
    }
    if (s.credentials_missing) {
      out.push({
        label: 'Credentials missing' + (s.credentials_due_at ? ` · due ${calendarDay(s.credentials_due_at)}` : ''),
        icon: 'badge-alert',
        cls: 'bg-alert/10 text-alert',
      });
    }
    return out;
  }

  // ----- New specialist -----

  protected openCreate(): void {
    this.draft.set({ ...EMPTY_DRAFT });
    this.createError.set('');
    this.createErrors.set({});
    this.created.set(null);
    this.inviteResult.set(null);
    this.inviteError.set('');
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    if (this.creating() || this.inviting()) return;
    this.createOpen.set(false);
  }

  protected setDraft(key: keyof Draft, value: string | boolean): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
    if (this.createErrors()[key]) {
      this.createErrors.update((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
    }
  }

  protected submitCreate(): void {
    if (this.creating()) return;
    const d = this.draft();
    const errors: Record<string, string> = {};
    if (d.name.trim() === '') errors['name'] = "Enter the doctor's full name.";
    if (d.specialty.trim() === '') errors['specialty'] = 'Enter their speciality.';
    if (d.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) errors['email'] = 'Enter a valid email address.';
    this.createErrors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.createError.set('Please fix the highlighted fields.');
      return;
    }
    this.creating.set(true);
    this.createError.set('');
    const params: CreateSpecialistParams = {
      name: d.name.trim(),
      specialty: d.specialty.trim(),
      email: d.email.trim() || undefined,
      consultation_fee: d.consultation_fee.trim() || undefined,
      location: d.location.trim() || undefined,
      years_experience: d.years_experience.trim() || undefined,
      bio: d.bio.trim() || undefined,
      available: d.available,
    };
    this.api
      .createAdmin(params)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.creating.set(false);
          this.created.set(res.data);
          // The invite step replaced the form and its focused button.
          this.createDialog()?.refocus();
          this.fetch();
          this.reviewQueue.refresh();
        },
        error: (err: unknown) => {
          this.creating.set(false);
          this.createErrors.set(apiErrorFields(err));
          this.createError.set(apiErrorMessage(err, 'Could not create the specialist.'));
        },
      });
  }

  protected inviteCreated(): void {
    const c = this.created();
    if (!c || this.inviting()) return;
    this.inviting.set(true);
    this.inviteError.set('');
    this.api
      .invite(c.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.inviting.set(false);
          this.inviteResult.set(res.data);
          // "Send invite" gave way to "Done".
          this.createDialog()?.refocus();
          this.fetch();
        },
        error: (err: unknown) => {
          this.inviting.set(false);
          this.inviteError.set(apiErrorMessage(err, 'Could not send the invite.'));
          // "Send invite" lost focus while it was disabled.
          this.createDialog()?.refocus();
        },
      });
  }

  protected photoSrc(url: string | null | undefined): string | null {
    return this.api.assetUrl((url ?? '').trim() || null);
  }

  protected initialsOf(name: string): string {
    return initials(name);
  }
}
