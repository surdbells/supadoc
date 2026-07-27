/**
 * Request/response shapes for the VideoMed API (VideoMedApi v1).
 * The `appId` required on most calls is injected by the data-access layer, so
 * these params omit it.
 */

/**
 * Account type sent on registration. The patient portal registers users as
 * `'public'` (the VideoMed API's value for a self-service patient account).
 */
export type AccountType = 'public' | 'patient' | 'doctor';

/**
 * How the VideoMed API interprets `userName` on login. The identifier field is
 * really a username, so email/phone sign-in both pass the typed value through
 * as the username; `phonenumber` is for a dedicated phone-number lookup.
 */
export type LoginType = 'username' | 'email' | 'phonenumber';

export interface LoginParams {
  userName: string;
  password: string;
  loginType?: LoginType;
}

export interface RegisterParams {
  email: string;
  password: string;
  accountType: string;
  otpCode: string;
}

export interface VerifyOtpParams {
  email: string;
  otpCode: string;
}

export interface ResetPasswordParams {
  email: string;
  otpCode: string;
  newPassword: string;
}

export interface CreateProfileParams {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string | null;
  organization?: string | null;
}

export interface UpdateProfileParams {
  userId: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string | null;
  defaultCurrency?: string | null;
  country?: string | null;
}

export interface UserProfile {
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string | null;
  [key: string]: unknown;
}

/**
 * The API spec documents login as `200 OK` with no body schema, so the token
 * field is unknown — accept the common shapes and fall back to the raw payload.
 */
export interface LoginResponse {
  token?: string;
  accessToken?: string;
  jwt?: string;
  [key: string]: unknown;
}
