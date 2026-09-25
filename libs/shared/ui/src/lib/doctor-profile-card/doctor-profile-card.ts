import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconComponent } from '../icon/icon';

/** The data a public doctor-profile card renders (a subset of SpecialistDto). */
export interface PublicDoctorProfileData {
  name: string;
  specialty: string;
  verified?: boolean;
  rating?: string | number;
  reviews_count?: number;
  bio?: string | null;
  languages?: string | null;
  years_experience?: number | null;
  country?: string | null;
  location?: string | null;
  gender?: string | null;
  expertise?: string[];
  qualification_entries?: { title: string; institution: string; year: string }[];
  certifications?: { name: string; body: string; year: string }[];
}

/**
 * The detailed public profile of a doctor (Figma 3927:xxxx) — headshot, verified
 * badge, rating, bio, a Languages/Experience/Country/Gender grid, areas of
 * expertise, qualifications and certifications. Rendered as a card body; the
 * caller supplies the surrounding modal/dialog. Shared by the doctor portal
 * (self-preview) and the patient portal (viewing a specialist).
 *
 * Usage: `<sd-doctor-profile-card [data]="doctor" [photoUrl]="src" />`
 */
@Component({
  selector: 'sd-doctor-profile-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (data(); as d) {
      <div class="flex flex-col gap-6">
        <!-- Header -->
        <div class="flex items-start gap-5">
          @if (photoUrl()) {
            <img [src]="photoUrl()" alt="" width="112" height="112" class="size-24 shrink-0 rounded-full object-cover sm:size-28" />
          } @else {
            <span class="flex size-24 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-heading text-h3 text-cerulean sm:size-28">{{ initials() || 'DR' }}</span>
          }
          <div class="flex min-w-0 flex-col gap-1.5 pt-1">
            <div class="flex flex-wrap items-center gap-2.5">
              <h2 class="font-heading text-h3 text-ink">{{ d.name }}</h2>
              @if (d.verified) {
                <span class="flex items-center gap-1.5 rounded-pill border border-cloud bg-white px-3 py-1 font-sans text-body-sm font-semibold text-cerulean">
                  <sd-icon name="badge-check" [size]="16" />Verified
                </span>
              }
            </div>
            <p class="font-sans text-body-lg font-semibold text-cerulean">{{ d.specialty }}</p>
            <span class="flex items-center gap-1.5 font-sans text-body-sm text-slate">
              <sd-icon name="star" [size]="17" class="text-warning" />
              <span class="font-semibold text-ink">{{ d.rating }}</span> ({{ d.reviews_count ?? 0 }} reviews)
            </span>
          </div>
        </div>

        <!-- Bio -->
        @if (d.bio) {
          <div class="flex flex-col gap-2.5">
            <h3 class="flex items-center gap-2 font-heading text-h5 text-ink"><sd-icon name="scroll-text" [size]="20" class="text-cerulean" />Bio</h3>
            <p class="font-sans text-body leading-relaxed text-ink">{{ d.bio }}</p>
          </div>
        }

        <!-- Info grid -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-1.5 rounded-2xl border border-cloud px-5 py-4">
            <span class="flex items-center gap-2 font-sans text-body-sm text-slate"><sd-icon name="languages" [size]="18" />Languages</span>
            <span class="font-sans text-body text-ink">{{ languageList() || '—' }}</span>
          </div>
          <div class="flex flex-col gap-1.5 rounded-2xl border border-cloud px-5 py-4">
            <span class="flex items-center gap-2 font-sans text-body-sm text-slate"><sd-icon name="briefcase" [size]="18" />Experience</span>
            <span class="font-sans text-body text-ink">{{ d.years_experience ? d.years_experience + ' years' : '—' }}</span>
          </div>
          <div class="flex flex-col gap-1.5 rounded-2xl border border-cloud px-5 py-4">
            <span class="flex items-center gap-2 font-sans text-body-sm text-slate"><sd-icon name="map-pin" [size]="18" />Country</span>
            <span class="font-sans text-body text-ink">{{ (d.country || d.location) || '—' }}</span>
          </div>
          <div class="flex flex-col gap-1.5 rounded-2xl border border-cloud px-5 py-4">
            <span class="flex items-center gap-2 font-sans text-body-sm text-slate"><sd-icon name="user" [size]="18" />Gender</span>
            <span class="font-sans text-body capitalize text-ink">{{ d.gender || '—' }}</span>
          </div>
        </div>

        <!-- Area of expertise -->
        @if ((d.expertise?.length ?? 0) > 0) {
          <div class="flex flex-col gap-3">
            <h3 class="flex items-center gap-2 font-heading text-h5 text-ink"><sd-icon name="sparkles" [size]="20" class="text-cerulean" />Area of expertise</h3>
            <div class="flex flex-wrap gap-2.5">
              @for (x of d.expertise ?? []; track x) {
                <span class="rounded-pill bg-frost px-4 py-1.5 font-sans text-body-sm font-medium text-cerulean">{{ x }}</span>
              }
            </div>
          </div>
        }

        <!-- Qualifications + Certifications -->
        @if ((d.qualification_entries?.length ?? 0) > 0 || (d.certifications?.length ?? 0) > 0) {
          <div class="grid grid-cols-1 gap-8 sm:grid-cols-2">
            @if ((d.qualification_entries?.length ?? 0) > 0) {
              <div class="flex flex-col gap-3">
                <h3 class="flex items-center gap-2 font-heading text-h5 text-ink"><sd-icon name="graduation-cap" [size]="20" class="text-cerulean" />Qualifications</h3>
                @for (q of d.qualification_entries ?? []; track $index) {
                  <div class="flex items-start gap-2.5">
                    <sd-icon name="check" [size]="18" class="mt-0.5 shrink-0 text-cerulean" />
                    <div class="flex flex-col">
                      <span class="font-sans text-body font-semibold text-ink">{{ q.title }}</span>
                      <span class="font-sans text-body-sm text-slate">{{ subLine(q.institution, q.year) }}</span>
                    </div>
                  </div>
                }
              </div>
            }
            @if ((d.certifications?.length ?? 0) > 0) {
              <div class="flex flex-col gap-3">
                <h3 class="flex items-center gap-2 font-heading text-h5 text-ink"><sd-icon name="shield-check" [size]="20" class="text-cerulean" />Certifications</h3>
                @for (c of d.certifications ?? []; track $index) {
                  <div class="flex items-start gap-2.5">
                    <sd-icon name="badge-check" [size]="18" class="mt-0.5 shrink-0 text-cerulean" />
                    <div class="flex flex-col">
                      <span class="font-sans text-body font-semibold text-ink">{{ c.name }}</span>
                      <span class="font-sans text-body-sm text-slate">{{ subLine(c.body, c.year) }}</span>
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class DoctorProfileCardComponent {
  readonly data = input<PublicDoctorProfileData | null>(null);
  readonly photoUrl = input<string | null>(null);

  protected readonly initials = computed(() =>
    (this.data()?.name ?? '')
      // Strip an honorific first so "Dr. Jane Doe" → "JD" (matching the patient
      // directory card), not "DJ".
      .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase(),
  );

  protected languageList(): string {
    return (this.data()?.languages ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
  }

  protected subLine(a?: string, b?: string): string {
    return [a, b].filter(Boolean).join(' · ');
  }
}
