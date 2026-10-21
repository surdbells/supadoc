/**
 * Test helpers (spec files only — not exported from the library).
 */

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** An unsigned JWT carrying `claims` — enough for the client's timing and "same user?" reads. */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

/**
 * An access token for `sub` with `secondsLeft` of life left now (device clock;
 * negative: already expired), from a `lifetimeSeconds` TTL (default 900 s).
 */
export function tokenFor(
  sub: string,
  secondsLeft: number,
  extra: Record<string, unknown> = {},
  lifetimeSeconds = 900,
): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + secondsLeft;
  return fakeJwt({ sub, iat: exp - lifetimeSeconds, exp, ...extra });
}
