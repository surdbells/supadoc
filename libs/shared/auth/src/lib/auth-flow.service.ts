import { Injectable, signal } from '@angular/core';

/**
 * Transient state carried across the multi-step register / recover / phone
 * flows. Held in memory only — the OTP and proof token are never put in the URL.
 */
@Injectable({ providedIn: 'root' })
export class AuthFlowService {
  // Email + betacrest OTP flow.
  readonly email = signal('');
  readonly otpCode = signal('');

  // Termii phone flow.
  readonly phone = signal(''); // international format, e.g. 2348012345678
  readonly pinId = signal('');
  readonly verificationToken = signal('');
  readonly purpose = signal<'register' | 'login'>('register');

  start(email: string): void {
    this.email.set(email);
    this.otpCode.set('');
  }

  setOtp(otpCode: string): void {
    this.otpCode.set(otpCode);
  }

  startPhone(phone: string, pinId: string, purpose: 'register' | 'login'): void {
    this.phone.set(phone);
    this.pinId.set(pinId);
    this.purpose.set(purpose);
    this.verificationToken.set('');
  }

  reset(): void {
    this.email.set('');
    this.otpCode.set('');
    this.phone.set('');
    this.pinId.set('');
    this.verificationToken.set('');
  }
}
