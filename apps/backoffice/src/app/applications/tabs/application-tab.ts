import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ApplicationInfoRequestDto, DoctorApplicationDetailDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';
import { BTN_SECONDARY, LABEL, SECTION, SECTION_GRID, SECTION_TITLE, TAG } from '../../shared/layout';
import { calendarDay, dateTime } from '../../specialists/specialist-ui';
import {
  CLOSE_REASON_LABELS,
  countryName,
  genderLabel,
  viewerDateTime,
  viewerTimeDiffers,
} from '../application-ui';

const DD = 'break-words text-ink';

/**
 * The application as submitted (and as changed in answer to a request): the
 * information requests and the interview on top, then one card per section —
 * personal, professional, licence (Nigeria or abroad), qualifications,
 * indemnity and the signed consent. Read-only; all text, never HTML.
 */
@Component({
  selector: 'bo-application-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @let d = detail();
    <div class="flex flex-col gap-6">
      @if (d.info_requests.length > 0) {
        <section class="${SECTION} !gap-4" aria-labelledby="bo-app-requests-title">
          <h2 id="bo-app-requests-title" class="${SECTION_TITLE}"><sd-icon name="message-square" [size]="20" class="text-cerulean" />Information requests</h2>
          <ol class="flex flex-col gap-4">
            @for (r of requests(); track r.id) {
              <li class="flex flex-col gap-3 rounded-field border p-4" [class]="isOpen(r) ? 'border-warning/60 bg-warning/5' : 'border-cloud'">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-sans text-caption text-slate">Requested {{ when(r.requested_at) }}{{ r.requested_by_name ? ' by ' + r.requested_by_name : '' }}</span>
                  <span class="inline-flex items-center gap-1 font-sans text-caption font-semibold" [class]="isOpen(r) ? 'text-ink' : 'text-slate'">
                    <sd-icon [name]="r.responded_at ? 'circle-check' : isOpen(r) ? 'hourglass' : 'circle-x'" [size]="14" />{{ requestState(r) }}
                  </span>
                </div>
                <p class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ r.message }}</p>
                <ul class="flex flex-wrap gap-1.5" aria-label="Requested items">
                  @for (item of r.items; track item.kind + item.key + item.label) {
                    <li class="${TAG}">{{ item.label }}</li>
                  }
                </ul>
                @if (r.response_note) {
                  <div class="rounded-field bg-glacier px-3 py-2">
                    <span class="block font-sans text-caption font-semibold text-slate">Applicant's note</span>
                    <span class="whitespace-pre-line break-words font-sans text-body-sm text-ink">{{ r.response_note }}</span>
                  </div>
                }
              </li>
            }
          </ol>
        </section>
      }

      @if (d.interview; as iv) {
        <section class="${SECTION} !gap-4" aria-labelledby="bo-app-interview-title">
          <h2 id="bo-app-interview-title" class="${SECTION_TITLE}"><sd-icon name="video" [size]="20" class="text-cerulean" />Interview</h2>
          <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex flex-col gap-0.5">
              <dt class="${LABEL}">When (Lagos time)</dt>
              <dd class="${DD}">{{ iv.starts_at_label }}</dd>
              @if (viewerDiffers(iv.starts_at)) {
                <dd class="font-sans text-caption text-slate">Your time: {{ viewerTime(iv.starts_at) }}</dd>
              }
            </div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Length</dt><dd class="${DD}">{{ iv.duration_minutes }} minutes</dd></div>
            <div class="flex flex-col gap-0.5">
              <dt class="${LABEL}">Where</dt>
              <dd class="flex flex-wrap items-center gap-2 text-ink">
                <span class="break-all">Video call ({{ iv.meeting_host }})</span>
                <a [href]="iv.meeting_url" target="_blank" rel="noopener noreferrer" class="${BTN_SECONDARY} !min-h-11 !py-1.5">
                  <sd-icon name="external-link" [size]="16" />Open link<span class="sr-only"> (opens in a new tab)</span>
                </a>
              </dd>
            </div>
            @if (iv.note) {
              <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${LABEL}">Note to the applicant</dt><dd class="whitespace-pre-line ${DD}">{{ iv.note }}</dd></div>
            }
          </dl>
        </section>
      }

      <div class="${SECTION_GRID}">
        <section class="${SECTION}" aria-labelledby="bo-app-personal-title">
          <h2 id="bo-app-personal-title" class="${SECTION_TITLE}"><sd-icon name="user-round" [size]="20" class="text-cerulean" />Personal</h2>
          <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">First name</dt><dd class="${DD}">{{ personal()?.first_name || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Last name</dt><dd class="${DD}">{{ personal()?.last_name || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5">
              <dt class="${LABEL}">Email</dt>
              <dd class="break-all text-ink">{{ d.email }}</dd>
              <dd class="font-sans text-caption text-slate">{{ d.email_verified_at ? 'Confirmed ' + when(d.email_verified_at) : 'Not confirmed' }}</dd>
            </div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Phone number</dt><dd class="break-all text-ink">{{ d.phone || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Date of birth</dt><dd class="${DD}">{{ day(personal()?.date_of_birth) }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Gender</dt><dd class="${DD}">{{ gender(personal()?.gender) }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Country of residence</dt><dd class="${DD}">{{ country(personal()?.country_of_residence) }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">City</dt><dd class="${DD}">{{ personal()?.city || '—' }}</dd></div>
          </dl>
        </section>

        <section class="${SECTION}" aria-labelledby="bo-app-professional-title">
          <h2 id="bo-app-professional-title" class="${SECTION_TITLE}"><sd-icon name="stethoscope" [size]="20" class="text-cerulean" />Professional</h2>
          <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Primary speciality</dt><dd class="${DD}">{{ professional()?.specialty || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Years of experience</dt><dd class="${DD}">{{ professional()?.years_experience ?? '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Current workplace</dt><dd class="${DD}">{{ professional()?.workplace || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Languages</dt><dd class="${DD}">{{ languages() || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5 sm:col-span-2"><dt class="${LABEL}">Short bio</dt><dd class="whitespace-pre-line ${DD}">{{ professional()?.bio || '—' }}</dd></div>
          </dl>
        </section>

        <section class="${SECTION}" aria-labelledby="bo-app-licence-title">
          <h2 id="bo-app-licence-title" class="${SECTION_TITLE}"><sd-icon [name]="abroad() ? 'globe' : 'id-card'" [size]="20" class="text-cerulean" />Licence · {{ abroad() ? 'Abroad' : 'Nigeria' }}</h2>
          <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
            @if (abroad()) {
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Country of the regulator</dt><dd class="${DD}">{{ country(licence()?.regulator_country) }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Regulator</dt><dd class="${DD}">{{ licence()?.regulator_name || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Licence or registration number</dt><dd class="break-all text-ink">{{ licence()?.registration_number || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Certificate of Good Standing — issue date</dt><dd class="${DD}">{{ day(licence()?.good_standing_issued_on) }}</dd></div>
            } @else {
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">MDCN registration number</dt><dd class="break-all text-ink">{{ licence()?.mdcn_number || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Year of full registration</dt><dd class="${DD}">{{ licence()?.full_registration_year ?? '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Annual practising licence expiry</dt><dd class="${DD}">{{ day(licence()?.licence_expires_on) }}</dd></div>
            }
          </dl>
        </section>

        <section class="${SECTION}" aria-labelledby="bo-app-quals-title">
          <h2 id="bo-app-quals-title" class="${SECTION_TITLE}"><sd-icon name="graduation-cap" [size]="20" class="text-cerulean" />Qualifications</h2>
          <ol class="flex flex-col gap-3">
            @for (q of qualifications(); track $index) {
              <li class="flex flex-col gap-0.5 font-sans text-body-sm">
                <span class="break-words font-semibold text-ink">{{ q.degree }}</span>
                <span class="break-words text-slate">{{ q.institution }}{{ q.year_awarded ? ' · ' + q.year_awarded : '' }}</span>
                @if ($first) {
                  <span class="font-sans text-caption text-slate">Primary medical degree</span>
                }
              </li>
            } @empty {
              <li class="font-sans text-body-sm text-slate">None given.</li>
            }
          </ol>
        </section>

        <section class="${SECTION}" aria-labelledby="bo-app-indemnity-title">
          <h2 id="bo-app-indemnity-title" class="${SECTION_TITLE}"><sd-icon name="shield-check" [size]="20" class="text-cerulean" />Indemnity</h2>
          <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Indemnity provider</dt><dd class="${DD}">{{ indemnity()?.provider || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Policy number</dt><dd class="break-all text-ink">{{ indemnity()?.policy_number || '—' }}</dd></div>
            <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Cover expiry date</dt><dd class="${DD}">{{ day(indemnity()?.cover_expires_on) }}</dd></div>
          </dl>
        </section>

        <section class="${SECTION}" aria-labelledby="bo-app-consent-title">
          <h2 id="bo-app-consent-title" class="${SECTION_TITLE}"><sd-icon name="file-check" [size]="20" class="text-cerulean" />Consent</h2>
          @if (d.consent; as c) {
            <ul class="flex flex-col gap-2">
              @for (s of statements(); track s.label) {
                <li class="flex items-start gap-2 font-sans text-body-sm text-ink">
                  <sd-icon [name]="s.ok ? 'circle-check' : 'circle-x'" [size]="16" class="mt-0.5 shrink-0" [class]="s.ok ? 'text-sage' : 'text-alert'" />
                  <span>{{ s.label }}<span class="sr-only">: {{ s.ok ? 'yes' : 'no' }}</span></span>
                </li>
              }
            </ul>
            <dl class="grid gap-x-6 gap-y-3 font-sans text-body-sm sm:grid-cols-2">
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Signature</dt><dd class="${DD}">{{ c.signature_name || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Signed</dt><dd class="${DD}">{{ when(c.consented_at) }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">Consent version</dt><dd class="${DD}">{{ c.consent_version || '—' }}</dd></div>
              <div class="flex flex-col gap-0.5"><dt class="${LABEL}">From IP</dt><dd class="break-all text-ink">{{ c.consent_ip || '—' }}</dd></div>
            </dl>
          } @else {
            <p class="font-sans text-body-sm text-slate">No consent recorded.</p>
          }
        </section>
      </div>
    </div>
  `,
})
export class ApplicationTab {
  readonly detail = input.required<DoctorApplicationDetailDto>();

  protected readonly abroad = computed(() => this.detail().licence_route === 'abroad');
  protected readonly personal = computed(() => this.detail().sections?.personal ?? null);
  protected readonly professional = computed(() => this.detail().sections?.professional ?? null);
  protected readonly licence = computed(() => this.detail().sections?.licence ?? null);
  protected readonly indemnity = computed(() => this.detail().sections?.indemnity ?? null);
  protected readonly qualifications = computed(() => this.detail().sections?.qualifications?.entries ?? []);
  protected readonly languages = computed(() => (this.professional()?.languages ?? []).join(', '));
  /** Newest request first. */
  protected readonly requests = computed(() =>
    [...this.detail().info_requests].sort((a, b) => b.requested_at.localeCompare(a.requested_at)),
  );
  protected readonly statements = computed(() => {
    const c = this.detail().consent;
    return [
      { label: 'Accepted the Terms of Service and Privacy Policy', ok: c?.accept_terms === true },
      { label: 'Authorised VideoMed to verify their licence, qualifications and indemnity', ok: c?.authorise_verification === true },
      { label: 'Confirmed the information and documents are accurate and complete', ok: c?.confirm_accurate === true },
    ];
  });

  protected isOpen(r: ApplicationInfoRequestDto): boolean {
    return !r.responded_at && !r.closed_at;
  }

  protected requestState(r: ApplicationInfoRequestDto): string {
    if (r.responded_at) return `Answered ${dateTime(r.responded_at)}`;
    if (r.closed_at) return r.close_reason ? CLOSE_REASON_LABELS[r.close_reason] : `Closed ${dateTime(r.closed_at)}`;
    return 'Waiting for the applicant';
  }

  protected when(iso: string | null | undefined): string {
    return dateTime(iso);
  }
  protected day(ymd: string | null | undefined): string {
    return calendarDay(ymd);
  }
  protected country(iso: string | null | undefined): string {
    return countryName(iso);
  }
  protected gender(g: string | null | undefined): string {
    return genderLabel(g);
  }
  protected viewerDiffers(iso: string): boolean {
    return viewerTimeDiffers(iso);
  }
  protected viewerTime(iso: string): string {
    return viewerDateTime(iso);
  }
}
