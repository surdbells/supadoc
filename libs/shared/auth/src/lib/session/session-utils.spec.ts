import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  classifyAuth401,
  endReasonFor,
  isDefinitiveAuthFailure,
  isSafeReturnUrl,
  isSessionEndError,
  jwtSubject,
  refreshMarginMs,
  retryAfterMsOf,
} from './session-utils';
import { fakeJwt } from './testing';

describe('session utils', () => {
  describe('classifyAuth401', () => {
    it('refreshes on an expired / invalid token, and on a 401 without a code (an API without codes)', () => {
      expect(classifyAuth401('token_expired', true)).toBe('refresh');
      expect(classifyAuth401('token_invalid', true)).toBe('refresh');
      expect(classifyAuth401(null, true)).toBe('refresh');
      expect(classifyAuth401(null, false)).toBe('refresh');
    });

    it('refreshes a missing token only when there is a refresh token', () => {
      expect(classifyAuth401('token_missing', true)).toBe('refresh');
      expect(classifyAuth401('token_missing', false)).toBe('pass');
    });

    it('ends the session for session / account / refresh codes', () => {
      for (const code of [
        'session_expired',
        'session_revoked',
        'session_invalid',
        'refresh_invalid',
        'account_missing',
        'account_deactivated',
        'signed_out',
      ]) {
        expect(classifyAuth401(code, true)).toBe('end');
      }
    });

    it('passes on a token for the wrong portal (and anything unknown)', () => {
      expect(classifyAuth401('token_wrong_audience', true)).toBe('pass');
      expect(classifyAuth401('refresh_unavailable', true)).toBe('pass');
      expect(classifyAuth401('something_new', true)).toBe('pass');
    });
  });

  it('endReasonFor: revoked / deactivated → revoked, idle expiry → idle, else expired', () => {
    expect(endReasonFor('session_revoked')).toBe('revoked');
    expect(endReasonFor('account_deactivated')).toBe('revoked');
    expect(endReasonFor('account_missing')).toBe('revoked');
    expect(endReasonFor('session_expired', 'idle')).toBe('idle');
    expect(endReasonFor('session_expired', 'lifetime')).toBe('expired');
    expect(endReasonFor('session_expired')).toBe('expired');
    expect(endReasonFor('session_invalid')).toBe('expired');
    expect(endReasonFor(null)).toBe('expired');
  });

  it('isDefinitiveAuthFailure: only 401 / 422 end a session — a CDN 403, 429, 5xx or offline never do', () => {
    expect(isDefinitiveAuthFailure({ status: 401 })).toBe(true);
    expect(isDefinitiveAuthFailure({ statusCode: 422 })).toBe(true);
    for (const status of [400, 403, 429, 500, 502, 0]) {
      expect(isDefinitiveAuthFailure({ status })).toBe(false);
    }
  });

  it('isSafeReturnUrl: same-app paths only, never the sign-in screens', () => {
    expect(isSafeReturnUrl('/a')).toBe(true);
    expect(isSafeReturnUrl('/dashboard/appointments/book/1?slot=2')).toBe(true);
    expect(isSafeReturnUrl('/authors')).toBe(true);
    expect(isSafeReturnUrl('//evil.example')).toBe(false);
    expect(isSafeReturnUrl('/\\evil.example')).toBe(false);
    expect(isSafeReturnUrl('/auth/login')).toBe(false);
    expect(isSafeReturnUrl('/auth')).toBe(false);
    expect(isSafeReturnUrl('https://x.example/a')).toBe(false);
    expect(isSafeReturnUrl('')).toBe(false);
    expect(isSafeReturnUrl(null)).toBe(false);
  });

  it('jwtSubject reads `sub` (string or number), else null', () => {
    expect(jwtSubject(fakeJwt({ sub: 'u-1' }))).toBe('u-1');
    expect(jwtSubject(fakeJwt({ sub: 42 }))).toBe('42');
    expect(jwtSubject(fakeJwt({}))).toBeNull();
    expect(jwtSubject('opaque-token')).toBeNull();
    expect(jwtSubject(null)).toBeNull();
  });

  it('refreshMarginMs never exceeds three quarters of the token lifetime', () => {
    const iat = 1_000_000;
    expect(refreshMarginMs(fakeJwt({ iat, exp: iat + 900 }), 60_000)).toBe(
      60_000,
    );
    expect(refreshMarginMs(fakeJwt({ iat, exp: iat + 900 }), 600_000)).toBe(
      600_000,
    );
    expect(refreshMarginMs(fakeJwt({ iat, exp: iat + 60 }), 60_000)).toBe(
      45_000,
    );
    expect(refreshMarginMs('opaque', 60_000)).toBe(60_000);
  });

  it('isSessionEndError reads both error shapes', () => {
    const raw = new HttpErrorResponse({
      status: 401,
      error: {
        message: 'This session has been signed out',
        errors: { auth: 'x', code: 'session_revoked' },
      },
    });
    expect(isSessionEndError(raw)).toBe(true);
    expect(
      isSessionEndError({
        statusCode: 401,
        message: 'x',
        errors: { auth: 'x', code: 'signed_out' },
      }),
    ).toBe(true);
    expect(
      isSessionEndError({
        statusCode: 401,
        message: 'x',
        errors: { auth: 'x', code: 'refresh_unavailable' },
      }),
    ).toBe(false);
    expect(
      isSessionEndError({
        statusCode: 401,
        message: 'Invalid or expired token',
      }),
    ).toBe(false);
    expect(
      isSessionEndError({
        statusCode: 403,
        errors: { code: 'session_revoked' },
      }),
    ).toBe(false);
  });

  it('retryAfterMsOf reads a normalised error or the raw header', () => {
    expect(retryAfterMsOf({ statusCode: 429, retryAfterMs: 7000 })).toBe(7000);
    expect(
      retryAfterMsOf(
        new HttpErrorResponse({
          status: 429,
          headers: new HttpHeaders({ 'Retry-After': '7' }),
        }),
      ),
    ).toBe(7000);
    expect(retryAfterMsOf(new HttpErrorResponse({ status: 503 }))).toBeNull();
  });
});
