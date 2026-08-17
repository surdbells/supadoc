/** Dev environment. Swapped for environment.prod.ts in production builds. */
export const environment = {
  production: false,
  // VideoMed backend origin (apps/api). Paths are built as `${apiBaseUrl}/api/...`.
  apiBaseUrl: 'http://localhost:8080',
};
