import { Injectable, signal } from '@angular/core';

/**
 * Transient state carried across the multi-step register / recover flows
 * (email + verified OTP). Held in memory only — the OTP is never put in the URL.
 */
@Injectable({ providedIn: 'root' })
export class AuthFlowService {
  readonly email = signal('');
  readonly otpCode = signal('');

  start(email: string): void {
    this.email.set(email);
    this.otpCode.set('');
  }

  setOtp(otpCode: string): void {
    this.otpCode.set(otpCode);
  }

  reset(): void {
    this.email.set('');
    this.otpCode.set('');
  }
}
