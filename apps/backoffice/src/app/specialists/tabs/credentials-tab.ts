import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type {
  CredentialType,
  SpecialistCredentialDto,
  SpecialistDetailDto,
  SpecialistReviewSummaryDto,
} from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { CredentialDialog, CredentialDialogMode } from '../dialogs/credential-dialog';
import { CARD_LIST, CARD_RAISED, LIST_CARD_EMPTY, SECTION_TITLE, STAT_TILE } from '../../shared/layout';
import {
  Badge,
  BTN_DANGER_OUTLINE,
  BTN_SECONDARY,
  BTN_SUCCESS,
  calendarDay,
  clinicTodayYmd,
  credentialBadge,
  dateOnly,
  dateTime,
  fileSize,
  licenceStateBadge,
  PILL,
} from '../specialist-ui';

const ORDER: Record<CredentialType, number> = {
  mdcn_full_registration: 0,
  annual_practising_licence: 1,
  specialist_certificate: 2,
  good_standing_certificate: 3,
  foreign_practising_licence: 4,
  government_id: 5,
  medical_degree: 6,
  curriculum_vitae: 7,
  indemnity_certificate: 8,
};

/**
 * The doctor page's Credentials tab: the MDCN certificate and practising
 * licence the approval rests on, every document the doctor uploaded (replaced
 * ones folded away), and per document View / Verify / Reject — all through
 * {@link CredentialDialog}, which shows the file itself.
 */
@Component({
  selector: 'bo-specialist-credentials',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, CredentialDialog],
  template: `
    <div class="flex flex-col gap-6">
      <section class="grid gap-3 sm:grid-cols-2" aria-label="Licensing summary">
        <div class="${STAT_TILE}">
          <span class="font-sans text-caption font-semibold text-slate">MDCN full-registration certificate</span>
          <span class="${PILL} w-fit" [class]="mdcnBadge().cls"><sd-icon [name]="mdcnBadge().icon" [size]="13" />{{ mdcnBadge().label }}</span>
        </div>
        <div class="${STAT_TILE}">
          <span class="font-sans text-caption font-semibold text-slate">Annual practising licence</span>
          <span class="${PILL} w-fit" [class]="licence().cls"><sd-icon [name]="licence().icon" [size]="13" />{{ licence().label }}</span>
        </div>
      </section>

      @if (detail().credentials_missing) {
        <sd-alert tone="warning">
          This doctor was approved before documents were required and hasn't uploaded them{{ detail().credentials_due_at ? ' (due ' + day(detail().credentials_due_at) + ')' : '' }}.
        </sd-alert>
      }
      <div aria-live="polite">
        @if (notice(); as n) {
          <sd-alert tone="success">{{ n }}</sd-alert>
        }
      </div>

      <section class="flex flex-col gap-4" aria-labelledby="bo-cred-current-title">
        <h2 id="bo-cred-current-title" class="${SECTION_TITLE}"><sd-icon name="file-text" [size]="20" class="text-cerulean" />Documents</h2>
        @if (current().length === 0) {
          <div class="${CARD_RAISED} ${LIST_CARD_EMPTY}">
            <sd-icon name="folder-open" [size]="28" class="text-slate" />
            <p class="font-sans text-body-sm text-slate">The doctor hasn't uploaded any licensing documents yet.</p>
          </div>
        } @else {
          <ul class="${CARD_LIST}">
            @for (c of current(); track c.id) {
              <li class="flex flex-col gap-4 rounded-card border bg-white p-5 shadow-card" [class]="c.status === 'pending' ? 'border-warning' : 'border-haze'">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div class="flex min-w-0 flex-col gap-1">
                    <span class="font-heading text-body-lg text-ink">{{ c.type_label }}</span>
                    <span class="break-all font-sans text-caption text-slate">{{ c.original_name }} · {{ size(c.size_bytes) }} · uploaded {{ dateOnly(c.created_at) }}</span>
                  </div>
                  <span class="${PILL}" [class]="badge(c).cls"><sd-icon [name]="badge(c).icon" [size]="13" />{{ badge(c).label }}</span>
                </div>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-caption sm:grid-cols-4">
                  <div class="flex flex-col"><dt class="text-slate">Number</dt><dd class="break-all text-ink">{{ c.number || '—' }}</dd></div>
                  <div class="flex flex-col"><dt class="text-slate">Issued</dt><dd class="text-ink">{{ day(c.issued_at) }}</dd></div>
                  <div class="flex flex-col"><dt class="text-slate">Expires</dt><dd [class]="expired(c) ? 'text-alert' : 'text-ink'">{{ day(c.expires_at) }}{{ expired(c) ? ' (passed)' : '' }}</dd></div>
                  <div class="flex flex-col"><dt class="text-slate">Reviewed</dt><dd class="break-words text-ink">{{ c.reviewed_at ? dateTime(c.reviewed_at) + (c.reviewed_by_name ? ' · ' + c.reviewed_by_name : '') : '—' }}</dd></div>
                </dl>
                @if (c.attestation; as a) {
                  <p class="font-sans text-caption text-slate">Register checked · ref. <span class="break-all text-ink">{{ a.register_reference }}</span>{{ a.note ? ' · ' + a.note : '' }}</p>
                }
                @if (c.rejection_reason) {
                  <p class="rounded-field bg-alert/10 px-4 py-3 font-sans text-caption text-ink"><span class="font-semibold">Rejected:</span> {{ c.rejection_reason }}</p>
                }
                <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button type="button" [id]="'bo-cred-view-' + c.id" class="${BTN_SECONDARY}" (click)="openDialog(c, 'view')" [attr.aria-label]="'View ' + c.type_label">
                    <sd-icon name="eye" [size]="16" />View
                  </button>
                  @if (c.status === 'pending') {
                    <button type="button" class="${BTN_SUCCESS}" (click)="openDialog(c, 'verify')" [attr.aria-label]="'Verify ' + c.type_label">
                      <sd-icon name="badge-check" [size]="16" />Verify
                    </button>
                  }
                  @if (c.status === 'pending' || c.status === 'verified') {
                    <button type="button" class="${BTN_DANGER_OUTLINE}" (click)="openDialog(c, 'reject')" [attr.aria-label]="'Reject ' + c.type_label">
                      <sd-icon name="circle-x" [size]="16" />Reject
                    </button>
                  }
                </div>
              </li>
            }
          </ul>
        }
      </section>

      @if (replaced().length > 0) {
        <details class="${CARD_RAISED} p-5">
          <summary class="flex min-h-11 cursor-pointer items-center gap-2 font-sans text-body-sm font-semibold text-ink">
            <sd-icon name="history" [size]="16" class="text-slate" />Replaced documents ({{ replaced().length }})
          </summary>
          <ul class="mt-3 flex flex-col divide-y divide-cloud">
            @for (c of replaced(); track c.id) {
              <li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex min-w-0 flex-col">
                  <span class="font-sans text-body-sm text-ink">{{ c.type_label }}{{ c.number ? ' · ' + c.number : '' }}</span>
                  <span class="font-sans text-caption text-slate">Uploaded {{ dateOnly(c.created_at) }}{{ c.expires_at ? ' · expired/expires ' + day(c.expires_at) : '' }}</span>
                </div>
                <button type="button" class="${BTN_SECONDARY}" (click)="openDialog(c, 'view')" [attr.aria-label]="'View replaced ' + c.type_label">
                  <sd-icon name="eye" [size]="16" />View
                </button>
              </li>
            }
          </ul>
        </details>
      }
    </div>

    <bo-credential-dialog
      [open]="dialogOpen()"
      [specialistId]="detail().profile.id"
      [doctorName]="detail().profile.name"
      [credential]="selected()"
      [mode]="mode()"
      (closed)="dialogOpen.set(false)"
      (decided)="onDecided($event)"
    />
  `,
})
export class SpecialistCredentialsTab {
  private readonly doc = inject(DOCUMENT);

  readonly detail = input.required<SpecialistDetailDto>();
  readonly updated = output<Partial<SpecialistDetailDto>>();

  private readonly today = clinicTodayYmd();
  private readonly selectedId = signal<string | null>(null);
  protected readonly dialogOpen = signal(false);
  protected readonly mode = signal<CredentialDialogMode>('view');
  protected readonly notice = signal('');

  /** Re-read from the page's data, so the dialog shows the document's latest state. */
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.detail().credentials.find((c) => c.id === id) ?? null) : null;
  });

  private readonly sorted = computed(() =>
    [...this.detail().credentials].sort(
      (a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || b.created_at.localeCompare(a.created_at),
    ),
  );
  protected readonly current = computed(() => this.sorted().filter((c) => c.status !== 'superseded'));
  protected readonly replaced = computed(() => this.sorted().filter((c) => c.status === 'superseded'));

  protected readonly licence = computed(() => licenceStateBadge(this.detail().licence));
  protected readonly mdcnBadge = computed<Badge>(() => {
    const docs = this.current().filter((c) => c.type === 'mdcn_full_registration');
    if (docs.some((c) => c.status === 'verified')) return credentialBadge('verified');
    if (docs.some((c) => c.status === 'pending')) return credentialBadge('pending');
    if (docs.some((c) => c.status === 'rejected')) return credentialBadge('rejected');
    return { label: 'Not uploaded', icon: 'shield-alert', cls: 'bg-glacier text-slate' };
  });

  protected openDialog(c: SpecialistCredentialDto, mode: CredentialDialogMode): void {
    this.selectedId.set(c.id);
    this.mode.set(mode);
    this.notice.set('');
    this.dialogOpen.set(true);
  }

  protected onDecided(summary: SpecialistReviewSummaryDto): void {
    const c = this.selected();
    const after = summary.credentials.find((x) => x.id === c?.id);
    this.dialogOpen.set(false);
    this.notice.set(
      c ? `${c.type_label} ${after?.status === 'verified' ? 'verified' : 'rejected — the doctor has been told why'}.` : 'Saved.',
    );
    this.updated.emit(summary);
    // The Verify / Reject button that opened the dialog may be gone now: land on the document's View.
    setTimeout(() => {
      const active = this.doc.activeElement;
      if (c && (!active || active === this.doc.body)) this.doc.getElementById(`bo-cred-view-${c.id}`)?.focus();
    }, 50);
  }

  protected badge(c: SpecialistCredentialDto): Badge {
    return credentialBadge(c.status);
  }
  protected expired(c: SpecialistCredentialDto): boolean {
    return !!c.expires_at && c.expires_at < this.today && c.status !== 'superseded';
  }
  protected day(ymd: string | null | undefined): string {
    return calendarDay(ymd);
  }
  protected dateOnly(iso: string | null): string {
    return dateOnly(iso);
  }
  protected dateTime(iso: string | null): string {
    return dateTime(iso);
  }
  protected size(bytes: number): string {
    return fileSize(bytes);
  }
}
