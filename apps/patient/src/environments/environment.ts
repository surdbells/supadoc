/** Dev environment. Swapped for environment.prod.ts in production builds. */
export const environment = {
  production: false,
  // Local VideoMed backend (apps/api). Start it with:
  //   cd apps/api && composer start   (php -S localhost:8080)
  apiBaseUrl: 'http://localhost:8080',
  // Customer (patient) sign-in route on the local backend.
  loginPath: 'api/portal/auth/login',
  // Firebase Web config for Google sign-in — fill from the Firebase console
  // (Project settings → General → Your apps). `projectId` must match the
  // backend's FIREBASE_PROJECT_ID. Left blank => the Google button is disabled.
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    appId: '',
  },
};
