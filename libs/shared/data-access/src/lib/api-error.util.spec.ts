import { HttpErrorResponse } from '@angular/common/http';
import {
  apiErrorCode,
  apiErrorFields,
  apiErrorMessage,
  apiErrorReason,
  SERVER_ERROR_MESSAGE,
} from './api-error.util';

describe('apiErrorMessage — machine tags', () => {
  it('never shows a bare code (`errors: { code: "doctor_portal_only" }` gives the top message)', () => {
    const raw = new HttpErrorResponse({
      status: 403,
      error: {
        message: 'This account can only use the doctor portal.',
        errors: { code: 'doctor_portal_only' },
      },
    });
    expect(apiErrorMessage(raw)).toBe(
      'This account can only use the doctor portal.',
    );
  });

  it('shows the human message that comes first beside the code', () => {
    const normalised = {
      statusCode: 401,
      message: 'This session has been signed out',
      errors: {
        auth: 'This session has been signed out',
        code: 'session_revoked',
        reason: 'idle',
      },
    };
    expect(apiErrorMessage(normalised)).toBe(
      'This session has been signed out',
    );
  });

  it('still shows a real field error that happens to be named code / reason', () => {
    expect(
      apiErrorMessage({
        statusCode: 422,
        message: 'Validation failed',
        errors: { code: 'Invalid code' },
      }),
    ).toBe('Invalid code');
    expect(
      apiErrorMessage({
        statusCode: 422,
        message: 'Validation failed',
        errors: { reason: 'Say why you are cancelling it' },
      }),
    ).toBe('Say why you are cancelling it');
  });
});

describe('apiErrorMessage — a 2xx whose body could not be parsed', () => {
  const CALL_URL = 'https://api.example.test/api/public/call/secret-token';

  it('XHR shape ({ error, text }): the server-error message, never "Http failure during parsing for <url>"', () => {
    const raw = new HttpErrorResponse({
      status: 200,
      statusText: 'OK',
      url: CALL_URL,
      error: { error: new SyntaxError('Unexpected token'), text: '<br />Deprecated…{"status":"success"}' },
    });
    expect(raw.message).toContain('Http failure during parsing');
    const msg = apiErrorMessage(raw, 'Could not upload the file.');
    expect(msg).toBe(SERVER_ERROR_MESSAGE);
    expect(msg).not.toContain(CALL_URL);
  });

  it("fetch shape (the parser's SyntaxError): the server-error message, not the parser's words", () => {
    const raw = new HttpErrorResponse({
      status: 201,
      url: CALL_URL,
      error: new SyntaxError(`Unexpected token '<', "<br />Depr"... is not valid JSON`),
    });
    expect(apiErrorMessage(raw)).toBe(SERVER_ERROR_MESSAGE);
  });

  it('the transport text alone (no status) is noise too, whichever wording Angular used', () => {
    expect(apiErrorMessage({ message: `Http failure during parsing for ${CALL_URL}` }, 'Fallback.')).toBe('Fallback.');
    expect(apiErrorMessage({ message: `Http failure response for ${CALL_URL}: 502 Bad Gateway` }, 'Fallback.')).toBe('Fallback.');
  });

  it('a normalised ApiError from it keeps saying the same', () => {
    expect(apiErrorMessage({ statusCode: 200, message: SERVER_ERROR_MESSAGE })).toBe(SERVER_ERROR_MESSAGE);
  });
});

describe('apiErrorMessage — document-sharing 409s', () => {
  it('request_not_pending: never shows the bare status ("approved")', () => {
    const raw = new HttpErrorResponse({
      status: 409,
      error: {
        message: 'This request has already been answered.',
        errors: { code: 'request_not_pending', status: 'approved' },
      },
    });
    expect(apiErrorMessage(raw)).toBe('This request has already been answered.');
    // the status itself stays readable for the page
    expect(apiErrorFields(raw)['status']).toBe('approved');
  });

  it('request_cooldown / request_limit: never shows the raw available_at instant', () => {
    for (const code of ['request_cooldown', 'request_limit']) {
      const normalised = {
        statusCode: 409,
        message: 'You can ask again later.',
        errors: { code, available_at: '2026-10-24T09:00:00+01:00' },
      };
      expect(apiErrorMessage(normalised)).toBe('You can ask again later.');
      expect(apiErrorFields(normalised)['available_at']).toBe('2026-10-24T09:00:00+01:00');
    }
  });

  it('a human errors.status (a field error) is still the message', () => {
    expect(
      apiErrorMessage({
        statusCode: 422,
        message: 'Validation failed',
        errors: { status: 'Not reschedulable' },
      }),
    ).toBe('Not reschedulable');
  });

  it('request_pending: the errors.request object is not a string field, so the top message wins', () => {
    const raw = new HttpErrorResponse({
      status: 409,
      error: {
        message: 'You already asked this patient.',
        errors: { code: 'request_pending', request: { id: 'r-1', status: 'pending' } },
      },
    });
    expect(apiErrorMessage(raw)).toBe('You already asked this patient.');
    expect(apiErrorFields(raw)['request']).toBeUndefined();
  });
});

describe('apiErrorCode / apiErrorReason', () => {
  it('read errors.code / errors.reason from either error shape', () => {
    const raw = new HttpErrorResponse({
      status: 401,
      error: {
        message: 'x',
        errors: { auth: 'x', code: 'session_expired', reason: 'idle' },
      },
    });
    expect(apiErrorCode(raw)).toBe('session_expired');
    expect(apiErrorReason(raw)).toBe('idle');
    const normalised = {
      statusCode: 401,
      message: 'x',
      errors: { auth: 'x', code: 'token_expired' },
    };
    expect(apiErrorCode(normalised)).toBe('token_expired');
    expect(apiErrorReason(normalised)).toBeNull();
  });

  it('is null without a code, or when the "code" is words (a field error)', () => {
    expect(
      apiErrorCode(
        new HttpErrorResponse({
          status: 401,
          error: { message: 'Invalid or expired token' },
        }),
      ),
    ).toBeNull();
    expect(
      apiErrorCode({ statusCode: 422, errors: { code: 'Invalid code' } }),
    ).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
  });
});
