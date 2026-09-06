import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { StaffUserDto, SuccessResponse } from '@supadoc/models';
import { ApiService } from './api.service';

export interface CreateStaffParams {
  email: string;
  first_name: string;
  last_name: string;
  password: string;
  roles?: string[];
  permissions?: string[];
  specialist_id?: string | null;
}

export interface UpdateStaffParams {
  email?: string;
  first_name?: string;
  last_name?: string;
  roles?: string[];
  permissions?: string[];
  active?: boolean;
  specialist_id?: string | null;
}

/** Staff & role management API (needs `staff.manage`). */
@Injectable({ providedIn: 'root' })
export class StaffApi {
  private readonly api = inject(ApiService);

  /** GET /api/staff — the staff directory. */
  list(): Observable<SuccessResponse<StaffUserDto[]>> {
    return this.api.get<SuccessResponse<StaffUserDto[]>>('api/staff');
  }

  /** POST /api/staff — create a staff account. */
  create(params: CreateStaffParams): Observable<SuccessResponse<StaffUserDto>> {
    return this.api.post<SuccessResponse<StaffUserDto>>('api/staff', params);
  }

  /** PATCH /api/staff/{id} — update a staff account. */
  update(
    id: string,
    params: UpdateStaffParams,
  ): Observable<SuccessResponse<StaffUserDto>> {
    return this.api.patch<SuccessResponse<StaffUserDto>>(
      `api/staff/${encodeURIComponent(id)}`,
      params,
    );
  }

  /** POST /api/staff/{id}/password — admin reset of a staff password. */
  resetPassword(
    id: string,
    newPassword: string,
  ): Observable<SuccessResponse<{ changed: boolean }>> {
    return this.api.post<SuccessResponse<{ changed: boolean }>>(
      `api/staff/${encodeURIComponent(id)}/password`,
      { new_password: newPassword },
    );
  }
}
