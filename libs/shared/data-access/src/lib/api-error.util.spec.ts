import { HttpErrorResponse } from '@angular/common/http';
import {
  apiErrorCode,
  apiErrorMessage,
  apiErrorReason,
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
