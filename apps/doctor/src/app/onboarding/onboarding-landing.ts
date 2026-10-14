import { firstValueFrom } from 'rxjs';
import type { DoctorApi } from '@supadoc/data-access';

/**
 * Where a doctor lands after signing in: their onboarding checklist until an
 * admin approves them, then their schedule. Falls back to the schedule if the
 * status can't be read (the dashboard banner still points the way).
 */
export async function doctorLandingUrl(api: DoctorApi): Promise<string> {
  try {
    const res = await firstValueFrom(api.onboarding());
    return res.data.status === 'approved' ? '/schedule' : '/onboarding';
  } catch {
    return '/schedule';
  }
}
