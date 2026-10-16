import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { AuditEventDto, SpecialistHistoryDto, SpecialistStatus } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { PANEL_STATE, SECTION, SECTION_TITLE } from '../../shared/layout';
import { Badge, BTN_SECONDARY, codeLabel, dateTime, statusBadge } from '../specialist-ui';

const ACTIONS: Record<string, { label: string; icon: string }> = {
  'specialist.created': { label: 'Created', icon: 'user-plus' },
  'specialist.invited': { label: 'Invite sent', icon: 'mail' },
  'specialist.updated': { label: 'Profile edited', icon: 'pencil' },
  'specialist.submitted': { label: 'Submitted for review', icon: 'send' },
  'specialist.approved': { label: 'Approved', icon: 'badge-check' },
  'specialist.rejected': { label: 'Sent back', icon: 'undo-2' },
  'specialist.changes_submitted': { label: 'Change request sent', icon: 'square-pen' },
  'specialist.changes_withdrawn': { label: 'Change request withdrawn', icon: 'undo-2' },
  'specialist.changes_approved': { label: 'Changes approved', icon: 'check' },
  'specialist.changes_rejected': { label: 'Changes rejected', icon: 'circle-x' },
  'specialist.credential_uploaded': { label: 'Document uploaded', icon: 'upload' },
  'specialist.credential_viewed': { label: 'Document viewed', icon: 'eye' },
  'specialist.credential_verified': { label: 'Document verified', icon: 'badge-check' },
  'specialist.credential_rejected': { label: 'Document rejected', icon: 'circle-x' },
  'specialist.credential_deleted': { label: 'Document deleted', icon: 'trash-2' },
  'specialist.terms_accepted': { label: 'Practitioner terms accepted', icon: 'scroll-text' },
  'specialist.suspended': { label: 'Suspended', icon: 'ban' },
  'specialist.suspension_rerun': { label: 'Suspension run again', icon: 'refresh-cw' },
  'specialist.suspension_bookings': { label: 'Bookings cancelled', icon: 'calendar-off' },
  'specialist.reinstated': { label: 'Reinstated', icon: 'user-check' },
};

/** Metadata keys not worth repeating (the doctor's own name, internal ids). */
const HIDDEN_META = new Set(['doctor', 'specialist_id', 'before', 'after']);

const FIELD_LABELS: Record<string, string> = {
  specialty: 'Specialty',
  requested_specialty: 'Requested specialty',
  email: 'Email',
  consultation_fee: 'Fee',
  photo_url: 'Photo',
  available: 'Taking bookings',
  bio: 'Bio',
  location: 'Location',
  country: 'Country',
  languages: 'Languages',
  years_experience: 'Years of experience',
  gender: 'Gender',
  offers_in_person: 'In person',
  expertise: 'Expertise',
};

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((v) => text(v)).join(', ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

/** How a photo change was made (`via` on the photo upload / remove audit events). */
const VIA_LABELS: Record<string, string> = {
  photo_upload: 'Photo uploaded from the back office',
  photo_remove: 'Photo removed from the back office',
};

/** A photo's before / after in words — the stored file path means nothing to a reader. */
function photoText(value: unknown, side: 'before' | 'after'): string {
  if (value === null || value === undefined || value === '') return 'none';
  return side === 'before' ? 'previous photo' : 'new photo';
}

function humanKey(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The doctor page's History tab: their status changes (who, when, why) and
 * the audit trail recorded against them — edits with before / after, document
 * uploads, views and decisions, terms, change requests. All shown as text.
 */
@Component({
  selector: 'bo-specialist-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (loading() && !data()) {
      <div class="flex flex-col gap-4" aria-busy="true">
        <span class="sr-only" role="status">Loading history…</span>
        <div class="sd-shimmer h-32 rounded-card"></div>
        <div class="sd-shimmer h-64 rounded-card"></div>
      </div>
    } @else if (error() && !data()) {
      <div class="${PANEL_STATE}">
        <sd-icon name="wifi-off" [size]="28" class="text-alert" />
        <p class="font-sans text-body-sm text-slate" role="alert">{{ error() }}</p>
        <button type="button" class="${BTN_SECONDARY}" (click)="load()"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
      </div>
    } @else if (data(); as d) {
      <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section class="${SECTION} !gap-4" aria-labelledby="bo-hist-status-title">
          <h2 id="bo-hist-status-title" class="${SECTION_TITLE}"><sd-icon name="activity" [size]="20" class="text-cerulean" />Status changes</h2>
          <ol class="flex flex-col gap-4">
            @for (e of d.status_events; track e.id) {
              <li class="flex gap-3">
                <span class="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full" [class]="badge(e.to_status).cls" aria-hidden="true"><sd-icon [name]="badge(e.to_status).icon" [size]="14" /></span>
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ e.from_status ? badge(e.from_status).label + ' → ' : '' }}{{ badge(e.to_status).label }}</span>
                  <span class="font-sans text-caption text-slate">{{ when(e.created_at) }} · {{ e.actor_name || 'System' }}{{ e.code ? ' · ' + codeLabel(e.code) : '' }}</span>
                  @if (e.reason) {
                    <span class="whitespace-pre-line break-words font-sans text-caption text-ink">{{ e.reason }}</span>
                  }
                </div>
              </li>
            } @empty {
              <li class="font-sans text-body-sm text-slate">No status changes recorded yet.</li>
            }
          </ol>
        </section>

        <section class="${SECTION} !gap-4" aria-labelledby="bo-hist-audit-title">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 id="bo-hist-audit-title" class="${SECTION_TITLE}"><sd-icon name="history" [size]="20" class="text-cerulean" />Audit trail</h2>
            <label class="flex min-h-11 cursor-pointer items-center gap-2 font-sans text-body-sm text-ink">
              <input type="checkbox" class="size-5 accent-cerulean" [checked]="hideViews()" (change)="hideViews.set($any($event.target).checked)" />
              Hide document views
            </label>
          </div>
          <ol class="flex flex-col divide-y divide-cloud">
            @for (a of audit(); track a.id) {
              <li class="flex gap-3 py-3">
                <sd-icon [name]="action(a).icon" [size]="16" class="mt-0.5 shrink-0 text-slate" />
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-sans text-body-sm font-semibold text-ink">{{ action(a).label }}</span>
                  <span class="font-sans text-caption text-slate">{{ when(a.created_at) }} · {{ a.actor_name || 'System' }}{{ a.actor_role ? ' (' + a.actor_role + ')' : '' }}</span>
                  @for (line of details(a); track $index) {
                    <span class="break-words font-sans text-caption text-ink">{{ line }}</span>
                  }
                </div>
              </li>
            } @empty {
              <li class="py-3 font-sans text-body-sm text-slate">Nothing recorded yet.</li>
            }
          </ol>
          @if (d.audit.length >= 200) {
            <p class="font-sans text-caption text-slate">Showing the latest 200 events. Older ones are in the Audit log.</p>
          }
        </section>
      </div>
    }
  `,
})
export class SpecialistHistoryTab {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly specialistId = input.required<string>();
  /** Bumped by the page after every change, so the trail re-reads. */
  readonly version = input(0);

  protected readonly data = signal<SpecialistHistoryDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly hideViews = signal(false);
  private sub?: Subscription;

  protected readonly audit = computed(() => {
    const list = this.data()?.audit ?? [];
    return this.hideViews() ? list.filter((a) => a.action !== 'specialist.credential_viewed') : list;
  });

  constructor() {
    effect(() => {
      this.specialistId();
      this.version();
      untracked(() => this.load());
    });
  }

  protected load(): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.sub = this.api
      .history(this.specialistId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.error.set(apiErrorMessage(err, "Could not load this doctor's history."));
          this.loading.set(false);
        },
      });
  }

  protected badge(status: string): Badge {
    return statusBadge(status as SpecialistStatus);
  }

  protected action(a: AuditEventDto): { label: string; icon: string } {
    return ACTIONS[a.action] ?? { label: a.action, icon: 'history' };
  }

  /** The event's details as plain lines: before → after for edits, then key: value. */
  protected details(a: AuditEventDto): string[] {
    const meta = a.metadata ?? {};
    const lines: string[] = [];
    const before = (meta['before'] ?? {}) as Record<string, unknown>;
    const after = (meta['after'] ?? {}) as Record<string, unknown>;
    if (typeof after === 'object' && after !== null) {
      for (const key of Object.keys(after)) {
        lines.push(
          key === 'photo_url'
            ? `${humanKey(key)}: ${photoText(before?.[key], 'before')} → ${photoText(after[key], 'after')}`
            : `${humanKey(key)}: ${text(before?.[key])} → ${text(after[key])}`,
        );
      }
    }
    for (const [key, value] of Object.entries(meta)) {
      if (HIDDEN_META.has(key) || value === null || value === undefined || value === '') continue;
      if (key === 'via' && typeof value === 'string' && VIA_LABELS[value]) {
        lines.push(VIA_LABELS[value]);
        continue;
      }
      lines.push(`${humanKey(key)}: ${text(value)}`);
    }
    return lines.slice(0, 12);
  }

  protected when(iso: string): string {
    return dateTime(iso);
  }
  protected codeLabel(code: string): string {
    return codeLabel(code);
  }
}
