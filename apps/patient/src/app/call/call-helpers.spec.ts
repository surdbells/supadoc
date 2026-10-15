import {
  callRefusal,
  countdownLabel,
  deviceProblem,
  deviceProblemText,
  doctorTitle,
  httpStatus,
  isFinalRefusal,
} from './call-helpers';

/** An API error as the http-error interceptor hands it over. */
function apiError(statusCode: number, errors: Record<string, string>, message = 'Refused') {
  return { statusCode, message, errors };
}

describe('deviceProblem', () => {
  it('tells blocked, missing and busy devices apart (Agora codes and browser names)', () => {
    expect(deviceProblem({ code: 'PERMISSION_DENIED', message: 'NotAllowedError: Permission denied' })).toBe('denied');
    expect(deviceProblem({ name: 'NotAllowedError' })).toBe('denied');
    expect(deviceProblem({ code: 'DEVICE_NOT_FOUND' })).toBe('missing');
    expect(deviceProblem({ name: 'NotFoundError', message: 'Requested device not found' })).toBe('missing');
    expect(deviceProblem({ code: 'NOT_READABLE', message: 'NotReadableError: Could not start video source' })).toBe('busy');
    expect(deviceProblem(new Error('something else'))).toBe('failed');
    expect(deviceProblem(null)).toBe('failed');
  });

  it('says what to do about each', () => {
    expect(deviceProblemText('camera', 'denied')).toContain('site settings');
    expect(deviceProblemText('microphone', 'missing')).toContain('No microphone was found');
    expect(deviceProblemText('camera', 'busy')).toContain('another app');
  });
});

describe('callRefusal', () => {
  it('reads a too-early refusal with its countdown times', () => {
    const r = callRefusal(
      apiError(425, {
        call: 'This consultation hasn’t started yet.',
        code: 'too_early',
        opens_at: '2026-10-14T09:45:00+00:00',
        server_time: '2026-10-14T09:00:00+00:00',
      }),
    );
    expect(r).toEqual({
      status: 425,
      code: 'too_early',
      message: 'This consultation hasn’t started yet.',
      opensAt: '2026-10-14T09:45:00+00:00',
      serverTime: '2026-10-14T09:00:00+00:00',
    });
    expect(r && isFinalRefusal(r)).toBe(false);
  });

  it('treats withdrawn, cancelled, ended and unconfirmed links as final', () => {
    for (const [status, code] of [
      [410, 'withdrawn'],
      [410, 'cancelled'],
      [410, 'ended'],
      [409, 'not_confirmed'],
    ] as const) {
      const r = callRefusal(apiError(status, { call: 'No call', code }));
      expect(r?.code).toBe(code);
      expect(r && isFinalRefusal(r)).toBe(true);
    }
  });

  it('is not a refusal for a bad link, a validation error or a network failure', () => {
    expect(callRefusal(apiError(401, {}))).toBeNull();
    expect(callRefusal(apiError(422, { display_name: 'Enter a name' }))).toBeNull();
    expect(callRefusal({ statusCode: 0, message: 'offline' })).toBeNull();
    expect(httpStatus({ status: 503 })).toBe(503);
    expect(httpStatus('nope')).toBe(0);
  });

  it('a consent refusal is not final — the lobby asks for the notice', () => {
    const r = callRefusal(apiError(403, { call: 'Please accept the notice', code: 'consent_required' }));
    expect(r?.code).toBe('consent_required');
    expect(r && isFinalRefusal(r)).toBe(false);
  });
});

describe('countdownLabel', () => {
  it('counts minutes and seconds, then hours, then days', () => {
    expect(countdownLabel(0)).toBe('0:00');
    expect(countdownLabel(-5_000)).toBe('0:00');
    expect(countdownLabel(65_000)).toBe('1:05');
    expect(countdownLabel(59 * 60_000 + 59_000)).toBe('59:59');
    expect(countdownLabel(59 * 60_000 + 59_500)).toBe('1 h 00 min');
    expect(countdownLabel(3_600_000 + 5 * 60_000)).toBe('1 h 05 min');
    expect(countdownLabel(2 * 86_400_000 + 1)).toBe('2 days');
  });
});

describe('doctorTitle', () => {
  it('adds the title once', () => {
    expect(doctorTitle('Ada Obi')).toBe('Dr Ada Obi');
    expect(doctorTitle('Dr Ada Obi')).toBe('Dr Ada Obi');
    expect(doctorTitle('Prof. Ada Obi')).toBe('Prof. Ada Obi');
    expect(doctorTitle('')).toBe('your doctor');
  });
});
