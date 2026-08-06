/** Dev environment. Swapped for environment.prod.ts in production builds. */
export const environment = {
  production: false,
  // Local VideoMed backend (apps/api). Start it with:
  //   cd apps/api && composer start   (php -S localhost:8080)
  // To hit the hosted API instead, use 'https://vmapi.betacrest.com' + loginPath 'login'.
  apiBaseUrl: 'http://localhost:8080',
  // Customer (patient) sign-in route on the local backend.
  loginPath: 'api/portal/auth/login',
  appId: 'ViewHot',
};
