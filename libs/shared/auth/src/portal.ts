/*
 * @supadoc/auth/portal — getting between the public homepage and the staff
 * portals (separate sites): the homepage's reading of the portal hints, the
 * staff logo's homepage URL and the `go/home` route. A separate entry point so
 * it loads with the pages that use it (the homepage, the staff shells), not
 * with every app's main bundle like the `@supadoc/auth` barrel.
 */
export * from './lib/portal/portal-links';
export * from './lib/portal/leave-for-home';
export type { PortalKind } from './lib/session/portal-hint';
