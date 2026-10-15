import type { DoctorStandingStore } from '../standing/doctor-standing.store';

/**
 * Where a doctor lands after signing in: their onboarding checklist until an
 * admin approves them, the account-status page while suspended, the terms page
 * when a new version waits for their acceptance, else their schedule. Falls
 * back to the schedule if the status can't be read (the dashboard banner still
 * points the way). Always reads afresh — it may be another doctor than before.
 */
export async function doctorLandingUrl(standing: DoctorStandingStore): Promise<string> {
  const data = await standing.load(true);
  if (!data) return '/schedule';
  if (data.status === 'suspended') return '/account-status';
  if (data.status !== 'approved') return '/onboarding';
  return data.standing?.code === 'terms_required' ? '/onboarding/terms' : '/schedule';
}
