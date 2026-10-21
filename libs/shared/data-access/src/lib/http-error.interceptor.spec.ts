import {
  HttpClient,
  HttpHeaders,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ApiError } from '@supadoc/models';
import { httpErrorInterceptor } from './http-error.interceptor';
import { LOGGER } from './logger';

const BASE = 'https://api.test';

function setup() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([httpErrorInterceptor])),
      provideHttpClientTesting(),
      { provide: LOGGER, useValue: logger },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    ctl: TestBed.inject(HttpTestingController),
    logger,
  };
}

describe('httpErrorInterceptor', () => {
  it('normalises the error, copying Retry-After into retryAfterMs', () => {
    const { http, ctl } = setup();
    let error: ApiError | undefined;
    http
      .get(`${BASE}/api/x`)
      .subscribe({ error: (e: ApiError) => (error = e) });
    ctl
      .expectOne(`${BASE}/api/x`)
      .flush(
        {
          message: 'Too many requests',
          errors: {
            rate: 'Too many requests. Please wait a moment and try again.',
            code: 'rate_limited',
          },
        },
        {
          status: 429,
          statusText: 'Too Many Requests',
          headers: new HttpHeaders({ 'Retry-After': '7' }),
        },
      );
    expect(error).toEqual({
      statusCode: 429,
      message: 'Too many requests. Please wait a moment and try again.',
      errors: {
        rate: 'Too many requests. Please wait a moment and try again.',
        code: 'rate_limited',
      },
      retryAfterMs: 7000,
    });
  });

  it('logs a session that ended (401 session_* / account_* / token_missing) as a warning, not an error', () => {
    const { http, ctl, logger } = setup();
    for (const code of [
      'session_revoked',
      'account_deactivated',
      'refresh_invalid',
      'token_missing',
      'signed_out',
    ]) {
      http.get(`${BASE}/api/${code}`).subscribe({ error: () => undefined });
      ctl
        .expectOne(`${BASE}/api/${code}`)
        .flush(
          { message: 'Signed out', errors: { auth: 'Signed out', code } },
          { status: 401, statusText: 'Unauthorized' },
        );
    }
    expect(logger.warn).toHaveBeenCalledTimes(5);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain(
      'session ended (session_revoked)',
    );
  });

  it('a sign-in that could not be confirmed for now (refresh_unavailable) is a warning — never "session ended"', () => {
    const { http, ctl, logger } = setup();
    http.get(`${BASE}/api/doctor/onboarding`).subscribe({ error: () => undefined });
    ctl.expectOne(`${BASE}/api/doctor/onboarding`).flush(
      {
        message: 'Not confirmed',
        errors: { auth: 'Not confirmed', code: 'refresh_unavailable' },
      },
      { status: 401, statusText: 'Unauthorized' },
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toBe('[API 401] GET https://api.test/api/doctor/onboarding sign-in not confirmed (transient)');
    expect(line).not.toContain('session ended');
  });

  it('a refused refresh (an API without codes) is a warning too', () => {
    const { http, ctl, logger } = setup();
    http
      .post(`${BASE}/api/auth/refresh`, { refresh_token: 'secret-refresh' })
      .subscribe({ error: () => undefined });
    ctl
      .expectOne(`${BASE}/api/auth/refresh`)
      .flush(
        { message: 'Your session has expired.' },
        { status: 401, statusText: 'Unauthorized' },
      );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs anything else (a token for the wrong portal, a 500) as an error', () => {
    const { http, ctl, logger } = setup();
    http.get(`${BASE}/api/a`).subscribe({ error: () => undefined });
    ctl
      .expectOne(`${BASE}/api/a`)
      .flush(
        {
          message: 'Wrong portal',
          errors: { auth: 'Wrong portal', code: 'token_wrong_audience' },
        },
        { status: 401, statusText: 'Unauthorized' },
      );
    http.get(`${BASE}/api/b`).subscribe({ error: () => undefined });
    ctl
      .expectOne(`${BASE}/api/b`)
      .flush(
        { message: 'Unexpected server error' },
        { status: 500, statusText: 'Server Error' },
      );
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never logs a request body (refresh / logout bodies carry the refresh token) and redacts call links', () => {
    const { http, ctl, logger } = setup();
    http
      .post(`${BASE}/api/auth/logout`, { refresh_token: 'secret-refresh' })
      .subscribe({ error: () => undefined });
    ctl
      .expectOne(`${BASE}/api/auth/logout`)
      .flush(
        { message: 'Server down' },
        { status: 503, statusText: 'Unavailable' },
      );
    http
      .get(`${BASE}/api/public/call/eyJhbGciOi.secret.sig/presence`)
      .subscribe({ error: () => undefined });
    ctl
      .expectOne(`${BASE}/api/public/call/eyJhbGciOi.secret.sig/presence`)
      .flush({ message: 'Gone' }, { status: 410, statusText: 'Gone' });
    const logged = JSON.stringify([
      ...logger.error.mock.calls,
      ...logger.warn.mock.calls,
    ]);
    expect(logged).not.toContain('secret-refresh');
    expect(logged).not.toContain('eyJhbGciOi.secret.sig');
    expect(logged).toContain('/api/public/call/[redacted]/presence');
  });
});
