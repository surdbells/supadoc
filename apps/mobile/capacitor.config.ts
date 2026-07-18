import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.supadoc.patient',
  appName: 'Supadoc',
  // Nx builds the mobile web bundle to the repo-root dist/ folder.
  // webDir is resolved relative to this config file (apps/mobile).
  webDir: '../../dist/apps/mobile/browser',
};

export default config;
