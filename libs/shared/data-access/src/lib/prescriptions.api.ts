import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PrescriptionCheckResult,
  PrescriptionDto,
  PrescriptionLinkDto,
  PrescriptionSettingsDto,
  PrescriptionSummaryDto,
  SuccessResponse,
} from '@supadoc/models';
import { API_CONFIG } from './api-config';
import { ApiService } from './api.service';

/**
 * Absolute URL for an API-relative path such as a prescription link's
 * `/api/public/prescriptions/file?token=…`.
 */
export function apiFileUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Open a signed file link obtained asynchronously without tripping popup
 * blockers: call this synchronously from the click handler, then `go(url)` once
 * the link arrives (or `fail()` to close the placeholder tab).
 *
 * `go()` returns true when the file opened in the new tab. If the browser
 * blocked the tab (or the user closed it first) it falls back to opening the
 * file in the current tab — unless `allowSameTab: false` is passed (e.g. during
 * a live video call, where leaving the page would end the call), in which case
 * it returns false and the caller should offer a link to open it instead.
 */
export function openPendingTab(options: { allowSameTab?: boolean } = {}): {
  go: (url: string) => boolean;
  fail: () => void;
} {
  const allowSameTab = options.allowSameTab ?? true;
  let win: Window | null = null;
  try {
    win = window.open('', '_blank');
    if (win) {
      win.opener = null;
      win.document.title = 'Opening prescription…';
      win.document.body.textContent = 'Opening your prescription…';
    }
  } catch {
    win = null;
  }
  return {
    go: (url: string) => {
      if (win && !win.closed) {
        win.location.href = url;
        return true;
      }
      if (allowSameTab) {
        window.location.href = url;
        return true;
      }
      return false;
    },
    fail: () => {
      if (win && !win.closed) win.close();
    },
  };
}

/**
 * Patient prescriptions (`/api/portal/prescriptions*`), the public pharmacist
 * check, and the back-office prescription settings / staff access.
 */
@Injectable({ providedIn: 'root' })
export class PrescriptionsApi {
  private readonly api = inject(ApiService);
  private readonly config = inject(API_CONFIG);

  /** Absolute URL for a signed link returned by any `*link` call. */
  fileUrl(link: PrescriptionLinkDto): string {
    return apiFileUrl(this.config.baseUrl, link.url);
  }

  // ----- patient -----

  /** GET /api/portal/prescriptions — my prescriptions, newest first. */
  mine(): Observable<SuccessResponse<PrescriptionSummaryDto[]>> {
    return this.api.get<SuccessResponse<PrescriptionSummaryDto[]>>('api/portal/prescriptions');
  }

  /** GET /api/portal/prescriptions/{id} — one of my sent prescriptions. */
  get(id: string): Observable<SuccessResponse<PrescriptionDto>> {
    return this.api.get<SuccessResponse<PrescriptionDto>>(`api/portal/prescriptions/${encodeURIComponent(id)}`);
  }

  /** POST /api/portal/prescriptions/{id}/link — signed PDF link (view or download). */
  link(id: string, download = false): Observable<SuccessResponse<PrescriptionLinkDto>> {
    return this.api.post<SuccessResponse<PrescriptionLinkDto>>(
      `api/portal/prescriptions/${encodeURIComponent(id)}/link`,
      { download },
    );
  }

  // ----- public pharmacist check -----

  /** POST /api/public/prescriptions/check — no sign-in; always answers with a `result`. */
  check(number: string, dateOfBirth: string, deviceId: string): Observable<SuccessResponse<PrescriptionCheckResult>> {
    return this.api.post<SuccessResponse<PrescriptionCheckResult>>('api/public/prescriptions/check', {
      number,
      date_of_birth: dateOfBirth,
      device_id: deviceId,
    });
  }

  // ----- back office (authorised staff) -----

  /** GET /api/admin/patients/{id}/prescriptions — a patient's sent prescriptions. */
  forPatient(patientId: string): Observable<SuccessResponse<PrescriptionSummaryDto[]>> {
    return this.api.get<SuccessResponse<PrescriptionSummaryDto[]>>(
      `api/admin/patients/${encodeURIComponent(patientId)}/prescriptions`,
    );
  }

  /** POST /api/admin/prescriptions/{id}/link — signed PDF link for staff (audited on open). */
  staffLink(id: string, download = false): Observable<SuccessResponse<PrescriptionLinkDto>> {
    return this.api.post<SuccessResponse<PrescriptionLinkDto>>(
      `api/admin/prescriptions/${encodeURIComponent(id)}/link`,
      { download },
    );
  }

  /** GET /api/settings/prescriptions — admin-configurable prescription rules. */
  settings(): Observable<SuccessResponse<PrescriptionSettingsDto>> {
    return this.api.get<SuccessResponse<PrescriptionSettingsDto>>('api/settings/prescriptions');
  }

  /** PATCH /api/settings/prescriptions — update any subset of the rules. */
  updateSettings(patch: Partial<PrescriptionSettingsDto>): Observable<SuccessResponse<PrescriptionSettingsDto>> {
    return this.api.patch<SuccessResponse<PrescriptionSettingsDto>>('api/settings/prescriptions', patch);
  }
}
