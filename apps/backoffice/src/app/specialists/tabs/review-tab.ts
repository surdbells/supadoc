import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';
import { apiErrorFields, apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type {
  CertificationEntry,
  PendingChanges,
  QualificationEntry,
  SpecialistDetailDto,
  SuccessResponse,
} from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { SECTION, SECTION_TITLE } from '../../shared/layout';
import {
  BTN_DANGER_OUTLINE,
  BTN_GHOST,
  BTN_SUCCESS,
  CHECKLIST,
  dateOnly,
  dateTime,
  type DoctorTab,
  FIELD,
  FIELD_INVALID,
  LABEL,
  PILL,
  statusBadge,
} from '../specialist-ui';

type ChangeKey = keyof PendingChanges;

const CHANGE_LABELS: Record<ChangeKey, string> = {
  name: 'Name',
  specialty: 'Specialty',
  mdcn_number: 'MDCN number',
  qualifications: 'Qualifications (text)',
  qualification_entries: 'Qualifications',
  certifications: 'Certifications',
};

/** What each approval problem points the reviewer to. */
const PROBLEM_TABS: Record<string, { tab: DoctorTab; label: string } | undefined> = {
  mdcn_certificate: { tab: 'credentials', label: 'Go to Credentials' },
  practising_licence: { tab: 'credentials', label: 'Go to Credentials' },
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function qualificationLines(list: readonly QualificationEntry[] | null | undefined): string[] {
  return (list ?? []).map((q) => [q.title, q.institution, q.year ? `(${q.year})` : ''].filter(Boolean).join(' · '));
}

function certificationLines(list: readonly CertificationEntry[] | null | undefined): string[] {
  return (list ?? []).map((c) => [c.name, c.body, c.year ? `(${c.year})` : ''].filter(Boolean).join(' · '));
}

/**
 * The doctor page's Review tab: where the doctor is in review, the onboarding
 * checklist and terms, what blocks approval, approve (with the reviewer's
 * attestation) or send back with a reason, and — once approved — a change
 * request to the locked identity fields shown against the approved snapshot,
 * to approve or reject with a reason.
 */
@Component({
  selector: 'bo-specialist-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div aria-live="polite">
        @if (notice(); as n) {
          <sd-alert tone="success">{{ n }}</sd-alert>
        }
      </div>

      <!-- Where they are -->
      <section class="${SECTION} !gap-4" aria-labelledby="bo-rv-status-title">
        <h2 #statusTitle id="bo-rv-status-title" tabindex="-1" class="${SECTION_TITLE} focus:outline-none"><sd-icon name="list-checks" [size]="20" class="text-cerulean" />Review status</h2>
        <div class="flex flex-wrap items-center gap-2 font-sans text-caption text-slate">
          <span class="${PILL}" [class]="status().cls"><sd-icon [name]="status().icon" [size]="13" />{{ status().label }}</span>
          @if (detail().submitted_at) { <span>Submitted {{ when(detail().submitted_at) }}</span> }
          @if (detail().approved_at) { <span>· Approved {{ when(detail().approved_at) }}</span> }
        </div>
        @if (detail().status === 'rejected' && detail().rejection_reason) {
          <div class="rounded-field bg-warning/10 px-4 py-3 font-sans text-body-sm text-ink">
            <span class="block font-semibold">Sent back with:</span>
            <span class="whitespace-pre-line break-words">{{ detail().rejection_reason }}</span>
          </div>
        }
        @if (detail().approved_snapshot; as snap) {
          <p class="font-sans text-caption text-slate">
            Approved by {{ snap.approved_by_name || 'a reviewer' }} on {{ day(snap.approved_at) }} — name, specialty, MDCN number, qualifications and certifications are locked to what was approved.
          </p>
        }
      </section>

      <div class="grid gap-6 lg:grid-cols-2">
        <!-- Checklist -->
        <section class="${SECTION} !gap-4" aria-labelledby="bo-rv-check-title">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 id="bo-rv-check-title" class="${SECTION_TITLE}"><sd-icon name="clipboard-list" [size]="20" class="text-cerulean" />Onboarding checklist</h2>
            <span class="rounded-pill bg-cloud px-2.5 py-0.5 font-sans text-caption font-semibold text-slate">{{ detail().completed }} of {{ detail().total }} done</span>
          </div>
          <ul class="flex flex-col gap-2">
            @for (c of checklist; track c.key) {
              <li class="flex items-center gap-2 font-sans text-body-sm" [class]="detail().checklist[c.key] ? 'text-ink' : 'text-slate'">
                <sd-icon [name]="detail().checklist[c.key] ? 'circle-check' : 'circle-x'" [size]="16" [class]="detail().checklist[c.key] ? 'text-sage' : 'text-alert'" />
                <span>{{ c.label }}<span class="sr-only">: {{ detail().checklist[c.key] ? 'done' : 'missing' }}</span></span>
              </li>
            }
          </ul>
        </section>

        <!-- Terms -->
        <section class="${SECTION} !gap-4" aria-labelledby="bo-rv-terms-title">
          <h2 id="bo-rv-terms-title" class="${SECTION_TITLE}"><sd-icon name="scroll-text" [size]="20" class="text-cerulean" />Practitioner terms</h2>
          @if (detail().terms; as t) {
            <span class="${PILL} w-fit" [class]="t.accepted ? 'bg-sage/15 text-sage' : 'bg-warning/15 text-ink'">
              <sd-icon [name]="t.accepted ? 'circle-check' : 'hourglass'" [size]="13" />{{ t.accepted ? 'Version ' + t.current_version + ' accepted' : 'Version ' + t.current_version + ' not accepted yet' }}
            </span>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-sans text-body-sm">
              <dt class="text-slate">Accepted version</dt><dd class="text-ink">{{ t.accepted_version || '—' }}</dd>
              <dt class="text-slate">Accepted at</dt><dd class="text-ink">{{ t.accepted_at ? when(t.accepted_at) : '—' }}</dd>
              <dt class="text-slate">From IP</dt><dd class="break-all text-ink">{{ t.accepted_ip || '—' }}</dd>
            </dl>
            @if (!t.accepted && t.accepted_version) {
              <p class="font-sans text-caption text-slate">They accepted an older version; they must accept {{ t.current_version }} before new clinical work.</p>
            }
          }
        </section>
      </div>

      <!-- Decision -->
      @if (detail().status === 'pending_review') {
        <section class="${SECTION}" aria-labelledby="bo-rv-decide-title">
          <h2 id="bo-rv-decide-title" class="${SECTION_TITLE}"><sd-icon name="badge-check" [size]="20" class="text-cerulean" />Decision</h2>

          @if (problems().length > 0) {
            <div class="flex flex-col gap-2 rounded-field bg-warning/10 p-4">
              <p class="font-sans text-body-sm font-semibold text-ink">Before you can approve:</p>
              <ul class="flex flex-col gap-2">
                @for (p of problems(); track p.key) {
                  <li class="flex flex-col gap-1 font-sans text-body-sm text-ink sm:flex-row sm:items-center sm:justify-between">
                    <span class="flex items-start gap-2"><sd-icon name="circle-alert" [size]="16" class="mt-0.5 shrink-0 text-warning" />{{ p.message }}</span>
                    @if (p.link; as l) {
                      <button type="button" class="${BTN_GHOST} !min-h-11 shrink-0 !px-3 text-cerulean" (click)="openTab.emit(l.tab)">{{ l.label }}<sd-icon name="chevron-right" [size]="14" /></button>
                    }
                  </li>
                }
              </ul>
            </div>
          } @else {
            <sd-alert tone="info">Everything is in place. Check the documents and profile, then approve.</sd-alert>
          }

          <form class="flex flex-col gap-3" novalidate (submit)="$event.preventDefault(); approve()">
            <label class="flex min-h-11 cursor-pointer items-start gap-3 rounded-field border px-4 py-3" [class]="approveErrors()['attest'] ? 'border-alert' : 'border-cloud'">
              <input type="checkbox" class="mt-0.5 size-5 shrink-0 accent-sage" [checked]="attest()" [disabled]="!ready()" (change)="attest.set($any($event.target).checked)" aria-describedby="bo-rv-attest-hint" />
              <span class="flex flex-col">
                <span class="font-sans text-body-sm text-ink">I checked the MDCN full-registration certificate and the current practising licence against the MDCN register.</span>
                <span id="bo-rv-attest-hint" class="font-sans text-caption text-slate">Recorded with your name in the approval and the audit log.</span>
              </span>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Note (optional, internal)</span>
              <textarea rows="2" maxlength="2000" class="${FIELD}" [disabled]="!ready()" [value]="approveNote()" (input)="approveNote.set($any($event.target).value)"></textarea>
            </label>
            @for (e of approveErrorList(); track e) {
              <p class="flex items-start gap-1.5 font-sans text-caption text-alert"><sd-icon name="circle-alert" [size]="14" class="mt-0.5 shrink-0" />{{ e }}</p>
            }
            <button type="submit" class="${BTN_SUCCESS} w-full sm:w-fit" [disabled]="busy() !== '' || !ready() || !attest()">
              <sd-icon [name]="busy() === 'approve' ? 'loader-circle' : 'badge-check'" [size]="18" [class.animate-spin]="busy() === 'approve'" />{{ busy() === 'approve' ? 'Approving…' : 'Approve doctor' }}
            </button>
          </form>

          <form class="flex flex-col gap-3 border-t border-cloud pt-5" novalidate (submit)="$event.preventDefault(); sendBack()">
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Or send it back — tell the doctor what to change (required)</span>
              <textarea rows="3" maxlength="2000" class="${FIELD}" [class]="rejectError() ? '${FIELD_INVALID}' : ''" [value]="rejectReason()" (input)="rejectReason.set($any($event.target).value); rejectError.set('')" placeholder="e.g. Please upload a clearer, professional headshot." [attr.aria-invalid]="rejectError() ? 'true' : null" [attr.aria-describedby]="rejectError() ? 'bo-rv-reject-err' : null"></textarea>
              @if (rejectError(); as e) { <span id="bo-rv-reject-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
            <button type="submit" class="${BTN_DANGER_OUTLINE} w-full sm:w-fit" [disabled]="busy() !== ''">
              <sd-icon [name]="busy() === 'reject' ? 'loader-circle' : 'undo-2'" [size]="18" [class.animate-spin]="busy() === 'reject'" />{{ busy() === 'reject' ? 'Sending…' : 'Send back to doctor' }}
            </button>
          </form>
        </section>
      } @else if (detail().status === 'invited' || detail().status === 'rejected') {
        <sd-alert tone="info">Approve or send back becomes available once the doctor submits their profile for review.</sd-alert>
      }

      <!-- Change request -->
      @if (detail().pending_changes) {
        <section class="flex flex-col gap-5 rounded-card border border-warning/60 bg-white p-5 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-6" aria-labelledby="bo-rv-changes-title">
          <div class="flex flex-col gap-1">
            <h2 id="bo-rv-changes-title" class="${SECTION_TITLE}"><sd-icon name="square-pen" [size]="20" class="text-warning" />Change request</h2>
            <p class="font-sans text-body-sm text-slate">Requested {{ when(detail().pending_changes_submitted_at) }}. Approving makes these live (prescriptions print them) and becomes the new approved snapshot.</p>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[480px] text-left font-sans text-body-sm">
              <caption class="sr-only">Approved values against the requested ones</caption>
              <thead class="border-b border-cloud text-caption font-semibold text-slate">
                <tr><th scope="col" class="py-2 pr-3">Field</th><th scope="col" class="py-2 pr-3">Approved</th><th scope="col" class="py-2">Requested</th></tr>
              </thead>
              <tbody>
                @for (row of diff(); track row.key) {
                  <tr class="border-b border-cloud/60 align-top">
                    <th scope="row" class="py-2 pr-3 font-semibold text-ink">{{ row.label }}</th>
                    <td class="py-2 pr-3 text-slate">
                      @for (line of row.before; track $index) { <span class="block break-words line-through decoration-slate/50">{{ line }}</span> } @empty { <span>—</span> }
                    </td>
                    <td class="py-2 text-ink">
                      @for (line of row.after; track $index) { <span class="block break-words font-semibold">{{ line }}</span> } @empty { <span>— (cleared)</span> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <button type="button" class="${BTN_SUCCESS} w-full sm:w-fit" [disabled]="busy() !== ''" (click)="approveChanges()">
            <sd-icon [name]="busy() === 'changes-approve' ? 'loader-circle' : 'check'" [size]="18" [class.animate-spin]="busy() === 'changes-approve'" />{{ busy() === 'changes-approve' ? 'Approving…' : 'Approve changes' }}
          </button>
          <form class="flex flex-col gap-3 border-t border-cloud pt-5" novalidate (submit)="$event.preventDefault(); rejectChanges()">
            <label class="flex flex-col gap-1.5">
              <span class="${LABEL}">Or reject them — tell the doctor why (required)</span>
              <textarea rows="3" maxlength="2000" class="${FIELD}" [class]="changesError() ? '${FIELD_INVALID}' : ''" [value]="changesReason()" (input)="changesReason.set($any($event.target).value); changesError.set('')" [attr.aria-invalid]="changesError() ? 'true' : null" [attr.aria-describedby]="changesError() ? 'bo-rv-changes-err' : null"></textarea>
              @if (changesError(); as e) { <span id="bo-rv-changes-err" class="font-sans text-caption text-alert">{{ e }}</span> }
            </label>
            <button type="submit" class="${BTN_DANGER_OUTLINE} w-full sm:w-fit" [disabled]="busy() !== ''">
              <sd-icon [name]="busy() === 'changes-reject' ? 'loader-circle' : 'circle-x'" [size]="18" [class.animate-spin]="busy() === 'changes-reject'" />{{ busy() === 'changes-reject' ? 'Rejecting…' : 'Reject changes' }}
            </button>
          </form>
        </section>
      } @else if (detail().changes_review_note) {
        <p class="font-sans text-caption text-slate">Last change request turned down: {{ detail().changes_review_note }}</p>
      }

      <div aria-live="assertive">
        @if (error()) {
          <sd-alert tone="error">{{ error() }}</sd-alert>
        }
      </div>

      <!-- What the doctor submitted -->
      <section class="${SECTION}" aria-labelledby="bo-rv-profile-title">
        <h2 id="bo-rv-profile-title" class="${SECTION_TITLE}"><sd-icon name="user-round" [size]="20" class="text-cerulean" />Profile</h2>
        <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
          <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Name</dt><dd class="break-words text-ink">{{ detail().profile.name }}</dd></div>
          <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Specialty</dt><dd class="break-words text-ink">{{ detail().profile.specialty }}</dd></div>
          <div class="flex flex-col gap-0.5"><dt class="${LABEL}">MDCN number</dt><dd class="break-all text-ink">{{ detail().profile.mdcn_number || '—' }}</dd></div>
          <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Signature</dt><dd class="text-ink">{{ detail().profile.has_signature ? 'Saved' : 'Not saved' }}</dd></div>
          <div class="flex flex-col gap-0.5 sm:col-span-2">
            <dt class="${LABEL}">Qualifications</dt>
            <dd class="text-ink">
              @if (detail().profile.qualifications) { <span class="block break-words">{{ detail().profile.qualifications }}</span> }
              @for (q of qualifications(); track $index) { <span class="block break-words">{{ q }}</span> }
              @if (!detail().profile.qualifications && qualifications().length === 0) { — }
            </dd>
          </div>
          <div class="flex flex-col gap-0.5 sm:col-span-2">
            <dt class="${LABEL}">Certifications</dt>
            <dd class="text-ink">
              @for (c of certifications(); track $index) { <span class="block break-words">{{ c }}</span> } @empty { — }
            </dd>
          </div>
          <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${LABEL}">Weekly hours</dt><dd class="break-words text-ink">{{ hours() }}</dd></div>
          <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${LABEL}">Bio</dt><dd class="whitespace-pre-line break-words text-ink">{{ detail().profile.bio || '—' }}</dd></div>
        </dl>
      </section>
    </div>
  `,
})
export class SpecialistReviewTab {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly statusTitle = viewChild<ElementRef<HTMLElement>>('statusTitle');

  readonly detail = input.required<SpecialistDetailDto>();
  readonly updated = output<Partial<SpecialistDetailDto>>();
  readonly openTab = output<DoctorTab>();

  protected readonly checklist = CHECKLIST;
  protected readonly attest = signal(false);
  protected readonly approveNote = signal('');
  protected readonly approveErrors = signal<Record<string, string>>({});
  protected readonly rejectReason = signal('');
  protected readonly rejectError = signal('');
  protected readonly changesReason = signal('');
  protected readonly changesError = signal('');
  protected readonly busy = signal<'' | 'approve' | 'reject' | 'changes-approve' | 'changes-reject'>('');
  protected readonly error = signal('');
  protected readonly notice = signal('');

  protected readonly status = computed(() => statusBadge(this.detail().status));

  /** The server's reasons approval is blocked (the attestation is this form's own). */
  protected readonly problems = computed(() =>
    Object.entries(this.detail().approval?.problems ?? {})
      .filter(([key, message]) => key !== 'attest' && !!message)
      .map(([key, message]) => ({ key, message: message as string, link: PROBLEM_TABS[key] })),
  );
  protected readonly ready = computed(() => !!this.detail().approval?.ready);
  protected readonly approveErrorList = computed(() => Object.values(this.approveErrors()));

  protected readonly qualifications = computed(() => qualificationLines(this.detail().profile.qualification_entries));
  protected readonly certifications = computed(() => certificationLines(this.detail().profile.certifications));

  protected readonly hours = computed(() => {
    const hours = this.detail().profile.weekly_hours ?? {};
    const parts = Object.keys(hours)
      .sort()
      .filter((d) => (hours[d] ?? []).length > 0)
      .map((d) => `${WEEKDAYS[Number(d)] ?? d} ${hours[d].map(([a, b]) => `${a}–${b}`).join(', ')}`);
    if (parts.length) return parts.join(' · ');
    return this.detail().checklist.availability ? 'No weekly hours — uses published open slots.' : 'Not set yet.';
  });

  /** Each requested field against the approved snapshot (or, without one, the live profile). */
  protected readonly diff = computed(() => {
    const d = this.detail();
    const pending = d.pending_changes ?? {};
    const base = d.approved_snapshot ?? {
      name: d.profile.name,
      specialty: d.profile.specialty,
      mdcn_number: d.profile.mdcn_number ?? null,
      qualifications: d.profile.qualifications ?? null,
      qualification_entries: d.profile.qualification_entries ?? [],
      certifications: d.profile.certifications ?? [],
    };
    const lines = (key: ChangeKey, source: PendingChanges): string[] => {
      if (key === 'qualification_entries') return qualificationLines(source.qualification_entries);
      if (key === 'certifications') return certificationLines(source.certifications);
      const v = source[key];
      return typeof v === 'string' && v.trim() !== '' ? [v] : [];
    };
    return (Object.keys(pending) as ChangeKey[])
      .filter((key) => key in CHANGE_LABELS)
      .map((key) => ({
        key,
        label: CHANGE_LABELS[key],
        before: lines(key, base as PendingChanges),
        after: lines(key, pending),
      }));
  });

  protected approve(): void {
    if (this.busy() || !this.ready()) return;
    if (!this.attest()) {
      this.approveErrors.set({ attest: 'Confirm that you checked their documents against the MDCN register.' });
      return;
    }
    this.run('approve', this.api.approve(this.detail().profile.id, { attest: true, note: this.approveNote().trim() || undefined }), 'Could not approve this doctor.', 'Approved. The doctor is listed and has been emailed.');
  }

  protected sendBack(): void {
    if (this.busy()) return;
    const reason = this.rejectReason().trim();
    if (!reason) {
      this.rejectError.set('Tell the doctor what to change before sending it back.');
      return;
    }
    this.run('reject', this.api.reject(this.detail().profile.id, reason), 'Could not send this profile back.', 'Sent back. The doctor has been told what to change.');
  }

  protected approveChanges(): void {
    if (this.busy()) return;
    this.run('changes-approve', this.api.approveChanges(this.detail().profile.id), 'Could not approve the changes.', 'Changes approved and live.');
  }

  protected rejectChanges(): void {
    if (this.busy()) return;
    const reason = this.changesReason().trim();
    if (!reason) {
      this.changesError.set('Tell the doctor why the changes were not approved.');
      return;
    }
    this.run('changes-reject', this.api.rejectChanges(this.detail().profile.id, reason), 'Could not reject the changes.', 'Changes rejected. The doctor has been told why.');
  }

  private run(
    kind: 'approve' | 'reject' | 'changes-approve' | 'changes-reject',
    request: Observable<SuccessResponse<Partial<SpecialistDetailDto>>>,
    fallback: string,
    success: string,
  ): void {
    this.busy.set(kind);
    this.error.set('');
    this.notice.set('');
    this.approveErrors.set({});
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.busy.set('');
        this.attest.set(false);
        this.approveNote.set('');
        this.rejectReason.set('');
        this.changesReason.set('');
        this.notice.set(success);
        this.updated.emit(res.data);
        // The section with the pressed button is gone now (the decision, or the
        // change request): put focus on the review status, under the notice.
        afterNextRender(
          () => {
            const active = this.doc.activeElement;
            if (!active || active === this.doc.body || !active.isConnected) this.statusTitle()?.nativeElement.focus();
          },
          { injector: this.injector },
        );
      },
      error: (err: unknown) => {
        this.busy.set('');
        if (kind === 'approve') {
          this.approveErrors.set(apiErrorFields(err));
        } else if (kind === 'reject') {
          this.rejectError.set(apiErrorFields(err)['reason'] ?? '');
        } else if (kind === 'changes-reject') {
          this.changesError.set(apiErrorFields(err)['reason'] ?? '');
        }
        this.error.set(apiErrorMessage(err, fallback));
      },
    });
  }

  protected when(iso: string | null | undefined): string {
    return dateTime(iso);
  }
  protected day(iso: string | null | undefined): string {
    return dateOnly(iso);
  }
}
