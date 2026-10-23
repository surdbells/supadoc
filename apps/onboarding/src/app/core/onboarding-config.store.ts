import { inject, Injectable, signal } from '@angular/core';
import { DoctorApplicationsApi } from '@supadoc/data-access';
import type { ApplicationConfigDto } from '@supadoc/models';
import { firstValueFrom } from 'rxjs';

/** Used until GET /config answers, and kept if it fails. */
export const DEFAULT_CONFIG: ApplicationConfigDto = {
  consent_version: '2026-10',
  max_upload_bytes: 5 * 1024 * 1024,
  accepted_mime: ['application/pdf', 'image/png', 'image/jpeg'],
  doctor_portal_url: 'https://doctor.dosthq.com',
  support_email: 'support@videomed.app',
  draft_ttl_days: 30,
  good_standing_max_age_months: 6,
  sms_enabled: true,
  legal_terms_url: null,
  legal_privacy_url: null,
  patient_site_url: 'https://patient.dosthq.com',
};

/** Only https links from config are ever rendered. */
function httpsOrNull(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

/**
 * GET /api/public/doctor-applications/config, fetched once: the consent
 * version, the doctor portal paired with this site (Log In), the support
 * address, whether SMS is on, and the legal / patient-site links (null legal
 * URLs show the words without a link).
 */
@Injectable({ providedIn: 'root' })
export class OnboardingConfigStore {
  private readonly api = inject(DoctorApplicationsApi);
  readonly config = signal<ApplicationConfigDto>(DEFAULT_CONFIG);
  private loading: Promise<ApplicationConfigDto> | null = null;

  /** Loads the config once; later calls share the first result. Never rejects. */
  load(): Promise<ApplicationConfigDto> {
    this.loading ??= firstValueFrom(this.api.config$())
      .then((res) => {
        const c = { ...DEFAULT_CONFIG, ...res.data };
        c.legal_terms_url = httpsOrNull(c.legal_terms_url);
        c.legal_privacy_url = httpsOrNull(c.legal_privacy_url);
        this.config.set(c);
        return c;
      })
      .catch(() => this.config());
    return this.loading;
  }

  /** `{doctor_portal_url}/auth/login`. */
  loginUrl(): string {
    return `${this.config().doctor_portal_url.replace(/\/+$/, '')}/auth/login`;
  }
}
