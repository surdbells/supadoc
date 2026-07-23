import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  CreateProfileParams,
  UpdateProfileParams,
  UserProfile,
} from '@supadoc/models';
import { ApiService } from './api.service';

/** Typed client for the VideoMed API UserProfile endpoints. */
@Injectable({ providedIn: 'root' })
export class ProfileApi {
  private readonly api = inject(ApiService);

  getProfile(): Observable<UserProfile> {
    return this.api.get<UserProfile>('GetProfile');
  }

  createProfile(params: CreateProfileParams): Observable<UserProfile> {
    return this.api.post<UserProfile>('CreateProfile', params);
  }

  updateProfile(params: UpdateProfileParams): Observable<UserProfile> {
    return this.api.post<UserProfile>('UpdateUserProfile', params);
  }
}
