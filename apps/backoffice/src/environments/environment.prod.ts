export const environment = {
  production: true,
  apiBaseUrl: 'https://api.dosthq.com',
  // Idle timeout: sign out after this many minutes without activity (with a
  // 60s warning first). Keep below the API's SESSION_IDLE_TIMEOUT.
  session: { idleMinutes: 30 },
};
