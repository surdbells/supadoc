import { inject, Injectable } from '@angular/core';
import { FirebaseApp, getApp, getApps, initializeApp } from '@firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
} from '@firebase/auth';
import { AuthService } from '@supadoc/auth';
import { environment } from '../../environments/environment';

/**
 * Google sign-in via Firebase. Opens the Google popup, then hands the resulting
 * Firebase ID token to the backend (AuthService.loginWithGoogle), which verifies
 * it and returns a VideoMed session token.
 */
@Injectable({ providedIn: 'root' })
export class GoogleAuthService {
  private readonly auth = inject(AuthService);

  /** Whether the Firebase Web config has been filled in. */
  get isConfigured(): boolean {
    return !!environment.firebase?.apiKey;
  }

  async signIn(): Promise<void> {
    if (!this.isConfigured) {
      throw new Error('Google sign-in is not configured yet.');
    }

    const app: FirebaseApp = getApps().length
      ? getApp()
      : initializeApp(environment.firebase);

    const credential = await signInWithPopup(
      getAuth(app),
      new GoogleAuthProvider(),
    );
    const idToken = await credential.user.getIdToken();

    await this.auth.loginWithGoogle(idToken);
  }
}
