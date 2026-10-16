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
import { AlertComponent, EmptyStateComponent, IconComponent, SearchSelectComponent } from '@supadoc/ui';
import { BoDialog } from '../shared/dialog';
import {
  CARD_ITEM,
  CARD_LIST,
  CARD_ROW,
  COUNT_BADGE,
  EMPTY_FRAME,
  FIELD_ICON,
  FIELD_WITH_ICON,
  FILTER_CHIP,
  FILTER_CHIP_HOT,
  FILTER_CHIP_OFF,
  FILTER_CHIP_ON,
  FILTER_CHIPS,
  PAGE,
  PAGE_HEADER,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PAGE_TITLE_ROW,
  SEARCH_BOX,
  SEARCH_CLEAR,
  SEARCH_ICON,
  SEARCH_INPUT,
  SEARCH_WRAP,
} from '../shared/layout';
import { PhotoPicker, photoErrorText, photoUploadStep } from './photo-picker';
import { ReviewQueue } from './review-queue';
import { SearchSelectA11y } from './select-a11y';
import { SpecialistAvatar } from './specialist-avatar';
import { isActiveSpecialty, SpecialtyChoices, specialtyField } from './specialty-choices';
import {
  Badge,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  calendarDay,
  FIELD,
  FIELD_INVALID,
  FOCUS_RING,
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
  { value: 'specialty', label: 'Specialty', sort_by: 'specialty', sort_dir: 'asc' },
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
 * opens the doctor page. "New specialist" creates one — specialty picked from
 * the Reference data list, an optional photo uploaded right after the record
 * is created — and offers the invite.
 */
@Component({
  selector: 'bo-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IconComponent,
    AlertComponent,
    EmptyStateComponent,
    BoDialog,
    SearchSelectComponent,
    SearchSelectA11y,
    PhotoPicker,
    SpecialistAvatar,
  ],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER}">
        <div class="${PAGE_HEADER_TEXT}">
          <div class="${PAGE_TITLE_ROW}">
            <h1 class="${PAGE_TITLE}">Specialists</h1>
            @if (allTotal(); as n) {
              <span class="${COUNT_BADGE}">
                <sd-icon name="stethoscope" [size]="14" />{{ plural(n, 'doctor') }}
              </span>
            }
          </div>
          <p class="${PAGE_SUBTITLE}">Find a doctor, review their profile and documents, and manage their standing.</p>
        </div>
        <button type="button" class="${BTN_PRIMARY}" (click)="openCreate()">
          <sd-icon name="plus" [size]="18" />New specialist
        </button>
      </header>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="search" class="${SEARCH_WRAP}">
          <label for="bo-specialists-search" class="sr-only">Search specialists by name, specialty, email or MDCN number</label>
          <div class="${SEARCH_BOX}">
            <sd-icon name="search" [size]="20" class="${SEARCH_ICON}" />
            <input
              id="bo-specialists-search"
              type="search"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="search"
              class="${SEARCH_INPUT}"
              placeholder="Name, specialty, email or MDCN number…"
              [value]="search()"
              (input)="onSearch($any($event.target).value)"
              (keydown.escape)="search() && onSearch('')"
            />
            @if (search()) {
              <button type="button" class="${SEARCH_CLEAR}" aria-label="Clear search" (click)="onSearch('')">
                <sd-icon name="x" [size]="16" />
              </button>
            }
          </div>
        </div>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label class="relative block sm:hidden">
            <span class="sr-only">Show</span>
            <sd-icon name="filter" [size]="20" class="${FIELD_ICON}" />
            <select class="${FIELD_WITH_ICON}" (change)="setFilter($any($event.target).value)">
              @for (f of filterChips(); track f.value) {
                <option [value]="f.value" [selected]="f.value === filter()">{{ f.label }}{{ f.count !== null ? ' (' + f.count + ')' : '' }}</option>
              }
            </select>
          </label>
          <label class="relative block sm:w-64">
            <span class="sr-only">Sort by</span>
            <sd-icon name="arrow-up-down" [size]="20" class="${FIELD_ICON}" />
            <select class="${FIELD_WITH_ICON}" (change)="setSort($any($event.target).value)">
              @for (s of sorts; track s.value) {
                <option [value]="s.value" [selected]="s.value === sort()">{{ s.label }}</option>
              }
            </select>
          </label>
        </div>
      </div>

      <div class="hidden ${FILTER_CHIPS} sm:flex" role="group" aria-label="Filter specialists">
        @for (f of filterChips(); track f.value) {
          <button
            type="button"
            [attr.aria-pressed]="filter() === f.value"
            class="${FILTER_CHIP}"
            [class]="filter() === f.value ? '${FILTER_CHIP_ON}' : (f.hot ? '${FILTER_CHIP_HOT}' : '${FILTER_CHIP_OFF}')"
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
        <div class="${CARD_LIST}" aria-hidden="true">
          @for (i of [1, 2, 3]; track i) {
            <div class="${CARD_ITEM} sm:flex-row sm:items-center">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <div class="sd-shimmer size-12 shrink-0 rounded-full"></div>
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <div class="sd-shimmer h-4 w-40 max-w-full rounded-pill"></div>
                  <div class="sd-shimmer h-3 w-56 max-w-full rounded-pill"></div>
                </div>
              </div>
              <div class="sd-shimmer h-6 w-40 rounded-pill"></div>
            </div>
          }
        </div>
      } @else if (listError()) {
        <div class="${EMPTY_FRAME}">
          <sd-empty-state icon="wifi-off" tone="error" title="Couldn't load specialists" [message]="listError()">
            <button type="button" class="${BTN_SECONDARY}" (click)="fetch()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
          </sd-empty-state>
        </div>
      } @else {
        <ul class="${CARD_LIST}" [attr.aria-busy]="loading() || null" [class.opacity-60]="loading()">
          @for (s of rows(); track s.id) {
            <li>
              <a
                [routerLink]="['/specialists', s.id]"
                [state]="{ listQuery: queryParams() }"
                class="${CARD_ROW} sm:flex-row sm:items-center sm:gap-6 ${FOCUS_RING}"
              >
                <span class="flex min-w-0 flex-1 items-center gap-3">
                  <bo-specialist-avatar [src]="photoSrc(s.photo_url)" [name]="s.name" size="md" />
                  <span class="flex min-w-0 flex-col">
                    <span class="break-words font-heading text-body-lg text-ink transition-colors group-hover:text-cerulean">{{ s.name }}</span>
                    <span class="truncate font-sans text-body-sm text-cerulean">{{ s.specialty }}</span>
                    <span class="truncate font-sans text-body-sm text-slate">{{ s.email || 'No contact email' }}</span>
                  </span>
                </span>
                <span class="flex flex-wrap items-center gap-1.5 sm:max-w-[60%] sm:justify-end">
                  @for (b of badgesFor(s); track b.label) {
                    <span class="${PILL}" [class]="b.cls"><sd-icon [name]="b.icon" [size]="13" />{{ b.label }}</span>
                  }
                </span>
                <sd-icon name="chevron-right" [size]="22" class="hidden shrink-0 text-slate transition-colors group-hover:text-cerulean sm:block" />
              </a>
            </li>
          } @empty {
            <li>
              @if (search() || filter() !== 'all') {
                <sd-empty-state icon="search" title="No specialists match" message="Try a different name, email or MDCN number, or another filter.">
                  <button type="button" class="${BTN_SECONDARY}" (click)="clearFilters()"><sd-icon name="x" [size]="16" />Clear search and filter</button>
                </sd-empty-state>
              } @else {
                <sd-empty-state icon="stethoscope" tone="brand" title="No specialists yet" message="Create one with New specialist — they get an invite to set up their profile." />
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
      [busy]="creating() || inviting() || uploadProgress() !== null"
      (closed)="closeCreate()"
    >
      @if (created(); as c) {
        <div class="flex flex-col gap-4">
          <sd-alert tone="success">{{ c.name }} was created.</sd-alert>
          @if (photoFile() || photoUploadError() || photoUploaded()) {
            <!-- The photo goes up right after the record exists. -->
            <div class="flex flex-col gap-3 rounded-field border border-cloud px-4 py-3" aria-live="polite">
              @if (uploadProgress() !== null) {
                <div class="flex items-center gap-3">
                  <sd-icon name="loader-circle" [size]="18" class="shrink-0 animate-spin text-cerulean" />
                  <span class="font-sans text-body-sm text-ink">Uploading the photo…</span>
                  <!-- Not announced on every tick: the progressbar below carries the value. -->
                  <span class="ml-auto font-sans text-caption tabular-nums text-slate" aria-hidden="true">{{ uploadProgress() }}%</span>
                </div>
                <div class="h-2 overflow-hidden rounded-pill bg-glacier" role="progressbar" aria-label="Uploading the photo" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="uploadProgress()">
                  <div class="h-full rounded-pill bg-cerulean transition-[width] duration-200" [style.width.%]="uploadProgress()"></div>
                </div>
              } @else if (photoUploadError(); as e) {
                <p class="flex items-start gap-2 font-sans text-body-sm text-alert" role="alert">
                  <sd-icon name="circle-alert" [size]="18" class="mt-0.5 shrink-0" />
                  <span>The photo wasn't added: {{ sentence(e) }} You can try again, or add it later on the doctor page.</span>
                </p>
                @if (photoFile()) {
                  <button type="button" class="${BTN_SECONDARY} w-full sm:w-fit" (click)="uploadCreatedPhoto()">
                    <sd-icon name="refresh-cw" [size]="16" />Try the upload again
                  </button>
                }
              } @else if (photoUploaded()) {
                <p class="flex items-center gap-3 font-sans text-body-sm text-ink">
                  <bo-specialist-avatar [src]="photoSrc(c.photo_url)" [name]="c.name" size="md" />
                  Photo added.
                </p>
              }
            </div>
          }
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
          <div class="grid items-start gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Full name (required)</span>
              <input type="text" class="${FIELD}" [class]="createErrors()['name'] ? '${FIELD_INVALID}' : ''" autocomplete="off" [value]="draft().name" (input)="setDraft('name', $any($event.target).value)" placeholder="Dr Jane Doe" [attr.aria-invalid]="createErrors()['name'] ? 'true' : null" [attr.aria-describedby]="createErrors()['name'] ? 'bo-new-name-err' : null" />
              @if (createErrors()['name']; as e) { <span id="bo-new-name-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
            <div class="flex min-w-0 flex-col gap-1.5">
              <span id="bo-new-spec-label" class="${LABEL}">Specialty (required)</span>
              @switch (choices.state()) {
                @case ('ready') {
                  <sd-search-select
                    boSelectA11y="bo-new-spec-label"
                    [boSelectDescribedBy]="createErrors()['specialty'] ? 'bo-new-spec-err' : null"
                    [options]="specialty().options"
                    [value]="specialty().value"
                    (valueChange)="setDraft('specialty', $event)"
                    [clearable]="false"
                    placeholder="Choose a specialty"
                    searchPlaceholder="Search specialties…"
                    [error]="createErrors()['specialty']"
                  />
                  @if (createErrors()['specialty']; as e) { <span id="bo-new-spec-err" class="sr-only">{{ e }}</span> }
                }
                @case ('loading') {
                  <div class="sd-shimmer h-12 rounded-field" aria-hidden="true"></div>
                  <span class="sr-only" role="status">Loading the specialty list…</span>
                  @if (createErrors()['specialty']; as e) { <span id="bo-new-spec-err" class="font-sans text-caption text-alert">{{ e }}</span> }
                }
                @default {
                  <!-- No list to pick from yet (or it failed to load): type it; the API still checks it. -->
                  <input type="text" class="${FIELD}" [class]="createErrors()['specialty'] ? '${FIELD_INVALID}' : ''" aria-labelledby="bo-new-spec-label" [value]="draft().specialty" (input)="setDraft('specialty', $any($event.target).value)" placeholder="Cardiology" [attr.aria-invalid]="createErrors()['specialty'] ? 'true' : null" [attr.aria-describedby]="createErrors()['specialty'] ? 'bo-new-spec-err' : null" />
                  @if (createErrors()['specialty']; as e) { <span id="bo-new-spec-err" class="font-sans text-caption text-alert">{{ e }}</span> }
                  @if (choices.state() === 'failed') {
                    <span class="flex flex-wrap items-center gap-x-2 font-sans text-caption text-slate">
                      The specialty list could not be loaded.
                      <button type="button" class="min-h-11 font-semibold text-cerulean hover:underline" (click)="choices.load()">Try again</button>
                    </span>
                  }
                }
              }
            </div>
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
          <div class="flex flex-col gap-1.5" role="group" aria-labelledby="bo-new-photo-label">
            <span id="bo-new-photo-label" class="${LABEL}">Profile photo (optional)</span>
            <bo-photo-picker
              [src]="photoPreview()"
              [name]="draft().name"
              [disabled]="creating()"
              addLabel="Add a photo"
              replaceLabel="Choose another photo"
              removeLabel="Don't use this photo"
              (picked)="pickPhoto($event)"
              (remove)="dropPhoto()"
            />
            <span class="font-sans text-caption text-slate">Uploaded as soon as the specialist is created.</span>
          </div>
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
          @if (uploadProgress() === null) {
            <a [routerLink]="['/specialists', c.id]" class="${BTN_GHOST}" (click)="closeCreate()">Open doctor page</a>
          }
          @if (c.email && !inviteResult()) {
            <button type="button" class="${BTN_PRIMARY}" [disabled]="inviting()" (click)="inviteCreated()" data-autofocus>
              <sd-icon [name]="inviting() ? 'loader-circle' : 'mail'" [size]="18" [class.animate-spin]="inviting()" />{{ inviting() ? 'Sending…' : 'Send invite' }}
            </button>
          } @else {
            <button type="button" class="${BTN_PRIMARY}" [disabled]="uploadProgress() !== null" (click)="closeCreate()" data-autofocus>Done</button>
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
  protected readonly choices = inject(SpecialtyChoices);

  protected readonly sorts = SORTS;
  protected readonly plural = plural;
  /**
   * Every doctor (the header badge): from an unfiltered page, or — when the
   * list opened filtered or searched (a dashboard or email link) — one tiny
   * unfiltered read (`countAll`).
   */
  protected readonly allTotal = signal<number | null>(null);
  /** A doctor was added while the list was filtered: re-count on the next filtered load. */
  private allTotalStale = false;
  private countSub?: Subscription;

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

  // New specialist → photo (uploaded right after the record is created)
  /** The chosen image, kept until it has been uploaded. */
  protected readonly photoFile = signal<File | null>(null);
  /** Its preview (an object URL). */
  protected readonly photoPreview = signal<string | null>(null);
  /** 0–100 while it uploads; null when idle. */
  protected readonly uploadProgress = signal<number | null>(null);
  protected readonly photoUploadError = signal('');
  protected readonly photoUploaded = signal(false);
  private uploadSub?: Subscription;

  /** The specialty dropdown for the draft. */
  protected readonly specialty = computed(() => specialtyField(this.choices.items(), this.draft().specialty));

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

  /** The list's query params, carried to the doctor page so "Back" returns here. */
  protected readonly queryParams = computed<Params>(() => listParams(this.listState()));

  private listState(): ListState {
    return { q: this.search(), filter: this.filter(), sort: this.sort(), page: this.page() };
  }

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.uploadSub?.unsubscribe();
      this.setPreview(null);
    });
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
          if (this.filter() === 'all' && q === '') {
            this.countSub?.unsubscribe();
            this.allTotalStale = false;
            this.allTotal.set(this.total());
          } else if (this.allTotalStale || (this.allTotal() === null && (this.countSub?.closed ?? true))) {
            this.countAll();
          }
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

  /** How many doctors there are in all (the header badge), for a list that is filtered or searched. */
  private countAll(): void {
    this.countSub?.unsubscribe();
    this.allTotalStale = false;
    this.countSub = this.api
      .listAdminPage({ page: 1, per_page: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const n = res.meta?.total;
          if (typeof n === 'number') this.allTotal.set(n);
        },
        // The badge is a nicety: without it the page still works.
        error: () => undefined,
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
    this.resetPhoto();
    // Re-read the specialty list, so an item just added under Reference data shows up.
    this.choices.load();
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    if (this.creating() || this.inviting() || this.uploadProgress() !== null) return;
    this.createOpen.set(false);
    this.resetPhoto();
  }

  // ----- New specialist: photo -----

  protected pickPhoto(file: File): void {
    this.photoFile.set(file);
    this.setPreview(URL.createObjectURL(file));
  }

  /** Forget the chosen image (nothing was uploaded yet, so nothing to confirm). */
  protected dropPhoto(): void {
    this.photoFile.set(null);
    this.setPreview(null);
  }

  /** Upload the chosen photo to the specialist just created (also "Try the upload again"). */
  protected uploadCreatedPhoto(): void {
    const c = this.created();
    const file = this.photoFile();
    if (!c || !file || this.uploadProgress() !== null) return;
    this.uploadProgress.set(0);
    this.photoUploadError.set('');
    this.uploadSub = this.api
      .uploadPhoto(c.id, file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          const step = photoUploadStep(event);
          if (step.progress !== undefined) this.uploadProgress.set(step.progress);
          if (step.result) {
            this.created.set(step.result);
            this.photoUploaded.set(true);
            this.photoFile.set(null);
            this.setPreview(null);
          }
        },
        error: (err: unknown) => {
          this.uploadProgress.set(null);
          this.photoUploadError.set(photoErrorText(err));
          this.createDialog()?.refocus();
        },
        complete: () => {
          this.uploadProgress.set(null);
          this.fetch();
          // The footer's buttons were disabled while it uploaded.
          this.createDialog()?.refocus();
        },
      });
  }

  private resetPhoto(): void {
    this.uploadSub?.unsubscribe();
    this.uploadProgress.set(null);
    this.photoUploadError.set('');
    this.photoUploaded.set(false);
    this.dropPhoto();
  }

  private setPreview(url: string | null): void {
    const old = this.photoPreview();
    if (old) URL.revokeObjectURL(old);
    this.photoPreview.set(url);
  }

  /** End a message with a full stop, so another sentence can follow it. */
  protected sentence(text: string): string {
    const t = text.trim();
    return /[.!?]$/.test(t) ? t : `${t}.`;
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
    if (d.specialty.trim() === '') {
      const state = this.choices.state();
      errors['specialty'] =
        state === 'loading' ? 'Wait for the specialty list to load, then choose one.'
        : state === 'ready' ? 'Choose their specialty.'
        : 'Enter their specialty.';
    } else if (this.choices.state() === 'ready' && !isActiveSpecialty(this.choices.items(), d.specialty)) {
      errors['specialty'] = 'Choose a specialty from the list.';
    }
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
          // One more doctor: a filtered list re-counts the header badge.
          this.allTotalStale = true;
          this.fetch();
          this.reviewQueue.refresh();
          // The record exists now: the chosen photo goes up straight away.
          if (this.photoFile()) this.uploadCreatedPhoto();
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
}
