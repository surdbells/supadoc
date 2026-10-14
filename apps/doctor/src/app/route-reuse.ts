import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

/**
 * Angular keeps a page's component when only its route params change, so a
 * link from `/appointments/A` to `/appointments/B` (a follow-up's "Follow-up
 * of…" link, a record in its follow-ups list) would keep showing A — the
 * record page reads its id once. A route with `data: { remountOnParamChange: true }`
 * gets a fresh component instead (its canDeactivate guard still runs first).
 */
export class DoctorRouteReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    if (!super.shouldReuseRoute(future, curr)) return false;
    if (future.routeConfig?.data?.['remountOnParamChange'] !== true) return true;
    const keys = new Set([...Object.keys(future.params), ...Object.keys(curr.params)]);
    return [...keys].every((k) => future.params[k] === curr.params[k]);
  }
}
