/** Dev environment. Swapped for environment.prod.ts in production builds. */
export const environment = {
  production: false,
  // VideoMed backend origin (apps/api). Paths are built as `${apiBaseUrl}/api/...`.
  apiBaseUrl: 'http://localhost:8080',
  // Idle timeout: sign out after this many minutes without activity (with a
  // 60s warning first). Keep below the API's SESSION_IDLE_TIMEOUT.
  session: { idleMinutes: 30 },
};
